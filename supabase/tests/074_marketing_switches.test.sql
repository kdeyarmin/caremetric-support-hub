begin;
select plan(11);

select ok(hub.get_backend_contract() -> 'features' @> '["platform.agents.marketing.v1"]'::jsonb, 'The marketing switches are declared in release metadata');

-- The seed: Intel marketed; CareBase (in its pilot) and Healthcare Advisors not.
select is((select jsonb_object_agg(product, marketed) from private.marketing_products),
  '{"caremetric-intel": true, "carebase": false, "advisors": false}'::jsonb, 'Only CareMetric Intel is marketed to begin with');
select throws_ok($$insert into private.marketing_products (product, label, description) values ('breathe', 'Breathe', 'Not a product the team markets.')$$,
  '23514', null, 'Only the three products the team could market have a switch');

-- The boundary: the table closed to every role, the server read the Hub server's alone, the owner operations self-authorizing.
select ok((select relrowsecurity from pg_class where oid = 'private.marketing_products'::regclass), 'The switches have row level security');
select ok(not bool_or(has_table_privilege(role_name, 'private.marketing_products', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')),
  'No browser, service or server role can touch the switches')
from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) role_name;
select ok(has_function_privilege('hub_app_server', 'private.marketed_products()', 'execute')
  and not bool_or(has_function_privilege(role_name, 'private.marketed_products()', 'execute')), 'Only the Hub server reads the marketed products')
from unnest(array['public', 'anon', 'authenticated', 'service_role']) role_name;
select ok(not bool_or(has_function_privilege(role_name, 'private.marketing_product_json(private.marketing_products)', 'execute')),
  'The helper is executable by no role')
from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) role_name;
select throws_ok('select private.marketed_products()', '42501', 'Application server required.', 'Reading the marketed products needs the Hub server');
set local role authenticated;
select throws_ok('select hub.get_marketing_products()', '28000', null, 'A signed-in user without an administrator session cannot read the switches');
select throws_ok($$select hub.set_marketing_product('carebase', true, now())$$, '28000', null, 'A signed-in user without a command session cannot switch one');
reset role;
set local role anon;
select throws_ok('select hub.get_marketing_products()', '42501', null, 'Anonymous callers cannot read the switches');
reset role;

-- The server's read and the owner's switch run through the real roles in server/agents-marketing-integration.mjs.

select * from finish();
rollback;
