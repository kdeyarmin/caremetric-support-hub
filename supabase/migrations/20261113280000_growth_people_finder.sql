-- The Hub finds decision-makers and their addresses itself (owner decision 2026-11-13: do in the Hub what Apollo did, guessing and
-- checking addresses with the business's own mail server included; Apollo is removed). server/growth/people.mjs reads three free
-- sources and, as far as the owner allows (Settings -> Customer growth -> "Finding people's addresses"), finds the chosen person's
-- work address: one the business's own pages publish, or one of the usual shapes of the person's name that the business's mail
-- server confirms (server/growth/mailbox.mjs). Every address still waits for the owner's review, exactly as before.
--
-- 1. private.growth_people.source also admits 'website' (a person the business's own pages name with a title that decides) and
--    'npi_registry' (the authorized official on the agency's NPI record). 'apollo' stays for people recorded before.
-- 2. private.growth_people.address_found says how a person's address was found: 'published' (the business's own page publishes it;
--    the contact's source_url is that page), 'mail_server' (confirmed by the business's mail server; no page) or 'apollo' (before).
-- 3. private.growth_people_candidates (same signature and grants) also returns each candidate's roster agencies (name, city, state,
--    ZIP, CMS telephone number, setting), which the NPI registry search needs. The number only matches the registry's record; it is
--    never stored with a person.
-- 4. private.growth_person_address: private.growth_enriched_contact with how the address was found and, for a published one, the
--    page on the business's own site that publishes it. The same rules: an address on the business's own domain, never one that
--    unsubscribed or that another contact has, recorded for the owner's review ('review').
-- 5. hub.growth_people (same signature and grants) shows how each waiting address was found and the page that publishes it.
-- 6. The owner's saved choice "Apollo" becomes "Also guess and check addresses with the business's mail server" ('verify'), the
--    built-in choice that does what Apollo did. The daily number ("Most address checks a day") is unchanged.
set local lock_timeout = '10s';

alter table private.growth_people drop constraint if exists growth_people_source_check;
alter table private.growth_people add constraint growth_people_source_check
  check (source in ('cms_owners', 'npi_registry', 'website', 'owner', 'import', 'apollo'));
alter table private.growth_people add column if not exists address_found text check (address_found in ('published', 'mail_server', 'apollo'));
update private.growth_people set address_found = 'apollo' where source = 'apollo' and contact_id is not null and address_found is null;

update private.hub_settings set value = '"verify"'::jsonb, changed_at = now()
 where key = 'growth.enrichment_provider' and value = '"apollo"'::jsonb;

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
    and (g.people_searched_at is null or g.people_searched_at < now() - interval '60 days')
    and not exists (select 1 from private.growth_contacts c where c.organization_id = g.id and c.source_kind in ('enriched', 'imported', 'inbound', 'owner')
                      and c.eligibility <> 'opted_out')
    and not exists (select 1 from private.growth_messages m join private.growth_opportunities y on y.id = m.opportunity_id
                      where y.organization_id = g.id and m.purpose = 'marketing' and m.attempted_at is not null)
  group by g.id, g.domain, g.name
  order by max(o.fit) desc nulls last, g.id limit p_limit) x);
end; $$;

-- Server: the work address found for one person, and how: 'published' with the page on the business's own site that publishes it,
-- or 'mail_server' (no page). On the business's own domain, never suppressed or taken; it waits for the owner ('review').
create function private.growth_person_address(p_person uuid, p_email text, p_name text, p_found text, p_source_url text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p private.growth_people%rowtype; g private.growth_organizations%rowtype; v_email text := lower(btrim(p_email)); v_contact uuid; v_host text; v_page text; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
 select * into p from private.growth_people where id = p_person for update;
 if not found then raise exception 'Unknown person' using errcode = '22023'; end if;
 select * into g from private.growth_organizations where id = p.organization_id;
 v_host := split_part(coalesce(v_email, ''), '@', 2);
 if v_email !~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$' or char_length(v_email) > 320 or (v_host <> g.domain and v_host not like '%.' || g.domain) then
  raise exception 'A found address must be a work address on the business''s own domain' using errcode = '22023';
 end if;
 v_page := lower(split_part(split_part(coalesce(p_source_url, ''), '://', 2), '/', 1));
 if p_found is null or p_found not in ('published', 'mail_server')
   or (p_found = 'published' and (p_source_url is null or p_source_url !~ '^https://' or char_length(p_source_url) > 2000 or v_page not in (g.domain, 'www.' || g.domain)))
   or (p_found = 'mail_server' and p_source_url is not null) then
  raise exception 'A published address needs its page on the business''s own site; a confirmed one has none' using errcode = '22023';
 end if;
 if exists (select 1 from private.email_suppressions where email_hash = encode(extensions.digest(v_email, 'sha256'), 'hex')) then
  return jsonb_build_object('found', false, 'reason', 'suppressed');
 end if;
 if exists (select 1 from private.growth_contacts where email = v_email) then return jsonb_build_object('found', false, 'reason', 'taken'); end if;
 insert into private.growth_contacts(organization_id, email, name, role, eligibility, verified_at, source_url, source_kind)
 values (g.id, v_email, left(coalesce(nullif(btrim(p_name), ''), p.name), 200), p.title, 'review', now(), p_source_url, 'enriched')
 returning id into v_contact;
 update private.growth_people set contact_id = v_contact, address_found = p_found, name = left(coalesce(nullif(btrim(p_name), ''), name), 200), observed_at = now()
  where id = p.id;
 insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
 values (null, 'growth.person_found', 'growth', g.id, jsonb_build_object('contact', v_contact, 'source', p.source, 'found', p_found));
 return jsonb_build_object('found', true, 'contactId', v_contact);
end; $$;
revoke all on function private.growth_person_address(uuid, text, text, text, text) from public, anon, authenticated, service_role;
grant execute on function private.growth_person_address(uuid, text, text, text, text) to hub_app_server;

-- Owner: found and imported people waiting for a decision, with their business, how the address was found and the page that publishes it.
create or replace function hub.growth_people(p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 perform hub.authorize_app_admin();
 if p_offset is null or p_offset < 0 or p_offset > 100000 then raise exception 'Invalid page' using errcode = '22023'; end if;
 return jsonb_build_object(
  'waiting', (select count(*) from private.growth_contacts where source_kind in ('enriched', 'imported') and eligibility = 'review'),
  'creditsToday', coalesce((select used from private.growth_enrichment_days where day = (now() at time zone 'America/New_York')::date), 0),
  'creditCap', private.growth_enrichment_cap(),
  'items', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'role', c.role, 'email', c.email, 'source', c.source_kind,
      'found', (select p.address_found from private.growth_people p where p.contact_id = c.id order by p.observed_at desc limit 1),
      'sourceUrl', case when c.source_kind = 'enriched' then c.source_url end,
      'organization', g.name, 'domain', g.domain, 'foundAt', c.verified_at) order by c.created_at), '[]'::jsonb)
    from (select * from private.growth_contacts where source_kind in ('enriched', 'imported') and eligibility = 'review' order by created_at offset p_offset limit 50) c
    join private.growth_organizations g on g.id = c.organization_id));
end; $$;
