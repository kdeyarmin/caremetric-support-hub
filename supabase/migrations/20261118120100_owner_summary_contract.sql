-- Declares platform.agents.owner-summary.v1 once the end-of-day summary is in place (20261118120000_owner_summary.sql): its three
-- settings have rows of the right kinds, an owner notification can be held for the summary (and only a held one says why), holding a
-- message and reading the summary's facts are security definers with a pinned empty search path that only the Hub server may run, and
-- the Chief of Staff's summary.daily task is scheduled.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.owner-summary.v1';
  server_fns constant text[] := array['private.agent_notify_hold(uuid,text)', 'private.agent_summary_facts(timestamptz,timestamptz)'];
  fn text;
begin
  if (contract @> '{"api_version":4,"features":["platform.settings.v1","platform.agents.hardening.v1"]}'::jsonb) is not true then
    raise exception 'Apply the settings and AI team hardening migrations first' using errcode = '55000';
  end if;
  if (select count(*) from private.hub_settings
      where (key, kind) in (('agents.daily_summary', 'flag'), ('agents.summary_hour', 'number'), ('agents.approvals_right_away', 'flag'))) <> 3 then
    raise exception 'The summary''s three settings must have rows' using errcode = '55000';
  end if;
  if not coalesce((select position('''held''' in pg_get_constraintdef(oid)) > 0 from pg_constraint
                   where conrelid = 'private.owner_notifications'::regclass and conname = 'owner_notifications_status_check'), false)
     or not exists (select 1 from pg_constraint where conrelid = 'private.owner_notifications'::regclass and conname = 'owner_notifications_held_attention') then
    raise exception 'An owner notification must be able to be held, and only a held one may say why' using errcode = '55000';
  end if;
  foreach fn in array server_fns loop
    if to_regprocedure(fn) is null or not has_function_privilege('hub_app_server', fn, 'execute')
       or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r where has_function_privilege(r, fn, 'execute'))
       or position('private.require_hub_app_server()' in pg_get_functiondef(fn::regprocedure)) = 0
       or not coalesce((select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p where p.oid = fn::regprocedure), false) then
      raise exception 'Only the Hub server may run %', fn using errcode = '55000';
    end if;
  end loop;
  -- Never a text, never an urgent alert.
  if position('channel = ''email''' in pg_get_functiondef('private.agent_notify_hold(uuid,text)'::regprocedure)) = 0
     or position('severity <> ''urgent''' in pg_get_functiondef('private.agent_notify_hold(uuid,text)'::regprocedure)) = 0 then
    raise exception 'Only an email that is not urgent may be held' using errcode = '55000';
  end if;
  if not exists (select 1 from private.agent_schedules where agent_key = 'chief_of_staff' and task_kind = 'summary.daily' and cadence = 'daily') then
    raise exception 'The Chief of Staff''s end-of-day summary must be scheduled' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
