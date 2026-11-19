-- Send hours in each agency's own time zone (docs/CUSTOMER_GROWTH.md, "Send cold email from this hour"): the hours were Eastern for
-- every agency, so with the roster beyond the East Coast the owner had to pick hours that suited one zone and compromise on the rest
-- (11 to 16 Eastern is 8 am to 1 pm in California). One new switch, "Send in each agency's own time zone"
-- (growth.send_local_time), starts off: nothing changes until the owner turns it on.
--
-- 1. private.growth_state_zones: the time zone of each state, territory and DC (the zone most of its people live in; see below).
-- 2. private.growth_org_zone(organization): the zone an agency's hours are read in. With the switch on, the state of the agency's Medicare
--    roster record (private.growth_roster_targets, linked once the roster agency became a prospect) gives it; an agency with no roster
--    record, or a state with no zone, and every agency while the switch is off, keep America/New_York.
-- 3. private.growth_next_send_at(timestamptz, text): the same next-opening rule as before (Monday to Friday, "from" inclusive, "until"
--    exclusive), read in the given zone. The one-argument form is the Eastern one it always was.
-- 4. private.growth_claim_message holds a cold email outside the hours in the agency's zone, and private.growth_defer_action waits for the
--    next opening in that zone. Nothing else in either function changes: replies and customer emails are never held, and the daily caps
--    still count the Eastern day.
--
-- A state that lies in two zones takes the zone most of its residents live in (Indiana, Kentucky, Michigan and Florida Eastern; Texas,
-- Kansas, Nebraska, North Dakota, South Dakota and Tennessee Central; Idaho Mountain; Oregon Pacific). An agency in the part of such a state
-- that keeps the other time is reached an hour early or late, which the owner's hours leave room for. Arizona keeps Mountain Standard
-- Time all year (America/Phoenix), as do Hawaii and the territories in their own zones; the database's time zone rules apply daylight
-- saving time on the right dates.
--
-- Nothing is sent by this migration.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values
  ('growth.send_local_time', 'flag')
on conflict (key) do nothing;

-- ---- The zone of each state ----------------------------------------------------------------------------------------------------------

create table private.growth_state_zones (
  state text primary key check (state ~ '^[A-Z]{2}$'),
  zone text not null check (char_length(zone) between 3 and 40)
);
alter table private.growth_state_zones enable row level security;
revoke all on private.growth_state_zones from public, anon, authenticated, service_role;

insert into private.growth_state_zones (state, zone) values
  ('CT', 'America/New_York'), ('DC', 'America/New_York'), ('DE', 'America/New_York'), ('FL', 'America/New_York'), ('GA', 'America/New_York'),
  ('IN', 'America/New_York'), ('KY', 'America/New_York'), ('MA', 'America/New_York'), ('MD', 'America/New_York'), ('ME', 'America/New_York'),
  ('MI', 'America/New_York'), ('NC', 'America/New_York'), ('NH', 'America/New_York'), ('NJ', 'America/New_York'), ('NY', 'America/New_York'),
  ('OH', 'America/New_York'), ('PA', 'America/New_York'), ('RI', 'America/New_York'), ('SC', 'America/New_York'), ('VA', 'America/New_York'),
  ('VT', 'America/New_York'), ('WV', 'America/New_York'),
  ('AL', 'America/Chicago'), ('AR', 'America/Chicago'), ('IA', 'America/Chicago'), ('IL', 'America/Chicago'), ('KS', 'America/Chicago'),
  ('LA', 'America/Chicago'), ('MN', 'America/Chicago'), ('MO', 'America/Chicago'), ('MS', 'America/Chicago'), ('ND', 'America/Chicago'),
  ('NE', 'America/Chicago'), ('OK', 'America/Chicago'), ('SD', 'America/Chicago'), ('TN', 'America/Chicago'), ('TX', 'America/Chicago'),
  ('WI', 'America/Chicago'),
  ('CO', 'America/Denver'), ('ID', 'America/Denver'), ('MT', 'America/Denver'), ('NM', 'America/Denver'), ('UT', 'America/Denver'),
  ('WY', 'America/Denver'),
  ('AZ', 'America/Phoenix'),
  ('CA', 'America/Los_Angeles'), ('NV', 'America/Los_Angeles'), ('OR', 'America/Los_Angeles'), ('WA', 'America/Los_Angeles'),
  ('AK', 'America/Anchorage'), ('HI', 'Pacific/Honolulu'),
  ('PR', 'America/Puerto_Rico'), ('VI', 'America/St_Thomas'), ('GU', 'Pacific/Guam'), ('MP', 'Pacific/Saipan'), ('AS', 'Pacific/Pago_Pago')
on conflict (state) do nothing;

do $$ begin
  if exists (select 1 from private.growth_state_zones z where not exists (select 1 from pg_catalog.pg_timezone_names n where n.name = z.zone)) then
    raise exception 'A state''s time zone is not one this database knows' using errcode = '55000';
  end if;
end $$;

-- ---- Which zone an agency's hours are read in ----------------------------------------------------------------------------------------

create or replace function private.growth_send_local_time_on() returns boolean
language sql stable set search_path = '' as $$
  select coalesce((select s.value = 'true'::jsonb from private.hub_settings s where s.key = 'growth.send_local_time'), false);
$$;
revoke all on function private.growth_send_local_time_on() from public, anon, authenticated, service_role;

-- With the switch on, the zone of the state of the organization's Medicare roster record (the highest ranked, then the lowest CCN, when
-- its agencies are in more than one state); otherwise, and for an organization with no roster record, Eastern.
create or replace function private.growth_org_zone(p_org uuid) returns text
language sql stable set search_path = '' as $$
  select coalesce(
    case when private.growth_send_local_time_on() then
      (select z.zone from private.growth_roster_targets t join private.growth_state_zones z on z.state = t.state
        where t.organization_id = p_org order by t.rank desc, t.ccn limit 1)
    end,
    'America/New_York');
$$;
revoke all on function private.growth_org_zone(uuid) from public, anon, authenticated, service_role;

-- ---- The next opening, in a zone -----------------------------------------------------------------------------------------------------

-- The first moment at or after `p_at` inside the owner's weekday send hours, read in `p_zone`: `p_at` itself when no hours are set, when
-- they are not a valid range or when `p_at` is inside them. A zone the database does not know is read as Eastern.
create or replace function private.growth_next_send_at(p_at timestamptz, p_zone text) returns timestamptz
language plpgsql stable set search_path = '' as $$
declare v_from integer; v_until integer; v_zone text := coalesce(p_zone, 'America/New_York'); v_local timestamp; v_day date; v_open timestamp; v_close timestamp; begin
 select case when jsonb_typeof(s.value) = 'number' and (s.value #>> '{}') ~ '^[0-9]{1,2}$' then (s.value #>> '{}')::integer end into v_from
   from private.hub_settings s where s.key = 'growth.send_from_hour';
 select case when jsonb_typeof(s.value) = 'number' and (s.value #>> '{}') ~ '^[0-9]{1,2}$' then (s.value #>> '{}')::integer end into v_until
   from private.hub_settings s where s.key = 'growth.send_until_hour';
 if p_at is null or (v_from is null and v_until is null) then return p_at; end if;
 v_from := coalesce(v_from, 0); v_until := coalesce(v_until, 24);
 if v_from > 23 or v_until < 1 or v_until > 24 or v_from >= v_until then return p_at; end if;
 if not exists (select 1 from pg_catalog.pg_timezone_names n where n.name = v_zone) then v_zone := 'America/New_York'; end if;
 v_local := p_at at time zone v_zone;
 for i in 0..7 loop
  v_day := v_local::date + i;
  if extract(isodow from v_day) <= 5 then
   v_open := v_day + make_interval(hours => v_from); v_close := v_day + make_interval(hours => v_until);
   if v_local >= v_open and v_local < v_close then return p_at; end if;
   if v_local < v_open then return v_open at time zone v_zone; end if;
  end if;
 end loop;
 return p_at;
end; $$;
revoke all on function private.growth_next_send_at(timestamptz, text) from public, anon, authenticated, service_role;

-- The Eastern form, as before.
create or replace function private.growth_next_send_at(p_at timestamptz) returns timestamptz
language sql stable set search_path = '' as $$
  select private.growth_next_send_at(p_at, 'America/New_York');
$$;
revoke all on function private.growth_next_send_at(timestamptz) from public, anon, authenticated, service_role;

-- ---- The send claim and the deferral ------------------------------------------------------------------------------------------------

-- The claim reads the hours in the zone of the opportunity's agency.
do $$
declare
  d text := pg_get_functiondef('private.growth_claim_message(uuid,uuid)'::regprocedure);
  old_check constant text := 'private.growth_next_send_at(now())>now()';
  new_check constant text := 'private.growth_next_send_at(now(), private.growth_org_zone(o.organization_id))>now()';
  old_note constant text := 'cold email only inside the owner''s Eastern weekday hours.';
  new_note constant text := 'cold email only inside the owner''s weekday hours, Eastern or, when the owner chose it, in the agency''s own time zone (20261118130000_growth_local_send_time.sql).';
begin
  if position('growth_org_zone' in d) > 0 then return; end if;
  if position(old_check in d) = 0 or position(old_note in d) = 0 then
    raise exception 'The send claim changed; update this migration' using errcode = '55000';
  end if;
  execute replace(replace(d, old_check, new_check), old_note, new_note);
end $$;

-- A growth email that could not go now waits (20261117190000_growth_priority.sql): over the day's cap, with "Send to the best prospects
-- first" on, until the next Eastern day; outside the send hours, until the next opening; a cold email never before the next opening,
-- which is now the opening in its agency's zone; anything else 15 minutes.
create or replace function private.growth_defer_action(p_id uuid, p_execution integer, p_reason text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_at timestamptz := now() + interval '15 minutes'; v_cold boolean; v_zone text; v_deferred boolean; begin
 perform private.require_hub_app_server();
 if p_reason in ('daily_limit', 'outside_hours') then
  select private.growth_message_class(a.agent_key, m.purpose, c.source_kind) = 'growth.cold_email', private.growth_org_zone(c.organization_id) into v_cold, v_zone
    from private.agent_actions a join private.growth_messages m on m.action_id = a.id join private.growth_contacts c on c.id = m.contact_id
   where a.id = p_id order by m.created_at desc limit 1;
  if p_reason = 'daily_limit' and private.growth_send_priority_on() then
   v_at := (date_trunc('day', now() at time zone 'America/New_York') + interval '1 day') at time zone 'America/New_York';
  end if;
  if coalesce(v_cold, false) then v_at := private.growth_next_send_at(v_at, coalesce(v_zone, 'America/New_York')); end if;
 end if;
 update private.agent_actions set status=case when decided_by is null then 'auto_approved' else 'approved' end,
 executing_at=null,not_before=v_at,updated_at=now()
 where id=p_id and kind='growth.message' and status='executing' and executions=p_execution
 returning true into v_deferred;
 return coalesce(v_deferred,false);
end; $$;
revoke all on function private.growth_defer_action(uuid, integer, text) from public, anon, authenticated, service_role;
grant execute on function private.growth_defer_action(uuid, integer, text) to hub_app_server;

-- ---- Checks ----------------------------------------------------------------------------------------------------------------------------

do $$
declare fn text; begin
  if not exists (select 1 from private.hub_settings where key = 'growth.send_local_time') then
    raise exception 'The send-in-local-time setting must have a row' using errcode = '55000';
  end if;
  if (select count(*) from private.growth_state_zones) < 56 then
    raise exception 'Every state, DC and the five territories need a time zone' using errcode = '55000';
  end if;
  if position('growth_org_zone' in pg_get_functiondef('private.growth_claim_message(uuid,uuid)'::regprocedure)) = 0
    or position('outside_hours' in pg_get_functiondef('private.growth_claim_message(uuid,uuid)'::regprocedure)) = 0
    or position('c.eligibility<>''permitted''' in pg_get_functiondef('private.growth_claim_message(uuid,uuid)'::regprocedure)) = 0 then
    raise exception 'The send claim must hold cold email outside the hours in the agency''s zone' using errcode = '55000';
  end if;
  if position('growth_org_zone' in pg_get_functiondef('private.growth_defer_action(uuid,integer,text)'::regprocedure)) = 0
    or position('private.require_hub_app_server()' in pg_get_functiondef('private.growth_defer_action(uuid,integer,text)'::regprocedure)) = 0
    or not has_function_privilege('hub_app_server', 'private.growth_defer_action(uuid,integer,text)', 'execute')
    or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r where has_function_privilege(r, 'private.growth_defer_action(uuid,integer,text)', 'execute')) then
    raise exception 'Only the Hub server may defer an email, to the opening in the agency''s zone' using errcode = '55000';
  end if;
  foreach fn in array array['private.growth_send_local_time_on()', 'private.growth_org_zone(uuid)', 'private.growth_next_send_at(timestamptz,text)', 'private.growth_next_send_at(timestamptz)'] loop
    if to_regprocedure(fn) is null
      or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r where has_function_privilege(r, fn, 'execute')) then
      raise exception '% must be closed to every role', fn using errcode = '55000';
    end if;
  end loop;
  if exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r where has_table_privilege(r, 'private.growth_state_zones', 'select')) then
    raise exception 'The state zones are closed to every role' using errcode = '55000';
  end if;
end $$;
