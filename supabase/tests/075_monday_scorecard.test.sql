begin;
select plan(17);

select ok(hub.get_backend_contract() -> 'features' @> '["platform.agents.scorecard.v1"]'::jsonb, 'The Monday scorecard is declared in release metadata');

-- The setting: one row, and the individual weekly reports start switched off.
select is((select individual_reports from private.agent_scorecard_settings), false, 'The individual weekly reports start switched off');
select throws_ok($$insert into private.agent_scorecard_settings (id, individual_reports) values (false, true)$$,
  '23514', null, 'There is only ever one scorecard setting');

-- The schedule: the Chief of Staff, every morning at 07:50 Eastern, without the owner's session.
select is((select array[cadence, at_local::text, timezone, requires_session::text] from private.agent_schedules
           where agent_key = 'chief_of_staff' and task_kind = 'scorecard.weekly'),
  array['daily', '07:50:00', 'America/New_York', 'false'], 'The scorecard is due at 07:50 Eastern every morning');

-- The boundary: the table closed to every role, the server reads the Hub server's alone, the owner operations self-authorizing.
select ok((select relrowsecurity from pg_class where oid = 'private.agent_scorecard_settings'::regclass), 'The setting has row level security');
select ok(not bool_or(has_table_privilege(role_name, 'private.agent_scorecard_settings', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')),
  'No browser, service or server role can touch the setting')
from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) role_name;
select ok(has_function_privilege('hub_app_server', 'private.agent_individual_reports()', 'execute')
  and has_function_privilege('hub_app_server', 'private.agent_scorecard_facts(timestamptz,timestamptz)', 'execute')
  and not bool_or(has_function_privilege(role_name, 'private.agent_individual_reports()', 'execute')
                  or has_function_privilege(role_name, 'private.agent_scorecard_facts(timestamptz,timestamptz)', 'execute')),
  'Only the Hub server reads the setting and the figures')
from unnest(array['public', 'anon', 'authenticated', 'service_role']) role_name;
select ok(not bool_or(has_function_privilege(role_name, 'private.agent_scorecard_settings_json(private.agent_scorecard_settings)', 'execute')
                      or has_function_privilege(role_name, 'private.agent_scorecard_facts_json(timestamptz,timestamptz)', 'execute')),
  'The helpers are executable by no role')
from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) role_name;
select throws_ok('select private.agent_individual_reports()', '42501', 'Application server required.', 'Reading the setting needs the Hub server');
select throws_ok($$select private.agent_scorecard_facts(now() - interval '7 days', now())$$, '42501', 'Application server required.',
  'Reading the figures needs the Hub server');
set local role authenticated;
select throws_ok('select hub.get_scorecard_settings()', '28000', null, 'A signed-in user without an administrator session cannot read the setting');
select throws_ok('select hub.set_individual_reports(true, now())', '28000', null, 'A signed-in user without a command session cannot change it');
reset role;
set local role anon;
select throws_ok('select hub.get_scorecard_settings()', '42501', null, 'Anonymous callers cannot read the setting');
reset role;

-- The figures: counts per product for one window. Test leads and internal organizations are left out, and a trial that reached first
-- value before the window is not activated again.
insert into private.growth_organizations (id, name, domain, internal) values
  ('0075aaaa-0000-4000-8000-000000000001', 'pgTAP 075 Home', 'pgtap-075-home.example.org', false),
  ('0075aaaa-0000-4000-8000-000000000002', 'pgTAP 075 Internal', 'pgtap-075-internal.example.org', true),
  ('0075aaaa-0000-4000-8000-000000000003', 'pgTAP 075 Earlier', 'pgtap-075-earlier.example.org', false);
insert into private.customer_activity_events (product, organization_id, event_key, kind, occurred_at) values
  ('caremetric-intel', '0075aaaa-0000-4000-8000-000000000001', 'pgtap-075-fv-1', 'first_value', '2026-11-03T15:00:00Z'),
  ('caremetric-intel', '0075aaaa-0000-4000-8000-000000000001', 'pgtap-075-fv-2', 'first_value', '2026-11-04T15:00:00Z'),
  ('caremetric-intel', '0075aaaa-0000-4000-8000-000000000002', 'pgtap-075-fv-3', 'first_value', '2026-11-03T15:00:00Z'),
  ('caremetric-intel', '0075aaaa-0000-4000-8000-000000000003', 'pgtap-075-fv-4', 'first_value', '2026-10-20T15:00:00Z'),
  ('caremetric-intel', '0075aaaa-0000-4000-8000-000000000003', 'pgtap-075-fv-5', 'first_value', '2026-11-05T15:00:00Z'),
  ('caremetric-intel', '0075aaaa-0000-4000-8000-000000000001', 'pgtap-075-reply', 'positive_reply', '2026-11-05T15:00:00Z');

-- The helper as its owner: the server read itself refuses every session user but hub_app_server (above), and the integration test
-- reads it as the Hub server.
select is((private.agent_scorecard_facts_json('2026-11-02T05:00:00Z', '2026-11-09T05:00:00Z') -> 'products' -> 1 ->> 'activated')::integer, 1,
  'One trial reached first value for the first time this week: repeats, internal organizations and earlier activations are left out');
select is((private.agent_scorecard_facts_json('2026-11-02T05:00:00Z', '2026-11-09T05:00:00Z') -> 'products' -> 1 ->> 'replies')::integer, 1,
  'Replies are counted per product');
select is(jsonb_array_length(private.agent_scorecard_facts_json('2026-11-02T05:00:00Z', '2026-11-09T05:00:00Z') -> 'products'), 2,
  'The figures cover CareBase and CareMetric Intel');
select is(private.agent_scorecard_facts_json('2026-11-02T05:00:00Z', '2026-11-09T05:00:00Z') -> 'products' -> 1 ->> 'product', 'caremetric-intel',
  'Products come in a fixed order');

-- The owner's switch runs through the real roles in server/agents-scorecard-integration.mjs.

select * from finish();
rollback;
