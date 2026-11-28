-- Declares platform.agents.state-launches.v1 once state launches (20261128100000) are in place: the settings exist, the launches and their
-- facilities are closed to every role, the Hub server's functions are its alone and require its connection, the owner's commands require
-- the owner, a launch is worked on only while "Build state launches in Instantly" is on, every lead is checked against the do-not-contact
-- list, an opt-out reported by Instantly reaches that list, and the Marketing Manager's task is scheduled.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.state-launches.v1';
  d text;
  fn text;
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.owner-sequence-guard.v1","platform.agents.growth-people.v1"]}'::jsonb) is not true then
    raise exception 'Apply the owner sequence guard and growth people migrations first' using errcode = '55000';
  end if;
  if (select count(*) from private.hub_settings where key in ('outreach.instantly', 'outreach.instantly_senders', 'outreach.instantly_daily_limit',
      'outreach.instantly_states', 'outreach.local_counties', 'outreach.hunter_per_launch')) <> 6 then
    raise exception 'The state launch settings are missing' using errcode = '55000';
  end if;
  if exists (select 1 from unnest(array['private.state_launches', 'private.state_launch_targets']) t
             where not (select c.relrowsecurity from pg_class c where c.oid = t::regclass)
               or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) x
                          where has_table_privilege(x, t, 'select,insert,update,delete'))) then
    raise exception 'The state launches must be closed to hub_app_server and every other role' using errcode = '55000';
  end if;
  foreach fn in array array['private.state_launch_next()', 'private.state_launch_save(uuid,jsonb)', 'private.state_launch_add_targets(uuid,jsonb)',
      'private.state_launch_pending(uuid,integer)', 'private.state_launch_target_save(uuid,jsonb)', 'private.state_launch_leads(uuid)',
      'private.state_launch_mark(jsonb,text,text,text)', 'private.state_launch_event(text,text,text)', 'private.state_launch_report_claim(uuid)'] loop
    if exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) x where has_function_privilege(x, fn, 'execute'))
       or not has_function_privilege('hub_app_server', fn, 'execute')
       or position('require_hub_app_server' in pg_get_functiondef(fn::regprocedure)) = 0 then
      raise exception 'The state launch functions must be the Hub server''s alone and require its connection' using errcode = '55000';
    end if;
  end loop;
  foreach fn in array array['hub.state_launches()', 'hub.state_launch_detail(uuid)', 'hub.state_launch_request(text)', 'hub.state_launch_approve(uuid)',
      'hub.state_launch_more(uuid)', 'hub.state_launch_cancel(uuid)'] loop
    d := pg_get_functiondef(fn::regprocedure);
    if has_function_privilege('anon', fn, 'execute') or has_function_privilege('service_role', fn, 'execute')
       or (position('authorize_app_admin' in d) = 0 and position('authorize_app_command' in d) = 0) then
      raise exception 'The state launch commands must require the owner' using errcode = '55000';
    end if;
  end loop;
  if position('''outreach.instantly''' in pg_get_functiondef('private.state_launch_next()'::regprocedure)) = 0 then
    raise exception 'A launch must be worked on only while the setting is on' using errcode = '55000';
  end if;
  if position('owner_sequence_check_people' in pg_get_functiondef('private.state_launch_leads(uuid)'::regprocedure)) = 0 then
    raise exception 'Every lead must be checked against the do-not-contact list' using errcode = '55000';
  end if;
  d := pg_get_functiondef('private.state_launch_event(text,text,text)'::regprocedure);
  if position('outreach_do_not_contact' in d) = 0 or position('email_suppressions' in d) = 0 or position('growth_free_mail' in d) = 0 then
    raise exception 'An opt-out Instantly reports must reach the do-not-contact list' using errcode = '55000';
  end if;
  if not exists (select 1 from private.agent_schedules where agent_key = 'marketing_manager' and task_kind = 'outreach.launch') then
    raise exception 'The Marketing Manager''s state launch task is not scheduled' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
