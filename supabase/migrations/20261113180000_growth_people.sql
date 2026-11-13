-- Named decision-makers (owner decision 2026-11-13: "named people and paid data"), and lists the owner imports.
--
-- Until now the Marketing Manager wrote only to a business's generic address (info@, admissions@), by the owner's decision of
-- 2026-11-04. The owner has now chosen to reach the people who decide: an agency's owner, administrator or business development
-- lead. So:
--
-- - private.growth_people: the people the team knows at a business, from public records (the CMS All Owners file through Intel's
--   feed), from a contact-data service (Apollo), from the owner or from an imported list. A person has no address until one is
--   found; most never need one.
-- - A work address the contact-data service verified, on the business's own domain, becomes a contact with source "enriched" and
--   eligibility "review": nothing is sent to it until the owner permits it on the Growth screen. Never a personal address, never one
--   guessed from a pattern, never one that unsubscribed. Permitting it makes it the opportunity's contact when the business has not
--   been emailed yet (the claim keeps one cold contact per business).
-- - The daily credit cap (Settings -> Customer growth -> "Most contact lookups a day", 10 until the owner saves a number) is reserved
--   in the database before each paid lookup, so two servers can never spend past it.
-- - hub.growth_import: the owner's list (a CSV on the Growth screen, or the signed import endpoint for lists built elsewhere) joins the
--   same path: organizations by domain, contacts as "imported" and "review", suppressed addresses refused.
-- - Every found address (role, enriched, imported) is cold email under the owner's cold-email cap (20261113170000).
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values
  ('growth.enrichment_provider', 'text'),
  ('growth.enrichment_daily_credits', 'number')
on conflict (key) do nothing;

alter table private.growth_organizations add column if not exists people_searched_at timestamptz;

create table private.growth_people (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references private.growth_organizations(id),
  name text not null check (char_length(name) between 1 and 200 and name !~ '[[:cntrl:]@]'),
  title text not null default '' check (char_length(title) <= 200 and title !~ '[[:cntrl:]]'),
  source text not null check (source in ('cms_owners', 'apollo', 'owner', 'import')),
  source_url text check (source_url ~ '^https://' and char_length(source_url) <= 2000),
  provider_ref text check (provider_ref ~ '^[A-Za-z0-9_-]{1,100}$'),
  contact_id uuid references private.growth_contacts(id),
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (organization_id, source, name)
);
create index growth_people_org on private.growth_people (organization_id);

create table private.growth_enrichment_days (
  day date primary key,
  used integer not null default 0 check (used >= 0)
);

alter table private.growth_people enable row level security;
alter table private.growth_enrichment_days enable row level security;
revoke all on private.growth_people, private.growth_enrichment_days from public, anon, authenticated, service_role, hub_app_server;

-- The owner's daily credit cap: the saved whole number, held to 0..500, or ten.
create function private.growth_enrichment_cap() returns integer
language sql stable set search_path = '' as $$
  select coalesce((select case when jsonb_typeof(s.value) = 'number' and (s.value #>> '{}') ~ '^[0-9]{1,9}$'
    then least((s.value #>> '{}')::integer, 500) end from private.hub_settings s where s.key = 'growth.enrichment_daily_credits'), 10);
$$;
revoke all on function private.growth_enrichment_cap() from public, anon, authenticated, service_role, hub_app_server;

-- Server: reserves p_credits of today's (Eastern) contact lookups; false when the owner's cap would be passed.
create function private.growth_enrichment_reserve(p_credits integer) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_day date := (now() at time zone 'America/New_York')::date; v_used integer; begin
 perform private.require_hub_app_server();
 if p_credits is null or p_credits < 1 or p_credits > 10 then raise exception 'Invalid credits' using errcode = '22023'; end if;
 insert into private.growth_enrichment_days(day, used) values (v_day, 0) on conflict (day) do nothing;
 update private.growth_enrichment_days set used = used + p_credits where day = v_day and used + p_credits <= private.growth_enrichment_cap()
  returning used into v_used;
 return v_used is not null;
end; $$;

-- Server: businesses worth finding a decision-maker at. A prospect researched or qualified, on its own domain, whose fit is 60 or
-- more or whose CMS record is known, with no named contact yet, not searched for 60 days, and not yet cold-emailed (its first
-- touch would fix its one cold contact).
create function private.growth_people_candidates(p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 perform private.require_hub_app_server();
 if p_limit is null or p_limit < 1 or p_limit > 20 then raise exception 'Invalid page' using errcode = '22023'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'domain', x.domain, 'name', x.name, 'product', x.product,
   'ccns', x.ccns) order by x.fit desc nulls last, x.id), '[]'::jsonb) from (
  select g.id, g.domain, g.name, min(o.product) as product, max(o.fit) as fit,
    coalesce((select jsonb_agg(t.ccn order by t.ccn) from private.growth_roster_targets t where t.organization_id = g.id), '[]'::jsonb) as ccns
  from private.growth_organizations g join private.growth_opportunities o on o.organization_id = g.id
  where not g.internal and g.tenant_id is null and g.domain !~ '\.invalid$'
    and o.owner_agent = 'marketing_manager' and o.stage in ('researched', 'qualified')
    and (o.fit >= 60 or exists (select 1 from private.growth_roster_targets t where t.organization_id = g.id))
    and (g.people_searched_at is null or g.people_searched_at < now() - interval '60 days')
    and not exists (select 1 from private.growth_contacts c where c.organization_id = g.id and c.source_kind in ('enriched', 'imported', 'inbound', 'owner')
                      and c.eligibility <> 'opted_out')
    and not exists (select 1 from private.growth_messages m join private.growth_opportunities y on y.id = m.opportunity_id
                      where y.organization_id = g.id and m.purpose = 'marketing' and m.attempted_at is not null)
  group by g.id, g.domain, g.name
  order by max(o.fit) desc nulls last, g.id limit p_limit) x);
end; $$;

-- Server: the people found at one business (at most 20), and that it was searched now. Returns each one's id.
create function private.growth_people_record(p_org uuid, p_people jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jsonb; v_id uuid; v_out jsonb := '[]'::jsonb; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
 if not exists (select 1 from private.growth_organizations where id = p_org) or jsonb_typeof(p_people) <> 'array' or jsonb_array_length(p_people) > 20 then
  raise exception 'Invalid people' using errcode = '22023';
 end if;
 update private.growth_organizations set people_searched_at = now() where id = p_org;
 for r in select value from jsonb_array_elements(p_people) loop
  insert into private.growth_people(organization_id, name, title, source, source_url, provider_ref)
  values (p_org, left(btrim(r ->> 'name'), 200), left(coalesce(r ->> 'title', ''), 200), r ->> 'source', nullif(r ->> 'sourceUrl', ''), nullif(r ->> 'providerRef', ''))
  on conflict (organization_id, source, name) do update set title = excluded.title, observed_at = now(),
    source_url = coalesce(excluded.source_url, private.growth_people.source_url), provider_ref = coalesce(excluded.provider_ref, private.growth_people.provider_ref)
  returning id into v_id;
  v_out := v_out || jsonb_build_array(jsonb_build_object('id', v_id, 'source', r ->> 'source', 'providerRef', nullif(r ->> 'providerRef', '')));
 end loop;
 return v_out;
end; $$;

-- Server: a work address the contact-data service verified for one person: on the business's own domain, never suppressed or taken.
create function private.growth_enriched_contact(p_person uuid, p_email text, p_name text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p private.growth_people%rowtype; g private.growth_organizations%rowtype; v_email text := lower(btrim(p_email)); v_contact uuid; v_host text; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
 select * into p from private.growth_people where id = p_person for update;
 if not found then raise exception 'Unknown person' using errcode = '22023'; end if;
 select * into g from private.growth_organizations where id = p.organization_id;
 v_host := split_part(coalesce(v_email, ''), '@', 2);
 if v_email !~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$' or char_length(v_email) > 320 or (v_host <> g.domain and v_host not like '%.' || g.domain) then
  raise exception 'A found address must be a work address on the business''s own domain' using errcode = '22023';
 end if;
 if exists (select 1 from private.email_suppressions where email_hash = encode(extensions.digest(v_email, 'sha256'), 'hex')) then
  return jsonb_build_object('found', false, 'reason', 'suppressed');
 end if;
 if exists (select 1 from private.growth_contacts where email = v_email) then return jsonb_build_object('found', false, 'reason', 'taken'); end if;
 insert into private.growth_contacts(organization_id, email, name, role, eligibility, verified_at, source_url, source_kind)
 values (g.id, v_email, left(coalesce(nullif(btrim(p_name), ''), p.name), 200), p.title, 'review', now(), p.source_url, 'enriched')
 returning id into v_contact;
 update private.growth_people set contact_id = v_contact, name = left(coalesce(nullif(btrim(p_name), ''), name), 200), observed_at = now() where id = p.id;
 insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
 values (null, 'growth.person_found', 'growth', g.id, jsonb_build_object('contact', v_contact, 'source', p.source));
 return jsonb_build_object('found', true, 'contactId', v_contact);
end; $$;

-- Owner: found and imported people waiting for a decision, with their business.
create function hub.growth_people(p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 perform hub.authorize_app_admin();
 if p_offset is null or p_offset < 0 or p_offset > 100000 then raise exception 'Invalid page' using errcode = '22023'; end if;
 return jsonb_build_object(
  'waiting', (select count(*) from private.growth_contacts where source_kind in ('enriched', 'imported') and eligibility = 'review'),
  'creditsToday', coalesce((select used from private.growth_enrichment_days where day = (now() at time zone 'America/New_York')::date), 0),
  'creditCap', private.growth_enrichment_cap(),
  'items', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'role', c.role, 'email', c.email, 'source', c.source_kind,
      'organization', g.name, 'domain', g.domain, 'foundAt', c.verified_at) order by c.created_at), '[]'::jsonb)
    from (select * from private.growth_contacts where source_kind in ('enriched', 'imported') and eligibility = 'review' order by created_at offset p_offset limit 50) c
    join private.growth_organizations g on g.id = c.organization_id));
end; $$;

-- Owner: permit or refuse found people. A permitted one becomes the opportunity's contact where the business was never emailed.
create function hub.growth_people_decide(p_ids uuid[], p_decision text) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid; v_n integer := 0; c private.growth_contacts%rowtype; begin
 v_actor := (hub.authorize_app_command() ->> 'user_id')::uuid;
 perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
 if p_decision not in ('permit', 'refuse') or p_ids is null or cardinality(p_ids) > 200 then raise exception 'Invalid decision' using errcode = '22023'; end if;
 for c in select * from private.growth_contacts where id = any(p_ids) and source_kind in ('enriched', 'imported') and eligibility = 'review' for update loop
  update private.growth_contacts set eligibility = case when p_decision = 'permit' then 'permitted' else 'opted_out' end,
    verified_at = coalesce(verified_at, now()), version = version + 1 where id = c.id;
  if p_decision = 'permit' then
   update private.growth_opportunities o set contact_id = c.id, version = o.version + 1, updated_at = now()
    where o.organization_id = c.organization_id and o.owner_agent = 'marketing_manager'
      and not exists (select 1 from private.growth_messages m where m.opportunity_id = o.id and m.purpose = 'marketing' and m.attempted_at is not null);
   update private.growth_messages set status = 'cancelled' where status in ('draft', 'proposed') and purpose = 'marketing'
     and opportunity_id in (select id from private.growth_opportunities where organization_id = c.organization_id and contact_id = c.id)
     and contact_id <> c.id;
  end if;
  insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
  values (v_actor, 'growth.person_' || case when p_decision = 'permit' then 'permitted' else 'refused' end, 'growth', c.organization_id, jsonb_build_object('contact', c.id));
  v_n := v_n + 1;
 end loop;
 return v_n;
end; $$;

-- One list of prospects: organizations by domain, an opportunity for the product, and a contact (imported, review) when an address on
-- the business's own domain is given. At most 500 rows; suppressed addresses and addresses elsewhere are skipped and counted.
create function private.growth_import_rows(p_rows jsonb, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jsonb; v_domain text; v_email text; v_org uuid; v_added integer := 0; v_contacts integer := 0; v_skipped integer := 0; v_product text; begin
 perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
 if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then raise exception 'Invalid list' using errcode = '22023'; end if;
 for r in select value from jsonb_array_elements(p_rows) loop
  v_domain := lower(regexp_replace(btrim(coalesce(r ->> 'domain', '')), '^(https?://)?(www\.)?([^/]+).*$', '\3'));
  v_email := lower(btrim(coalesce(r ->> 'email', '')));
  v_product := coalesce(nullif(r ->> 'product', ''), 'caremetric-intel');
  if v_domain !~ '^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$' or char_length(v_domain) > 253 or private.growth_free_mail(v_domain)
    or v_product not in ('carebase', 'caremetric-intel') or char_length(coalesce(r ->> 'name', '')) not between 1 and 200 then
   v_skipped := v_skipped + 1; continue;
  end if;
  insert into private.growth_organizations(name, domain, discovered_at) values (left(btrim(r ->> 'name'), 200), v_domain, now()) on conflict (domain) do nothing;
  select id into v_org from private.growth_organizations where domain = v_domain;
  if exists (select 1 from private.growth_organizations where id = v_org and (internal or tenant_id is not null)) then v_skipped := v_skipped + 1; continue; end if;
  update private.growth_organizations set discovered_at = coalesce(discovered_at, now()) where id = v_org;
  insert into private.growth_opportunities(organization_id, product) values (v_org, v_product) on conflict do nothing;
  if found then v_added := v_added + 1; end if;
  if v_email <> '' then
   if v_email ~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$' and (split_part(v_email, '@', 2) = v_domain or split_part(v_email, '@', 2) like '%.' || v_domain)
     and not exists (select 1 from private.email_suppressions where email_hash = encode(extensions.digest(v_email, 'sha256'), 'hex'))
     and not exists (select 1 from private.growth_contacts where email = v_email) then
    insert into private.growth_contacts(organization_id, email, name, role, eligibility, verified_at, source_kind)
    values (v_org, v_email, left(coalesce(r ->> 'contactName', ''), 200), left(coalesce(r ->> 'role', ''), 200), 'review', now(), 'imported');
    if nullif(btrim(coalesce(r ->> 'contactName', '')), '') is not null then
     insert into private.growth_people(organization_id, name, title, source, contact_id)
     values (v_org, left(btrim(r ->> 'contactName'), 200), left(coalesce(r ->> 'role', ''), 200), 'import', (select id from private.growth_contacts where email = v_email))
     on conflict (organization_id, source, name) do nothing;
    end if;
    v_contacts := v_contacts + 1;
   else
    v_skipped := v_skipped + 1;
   end if;
  end if;
 end loop;
 insert into private.audit_events(actor_id, action, entity_type, metadata)
 values (p_actor, 'growth.list_imported', 'growth', jsonb_build_object('rows', jsonb_array_length(p_rows), 'organizations', v_added, 'contacts', v_contacts, 'skipped', v_skipped));
 return jsonb_build_object('rows', jsonb_array_length(p_rows), 'organizations', v_added, 'contacts', v_contacts, 'skipped', v_skipped);
end; $$;
revoke all on function private.growth_import_rows(jsonb, uuid) from public, anon, authenticated, service_role, hub_app_server;

-- Owner (a CSV on the Growth screen) and server (the signed import endpoint, server/growth/service.mjs).
create function hub.growth_import(p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$ begin
 return private.growth_import_rows(p_rows, (hub.authorize_app_command() ->> 'user_id')::uuid);
end; $$;
create function private.growth_import_server(p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$ begin
 perform private.require_hub_app_server();
 return private.growth_import_rows(p_rows, null);
end; $$;

revoke all on function private.growth_enrichment_reserve(integer), private.growth_people_candidates(integer), private.growth_people_record(uuid, jsonb),
  private.growth_enriched_contact(uuid, text, text), private.growth_import_server(jsonb) from public, anon, authenticated, service_role;
grant execute on function private.growth_enrichment_reserve(integer), private.growth_people_candidates(integer), private.growth_people_record(uuid, jsonb),
  private.growth_enriched_contact(uuid, text, text), private.growth_import_server(jsonb) to hub_app_server;
revoke all on function hub.growth_people(integer), hub.growth_people_decide(uuid[], text), hub.growth_import(jsonb) from public, anon, service_role;
grant execute on function hub.growth_people(integer), hub.growth_people_decide(uuid[], text), hub.growth_import(jsonb) to authenticated;

-- Every half hour the Marketing Manager looks for the decision-makers at its best prospects (server/growth/people.mjs).
insert into private.agent_schedules (agent_key, task_kind, cadence, every_seconds, at_local, timezone, requires_session, next_run_at)
values ('marketing_manager', 'growth.people', 'interval', 1800, null, 'America/New_York', false, now())
on conflict (agent_key, task_kind) do nothing;
