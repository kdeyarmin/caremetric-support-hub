-- Search again where the people finder named nobody (review 2026-11-17).
--
-- Of 116 businesses the people finder searched, it named nobody at any of them. Two reasons, neither of which a 60-day wait fixes:
--
-- - 18 were matched to their Medicare record (a roster target) only after they were searched. CMS's owners and the NPI registry's
--   authorized official are read only for a matched business, so they were never read for these, and the finder does not look at a
--   business again for 60 days. From now on a business matched after its last search, with nobody named, is a candidate again
--   (once: its search then comes after the match).
-- - The rest are not matched to a Medicare record, so only their own websites were read. The people finder now also asks the NPI
--   registry about such an agency where its website's postal address places it (server/growth/people.mjs `placedAgencies`), so each
--   of them is searched again once, here.
--
-- private.growth_people_candidates is the same as in 20261116100000_growth_address_check.sql (same signature and grants), except for the
-- first point. Nothing here sends anything or loosens a check: a person found is recorded, and an address still waits for the owner.
set local lock_timeout = '10s';

create or replace function private.growth_people_candidates(p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 perform private.require_hub_app_server();
 if p_limit is null or p_limit < 1 or p_limit > 20 then raise exception 'Invalid page' using errcode = '22023'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'domain', x.domain, 'name', x.name, 'product', x.product,
   'ccns', x.ccns, 'agencies', x.agencies) order by x.fit desc nulls last, x.id), '[]'::jsonb) from (
  select g.id, g.domain, g.name, min(o.product) as product, max(o.fit) as fit,
    coalesce((select jsonb_agg(t.ccn order by t.ccn) from private.growth_roster_targets t where t.organization_id = g.id), '[]'::jsonb) as ccns,
    coalesce((select jsonb_agg(jsonb_build_object('ccn', t.ccn, 'name', t.name, 'city', t.city, 'state', t.state, 'zip', t.zip,
      'phone', case when t.facts ->> 'phone' ~ '^[0-9]{10}$' then t.facts ->> 'phone' end, 'setting', t.setting) order by t.ccn)
      from private.growth_roster_targets t where t.organization_id = g.id), '[]'::jsonb) as agencies
  from private.growth_organizations g join private.growth_opportunities o on o.organization_id = g.id
  where not g.internal and g.tenant_id is null and g.domain !~ '\.invalid$'
    and o.owner_agent = 'marketing_manager' and o.stage in ('researched', 'qualified')
    and (o.fit >= 60 or exists (select 1 from private.growth_roster_targets t where t.organization_id = g.id))
    and (g.people_searched_at is null or g.people_searched_at < now() - interval '60 days'
      -- Matched to its Medicare record after it was last searched, with nobody named: its CMS owners and NPI official can be read now.
      or (not exists (select 1 from private.growth_people p where p.organization_id = g.id)
          and exists (select 1 from private.growth_roster_targets t where t.organization_id = g.id and t.resolved_at > g.people_searched_at)))
    and not exists (select 1 from private.growth_contacts c where c.organization_id = g.id and c.source_kind in ('enriched', 'imported', 'inbound', 'owner')
                      and c.eligibility not in ('opted_out', 'undeliverable'))
    and not exists (select 1 from private.growth_messages m join private.growth_opportunities y on y.id = m.opportunity_id
                      where y.organization_id = g.id and m.purpose = 'marketing' and m.attempted_at is not null)
  group by g.id, g.domain, g.name
  order by max(o.fit) desc nulls last, g.id limit p_limit) x);
end; $$;

revoke all on function private.growth_people_candidates(integer) from public, anon, authenticated, service_role;
grant execute on function private.growth_people_candidates(integer) to hub_app_server;

-- Once: every business searched with nobody named and not matched to a Medicare record is searched again, now with the NPI registry
-- at its website's address. Counted in the audit trail; no name, domain or address is copied there.
with reset as (
  update private.growth_organizations g set people_searched_at = null
   where g.people_searched_at is not null and not g.internal and g.tenant_id is null
     and not exists (select 1 from private.growth_people p where p.organization_id = g.id)
     and not exists (select 1 from private.growth_roster_targets t where t.organization_id = g.id)
  returning g.id
)
insert into private.audit_events (actor_id, action, entity_type, entity_id, metadata)
select null, 'growth.people_research', 'growth', null, jsonb_build_object('organizations', count(*), 'reason', 'registry_by_website_address')
from reset having count(*) > 0;
