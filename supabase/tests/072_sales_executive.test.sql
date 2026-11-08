begin;
select plan(8);

select ok(hub.get_backend_contract() -> 'features' @> '["platform.agents.sales-executive.v1"]'::jsonb, 'The Sales Executive is declared in release metadata');

select is((select jsonb_build_array(display_name, status, autonomy, model_tier, daily_budget_cents, config -> 'auto_approve_kinds') from private.agents where key = 'sales_executive'),
  '["Sales Executive", "paused", "propose", "draft", 300, []]'::jsonb, 'The Sales Executive starts paused, in Propose, trusted with nothing');

select ok(exists (select 1 from private.agent_schedules where agent_key = 'sales_executive' and task_kind = 'sales.review' and cadence = 'daily'
  and at_local = '07:45' and timezone = 'America/New_York' and not requires_session), 'Its weekly pipeline review is scheduled every morning');

select is((select jsonb_build_array(status, changes) from private.agent_autonomy_steps where category = 'sales_answers'),
  '["off", [{"agent": "sales_executive", "values": ["communication.answer"], "config_key": "auto_approve_kinds"}]]'::jsonb,
  '"Sales answers" ships off and hands over drafted answers alone');

select ok((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = 'private.sales_handoff(uuid,uuid)'::regprocedure),
  'The hand-off is a security definer with a pinned empty search path');
select ok(has_function_privilege('hub_app_server', 'private.sales_handoff(uuid,uuid)', 'execute'), 'The Hub server can hand a prospect over');
select ok(not bool_or(has_function_privilege(role_name, 'private.sales_handoff(uuid,uuid)', 'execute')), 'No browser or service role can')
from unnest(array['public', 'anon', 'authenticated', 'service_role']) role_name;

select throws_ok($$select private.sales_handoff(gen_random_uuid(), gen_random_uuid())$$, '42501', null, 'Any other session is refused before anything is read');

select * from finish();
rollback;
