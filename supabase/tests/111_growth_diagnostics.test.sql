begin;
select plan(9);

-- Contacts hold why a check got no answer, as one of the known reasons only.
select ok(exists (select 1 from information_schema.columns where table_schema = 'private' and table_name = 'growth_contacts' and column_name = 'mailbox_reason'),
  'Contacts hold why a check got no answer');
select ok(position('sender_refused' in (select pg_get_constraintdef(c.oid) from pg_constraint c
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
  where c.conrelid = 'private.growth_contacts'::regclass and c.contype = 'c' and a.attname = 'mailbox_reason')) > 0, 'Only a known reason is held');

-- Only the server records; the reviews table and its read check are closed to every role.
select ok(has_function_privilege('hub_app_server', 'private.growth_mailbox_record(uuid,text,text)', 'execute')
  and has_function_privilege('hub_app_server', 'private.growth_mailbox_record(uuid,text)', 'execute')
  and has_function_privilege('hub_app_server', 'private.growth_review_record(uuid,jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'private.growth_mailbox_record(uuid,text,text)', 'execute')
  and not has_function_privilege('service_role', 'private.growth_review_record(uuid,jsonb)', 'execute'), 'Only the server records reasons and reviews');
select ok((select relrowsecurity from pg_class where oid = 'private.growth_message_reviews'::regclass)
  and not has_table_privilege('hub_app_server', 'private.growth_message_reviews', 'select')
  and not has_table_privilege('authenticated', 'private.growth_message_reviews', 'select')
  and not has_function_privilege('hub_app_server', 'private.growth_review_read_ok(jsonb)', 'execute'), 'Nobody reads the reviews table directly');
select throws_ok($$ select private.growth_review_record(gen_random_uuid(), '{}'::jsonb) $$, '42501', null, 'Outside the server role nothing is recorded');

-- A read is four scores from 1 to 5 and the weakest sentence, nothing else.
select ok(private.growth_review_read_ok('{"specific":2,"relevant":3,"clearAsk":4,"wouldReply":2,"weakest":"The last line."}'::jsonb), 'A read is accepted');
select ok(not private.growth_review_read_ok('{"specific":2,"relevant":3,"clearAsk":4,"wouldReply":6,"weakest":""}'::jsonb)
  and not private.growth_review_read_ok('{"specific":2,"relevant":3,"clearAsk":4,"wouldReply":2.5,"weakest":""}'::jsonb)
  and not private.growth_review_read_ok('{"specific":2,"relevant":3,"clearAsk":4,"wouldReply":2,"weakest":"","email":"x@example.org"}'::jsonb)
  and not private.growth_review_read_ok(jsonb_build_object('specific',2,'relevant',3,'clearAsk',4,'wouldReply',2,'weakest',repeat('x',401))),
  'A score out of range, a fraction, an extra key or a long sentence is refused');

-- The reason is recorded after the unchanged two-argument record, and the feature is declared.
select ok(position('private.growth_mailbox_record(p_contact, p_result)' in pg_get_functiondef('private.growth_mailbox_record(uuid,text,text)'::regprocedure)) > 0,
  'The reason follows the address check''s own answer');
select ok(hub.get_backend_contract() -> 'features' ? 'platform.agents.growth-diagnostics.v1', 'The diagnostics feature is declared');

select * from finish();
rollback;
