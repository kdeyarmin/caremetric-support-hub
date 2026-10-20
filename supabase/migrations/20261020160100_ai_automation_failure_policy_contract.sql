-- Additive deployment gate for the AI automation failure policy (20261020160000).
-- The Hub server records a failed step and its backoff through
-- private.ai_automation_save_state (consecutiveFailures, retryAt), reads them back
-- from private.ai_automation_work, and relies on the active batch waiting out
-- retry_at. It must not deploy against a backend that predates them, where every
-- recorded failure would be refused and a failing case would again cost a provider
-- call on every sweep.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  signature text;
  role_name text;
begin
  if (contract @> '{"api_version":4,"features":["support.ai-automation-server.v1"]}'::jsonb) is not true then
    raise exception 'Apply the AI automation server contract first' using errcode='55000';
  end if;
  if not exists (
    select 1 from pg_attribute a
    where a.attrelid = 'hub.case_ai_automation'::regclass and a.attname = 'consecutive_failures'
      and not a.attisdropped and a.attnotnull and a.atttypid = 'integer'::regtype
  ) or not exists (
    select 1 from pg_attribute a
    where a.attrelid = 'hub.case_ai_automation'::regclass and a.attname = 'retry_at'
      and not a.attisdropped and a.atttypid = 'timestamptz'::regtype
  ) then
    raise exception 'Apply the AI automation failure policy first: missing hub.case_ai_automation failure columns' using errcode='55000';
  end if;
  foreach signature in array array[
    'private.ai_automation_active_cases()', 'private.ai_automation_work(uuid)', 'private.ai_automation_save_state(uuid,jsonb)'
  ] loop
    if to_regprocedure(signature) is null or not has_function_privilege('hub_app_server', signature, 'execute') then
      raise exception 'Apply the AI automation failure policy first: missing %', signature using errcode='55000';
    end if;
    if not exists (
      select 1 from pg_proc p
      where p.oid = to_regprocedure(signature) and p.prosecdef and p.proconfig @> array['search_path=""']
    ) then
      raise exception 'AI automation server operation % must be a pinned security definer', signature using errcode='55000';
    end if;
    foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(role_name, signature, 'execute') then
        raise exception 'AI automation server operation % is exposed beyond the Hub server', signature using errcode='55000';
      end if;
    end loop;
  end loop;
  if position('automation.retry_at' in pg_get_functiondef('private.ai_automation_active_cases()'::regprocedure)) = 0 then
    raise exception 'Apply the AI automation failure policy first: the active batch does not wait out retry_at' using errcode='55000';
  end if;
  if position('''consecutiveFailures''' in pg_get_functiondef('private.ai_automation_work(uuid)'::regprocedure)) = 0
     or position('''retryAt''' in pg_get_functiondef('private.ai_automation_work(uuid)'::regprocedure)) = 0 then
    raise exception 'Apply the AI automation failure policy first: private.ai_automation_work does not return the failure fields' using errcode='55000';
  end if;
  if position('''consecutiveFailures''' in pg_get_functiondef('private.ai_automation_save_state(uuid,jsonb)'::regprocedure)) = 0
     or position('''retryAt''' in pg_get_functiondef('private.ai_automation_save_state(uuid,jsonb)'::regprocedure)) = 0 then
    raise exception 'Apply the AI automation failure policy first: private.ai_automation_save_state does not accept the failure fields' using errcode='55000';
  end if;
  if not (contract->'features' @> '["support.ai-automation-failure-policy.v1"]'::jsonb) then
    contract:=jsonb_set(contract,'{features}',(contract->'features')||'["support.ai-automation-failure-policy.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
