-- Declares platform.agents.growth-priority.v1 once the work recovery, report views, account brief, learning, address check and colleague
-- features are declared; the new server operations (the three-argument deferral, the quiet prospects, the Sales Executive's context, the
-- ready queue and the memo's facts) are executable by the Hub server alone and require its connection; the helpers are closed to every
-- role; the six settings have rows; and each change of stage 2 of the 2026-11-17 review is in place (the claim's send hours, the snapshot's
-- band and first form, briefs only for an agency that can be emailed, a report open bringing the second email forward, and the memo's
-- opens and weaknesses).
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.growth-priority.v1';
  server_fns constant text[] := array['private.growth_defer_action(uuid,integer,text)', 'private.growth_quiet_candidates(integer)',
    'private.sales_growth_context(uuid,uuid)', 'private.agent_actions_ready(integer,text[],text[])', 'private.growth_learning_facts(text,integer)'];
  helper_fns constant text[] := array['private.growth_send_priority_on()', 'private.growth_priority_band(uuid)', 'private.growth_action_score(uuid)',
    'private.growth_next_send_at(timestamptz)', 'private.growth_report_open_followup()', 'private.sales_growth_context_read(uuid,uuid)'];
  fn text;
begin
  if (contract @> '{"api_version":4,"features":["platform.settings.v1","platform.agents.work-recovery.v1","platform.agents.growth-report-views.v1","platform.agents.growth-brief.v1","platform.agents.growth-learning.v1","platform.agents.growth-address-check.v1","platform.agents.growth-colleagues.v1"]}'::jsonb) is not true then
    raise exception 'Apply the work recovery, report views, account brief, learning, address check and colleague migrations first' using errcode = '55000';
  end if;
  foreach fn in array server_fns loop
    if to_regprocedure(fn) is null or not has_function_privilege('hub_app_server', fn, 'execute')
      or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r where has_function_privilege(r, fn, 'execute'))
      or position('private.require_hub_app_server()' in pg_get_functiondef(fn::regprocedure)) = 0 then
      raise exception 'Only the Hub server may run %', fn using errcode = '55000';
    end if;
  end loop;
  foreach fn in array helper_fns loop
    if to_regprocedure(fn) is null
      or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r where has_function_privilege(r, fn, 'execute')) then
      raise exception '% must be closed to every role', fn using errcode = '55000';
    end if;
  end loop;
  if (select count(*) from private.hub_settings where key in ('growth.send_priority', 'growth.send_from_hour', 'growth.send_until_hour',
      'growth.short_first_email', 'growth.quiet_followup', 'growth.sales_context')) <> 6 then
    raise exception 'The six stage 2 settings must have rows' using errcode = '55000';
  end if;
  if position('outside_hours' in pg_get_functiondef('private.growth_claim_message(uuid,uuid)'::regprocedure)) = 0
    or position('c.eligibility<>''permitted''' in pg_get_functiondef('private.growth_claim_message(uuid,uuid)'::regprocedure)) = 0 then
    raise exception 'The send claim must hold cold email outside the owner''s send hours' using errcode = '55000';
  end if;
  if position('growth_send_priority_on' in pg_get_functiondef('private.agent_actions_ready(integer,text[],text[])'::regprocedure)) = 0
    or position('not_before' in pg_get_functiondef('private.agent_actions_ready(integer,text[],text[])'::regprocedure)) = 0 then
    raise exception 'The ready queue must put the best growth emails first while the owner''s switch is on' using errcode = '55000';
  end if;
  if position('as priority_band' in pg_get_functiondef('private.growth_snapshot(integer)'::regprocedure)) = 0
    or position('as first_form' in pg_get_functiondef('private.growth_snapshot(integer)'::regprocedure)) = 0
    or position('m.primary_message_id is null) as touches' in pg_get_functiondef('private.growth_snapshot(integer)'::regprocedure)) = 0 then
    raise exception 'The pipeline snapshot must carry each opportunity''s band and first form' using errcode = '55000';
  end if;
  if position('c.eligibility = ''permitted'')
  order by' in pg_get_functiondef('private.growth_brief_next(integer)'::regprocedure)) = 0 then
    raise exception 'An account brief must be written only for an agency that can be emailed' using errcode = '55000';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'private.customer_activity_events'::regclass and tgname = 'growth_report_open_followup' and not tgisinternal) then
    raise exception 'A first report open must bring the second email forward' using errcode = '55000';
  end if;
  if position('weaknesses' in pg_get_functiondef('private.growth_learning_facts(text,integer)'::regprocedure)) = 0
    or position('''opened''' in pg_get_functiondef('private.growth_learning_facts(text,integer)'::regprocedure)) = 0 then
    raise exception 'The weekly memo''s facts must count report opens per arm and the reader''s weaknesses' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
