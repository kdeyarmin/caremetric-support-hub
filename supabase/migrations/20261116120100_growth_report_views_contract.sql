-- Declares platform.agents.growth-report-views.v1 once the setting exists, an activity event may be a report open, the read cursor is
-- closed to every role, only the Hub server may read the cursor and record opens, an open counts only after the first email was sent, and
-- the Marketing Manager's growth.views task is scheduled.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.growth-report-views.v1';
  server_fns constant text[] := array['private.growth_report_views_cursor()', 'private.growth_report_views_record(jsonb,bigint)'];
  fn text;
begin
  if (contract @> '{"api_version":4,"features":["platform.settings.v1","platform.agents.growth-autonomy.v1","platform.agents.growth-roster.v1"]}'::jsonb) is not true then
    raise exception 'Apply the Hub settings, growth autonomy and roster migrations first' using errcode = '55000';
  end if;
  if not exists (select 1 from private.hub_settings where key = 'growth.report_views' and kind = 'flag') then
    raise exception 'The report views setting is missing' using errcode = '55000';
  end if;
  if coalesce(position('report_viewed' in (select pg_get_constraintdef(oid) from pg_constraint
       where conrelid = 'private.customer_activity_events'::regclass and conname = 'customer_activity_events_kind_check')), 0) = 0 then
    raise exception 'Activity events need the report_viewed kind' using errcode = '55000';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'private.growth_report_view_sync'::regclass)
    or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r
               where has_table_privilege(r, 'private.growth_report_view_sync', 'select') or has_table_privilege(r, 'private.growth_report_view_sync', 'update')) then
    raise exception 'The report view cursor must be closed to every role' using errcode = '55000';
  end if;
  foreach fn in array server_fns loop
    if not has_function_privilege('hub_app_server', fn, 'execute')
      or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r where has_function_privilege(r, fn, 'execute'))
      or position('private.require_hub_app_server()' in pg_get_functiondef(fn::regprocedure)) = 0 then
      raise exception 'Only the Hub server may run %', fn using errcode = '55000';
    end if;
  end loop;
  if position('v_first + interval ''2 minutes''' in pg_get_functiondef('private.growth_report_views_record(jsonb,bigint)'::regprocedure)) = 0 then
    raise exception 'An open must count only after the first email was sent' using errcode = '55000';
  end if;
  if not exists (select 1 from private.agent_schedules where agent_key = 'marketing_manager' and task_kind = 'growth.views') then
    raise exception 'The Marketing Manager''s report views task is not scheduled' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
