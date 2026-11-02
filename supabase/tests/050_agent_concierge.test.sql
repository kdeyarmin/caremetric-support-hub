begin;
select plan(20);

-- The boundary: three reads for the Hub server role, and nobody else. What they return is covered by
-- server/agents-concierge-integration.mjs, which runs them as hub_app_server.
select ok(p.prosecdef and p.proconfig @> array['search_path=""'],
  'The pending conversations operation is a security definer with a pinned empty search path')
from pg_proc p where p.oid = to_regprocedure('private.agent_concierge_pending(integer,integer,integer,text[])');
select ok(p.prosecdef and p.proconfig @> array['search_path=""'],
  'The conversation snapshot operation is a security definer with a pinned empty search path')
from pg_proc p where p.oid = to_regprocedure('private.agent_communication_snapshot(uuid,uuid,integer,integer)');
select ok(p.prosecdef and p.proconfig @> array['search_path=""'],
  'The alert count operation is a security definer with a pinned empty search path')
from pg_proc p where p.oid = to_regprocedure('private.agent_notification_count(text,text,timestamptz)');

select ok(has_function_privilege('hub_app_server', 'private.agent_concierge_pending(integer,integer,integer,text[])', 'execute'),
  'The Hub server role reads the pending conversations');
select ok(has_function_privilege('hub_app_server', 'private.agent_communication_snapshot(uuid,uuid,integer,integer)', 'execute'),
  'The Hub server role reads a conversation snapshot');
select ok(has_function_privilege('hub_app_server', 'private.agent_notification_count(text,text,timestamptz)', 'execute'),
  'The Hub server role counts alerts');

select ok(not bool_or(has_function_privilege(role_name, 'private.agent_concierge_pending(integer,integer,integer,text[])', 'execute')),
  'No browser, service or public role reads the pending conversations')
from unnest(array['public', 'anon', 'authenticated', 'service_role']) as role_name;
select ok(not bool_or(has_function_privilege(role_name, 'private.agent_communication_snapshot(uuid,uuid,integer,integer)', 'execute')),
  'No browser, service or public role reads a conversation snapshot')
from unnest(array['public', 'anon', 'authenticated', 'service_role']) as role_name;
select ok(not bool_or(has_function_privilege(role_name, 'private.agent_notification_count(text,text,timestamptz)', 'execute')),
  'No browser, service or public role counts alerts')
from unnest(array['public', 'anon', 'authenticated', 'service_role']) as role_name;

-- Every operation refuses a session user other than the Hub server, before it looks at its arguments.
select throws_ok($$select private.agent_concierge_pending(10, 90, 72, null)$$, '42501', 'Application server required.',
  'Listing pending conversations refuses every session user other than the Hub server');
select throws_ok($$select private.agent_communication_snapshot('00000000-0000-4000-8000-000000000000', null, 0, 1000)$$, '42501', 'Application server required.',
  'Reading a conversation refuses every session user other than the Hub server');
select throws_ok($$select private.agent_notification_count('concierge:', null, now())$$, '42501', 'Application server required.',
  'Counting alerts refuses every session user other than the Hub server');

set local role authenticated;
select throws_ok($$select private.agent_communication_snapshot('00000000-0000-4000-8000-000000000000', null, 10, 4000)$$, '42501',
  'permission denied for function agent_communication_snapshot', 'Signed-in users cannot read a conversation through the Concierge operation');
select throws_ok($$select private.agent_concierge_pending(10, 90, 72, null)$$, '42501',
  'permission denied for function agent_concierge_pending', 'Signed-in users cannot list pending conversations');
reset role;
set local role anon;
select throws_ok($$select private.agent_communication_snapshot('00000000-0000-4000-8000-000000000000', null, 10, 4000)$$, '42501', null,
  'Anonymous callers cannot read a conversation through the Concierge operation');
select throws_ok($$select private.agent_notification_count('concierge:', null, now())$$, '42501', null,
  'Anonymous callers cannot count alerts');
reset role;

-- The schedule and the settings.
select is((select every_seconds from private.agent_schedules where agent_key = 'support_concierge' and task_kind = 'concierge.sweep'),
  300, 'The sweep for new conversations runs every five minutes');
select is((select config - 'effort' - 'auto_approve_kinds' from private.agents where key = 'support_concierge'),
  '{"channels": ["email", "chat", "web_form", "phone"], "window_hours": 72, "settle_seconds": 90}'::jsonb,
  'The Concierge watches email, chat, web form and phone-line messages, and leaves text messages off');
select is((select config -> 'auto_approve_kinds' from private.agents where key = 'support_concierge'),
  '[]'::jsonb, 'Nothing the Concierge proposes is ever approved without the owner');
select ok(hub.get_backend_contract() -> 'features' @> '["platform.agents.concierge.v1"]'::jsonb,
  'The Support Concierge is declared in release metadata');

select * from finish();
rollback;
