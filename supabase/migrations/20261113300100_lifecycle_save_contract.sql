-- Declares platform.agents.lifecycle-save.v1 once the Account Manager's cancellation and win-back emails can be proposed, recorded
-- and sent (20261113300000_lifecycle_save.sql): the action check and every send-ledger check accept both templates, the facts
-- report them and include the accounts they are for, the facts helper stays executable by no role, and the owner's switch exists.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.lifecycle-save.v1';
  helper constant text := 'private.agent_lifecycle_json(integer,text,text,integer)';
  r text;
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.lifecycle.v1","platform.settings.v1"]}'::jsonb) is not true then
    raise exception 'Apply the customer email and settings migrations first' using errcode = '55000';
  end if;
  if not exists (select 1 from private.hub_settings where key = 'growth.save_emails' and kind = 'flag') then
    raise exception 'The win-back and cancellation switch is missing' using errcode = '55000';
  end if;
  if position('''cancel_save''' in coalesce((select pg_get_constraintdef(oid) from pg_constraint
        where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_email_send_check'), '')) = 0
     or position('''trial_ended''' in coalesce((select pg_get_constraintdef(oid) from pg_constraint
        where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_email_send_check'), '')) = 0
     or exists (select 1 from pg_constraint where conrelid = 'private.agent_lifecycle_emails'::regclass and contype = 'c'
        and pg_get_constraintdef(oid) like '%testimonial_ask%' and pg_get_constraintdef(oid) not like '%trial_ended%cancel_save%'
        and pg_get_constraintdef(oid) not like '%cancel_save%trial_ended%') then
    raise exception 'Every customer email check must accept the cancellation and win-back emails' using errcode = '55000';
  end if;
  if position('''cancel_save''' in pg_get_functiondef(helper::regprocedure)) = 0
     or position('''trial_ended''' in pg_get_functiondef(helper::regprocedure)) = 0
     or position('interval ''14 days''' in pg_get_functiondef(helper::regprocedure)) = 0 then
    raise exception 'The customer facts must include cancelling plans and recently ended trials' using errcode = '55000';
  end if;
  foreach r in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
    if has_function_privilege(r, helper, 'execute') then
      raise exception 'The customer email helper must stay internal to its operation' using errcode = '55000';
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
