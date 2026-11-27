-- No agency is off limits; smaller organizations first (owner, 2026-11-27: "I don't think any agencies should be off limits. Maybe focus on
-- smaller organizations, but all could use my app").
--
-- The weekly batch (20261127220000) and Hunter's owner lookups (20261127230000, 20261127233000) took only agencies whose every roster entry
-- was proprietary and that had one office, as batch 1's handoff asked. Both now take any Pennsylvania roster agency, whoever owns it and
-- however many offices it has, smallest first (fewer offices, then fewer Medicare patients). Still left out: the owner's home area (Cambria
-- County and the seven counties bordering it, his own competitor rule), an agency that opted out or is on the do-not-contact list
-- (growth_outreach_stopped), one the Marketing Manager already wrote to, and one already in a sequence. The server no longer leaves out an
-- agency for its CMS owners either (server/growth/sequence-batches.mjs, hunter.mjs).
--
-- Nothing is sent by this migration. 20261127240100_owner_sequence_open_contract.sql declares platform.agents.owner-sequence-open.v1.
set local lock_timeout = '10s';

create or replace function private.owner_sequence_batch_candidates(p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare excluded constant text[] := array['42021', '42033', '42027', '42013', '42009', '42111', '42129', '42063'];
begin
  perform private.require_hub_app_server();
  if p_limit is null or p_limit not between 1 and 200 then raise exception 'Invalid limit' using errcode = '22023'; end if;
  return (select coalesce(jsonb_agg(c order by c.offices, c.patients nulls first, c.name), '[]'::jsonb) from (
    select g.id, g.name, lower(g.domain) as domain,
      -- Smaller organizations first: fewer offices (street addresses), then fewer Medicare patients.
      (select count(distinct lower(coalesce(t.facts ->> 'address', t.zip, t.ccn))) from private.growth_roster_targets t where t.organization_id = g.id) as offices,
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
      -- Every entry in Pennsylvania and outside the owner's home area. Any owner, any size (owner, 2026-11-27: "I don't think any agencies
      -- should be off limits").
      and not exists (select 1 from private.growth_roster_targets t where t.organization_id = g.id
        and (t.state <> 'PA' or coalesce(t.county_fips, '') = any (excluded)))
      -- Never written to by the Marketing Manager; in no owner sequence; not stopped.
      and not exists (select 1 from private.growth_opportunities o join private.growth_messages m on m.opportunity_id = o.id
        where o.organization_id = g.id and m.attempted_at is not null)
      and not exists (select 1 from private.owner_sequence_recipients r where r.domain = lower(g.domain)
        or r.ccn in (select t.ccn from private.growth_roster_targets t where t.organization_id = g.id))
      and not private.growth_outreach_stopped(g.id)
      and exists (select 1 from private.growth_people p join private.growth_contacts c on c.id = p.contact_id
        where p.organization_id = g.id and c.mailbox_result = 'verified' and c.eligibility <> 'opted_out'
          and split_part(lower(c.email), '@', 2) = lower(g.domain))
    order by offices, patients nulls first, g.name
    limit p_limit) c);
end; $$;

create or replace function private.growth_hunter_next(p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare excluded constant text[] := array['42021', '42033', '42027', '42013', '42009', '42111', '42129', '42063'];
begin
  perform private.require_hub_app_server();
  if p_limit is null or p_limit not between 1 and 25 then raise exception 'Invalid limit' using errcode = '22023'; end if;
  if not coalesce((select s.value = 'true'::jsonb from private.hub_settings s where s.key = 'growth.hunter'), false) then return '[]'::jsonb; end if;
  return (select coalesce(jsonb_agg(c order by c.offices, c.patients nulls first, c.name), '[]'::jsonb) from (
    select g.id, g.name, lower(g.domain) as domain,
      -- Smaller organizations first: fewer offices (street addresses), then fewer Medicare patients.
      (select count(distinct lower(coalesce(t.facts ->> 'address', t.zip, t.ccn))) from private.growth_roster_targets t where t.organization_id = g.id) as offices,
      (select max((t.facts ->> 'patients')::numeric) from private.growth_roster_targets t
        where t.organization_id = g.id and t.facts ->> 'patients' ~ '^[0-9]+(\.[0-9]+)?$') as patients,
      (select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'title', p.title, 'source', p.source) order by p.created_at)
        from private.growth_people p where p.organization_id = g.id) as people,
      -- The roster's CCNs, so the server reads the agency's CMS owners before a lookup is spent (20261127233000).
      (select jsonb_agg(t.ccn order by t.ccn) from private.growth_roster_targets t where t.organization_id = g.id) as ccns
    from private.growth_organizations g
    where g.domain is not null
      and exists (select 1 from private.growth_roster_targets t where t.organization_id = g.id and t.status = 'graduated')
      -- Every entry in Pennsylvania and outside the owner's home area. Any owner, any size (owner, 2026-11-27: "I don't think any agencies
      -- should be off limits").
      and not exists (select 1 from private.growth_roster_targets t where t.organization_id = g.id
        and (t.state <> 'PA' or coalesce(t.county_fips, '') = any (excluded)))
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
    order by offices, patients nulls first, g.name
    limit p_limit) c);
end; $$;

revoke all on function private.owner_sequence_batch_candidates(integer) from public, anon, authenticated, service_role, hub_app_server;
revoke all on function private.growth_hunter_next(integer) from public, anon, authenticated, service_role;
grant execute on function private.growth_hunter_next(integer) to hub_app_server;
