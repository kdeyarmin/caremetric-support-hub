begin;
select plan(11);

-- The setting exists, not set, and the cap reader answers null until the owner saves a value (the claim then keeps ten).
select is((select kind from private.hub_settings where key = 'growth.cold_email_daily_cap'), 'number', 'The cold-email cap is a number setting');
select is((select value from private.hub_settings where key = 'growth.cold_email_daily_cap'), null::jsonb, 'The cold-email cap starts not set');
select is(private.growth_cold_email_cap(), null::integer, 'Not set, the reader answers null and the claim keeps ten');

-- A saved whole number is the cap, held to 1..100 whatever was stored; anything else is treated as not set.
update private.hub_settings set value = '25' where key = 'growth.cold_email_daily_cap';
select is(private.growth_cold_email_cap(), 25, 'A saved whole number is the cap');
update private.hub_settings set value = '5000' where key = 'growth.cold_email_daily_cap';
select is(private.growth_cold_email_cap(), 100, 'A cap above one hundred is held to one hundred');
update private.hub_settings set value = '0' where key = 'growth.cold_email_daily_cap';
select is(private.growth_cold_email_cap(), 1, 'A cap of zero is held to one: the switch that stops sending is "Send growth email"');
update private.hub_settings set value = '12.5' where key = 'growth.cold_email_daily_cap';
select is(private.growth_cold_email_cap(), null::integer, 'A number that is not whole is treated as not set');
update private.hub_settings set value = null where key = 'growth.cold_email_daily_cap';
select is(private.growth_cold_email_cap(), null::integer, 'Reset to the default, the reader answers null again');

-- The claim uses the setting, keeps ten as the default, and the reader is closed to every role.
select ok(position('v_cap:=private.growth_cold_email_cap();' in pg_get_functiondef('private.growth_claim_message(uuid,uuid)'::regprocedure)) > 0
  and position('v_cap is not null and v_cold_sent >= v_cap then' in pg_get_functiondef('private.growth_claim_message(uuid,uuid)'::regprocedure)) > 0,
  'Claiming a cold email is capped by the owner''s setting');
select ok(position('v_cap is null and v_cold_sent >= 10 then' in pg_get_functiondef('private.growth_claim_message(uuid,uuid)'::regprocedure)) > 0,
  'Without a saved setting the cap is still ten');
select ok(not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r
                      where has_function_privilege(r, 'private.growth_cold_email_cap()', 'execute')),
  'No role may read the cap directly');

select * from finish();
rollback;
