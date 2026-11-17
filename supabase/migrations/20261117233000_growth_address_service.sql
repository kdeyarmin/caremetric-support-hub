-- A verification service for addresses a business's mail server will not answer for (owner decision 2026-11-17).
--
-- The Hub's own address check asks the business's mail server from the Hub's cloud server, and most mail servers refuse that or give
-- no clear answer: on 2026-11-16 it confirmed 2 of 27 addresses, and every reason recorded since was a policy refusal. When the owner
-- switches it on, the Hub server asks ZeroBounce instead, only after the mail server gave no clear answer (server/growth/
-- address-service.mjs). This migration:
--
-- 1. Settings -> Customer growth: "Ask a verification service when a mail server won't answer" (growth.address_service, off) and "Most
--    verification service checks a day" (growth.address_service_daily, 50 until saved, 0 to 1000).
-- 2. private.growth_address_service_days and private.growth_address_service_reserve(checks): each check is reserved before it is made,
--    within the owner's daily number (Eastern day), and none while the switch is off. Hub server only.
-- 3. An address the service confirmed is recorded as found by the service (growth_people.address_found 'service'), with no page, and
--    as its address check's answer, exactly as one the business's mail server confirmed: private.growth_person_address is the same as
--    in 20261117180000_work_recovery.sql except that it also takes 'service'. The owner's hand-over of named people's addresses permits
--    it as it permits a mail server's confirmation.
--
-- Nothing is sent by this migration. 20261117233100_growth_address_service_contract.sql declares
-- platform.agents.growth-address-service.v1, and the server asks the service only once it is declared.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values ('growth.address_service', 'flag'), ('growth.address_service_daily', 'number')
on conflict (key) do nothing;

create table if not exists private.growth_address_service_days (
  day date primary key,
  used integer not null default 0 check (used >= 0)
);
alter table private.growth_address_service_days enable row level security;
revoke all on private.growth_address_service_days from public, anon, authenticated, service_role, hub_app_server;

-- The owner's daily number of service checks: the saved whole number, held to 0..1000, or 50.
create or replace function private.growth_address_service_cap() returns integer
language sql stable set search_path = '' as $$
  select coalesce((select case when jsonb_typeof(s.value) = 'number' and (s.value #>> '{}') ~ '^[0-9]{1,9}$'
    then least((s.value #>> '{}')::integer, 1000) end from private.hub_settings s where s.key = 'growth.address_service_daily'), 50);
$$;
revoke all on function private.growth_address_service_cap() from public, anon, authenticated, service_role, hub_app_server;

-- Server: reserves p_checks of today's (Eastern) service checks. False while the owner's switch (growth.address_service) is off, or
-- when the day's number would be passed.
create or replace function private.growth_address_service_reserve(p_checks integer) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_day date := (now() at time zone 'America/New_York')::date; v_used integer; begin
 perform private.require_hub_app_server();
 if p_checks is null or p_checks < 1 or p_checks > 10 then raise exception 'Invalid checks' using errcode = '22023'; end if;
 if not coalesce((select s.value = 'true'::jsonb from private.hub_settings s where s.key = 'growth.address_service'), false) then
  return false;
 end if;
 insert into private.growth_address_service_days(day, used) values (v_day, 0) on conflict (day) do nothing;
 update private.growth_address_service_days set used = used + p_checks
  where day = v_day and used + p_checks <= private.growth_address_service_cap()
  returning used into v_used;
 return v_used is not null;
end; $$;
revoke all on function private.growth_address_service_reserve(integer) from public, anon, authenticated, service_role;
grant execute on function private.growth_address_service_reserve(integer) to hub_app_server;

-- How an address was found: also by the verification service.
do $$
declare c record;
begin
  for c in select con.conname from pg_constraint con join pg_attribute a on a.attrelid = con.conrelid and a.attnum = any(con.conkey)
    where con.conrelid = 'private.growth_people'::regclass and con.contype = 'c' and a.attname = 'address_found'
      and position('''service''' in pg_get_constraintdef(con.oid)) = 0 loop
    execute format('alter table private.growth_people drop constraint %I', c.conname);
  end loop;
  if not exists (select 1 from pg_constraint where conrelid = 'private.growth_people'::regclass and conname = 'growth_people_address_found_check') then
    alter table private.growth_people add constraint growth_people_address_found_check
      check (address_found in ('published', 'mail_server', 'apollo', 'service'));
  end if;
end $$;

-- An address the service confirmed is taken as one the mail server confirmed is: no page, and its address check answered.
do $$
declare d text := pg_get_functiondef('private.growth_person_address(uuid,text,text,text,text)'::regprocedure);
begin
  if position('''service''' in d) > 0 then return; end if;
  if position($q$ if p_found is null or p_found not in ('published', 'mail_server')$q$ in d) = 0
    or position($q$ or (p_found = 'mail_server' and p_source_url is not null) then$q$ in d) = 0
    or position($q$ if p_found = 'mail_server' then$q$ in d) = 0 then
    raise exception 'The people finder''s address function changed; update this migration' using errcode = '55000';
  end if;
  d := replace(d, $q$ if p_found is null or p_found not in ('published', 'mail_server')$q$,
    $q$ if p_found is null or p_found not in ('published', 'mail_server', 'service')$q$);
  d := replace(d, $q$ or (p_found = 'mail_server' and p_source_url is not null) then$q$,
    $q$ or (p_found in ('mail_server', 'service') and p_source_url is not null) then$q$);
  d := replace(d, $q$ if p_found = 'mail_server' then$q$, $q$ if p_found in ('mail_server', 'service') then$q$);
  execute d;
end $$;
