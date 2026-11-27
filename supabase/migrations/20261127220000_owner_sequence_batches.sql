-- The AI team builds the owner's next cold email batch itself (owner, 2026-11-27: "train my AI workforce on how to do this").
--
-- Batch 2 was built by hand: the roster's Pennsylvania agencies screened by ownership, office and website, one owner or administrator
-- picked per agency, each address checked, the send list queued as a request (20261127200000_owner_sequence_requests.sql). The Marketing
-- Manager already names each agency's people and checks their addresses (growth.people). These functions let it do the rest: once a
-- week, while Settings → Customer growth → "Build your next sequence batch" is on, it reads the agencies ready for a batch and queues
-- the request in the owner's name; the request is prepared exactly as before, with every check, and approved only while
-- "Approve the batches the AI team builds" is on.
--
-- 1. private.owner_sequence_batch_due(): whether a batch may be built now, for whom, and the newest batch's first send date and number.
-- 2. private.owner_sequence_batch_candidates(p_limit): the agencies ready for a batch, with their roster entries and the people whose
--    work address was confirmed. Only Pennsylvania roster agencies the roster graduated, every entry proprietary (CMS's control type),
--    one office, outside Cambria County and the seven counties bordering it, on a domain of its own, never written to by the Marketing
--    Manager, not stopped (opted out, do-not-contact, the guard of 20261127210000), and in no owner sequence by domain or CCN. The server
--    then reads each agency's CMS owners and leaves out any owned by an organization.
-- 3. private.owner_sequence_batch_queue(p_payload): queues the request in the owner's name (the CareMetric admin who approved the
--    newest sequence), approved per the setting. At most one a week, never beside a request still waiting.
--
-- Nothing is sent by this migration. 20261127220100_owner_sequence_batches_contract.sql declares platform.agents.owner-sequence-batches.v1.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values
  ('growth.owner_sequence_batches', 'flag'), ('growth.owner_sequence_batch_size', 'number'), ('growth.owner_sequence_batch_approve', 'flag')
on conflict (key) do nothing;

create or replace function private.owner_sequence_batch_due() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_owner uuid; v_last date; v_number integer;
begin
  if coalesce((select (h.value #>> '{}')::boolean from private.hub_settings h where h.key = 'growth.owner_sequence_batches'), false) is not true then
    return jsonb_build_object('due', false, 'why', 'off');
  end if;
  if exists (select 1 from private.owner_sequence_requests where status in ('waiting', 'preparing')) then
    return jsonb_build_object('due', false, 'why', 'request_waiting');
  end if;
  if exists (select 1 from private.owner_sequence_requests where payload ->> 'builtBy' = 'growth.sequence_batches' and created_at > now() - interval '6 days') then
    return jsonb_build_object('due', false, 'why', 'built_this_week');
  end if;
  -- The owner: the CareMetric admin who approved the newest sequence, still a CareMetric admin.
  select s.approved_by into v_owner from private.owner_sequences s
  where s.approved_by is not null and s.approved_at is not null
    and exists (select 1 from private.staff_permissions p where p.user_id = s.approved_by and p.permission = 'platform.admin'
                and p.product_id is null and p.revoked_at is null)
  order by s.approved_at desc limit 1;
  if v_owner is null then return jsonb_build_object('due', false, 'why', 'no_owner'); end if;
  select max(s.send_dates[1]) into v_last from private.owner_sequences s;
  select coalesce(max((substring(s.name from '^Pennsylvania cold email, batch ([0-9]{1,4})$'))::integer), 0) into v_number
  from private.owner_sequences s where s.name ~ '^Pennsylvania cold email, batch [0-9]{1,4}$';
  return jsonb_build_object('due', true, 'owner', v_owner, 'lastFirstDate', v_last, 'lastNumber', v_number);
end; $$;

create or replace function private.owner_sequence_batch_candidates(p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare excluded constant text[] := array['42021', '42033', '42027', '42013', '42009', '42111', '42129', '42063'];
begin
  perform private.require_hub_app_server();
  if p_limit is null or p_limit not between 1 and 200 then raise exception 'Invalid limit' using errcode = '22023'; end if;
  return (select coalesce(jsonb_agg(c order by c.patients desc nulls last, c.name), '[]'::jsonb) from (
    select g.id, g.name, lower(g.domain) as domain,
      (select max((t.facts ->> 'patients')::numeric) from private.growth_roster_targets t
        where t.organization_id = g.id and t.facts ->> 'patients' ~ '^[0-9]+(\.[0-9]+)?$') as patients,
      (select jsonb_agg(jsonb_build_object('ccn', t.ccn, 'name', t.name, 'setting', t.setting, 'city', t.city, 'countyFips', t.county_fips,
          'patients', case when t.facts ->> 'patients' ~ '^[0-9]+(\.[0-9]+)?$' then (t.facts ->> 'patients')::numeric end)
          order by (case when t.facts ->> 'patients' ~ '^[0-9]+(\.[0-9]+)?$' then (t.facts ->> 'patients')::numeric end) desc nulls last, t.ccn)
        from private.growth_roster_targets t where t.organization_id = g.id) as targets,
      (select jsonb_agg(jsonb_build_object('name', p.name, 'title', p.title, 'source', p.source, 'email', lower(c.email)) order by p.created_at)
        from private.growth_people p join private.growth_contacts c on c.id = p.contact_id
        where p.organization_id = g.id and c.mailbox_result = 'verified' and c.eligibility <> 'opted_out'
          and split_part(lower(c.email), '@', 2) = lower(g.domain)) as people
    from private.growth_organizations g
    where g.domain is not null
      and exists (select 1 from private.growth_roster_targets t where t.organization_id = g.id and t.status = 'graduated')
      -- Every entry: Pennsylvania, proprietary, outside the owner's home area. One office (one street address).
      and not exists (select 1 from private.growth_roster_targets t where t.organization_id = g.id
        and (t.state <> 'PA' or coalesce(t.facts ->> 'control', '') <> 'Proprietary' or coalesce(t.county_fips, '') = any (excluded)))
      and (select count(distinct lower(coalesce(t.facts ->> 'address', t.zip, t.ccn))) from private.growth_roster_targets t where t.organization_id = g.id) = 1
      -- Never written to by the Marketing Manager; in no owner sequence; not stopped.
      and not exists (select 1 from private.growth_opportunities o join private.growth_messages m on m.opportunity_id = o.id
        where o.organization_id = g.id and m.attempted_at is not null)
      and not exists (select 1 from private.owner_sequence_recipients r where r.domain = lower(g.domain)
        or r.ccn in (select t.ccn from private.growth_roster_targets t where t.organization_id = g.id))
      and not private.growth_outreach_stopped(g.id)
      and exists (select 1 from private.growth_people p join private.growth_contacts c on c.id = p.contact_id
        where p.organization_id = g.id and c.mailbox_result = 'verified' and c.eligibility <> 'opted_out'
          and split_part(lower(c.email), '@', 2) = lower(g.domain))
    order by patients desc nulls last, g.name
    limit p_limit) c);
end; $$;

create or replace function private.owner_sequence_batch_plan(p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_due jsonb;
begin
  perform private.require_hub_app_server();
  v_due := private.owner_sequence_batch_due();
  if (v_due ->> 'due')::boolean is not true then return v_due; end if;
  return v_due || jsonb_build_object('candidates', private.owner_sequence_batch_candidates(p_limit));
end; $$;

create or replace function private.owner_sequence_batch_queue(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_due jsonb; v_id uuid; v_approve boolean;
begin
  perform private.require_hub_app_server();
  perform pg_advisory_xact_lock(hashtextextended('owner.sequences', 0));
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' or coalesce(jsonb_typeof(p_payload -> 'csv'), '') <> 'string' or pg_column_size(p_payload) > 90000 then
    raise exception 'Invalid batch' using errcode = '22023';
  end if;
  v_due := private.owner_sequence_batch_due();
  if (v_due ->> 'due')::boolean is not true then return jsonb_build_object('queued', false, 'why', v_due ->> 'why'); end if;
  v_approve := coalesce((select (h.value #>> '{}')::boolean from private.hub_settings h where h.key = 'growth.owner_sequence_batch_approve'), false);
  insert into private.owner_sequence_requests (requested_by, approve, payload)
  values ((v_due ->> 'owner')::uuid, v_approve, p_payload || jsonb_build_object('builtBy', 'growth.sequence_batches'))
  returning id into v_id;
  return jsonb_build_object('queued', true, 'id', v_id, 'approve', v_approve);
end; $$;

revoke all on function private.owner_sequence_batch_due(), private.owner_sequence_batch_candidates(integer)
  from public, anon, authenticated, service_role, hub_app_server;
revoke all on function private.owner_sequence_batch_plan(integer), private.owner_sequence_batch_queue(jsonb) from public, anon, authenticated, service_role;
grant execute on function private.owner_sequence_batch_plan(integer), private.owner_sequence_batch_queue(jsonb) to hub_app_server;
