-- Hunter finds the owners' work addresses for the owner's next batches (owner, 2026-11-27: "yes build the hunter connection").
--
-- Why. The weekly batch (20261127220000_owner_sequence_batches.sql) needs an owner or administrator with a confirmed address, and the
-- Marketing Manager's people step confirms almost none: most agencies' mail servers refuse the Hub's cloud server (2026-11-24: 15 checks,
-- none confirmed) and no verification service is in use. Built by hand, batch 2 found 8 of 10 owners with Hunter's Email Finder, which
-- looks a person up by name and domain and checks the address itself.
--
-- 1. private.growth_hunter_next(p_limit): while Settings → Customer growth → "Find owners' addresses with Hunter" is on, the agencies the
--    weekly batch would take but for an address (the same tests: Pennsylvania roster, proprietary, one office, outside the owner's home
--    area, a domain of its own, never written to, not stopped, in no sequence), not asked about in 180 days, with the people the people
--    step named. Most Medicare patients first.
-- 2. private.growth_hunter_begin(p_org, p_person) reserves one lookup under "Most Hunter lookups a day" (Hunter charges a credit only when
--    it finds an address); private.growth_hunter_finish records what it answered.
-- 3. private.growth_person_address takes an address Hunter found ('hunter'): recorded as confirmed, and never permitted for the Marketing
--    Manager's own cold email on its own, so the agency stays for the owner's batch.
--
-- Nothing is sent by this migration. 20261127230100_growth_hunter_contract.sql declares platform.agents.growth-hunter.v1.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values ('growth.hunter', 'flag'), ('growth.hunter_daily', 'number') on conflict (key) do nothing;

create table if not exists private.growth_hunter_lookups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references private.growth_organizations(id) on delete cascade,
  person_id uuid references private.growth_people(id) on delete set null,
  day date not null,
  result text not null default 'pending' check (result in ('pending', 'found', 'not_found', 'refused', 'error')),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists growth_hunter_lookups_org_idx on private.growth_hunter_lookups (organization_id, created_at desc);
create index if not exists growth_hunter_lookups_day_idx on private.growth_hunter_lookups (day);
alter table private.growth_hunter_lookups enable row level security;
revoke all on private.growth_hunter_lookups from public, anon, authenticated, service_role, hub_app_server;

-- An address Hunter found, beside the others.
do $$
declare c record;
begin
  for c in select con.conname from pg_constraint con join pg_attribute a on a.attrelid = con.conrelid and a.attnum = any(con.conkey)
    where con.conrelid = 'private.growth_people'::regclass and con.contype = 'c' and a.attname = 'address_found'
      and position('''hunter''' in pg_get_constraintdef(con.oid)) = 0 loop
    execute format('alter table private.growth_people drop constraint %I', c.conname);
  end loop;
  if not exists (select 1 from pg_constraint where conrelid = 'private.growth_people'::regclass and conname = 'growth_people_address_found_check') then
    alter table private.growth_people add constraint growth_people_address_found_check
      check (address_found in ('published', 'mail_server', 'apollo', 'service', 'hunter'));
  end if;
end $$;

do $$
declare d text := pg_get_functiondef('private.growth_person_address(uuid,text,text,text,text)'::regprocedure);
begin
  if position('''hunter''' in d) > 0 then return; end if;
  if position($q$ if p_found is null or p_found not in ('published', 'mail_server', 'service')$q$ in d) = 0
    or position($q$ or (p_found in ('mail_server', 'service') and p_source_url is not null) then$q$ in d) = 0
    or position($q$ if p_found in ('mail_server', 'service') then$q$ in d) = 0
    or position($q$ v_auto := found and v_agent.status = 'active'$q$ in d) = 0 then
    raise exception 'The people finder''s address function changed; update this migration' using errcode = '55000';
  end if;
  d := replace(d, $q$ if p_found is null or p_found not in ('published', 'mail_server', 'service')$q$,
    $q$ if p_found is null or p_found not in ('published', 'mail_server', 'service', 'hunter')$q$);
  d := replace(d, $q$ or (p_found in ('mail_server', 'service') and p_source_url is not null) then$q$,
    $q$ or (p_found in ('mail_server', 'service', 'hunter') and p_source_url is not null) then$q$);
  d := replace(d, $q$ if p_found in ('mail_server', 'service') then$q$, $q$ if p_found in ('mail_server', 'service', 'hunter') then$q$);
  -- Found for the owner's batches: never permitted for the Marketing Manager's own cold email on its own.
  d := replace(d, $q$ v_auto := found and v_agent.status = 'active'$q$, $q$ v_auto := found and p_found <> 'hunter' and v_agent.status = 'active'$q$);
  execute d;
end $$;

create or replace function private.growth_hunter_cap() returns integer
language sql stable set search_path = '' as $$
  select coalesce((select case when jsonb_typeof(s.value) = 'number' and (s.value #>> '{}') ~ '^[0-9]{1,9}$'
    then least((s.value #>> '{}')::integer, 100) end from private.hub_settings s where s.key = 'growth.hunter_daily'), 5);
$$;
revoke all on function private.growth_hunter_cap() from public, anon, authenticated, service_role, hub_app_server;

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
        from private.growth_people p where p.organization_id = g.id) as people
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

create or replace function private.growth_hunter_begin(p_org uuid, p_person uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_day date := (now() at time zone 'America/New_York')::date; v_id uuid;
begin
  perform private.require_hub_app_server();
  perform pg_advisory_xact_lock(hashtextextended('growth.hunter', 0));
  if not coalesce((select s.value = 'true'::jsonb from private.hub_settings s where s.key = 'growth.hunter'), false) then return null; end if;
  if not exists (select 1 from private.growth_people p where p.id = p_person and p.organization_id = p_org) then
    raise exception 'Unknown person' using errcode = '22023';
  end if;
  if exists (select 1 from private.growth_hunter_lookups l where l.organization_id = p_org and l.created_at > now() - interval '180 days') then return null; end if;
  if (select count(*) from private.growth_hunter_lookups l where l.day = v_day) >= private.growth_hunter_cap() then return null; end if;
  insert into private.growth_hunter_lookups (organization_id, person_id, day) values (p_org, p_person, v_day) returning id into v_id;
  return v_id;
end; $$;

create or replace function private.growth_hunter_finish(p_id uuid, p_result text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  if p_result is null or p_result not in ('found', 'not_found', 'refused', 'error') then raise exception 'Invalid result' using errcode = '22023'; end if;
  update private.growth_hunter_lookups set result = p_result, finished_at = now() where id = p_id and result = 'pending';
  return found;
end; $$;

revoke all on function private.growth_hunter_next(integer), private.growth_hunter_begin(uuid, uuid), private.growth_hunter_finish(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function private.growth_hunter_next(integer), private.growth_hunter_begin(uuid, uuid), private.growth_hunter_finish(uuid, text) to hub_app_server;
