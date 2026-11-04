begin;
select plan(37);

-- ---------------------------------------------------------------------------------------
-- The boundary: the table is closed, the server operations belong to the Hub server, the owner operations to signed-in sessions,
-- and the helpers to nobody.
-- ---------------------------------------------------------------------------------------
select ok(not bool_or(has_table_privilege(role_name, 'private.agent_autonomy_steps', 'select,insert,update,delete')),
  'No browser, service or server role can touch the autonomy steps table')
from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) role_name;
select ok(bool_and(p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false)),
  'Every autonomy operation is a security definer with a pinned empty search path')
from unnest(array['private.agent_autonomy_due()', 'private.agent_autonomy_graduate(text)', 'hub.get_agent_autonomy()',
  'hub.set_agent_autonomy_step(text,text,timestamp with time zone)', 'private.agent_autonomy_apply(text,text,uuid,text)',
  'private.agent_autonomy_change(text,jsonb,boolean)']) signature join pg_proc p on p.oid = to_regprocedure(signature);
select ok(bool_and(has_function_privilege('hub_app_server', signature, 'execute'))
    and not bool_or(has_function_privilege(role_name, signature, 'execute')),
  'Only the Hub server runs the server operations')
from unnest(array['private.agent_autonomy_due()', 'private.agent_autonomy_graduate(text)', 'private.agent_autonomy_announced(text,timestamp with time zone)']) signature
cross join unnest(array['anon', 'authenticated', 'service_role']) role_name;
select ok(bool_and(has_function_privilege('authenticated', signature, 'execute'))
    and not bool_or(has_function_privilege(role_name, signature, 'execute')),
  'Only signed-in sessions run the owner operations')
from unnest(array['hub.get_agent_autonomy()', 'hub.set_agent_autonomy_step(text,text,timestamp with time zone)']) signature
cross join unnest(array['anon', 'service_role']) role_name;
select ok(not bool_or(has_function_privilege(role_name, signature, 'execute')), 'No role runs the internal helpers directly')
from unnest(array['private.agent_autonomy_step_json(private.agent_autonomy_steps)', 'private.agent_autonomy_change(text,jsonb,boolean)',
  'private.agent_autonomy_apply(text,text,uuid,text)']) signature
cross join unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) role_name;

select throws_ok('select private.agent_autonomy_due()', '42501', 'Application server required.', 'Reading due steps needs the Hub server');
select throws_ok($$select private.agent_autonomy_graduate('account_emails')$$, '42501', 'Application server required.', 'Graduating a step needs the Hub server');
set local role authenticated;
select throws_ok('select hub.get_agent_autonomy()', '28000', null, 'A signed-in user without an administrator session cannot read the steps');
select throws_ok($$select hub.set_agent_autonomy_step('account_emails', 'automatic', now())$$, '28000', null,
  'A signed-in user without a current administrator session cannot change a step');
reset role;
set local role anon;
select throws_ok('select hub.get_agent_autonomy()', '42501', null, 'Anonymous callers cannot read the steps');
reset role;

-- ---------------------------------------------------------------------------------------
-- What ships: four steps, all off, and the hourly check.
-- ---------------------------------------------------------------------------------------
select ok(hub.get_backend_contract() -> 'features' @> '["platform.agents.autonomy.v1"]'::jsonb, 'Autonomy steps are declared in release metadata');
select is((select array_agg(category || ':' || status order by category) from private.agent_autonomy_steps),
  array['account_emails:off', 'articles:off', 'offers:off', 'support_answers:off'], 'Four steps ship, all off');
select ok((select count(*) = 1 from private.agent_schedules where agent_key = 'chief_of_staff' and task_kind = 'autonomy.graduate'
  and cadence = 'interval' and every_seconds = 3600 and not requires_session), 'The Chief of Staff checks the steps every hour');
select is((select (private.agent_autonomy_step_json(s)) ->> 'ready' from private.agent_autonomy_steps s where category = 'account_emails'), 'true',
  'Account emails are ready: their code is on the Hub');
select ok((select bool_and(((private.agent_autonomy_step_json(s)) ->> 'ready')::boolean = coalesce((hub.get_backend_contract() -> 'features') ? s.requires_feature, false))
  from private.agent_autonomy_steps s), 'A step is ready exactly when its feature is declared');

-- ---------------------------------------------------------------------------------------
-- A supervised week, then automatic, then back to approving.
-- ---------------------------------------------------------------------------------------
-- The owner had switched one template on by hand: a supervised week takes it off too, or it would go out unapproved all week.
update private.agents set autonomy = 'observe', config = config || '{"auto_send_templates": ["welcome"]}'::jsonb where key = 'account_manager';
select lives_ok($$select private.agent_autonomy_apply('account_emails', 'supervise', null, 'test')$$, 'A supervised week starts');
select is((select status from private.agent_autonomy_steps where category = 'account_emails'), 'supervised', 'The step is supervised');
select ok((select automatic_at between now() + interval '7 days' - interval '1 minute' and now() + interval '7 days' + interval '1 minute'
  from private.agent_autonomy_steps where category = 'account_emails'), 'It becomes automatic a week from now');
select is((select autonomy from private.agents where key = 'account_manager'), 'propose', 'The Account Manager now proposes its emails for approval');
select is((select config -> 'auto_send_templates' from private.agents where key = 'account_manager'), '[]'::jsonb,
  'Nothing is sent on its own during the week, a template switched on by hand included');

select lives_ok($$select private.agent_autonomy_apply('account_emails', 'automatic', null, 'schedule')$$, 'The schedule switches the step to automatic');
select ok((select announce_pending from private.agent_autonomy_steps where category = 'account_emails'), 'A switch the schedule made waits to be announced');
select ok(position('for update' in pg_get_functiondef('hub.set_agent_autonomy_step(text,text,timestamp with time zone)'::regprocedure)) > 0,
  'The owner''s change locks the step before comparing its version');
select is((select autonomy from private.agents where key = 'account_manager'), 'act', 'The Account Manager acts');
select is((select config -> 'auto_send_templates' from private.agents where key = 'account_manager'),
  '["setup_nudge", "testimonial_ask", "trial_checkin", "welcome"]'::jsonb, 'All four account emails send on their own');
select is((select (private.agent_autonomy_apply('account_emails', 'automatic', null, 'test')) ->> 'status'), 'automatic',
  'Making an automatic step automatic again changes nothing');

-- Another step on the same agent: taking one back keeps the other's values.
update private.agents set config = jsonb_set(config, '{auto_approve_kinds}', '["growth.message"]') where key = 'account_manager';
select lives_ok($$select private.agent_autonomy_apply('account_emails', 'hold', null, 'test')$$, 'The owner keeps approving');
select is((select status from private.agent_autonomy_steps where category = 'account_emails'), 'held', 'The step is held');
select is((select config -> 'auto_send_templates' from private.agents where key = 'account_manager'), '[]'::jsonb,
  'The account emails are taken back off the list');
select is((select config -> 'auto_approve_kinds' from private.agents where key = 'account_manager'), '["growth.message"]'::jsonb,
  'What another step or the owner added is left alone');
select ok((select count(*) = 3 from private.audit_events where action = 'agent.autonomy_step' and metadata ->> 'category' = 'account_emails'
  and metadata ->> 'source' in ('test', 'schedule')), 'Each change is audited, and one that changes nothing is not');
select ok(not (select announce_pending from private.agent_autonomy_steps where category = 'account_emails'), 'Holding a step clears a pending announcement');

-- Refusals.
update private.agent_autonomy_steps set requires_feature = 'platform.agents.never-declared.v1' where category = 'offers';
select throws_ok($$select private.agent_autonomy_apply('offers', 'automatic', null, 'test')$$, '55000', null,
  'A step whose code is not on the Hub cannot become automatic');
select throws_ok($$select private.agent_autonomy_apply('nothing', 'hold', null, 'test')$$, 'P0002', null, 'An unknown step is refused');
select throws_ok($$select private.agent_autonomy_apply('account_emails', 'sometimes', null, 'test')$$, '22023', null, 'An unknown action is refused');
select throws_ok($$update private.agent_autonomy_steps set status = 'supervised', automatic_at = null where category = 'offers'$$, '23514', null,
  'A supervised step always has an end date');
select throws_ok($$select private.agent_autonomy_announced('account_emails', now())$$, '42501', 'Application server required.', 'Recording an announcement needs the Hub server');

select * from finish();
rollback;
