begin;
select plan(12);

select ok(hub.get_backend_contract() -> 'features' @> '["platform.settings.v1"]'::jsonb, 'The Hub settings are declared in release metadata');

-- The seed: every setting the server knows, none set.
select is((select count(*)::int from private.hub_settings), 33, 'Every setting the Hub server knows has a row');
select is((select count(*)::int from private.hub_settings where value is not null or imported_from is not null or changed_by is not null), 0,
  'No setting starts with a value');
select throws_ok($$update private.hub_settings set value = '"on"' where key = 'support.chat'$$, '23514', null,
  'A switch holds only true or false');
select throws_ok($$update private.hub_settings set value = '["https://example.com", 5]' where key = 'social.image_urls'$$, '23514', null,
  'A list holds only texts');

-- The boundary: the table closed to every role, the server operations the Hub server's alone, the owner operations self-authorizing.
select ok((select relrowsecurity from pg_class where oid = 'private.hub_settings'::regclass), 'The settings have row level security');
select ok(not bool_or(has_table_privilege(role_name, 'private.hub_settings', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')),
  'No browser, service or server role can touch the settings table')
from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) role_name;
select ok(has_function_privilege('hub_app_server', 'private.hub_settings_values()', 'execute')
  and has_function_privilege('hub_app_server', 'private.hub_settings_import(jsonb)', 'execute')
  and not bool_or(has_function_privilege(role_name, 'private.hub_settings_values()', 'execute')
    or has_function_privilege(role_name, 'private.hub_settings_import(jsonb)', 'execute')), 'Only the Hub server reads and imports settings')
from unnest(array['public', 'anon', 'authenticated', 'service_role']) role_name;
select throws_ok('select private.hub_settings_values()', '42501', 'Application server required.', 'Reading the settings needs the Hub server');
set local role authenticated;
select throws_ok('select hub.get_hub_settings()', '28000', null, 'A signed-in user without an administrator session cannot read the settings');
select throws_ok($$select hub.set_hub_setting('support.chat', 'true', now())$$, '28000', null, 'A signed-in user without a command session cannot change one');
reset role;
set local role anon;
select throws_ok('select hub.get_hub_settings()', '42501', null, 'Anonymous callers cannot read the settings');
reset role;

-- The import, the owner's changes and the server's read run through the real roles in server/settings-integration.mjs.

select * from finish();
rollback;
