begin;
select plan(5);

-- Settings → Customer growth → "States to prospect in" accepts up to 60 state codes on the Settings page; the database must too.
select ok(private.hub_setting_value_ok('list', (select jsonb_agg(format('S%s', n)) from generate_series(1, 60) n)),
  'A list setting holds 60 texts');
select ok(not private.hub_setting_value_ok('list', (select jsonb_agg(format('S%s', n)) from generate_series(1, 61) n)),
  'A list setting holds no more than 60 texts');
select ok(not private.hub_setting_value_ok('list', '[]'::jsonb), 'An empty list is cleared, not saved');

update private.hub_settings set value = (select jsonb_agg(format('S%s', n)) from generate_series(1, 60) n) where key = 'growth.roster_states';
select is((select jsonb_array_length(value) from private.hub_settings where key = 'growth.roster_states'), 60,
  'Sixty states to prospect in can be saved');
select throws_ok($$update private.hub_settings set value = (select jsonb_agg(format('S%s', n)) from generate_series(1, 61) n)
  where key = 'growth.roster_states'$$, '23514', null, 'A 61st state is refused');

select * from finish();
rollback;
