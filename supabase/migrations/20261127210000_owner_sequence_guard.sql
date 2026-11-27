-- The owner's sequences and the Marketing Manager's cold email keep out of each other's way (batch 1 review, 2026-11-27).
--
-- Why. Batch 1's check compared addresses and domains only: All Care Home Care (pa-b1-03) had had three emails from the Marketing Manager
-- to info@ on another domain, matched to the same CCN by the roster, and would have had a fourth from the owner. And the Marketing
-- Manager's own cold email knew nothing of the owner's sequences: its daily roster run could resolve a sequence's agency and write to it
-- while the owner's emails were still going.
--
-- 1. private.growth_outreach_stopped (read by the Marketing Manager's send claim for every cold email, its planning and its re-asks) is
--    also true for an organization whose domain, or a CCN the roster tied to it, is a person of an owner sequence approved in the last
--    180 days.
-- 2. private.owner_sequence_check_people (the Growth page's and a request's check) also leaves out an agency whose CCN the roster tied to
--    an organization the Marketing Manager emailed in the last 90 days.
--
-- Nothing is sent by this migration. 20261127210100_owner_sequence_guard_contract.sql declares platform.agents.owner-sequence-guard.v1.
set local lock_timeout = '10s';

do $$
declare
  d text := pg_get_functiondef('private.growth_outreach_stopped(uuid)'::regprocedure);
  anchor constant text := $q$join private.outreach_do_not_contact n on n.kind = 'domain' and n.value = lower(g.domain)
    where g.id = p_org);$q$;
begin
  if position('owner_sequence_recipients' in d) > 0 then return; end if;
  if position(anchor in d) = 0 then raise exception 'growth_outreach_stopped changed; update this migration' using errcode = '55000'; end if;
  execute replace(d, anchor, $q$join private.outreach_do_not_contact n on n.kind = 'domain' and n.value = lower(g.domain)
    where g.id = p_org)
  or exists (select 1 from private.owner_sequence_recipients r join private.owner_sequences s on s.id = r.sequence_id
    join private.growth_organizations g on g.id = p_org
    where s.status <> 'draft' and s.approved_at > now() - interval '180 days'
      and (r.domain = lower(g.domain) or r.ccn in (select t.ccn from private.growth_roster_targets t where t.organization_id = p_org)));$q$);
end $$;

create or replace function private.owner_sequence_check_people(p_people jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
  if jsonb_typeof(p_people) <> 'array' or jsonb_array_length(p_people) > 200 then raise exception 'Invalid people' using errcode = '22023'; end if;
  return (select coalesce(jsonb_object_agg(x.ref, x.why), '{}'::jsonb) from (
    select p ->> 'ref' as ref, coalesce(private.owner_sequence_blocked(lower(btrim(p ->> 'email')), nullif(lower(p ->> 'domain'), ''), nullif(p ->> 'ccn', '')),
      case when exists (select 1 from private.owner_sequence_recipients r join private.owner_sequences s on s.id = r.sequence_id
        where s.status = 'approved' and r.status = 'active' and (r.email = lower(btrim(p ->> 'email')) or (nullif(p ->> 'ccn', '') is not null and r.ccn = p ->> 'ccn')))
        then 'in_sequence' end,
      case when exists (select 1 from private.growth_messages gm join private.growth_contacts gc on gc.id = gm.contact_id
          join private.growth_organizations g on g.id = gc.organization_id
        where gm.purpose = 'marketing' and gm.attempted_at is not null and gm.attempted_at > now() - interval '90 days'
          and (gc.email = lower(btrim(p ->> 'email')) or (nullif(lower(p ->> 'domain'), '') is not null and g.domain = lower(p ->> 'domain'))))
        -- The same agency by its CCN: the roster ties a CCN to the organization the Marketing Manager wrote to, whatever its address.
        or (nullif(p ->> 'ccn', '') is not null and exists (select 1 from private.growth_roster_targets t
          join private.growth_opportunities o on o.organization_id = t.organization_id join private.growth_messages gm on gm.opportunity_id = o.id
          where t.ccn = p ->> 'ccn' and gm.purpose = 'marketing' and gm.attempted_at is not null and gm.attempted_at > now() - interval '90 days'))
        then 'growth_contacted' end) as why
    from jsonb_array_elements(p_people) p) x where x.why is not null);
end; $$;
revoke all on function private.owner_sequence_check_people(jsonb) from public, anon, authenticated, service_role, hub_app_server;
