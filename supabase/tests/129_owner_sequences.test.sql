begin;
select plan(9);

-- The owner's own email sequences (20261127150000_owner_sequences.sql).
select is((select kind from private.hub_settings where key = 'growth.owner_sequences'), 'flag', 'Sending your own sequences is a switch');
select ok((hub.get_backend_contract() -> 'features') ? 'platform.agents.owner-sequences.v1', 'The owner sequences feature is declared');
select ok(not bool_or(has_table_privilege(role_name, table_name, 'SELECT,INSERT,UPDATE,DELETE')),
  'The sequence tables and the do-not-contact list are closed to every role')
from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) role_name,
  unnest(array['private.owner_sequences', 'private.owner_sequence_recipients', 'private.owner_sequence_messages', 'private.owner_sequence_events',
    'private.outreach_do_not_contact']) table_name;
select throws_ok('select private.owner_sequence_claim()', '42501', 'Application server required.', 'Only the Hub server claims an email');
set local role authenticated;
select throws_ok($$select hub.owner_sequence_create('{}'::jsonb)$$, '28000', null, 'A signed-in user without an owner session cannot save a sequence');
reset role;
select ok(position('outreach_do_not_contact' in pg_get_functiondef('private.growth_outreach_stopped(uuid)'::regprocedure)) > 0,
  'The Marketing Manager''s cold email reads the do-not-contact list');
select ok(position('owner_sequence_contact' in pg_get_functiondef('private.agent_answer_begin(uuid,integer,text[])'::regprocedure)) > 0
  and position('owner_sequence_contact' in pg_get_functiondef('private.agent_acknowledge_begin(uuid,integer,text[])'::regprocedure)) > 0,
  'The Support Concierge leaves a sequence''s person to the owner');
select is(private.owner_sequence_own_words(E'No thanks.\n\nOn Tue, Kevin wrote:\n> Reply "no thanks"'), E'\nno thanks.', 'A reply is read from the sender''s own words');
select ok(exists (select 1 from private.agent_schedules where agent_key = 'marketing_manager' and task_kind = 'growth.sequences'),
  'The Marketing Manager''s sequence task is scheduled');

select * from finish();
rollback;
