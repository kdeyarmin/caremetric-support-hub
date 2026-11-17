-- Declares platform.agents.trial-path.v1 once the trial path is in place (20261117230000_trial_path.sql, team review 2026-11-17,
-- stage 4): an Intel trial is counted from its card's first confirmation (a closed table and its trigger), the billing mirror no
-- longer counts an Intel trial without one and queues a counted trial that ended unpaid, every customer email check accepts the three
-- new emails, the Account Manager's facts carry the trial path's facts and stay executable by no role, a refused customer email can
-- wait (executable by the Hub server alone), the Sales hand-over includes a trial, and Intel's milestones are accepted.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.trial-path.v1';
  helper constant text := 'private.agent_lifecycle_json(integer,text,text,integer)';
  defer_fn constant text := 'private.agent_lifecycle_defer(uuid,integer,text)';
  r text;
  t text;
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.lifecycle-save.v1","billing.trial-cards.v1","platform.agents.sales-executive.v1"]}'::jsonb) is not true then
    raise exception 'Apply the customer email, trial card and Sales Executive migrations first' using errcode = '55000';
  end if;
  if to_regclass('private.growth_trial_cards') is null
     or not (select relrowsecurity from pg_class where oid = 'private.growth_trial_cards'::regclass)
     or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) x
                 where has_table_privilege(x, 'private.growth_trial_cards', 'select,insert,update,delete')) then
    raise exception 'The trial cards table must be closed to every role' using errcode = '55000';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'private.billing_trial_cards'::regclass and tgname = 'growth_trial_card_seen' and not tgisinternal) then
    raise exception 'A confirmed card must start the Intel trial' using errcode = '55000';
  end if;
  if position('v_product<>''caremetric-intel''' in pg_get_functiondef('private.growth_capture_billing()'::regprocedure)) = 0
     or position('billing:trial_lost:' in pg_get_functiondef('private.growth_capture_billing()'::regprocedure)) = 0
     or position('''churned''' in coalesce((select pg_get_constraintdef(oid) from pg_constraint
        where conrelid = 'private.growth_billing_outbox'::regclass and conname = 'growth_billing_outbox_kind_check'), '')) = 0 then
    raise exception 'The billing mirror must count an Intel trial from its card and record a lost trial' using errcode = '55000';
  end if;
  foreach t in array array['card_reminder', 'midtrial_nudge', 'value_followup'] loop
    if position(quote_literal(t) in coalesce((select pg_get_constraintdef(oid) from pg_constraint
          where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_email_send_check'), '')) = 0
       or position(quote_literal(t) in coalesce((select pg_get_constraintdef(oid) from pg_constraint
          where conrelid = 'private.agent_lifecycle_emails'::regclass and conname = 'agent_lifecycle_emails_template_check'), '')) = 0
       or position(t in coalesce((select pg_get_constraintdef(oid) from pg_constraint
          where conrelid = 'private.agent_lifecycle_emails'::regclass and conname = 'agent_lifecycle_emails_period_key_check'), '')) = 0
       or position(quote_literal(t) in pg_get_functiondef(helper::regprocedure)) = 0 then
      raise exception 'Every customer email check must accept %', t using errcode = '55000';
    end if;
  end loop;
  if position('''cardConfirmedAt''' in pg_get_functiondef(helper::regprocedure)) = 0
     or position('''firstValueAt''' in pg_get_functiondef(helper::regprocedure)) = 0 then
    raise exception 'The customer facts must carry the trial path''s facts' using errcode = '55000';
  end if;
  foreach r in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
    if has_function_privilege(r, helper, 'execute') then
      raise exception 'The customer email helper must stay internal to its operation' using errcode = '55000';
    end if;
  end loop;
  if to_regprocedure(defer_fn) is null or not has_function_privilege('hub_app_server', defer_fn, 'execute')
     or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) x where has_function_privilege(x, defer_fn, 'execute'))
     or position('private.require_hub_app_server()' in pg_get_functiondef(defer_fn::regprocedure)) = 0 then
    raise exception 'Only the Hub server may defer a customer email' using errcode = '55000';
  end if;
  if position('''nurture'', ''trial'')' in pg_get_functiondef('private.sales_handoff(uuid,uuid)'::regprocedure)) = 0 then
    raise exception 'The Sales hand-over must include a prospect in its trial' using errcode = '55000';
  end if;
  if position('county_chosen' in pg_get_functiondef('private.growth_app_event(text,jsonb)'::regprocedure)) = 0 then
    raise exception 'Intel''s milestones must be accepted' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
