begin;
select plan(9);

select is((select value from private.hub_settings where key = 'growth.learning_memo'), null::jsonb, 'Writing from what is working starts off');
select ok(exists (select 1 from pg_attribute where attrelid = 'private.growth_messages'::regclass and attname = 'memo_version'), 'A message records the memo it was written with');
select ok((select relrowsecurity from pg_class where oid = 'private.growth_learning_memos'::regclass), 'The memos have row-level security');
select ok(not bool_or(has_table_privilege(r, 'private.growth_learning_memos', 'select,insert,update,delete')), 'No role reads or writes the memos directly')
  from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r;
select ok(not bool_or(has_function_privilege(r, f, 'execute')), 'Only the Hub server reads the counts and proposes memos')
  from unnest(array['anon', 'authenticated', 'service_role']) r
  cross join unnest(array['private.growth_learning_facts(text,integer)', 'private.growth_learning_propose(text,text,jsonb)', 'private.growth_learning_active(text)']) f;
select throws_ok($$select private.growth_learning_facts('carebase', 90)$$, '42501', null, 'The counts refuse anyone but the Hub server');
select throws_ok($$select hub.growth_learning_decide(gen_random_uuid(), 'activate')$$, null, null, 'Deciding a memo needs a signed-in owner');
insert into private.growth_learning_memos(product, version, memo, status) values ('carebase', 1, 'one', 'active');
select throws_ok($$insert into private.growth_learning_memos(product, version, memo, status) values ('carebase', 2, 'two', 'active')$$, '23505', null,
  'A product has at most one active memo');
select ok(hub.get_backend_contract() -> 'features' ? 'platform.agents.growth-learning.v1', 'The learning feature is declared');

select * from finish();
rollback;
