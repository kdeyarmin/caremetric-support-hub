begin;
select plan(15);

-- The owner's switch: a flag setting, not set (so on, its default) until the owner saves it.
select is((select kind from private.hub_settings where key = 'growth.cms_roster'), 'flag', 'The CMS roster switch is a flag setting');
select is((select value from private.hub_settings where key = 'growth.cms_roster'), null::jsonb, 'It starts not set');

-- The roster memory is reached only through the Hub server's two calls.
select ok(exists (select 1 from pg_class where oid = 'private.growth_roster_searches'::regclass and relrowsecurity), 'Row level security is on');
select ok(not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r
                      where has_table_privilege(r, 'private.growth_roster_searches', 'select')
                         or has_table_privilege(r, 'private.growth_roster_searches', 'insert')
                         or has_table_privilege(r, 'private.growth_roster_searches', 'update')),
  'No role reads or writes the roster memory directly');
select ok(not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r
                      where has_function_privilege(r, 'private.growth_roster_due(text[],timestamptz)', 'execute')),
  'No role may call the inner reader');
select ok(has_function_privilege('hub_app_server', 'private.growth_roster_pending(text[])', 'execute')
      and has_function_privilege('hub_app_server', 'private.growth_roster_searched(text,boolean)', 'execute'),
  'The Hub server may make its two calls');
select ok(not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r
                      where has_function_privilege(r, 'private.growth_roster_pending(text[])', 'execute')
                         or has_function_privilege(r, 'private.growth_roster_searched(text,boolean)', 'execute')),
  'Browser and service roles may not');
select throws_ok($$select private.growth_roster_pending(array['391501'])$$, '42501', 'Application server required.',
  'Reading what is due requires the actual server session');
select throws_ok($$select private.growth_roster_searched('391501', true)$$, '42501', 'Application server required.',
  'Recording a search requires the actual server session');
select throws_ok($$insert into private.growth_roster_searches (ccn, matched) values ('39-1501', false)$$, '23514', null,
  'Only a six-character CCN is stored');

-- What is due: never searched, or searched without a website match more than 180 days ago. Each CCN once, in the order given.
insert into private.growth_roster_searches (ccn, searched_at, matched) values
  ('391501', '2026-11-13T13:00:00Z', true),
  ('391502', '2026-11-13T04:00:00Z', false),
  ('391503', '2026-06-01T00:00:00Z', false),
  ('391504', '2025-01-01T00:00:00Z', true),
  ('391505', '2026-04-01T00:00:00Z', false);
select is(private.growth_roster_due(array['391505', '391501', '391502', '391503', '391504', '397001', '397001', 'bad'], '2026-11-13T15:00:00Z') -> 'due',
  '["391505", "397001"]'::jsonb, 'A matched agency is never due again; one without a site is due again after 180 days');

-- Searches so far this Eastern day, so a second run on the same day keeps to the day's limit.
select is((private.growth_roster_due(array[]::text[], '2026-11-13T15:00:00Z') ->> 'searchedToday')::integer, 1,
  'The day counts from midnight Eastern (04:00 UTC was still the day before)');
select is((private.growth_roster_due(array[]::text[], '2026-11-14T04:30:00Z') ->> 'searchedToday')::integer, 1,
  'Late evening Eastern is still the same day');
select is((private.growth_roster_due(array[]::text[], '2026-11-14T05:30:00Z') ->> 'searchedToday')::integer, 0,
  'A new Eastern day starts at zero');
select is(private.growth_roster_due(array[]::text[], '2026-11-13T15:00:00Z') -> 'due', '[]'::jsonb, 'An empty list has nothing due');

select * from finish();
rollback;
