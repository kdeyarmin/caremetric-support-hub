-- Declares platform.agents.support-truth.v1 once stage 5 of the team review is in place (20261117240000_support_truth.sql): the
-- acknowledgment is a checked action kind that admits only the standard text, recorded by a security definer the Hub server alone may
-- run, which re-checks the owner's switch, the Concierge's trust and the sender; the owner's switch has a row; an acknowledgment is not
-- counted as an answer; the Concierge's snapshot carries the account flags; the watchdog, scorecard and strategist facts carry what
-- stage 5 reads; and the strategist's notes accept `paying`. Each test fails closed.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.support-truth.v1';
  begin_fn constant text := 'private.agent_acknowledge_begin(uuid,integer,text[])';
  helper constant text := 'private.agent_growth_acknowledgment(uuid)';
  definition text;
  r text;
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.concierge-autosend.v1","platform.agents.trial-path.v1","platform.agents.watchdog.v1","platform.agents.strategist.v1","platform.settings.v1"]}'::jsonb) is not true then
    raise exception 'Apply the support answers, trial path, watchdog, strategist and settings migrations first' using errcode = '55000';
  end if;
  if not coalesce((select position('''communication.acknowledge''' in pg_get_constraintdef(oid)) > 0 from pg_constraint
                   where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_kind_check'), false)
    or not coalesce((select position('''standard''' in pg_get_constraintdef(oid)) > 0
                       and position('Thank you for contacting CareMetric Support. We have your message and a member of our team will review it and reply here.' in pg_get_constraintdef(oid)) > 0
                     from pg_constraint where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_communication_acknowledge_check'), false) then
    raise exception 'The acknowledgment must be a checked action kind that admits only the standard text' using errcode = '55000';
  end if;
  if to_regprocedure(begin_fn) is null
    or not coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(begin_fn)), false)
    or not has_function_privilege('hub_app_server', begin_fn, 'execute')
    or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) x where has_function_privilege(x, begin_fn, 'execute')) then
    raise exception 'Recording an acknowledgment must be a security definer executable by the Hub server only' using errcode = '55000';
  end if;
  definition := pg_get_functiondef(to_regprocedure(begin_fn));
  if position('private.require_hub_app_server()' in definition) = 0
    or position('agents.auto_acknowledge' in definition) = 0
    or position('v_agent.autonomy is distinct from ''act''' in definition) = 0
    or position('where key = v_action.agent_key for share' in definition) = 0
    or position('not_a_person' in definition) = 0
    or position('target_mismatch' in definition) = 0
    or position('a1a00000-a1a0-4000-8000-000000000001' in definition) = 0 then
    raise exception 'Recording an acknowledgment must re-check the switch, the Concierge''s trust and the sender' using errcode = '55000';
  end if;
  if not exists (select 1 from private.hub_settings where key = 'agents.auto_acknowledge' and kind = 'flag') then
    raise exception 'The acknowledgment switch is missing' using errcode = '55000';
  end if;
  if to_regprocedure(helper) is null
    or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) x where has_function_privilege(x, helper, 'execute'))
    or position('agent_growth_acknowledgment' in pg_get_functiondef('private.agent_growth_waiting()'::regprocedure)) = 0
    or position('agent_growth_acknowledgment' in pg_get_functiondef('private.agent_growth_facts_json(timestamptz,timestamptz)'::regprocedure)) = 0 then
    raise exception 'An acknowledgment must not count as the answer to a lead' using errcode = '55000';
  end if;
  if position('''account''' in pg_get_functiondef('private.agent_communication_snapshot(uuid,uuid,integer,integer)'::regprocedure)) = 0
    or position('''lastTaskAt''' in pg_get_functiondef('private.agent_watchdog_facts()'::regprocedure)) = 0
    or position('''skipped14d''' in pg_get_functiondef('private.agent_watchdog_facts()'::regprocedure)) = 0
    or position('marketingSpendCents' in pg_get_functiondef('private.agent_scorecard_facts_before_lifecycle(timestamptz,timestamptz)'::regprocedure)) = 0
    or position('''noCard''' in pg_get_functiondef('private.growth_strategy_facts_json(timestamptz,timestamptz)'::regprocedure)) = 0
    or position('''trialsLost''' in pg_get_functiondef('private.growth_strategy_facts_json(timestamptz,timestamptz)'::regprocedure)) = 0 then
    raise exception 'The snapshot, watchdog, scorecard and strategist facts must carry what stage 5 reads' using errcode = '55000';
  end if;
  if position('''paying''' in coalesce((select pg_get_constraintdef(oid) from pg_constraint
        where conrelid = 'private.agent_strategy_notes'::regclass and conname = 'agent_strategy_notes_constraint_key_check'), '')) = 0
    or position('''paid''' in coalesce((select pg_get_constraintdef(oid) from pg_constraint
        where conrelid = 'private.agent_strategy_notes'::regclass and conname = 'agent_strategy_notes_watch_check'), '')) = 0 then
    raise exception 'The strategist''s notes must accept trials ending unpaid' using errcode = '55000';
  end if;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(r, 'private.agent_communication_snapshot(uuid,uuid,integer,integer)', 'execute') then
      raise exception 'The Concierge''s snapshot must stay the server''s' using errcode = '55000';
    end if;
  end loop;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
