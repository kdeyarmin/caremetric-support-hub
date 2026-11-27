-- Hunter looks up only the agencies a batch would take (2026-11-27, after Hunter's key was added). Its first queue held a national chain
-- (Crossroads Hospice) and agencies whose only website is on a page builder: the weekly batch leaves both out, so a lookup there spends a
-- credit for nothing. private.growth_hunter_next now gives each agency's roster CCNs, and the server (server/growth/hunter.mjs) reads the
-- agency's CMS owners and its website before reserving a lookup, as the batch does. Nothing else changes; nothing is sent.
set local lock_timeout = '10s';

create or replace function private.growth_hunter_next(p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare excluded constant text[] := array['42021', '42033', '42027', '42013', '42009', '42111', '42129', '42063'];
begin
  perform private.require_hub_app_server();
  if p_limit is null or p_limit not between 1 and 25 then raise exception 'Invalid limit' using errcode = '22023'; end if;
  if not coalesce((select s.value = 'true'::jsonb from private.hub_settings s where s.key = 'growth.hunter'), false) then return '[]'::jsonb; end if;
  return (select coalesce(jsonb_agg(c order by c.patients desc nulls last, c.name), '[]'::jsonb) from (
    select g.id, g.name, lower(g.domain) as domain,
      (select max((t.facts ->> 'patients')::numeric) from private.growth_roster_targets t
        where t.organization_id = g.id and t.facts ->> 'patients' ~ '^[0-9]+(\.[0-9]+)?$') as patients,
      (select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'title', p.title, 'source', p.source) order by p.created_at)
        from private.growth_people p where p.organization_id = g.id) as people,
      -- The roster's CCNs, so the server reads the agency's CMS owners before a lookup is spent (20261127233000).
      (select jsonb_agg(t.ccn order by t.ccn) from private.growth_roster_targets t where t.organization_id = g.id) as ccns
    from private.growth_organizations g
    where g.domain is not null
      and exists (select 1 from private.growth_roster_targets t where t.organization_id = g.id and t.status = 'graduated')
      and not exists (select 1 from private.growth_roster_targets t where t.organization_id = g.id
        and (t.state <> 'PA' or coalesce(t.facts ->> 'control', '') <> 'Proprietary' or coalesce(t.county_fips, '') = any (excluded)))
      and (select count(distinct lower(coalesce(t.facts ->> 'address', t.zip, t.ccn))) from private.growth_roster_targets t where t.organization_id = g.id) = 1
      and not exists (select 1 from private.growth_opportunities o join private.growth_messages m on m.opportunity_id = o.id
        where o.organization_id = g.id and m.attempted_at is not null)
      and not exists (select 1 from private.owner_sequence_recipients r where r.domain = lower(g.domain)
        or r.ccn in (select t.ccn from private.growth_roster_targets t where t.organization_id = g.id))
      and not private.growth_outreach_stopped(g.id)
      and exists (select 1 from private.growth_people p where p.organization_id = g.id)
      -- Still missing an address the batch could use, and not asked about lately.
      and not exists (select 1 from private.growth_people p join private.growth_contacts c on c.id = p.contact_id
        where p.organization_id = g.id and c.mailbox_result = 'verified' and c.eligibility <> 'opted_out'
          and split_part(lower(c.email), '@', 2) = lower(g.domain))
      and not exists (select 1 from private.growth_hunter_lookups l where l.organization_id = g.id and l.created_at > now() - interval '180 days')
    order by patients desc nulls last, g.name
    limit p_limit) c);
end; $$;

revoke all on function private.growth_hunter_next(integer) from public, anon, authenticated, service_role;
grant execute on function private.growth_hunter_next(integer) to hub_app_server;
