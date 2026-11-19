begin;
select plan(31);

-- Send hours in each agency's own time zone (20261118130000_growth_local_send_time.sql).
select is((select value from private.hub_settings where key = 'growth.send_local_time'), null::jsonb, 'The setting has a row and starts off');
select is((select count(*)::int from private.growth_state_zones), 56, 'Every state, DC and the five territories have a zone');
select is((select count(*)::int from private.growth_state_zones z where not exists (select 1 from pg_timezone_names n where n.name = z.zone)), 0,
  'Every zone is one the database knows');
select is((select array_agg(zone order by state) from private.growth_state_zones where state in ('PA', 'TX', 'CO', 'AZ', 'CA', 'AK', 'HI', 'PR')),
  array['America/Anchorage', 'America/Phoenix', 'America/Los_Angeles', 'America/Denver', 'Pacific/Honolulu', 'America/New_York', 'America/Puerto_Rico', 'America/Chicago'],
  'A state''s zone is the one most of its people keep (Arizona never changes its clocks)');
select ok(not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r where has_table_privilege(r, 'private.growth_state_zones', 'select')),
  'The state zones are closed to every role');
select ok(not exists (select 1 from unnest(array['private.growth_send_local_time_on()', 'private.growth_org_zone(uuid)', 'private.growth_next_send_at(timestamptz,text)',
    'private.growth_next_send_at(timestamptz)']) f cross join unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r where has_function_privilege(r, f, 'execute')),
  'The zone helpers are closed to every role');
select ok(has_function_privilege('hub_app_server', 'private.growth_defer_action(uuid,integer,text)', 'execute')
  and not has_function_privilege('authenticated', 'private.growth_defer_action(uuid,integer,text)', 'execute')
  and not has_function_privilege('service_role', 'private.growth_defer_action(uuid,integer,text)', 'execute'), 'Only the server defers an email');
select ok(position('growth_org_zone' in pg_get_functiondef('private.growth_claim_message(uuid,uuid)'::regprocedure)) > 0
  and position('outside_hours' in pg_get_functiondef('private.growth_claim_message(uuid,uuid)'::regprocedure)) > 0
  and position('growth_org_zone' in pg_get_functiondef('private.growth_defer_action(uuid,integer,text)'::regprocedure)) > 0,
  'The claim and the deferral read the hours in the agency''s zone');

-- Which zone an agency's hours are read in: its Medicare record's state, and only with the switch on.
insert into private.growth_organizations (id, name, domain) values
  ('e1230000-0000-4000-8000-0000000001a1', 'West Coast Home Health', 'west-coast.example.test'),
  ('e1230000-0000-4000-8000-0000000001a2', 'No Record Home Health', 'no-record.example.test'),
  ('e1230000-0000-4000-8000-0000000001a3', 'Two State Home Health', 'two-state.example.test'),
  ('e1230000-0000-4000-8000-0000000001a4', 'Unknown State Home Health', 'unknown-state.example.test'),
  ('e1230000-0000-4000-8000-0000000001a5', 'Tied Home Health', 'tied.example.test');
insert into private.growth_roster_targets (ccn, name, setting, state, period, claim, rank, status, organization_id) values
  ('057001', 'West Coast Home Health', 'home_health', 'CA', '2026Q3', 'A Medicare-certified home health agency.', 50, 'graduated', 'e1230000-0000-4000-8000-0000000001a1'),
  ('057002', 'Two State One', 'home_health', 'CA', '2026Q3', 'A Medicare-certified home health agency.', 10, 'graduated', 'e1230000-0000-4000-8000-0000000001a3'),
  ('457001', 'Two State Two', 'home_health', 'TX', '2026Q3', 'A Medicare-certified home health agency.', 80, 'graduated', 'e1230000-0000-4000-8000-0000000001a3'),
  ('999001', 'Unknown State', 'home_health', 'ZZ', '2026Q3', 'A Medicare-certified home health agency.', 50, 'graduated', 'e1230000-0000-4000-8000-0000000001a4'),
  ('457009', 'Tied Two', 'home_health', 'TX', '2026Q3', 'A Medicare-certified home health agency.', 40, 'graduated', 'e1230000-0000-4000-8000-0000000001a5'),
  ('057009', 'Tied One', 'home_health', 'CA', '2026Q3', 'A Medicare-certified home health agency.', 40, 'graduated', 'e1230000-0000-4000-8000-0000000001a5');
select is(private.growth_org_zone('e1230000-0000-4000-8000-0000000001a1'), 'America/New_York', 'With the switch off every agency is Eastern');
update private.hub_settings set value = 'true' where key = 'growth.send_local_time';
select is(private.growth_org_zone('e1230000-0000-4000-8000-0000000001a1'), 'America/Los_Angeles', 'With it on, an agency in California is Pacific');
select is(private.growth_org_zone('e1230000-0000-4000-8000-0000000001a2'), 'America/New_York', 'An agency with no Medicare record stays Eastern');
select is(private.growth_org_zone('e1230000-0000-4000-8000-0000000001a3'), 'America/Chicago', 'An organization in two states takes its highest ranked agency''s state');
select is(private.growth_org_zone('e1230000-0000-4000-8000-0000000001a5'), 'America/Los_Angeles', 'At equal rank, the lowest CCN');
select is(private.growth_org_zone('e1230000-0000-4000-8000-0000000001a4'), 'America/New_York', 'A state with no zone stays Eastern');
select is(private.growth_org_zone(gen_random_uuid()), 'America/New_York', 'An unknown organization stays Eastern');
select is(private.growth_org_zone(null), 'America/New_York', 'No organization stays Eastern');
update private.hub_settings set value = 'false' where key = 'growth.send_local_time';
select is(private.growth_org_zone('e1230000-0000-4000-8000-0000000001a1'), 'America/New_York', 'Turned off again, Eastern again');

-- The next opening in a zone: 8 to 16, Monday to Friday, read where the agency is.
select is(private.growth_next_send_at('2026-11-15 13:00-05', 'America/Los_Angeles'), '2026-11-15 13:00-05'::timestamptz, 'With no hours set an email may go at any time, in any zone');
update private.hub_settings set value = '8' where key = 'growth.send_from_hour';
update private.hub_settings set value = '16' where key = 'growth.send_until_hour';
select is(private.growth_next_send_at('2026-11-16 12:00-05', 'America/Los_Angeles'), '2026-11-16 12:00-05'::timestamptz, 'Noon Eastern is 9 am Pacific: inside, it goes now');
select is(private.growth_next_send_at('2026-11-16 20:30-05', 'America/Los_Angeles'), '2026-11-17 08:00-08'::timestamptz, 'At 5:30 pm Pacific on a Monday it waits for Tuesday at 8 Pacific');
select is(private.growth_next_send_at('2026-11-16 20:30-05', 'America/New_York'), '2026-11-17 08:00-05'::timestamptz, 'The same moment is also after hours in the East, and waits for Tuesday at 8 Eastern');
select is(private.growth_next_send_at('2026-11-20 18:00-05', 'America/Los_Angeles'), '2026-11-20 18:00-05'::timestamptz, 'Friday at 6 pm Eastern is 3 pm Pacific: inside, it goes now');
select is(private.growth_next_send_at('2026-11-20 18:00-05', 'America/New_York'), '2026-11-23 08:00-05'::timestamptz, 'Friday at 6 pm in the East waits for Monday at 8');
select is(private.growth_next_send_at('2026-11-16 02:00-05', 'America/Los_Angeles'), '2026-11-16 08:00-08'::timestamptz, 'Monday at 2 am Eastern is still Sunday night in California, so it waits for Monday at 8 Pacific');
select is(private.growth_next_send_at('2026-11-16 12:00-05', 'Pacific/Honolulu'), '2026-11-16 08:00-10'::timestamptz, 'Noon Eastern is 7 am in Hawaii: it waits for 8');
select is(private.growth_next_send_at('2026-03-09 07:30-07', 'America/Los_Angeles'), '2026-03-09 08:00-07'::timestamptz, 'After the clocks change the opening is still 8 on the wall');
select is(private.growth_next_send_at('2026-11-16 12:30-07', 'America/Phoenix'), '2026-11-16 12:30-07'::timestamptz, 'Arizona keeps its own hours all year');
select is(private.growth_next_send_at('2026-11-16 20:30-05', 'Not/AZone'), '2026-11-17 08:00-05'::timestamptz, 'A zone the database does not know is read as Eastern');
select is(private.growth_next_send_at('2026-11-16 20:30-05', null), '2026-11-17 08:00-05'::timestamptz, 'No zone is Eastern');
select is(private.growth_next_send_at('2026-11-16 20:30-05'), private.growth_next_send_at('2026-11-16 20:30-05', 'America/New_York'), 'The one-argument form is the Eastern one');
update private.hub_settings set value = '17' where key = 'growth.send_from_hour';
select is(private.growth_next_send_at('2026-11-15 13:00-05', 'America/Los_Angeles'), '2026-11-15 13:00-05'::timestamptz, 'Hours that end before they start are not used, in any zone');

select * from finish();
rollback;
