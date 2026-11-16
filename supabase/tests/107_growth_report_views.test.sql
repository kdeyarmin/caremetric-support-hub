begin;
select plan(6);

select is((select kind from private.hub_settings where key = 'growth.report_views'), 'flag', 'Report views are a switch');
select ok(position('report_viewed' in (select pg_get_constraintdef(oid) from pg_constraint
  where conrelid = 'private.customer_activity_events'::regclass and conname = 'customer_activity_events_kind_check')) > 0, 'An activity event may be a report open');
select ok((select relrowsecurity from pg_class where oid = 'private.growth_report_view_sync'::regclass)
  and not has_table_privilege('hub_app_server', 'private.growth_report_view_sync', 'select'), 'Nobody reads the cursor directly');
select ok(has_function_privilege('hub_app_server', 'private.growth_report_views_record(jsonb,bigint)', 'execute')
  and not has_function_privilege('authenticated', 'private.growth_report_views_record(jsonb,bigint)', 'execute')
  and not has_function_privilege('service_role', 'private.growth_report_views_cursor()', 'execute'), 'Only the server records opens');
select is((select every_seconds from private.agent_schedules where agent_key = 'marketing_manager' and task_kind = 'growth.views'), 900, 'Opens are read every 15 minutes');
select ok(hub.get_backend_contract() -> 'features' ? 'platform.agents.growth-report-views.v1', 'The report views feature is declared');

select * from finish();
rollback;
