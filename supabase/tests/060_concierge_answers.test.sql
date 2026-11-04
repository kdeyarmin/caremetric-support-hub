begin;
select plan(9);

select ok(hub.get_backend_contract() -> 'features' @> '["platform.agents.concierge-autosend.v1"]'::jsonb, 'Support answers are declared in release metadata');
select ok((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = 'private.agent_answer_begin(uuid,integer,text[])'::regprocedure),
  'Recording an answer is a security definer with a pinned empty search path');
select ok(has_function_privilege('hub_app_server', 'private.agent_answer_begin(uuid,integer,text[])', 'execute')
  and not bool_or(has_function_privilege(role_name, 'private.agent_answer_begin(uuid,integer,text[])', 'execute')),
  'Only the Hub server records an answer')
from unnest(array['public', 'anon', 'authenticated', 'service_role']) role_name;
select throws_ok($$select private.agent_answer_begin(gen_random_uuid(), 1, array['email'])$$, '42501', 'Application server required.', 'Every other session user is refused');
select ok(position('''communication.answer''' in (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_kind_check')) > 0,
  'communication.answer is an allowed action kind');
select ok(position('''communication.reply''' in (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_kind_check')) > 0
  and position('''content.publish''' in (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_kind_check')) > 0,
  'The kinds earlier changes added are kept');

-- The shape: a task to hang proposals on, then one answer the table admits and two it does not.
insert into private.agent_tasks (id, agent_key, kind, request_key, status, attempts, lease_until)
values ('a5a5a5a5-0000-4000-8000-000000000001', 'support_concierge', 'concierge.communication', 'pgtap-answers', 'running', 1, now() + interval '5 minutes');
select lives_ok($$insert into private.agent_actions (agent_key, task_id, kind, target_kind, target_id, preview, input, status, expires_at)
  values ('support_concierge', 'a5a5a5a5-0000-4000-8000-000000000001', 'communication.answer', 'communication', 'CM-7', 'Hello',
    '{"communicationId": "a5a5a5a5-0000-4000-8000-000000000002", "reference": 7, "channel": "email", "route": "email", "basedOnMessageId": "a5a5a5a5-0000-4000-8000-000000000003",
      "body": "Hello", "classification": {"category": "general", "phi": false, "drafted": true}, "template": "drafted", "sources": ["A guide"]}', 'proposed', now() + interval '7 days')$$,
  'A cited drafted answer with no identifiers, by email, is admitted');
select throws_ok($$insert into private.agent_actions (agent_key, task_id, kind, target_kind, target_id, preview, input, status, expires_at)
  values ('support_concierge', 'a5a5a5a5-0000-4000-8000-000000000001', 'communication.answer', 'communication', 'CM-8', 'Hello',
    '{"communicationId": "a5a5a5a5-0000-4000-8000-000000000002", "reference": 8, "channel": "email", "route": "email", "basedOnMessageId": "a5a5a5a5-0000-4000-8000-000000000003",
      "body": "Hello", "classification": {"category": "general", "phi": true, "drafted": true}, "template": "drafted", "sources": ["A guide"]}', 'proposed', now() + interval '7 days')$$,
  '23514', null, 'A message with identifiers can never be answered on its own');
select throws_ok($$insert into private.agent_actions (agent_key, task_id, kind, target_kind, target_id, preview, input, status, expires_at)
  values ('support_concierge', 'a5a5a5a5-0000-4000-8000-000000000001', 'communication.answer', 'communication', 'CM-9', 'Hello',
    '{"communicationId": "a5a5a5a5-0000-4000-8000-000000000002", "reference": 9, "channel": "email", "route": "email", "basedOnMessageId": "a5a5a5a5-0000-4000-8000-000000000003",
      "body": "Hello", "classification": {"category": "general", "phi": false, "drafted": true}, "template": "standard", "sources": ["A guide"]}', 'proposed', now() + interval '7 days')$$,
  '23514', null, 'A fixed acknowledgment is a reply the owner sends, never an answer');

select * from finish();
rollback;
