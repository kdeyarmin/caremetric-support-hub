-- Advertise the capability only after its owner-only proposal and once-only send boundary
-- exists. This is additive: existing clients and workers ignore the new feature.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  signature text;
  role_name text;
  definition text;
begin
  if (contract @> '{"api_version":4,"features":["app.sms.v1","platform.admin.command.v1","platform.agents.v1","platform.agents.hardening.v1","platform.agents.lifecycle.v1","platform.agents.customer-growth.v1"]}'::jsonb) is not true then
    raise exception 'Apply the SMS owner commands, AI team, fenced executions and current email prerequisites first' using errcode = '55000';
  end if;

  if to_regclass('private.agent_external_emails') is null
    or not coalesce((select relrowsecurity from pg_class where oid = to_regclass('private.agent_external_emails')), false) then
    raise exception 'The external email ledger must exist with row level security' using errcode = '55000';
  end if;
  foreach role_name in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
    if has_table_privilege(role_name, 'private.agent_external_emails', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
      or has_any_column_privilege(role_name, 'private.agent_external_emails', 'SELECT,INSERT,UPDATE') then
      raise exception 'The external email ledger must remain closed to every browser, service and server role' using errcode = '55000';
    end if;
  end loop;
  if exists (select 1 from pg_policy where polrelid = 'private.agent_external_emails'::regclass)
    or not exists (select 1 from pg_constraint where conrelid = 'private.agent_external_emails'::regclass and contype = 'p' and convalidated)
    or not exists (select 1 from pg_constraint where conrelid = 'private.agent_external_emails'::regclass and conname = 'agent_external_emails_request_key_key' and contype = 'u' and convalidated)
    or not exists (select 1 from pg_constraint where conrelid = 'private.agent_external_emails'::regclass and conname = 'agent_external_emails_payload_check' and convalidated)
    or not exists (select 1 from pg_constraint where conrelid = 'private.agent_external_emails'::regclass and conname = 'agent_external_emails_attempt_check' and convalidated) then
    raise exception 'External emails require a private, checked, once-only request and attempt ledger' using errcode = '55000';
  end if;

  if not coalesce((select position('''email.external''' in pg_get_constraintdef(oid)) > 0 from pg_constraint
                     where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_kind_check' and convalidated), false)
    or not coalesce((select position('''external_email''' in pg_get_constraintdef(oid)) > 0 from pg_constraint
                     where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_target_kind_check' and convalidated), false)
    or not exists (select 1 from pg_constraint where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_external_email_check' and convalidated
      and position('auto_approved' in pg_get_constraintdef(oid)) > 0 and position('task_id IS NULL' in pg_get_constraintdef(oid)) > 0) then
    raise exception 'External emails must be owner-requested actions that cannot be auto-approved' using errcode = '55000';
  end if;

  foreach signature in array array[
    'private.agent_external_email_ready(integer,boolean)',
    'private.agent_external_email_begin_send(uuid,integer,boolean)',
    'private.agent_external_email_finish_send(uuid,integer,text,text)',
    'private.agent_action_propose(uuid,uuid,text,text,text,text,jsonb)'
  ] loop
    if to_regprocedure(signature) is null
      or not coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false)
      or has_function_privilege('anon', signature, 'EXECUTE') or has_function_privilege('authenticated', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
      or not has_function_privilege('hub_app_server', signature, 'EXECUTE')
      or position('private.require_hub_app_server()' in pg_get_functiondef(to_regprocedure(signature))) = 0 then
      raise exception 'External email operations must be pinned security definers executable by the application server only' using errcode = '55000';
    end if;
  end loop;
  definition := pg_get_functiondef(to_regprocedure('private.agent_external_email_ready(integer,boolean)'));
  if position('if not p_recover then' in definition) = 0
    or position('a.kind = ''email.external''' in definition) = 0
    or position('a.decided_by is not null' in definition) = 0
    or position('a.executing_at < now() - interval ''10 minutes''' in definition) = 0
    or position('for update of a skip locked' in definition) = 0 then
    raise exception 'Manual email recovery must preserve current leases and touch only approved external emails' using errcode = '55000';
  end if;
  definition := pg_get_functiondef(to_regprocedure('private.agent_action_propose(uuid,uuid,text,text,text,text,jsonb)'));
  if position('External emails require an explicit owner request.' in definition) = 0
    or position('auto_send_templates' in definition) = 0 then
    raise exception 'External email must refuse autonomous proposals and preserve lifecycle approvals' using errcode = '55000';
  end if;
  foreach signature in array array[
    'private.agent_external_email_begin_send(uuid,integer,boolean)',
    'private.agent_external_email_finish_send(uuid,integer,text,text)'
  ] loop
    definition := pg_get_functiondef(to_regprocedure(signature));
    if position('v_action.executions <> p_execution' in definition) = 0
      or position('v_action.decided_by is null' in definition) = 0
      or position('for update' in definition) = 0 then
      raise exception 'External email sends must require owner approval and the current fenced execution' using errcode = '55000';
    end if;
  end loop;

  signature := 'private.agent_external_email_valid(text,text,text)';
  if to_regprocedure(signature) is null
    or not coalesce((select p.provolatile = 'i' and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false) then
    raise exception 'The external email validation helper must be immutable with a pinned search path' using errcode = '55000';
  end if;
  foreach role_name in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
    if has_function_privilege(role_name, signature, 'EXECUTE') then
      raise exception 'The external email validation helper must remain internal' using errcode = '55000';
    end if;
  end loop;

  signature := 'hub.request_agent_email(text,text,text,uuid)';
  if to_regprocedure(signature) is null
    or not coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false)
    or not has_function_privilege('authenticated', signature, 'EXECUTE')
    or has_function_privilege('anon', signature, 'EXECUTE') or has_function_privilege('service_role', signature, 'EXECUTE')
    or position('hub.authorize_app_command()' in pg_get_functiondef(to_regprocedure(signature))) = 0 then
    raise exception 'External email requests must require the existing current owner SMS command session' using errcode = '55000';
  end if;
  if not exists (select 1 from private.agents where key = 'chief_of_staff') then
    raise exception 'The Chief of Staff must exist for owner-directed email requests' using errcode = '55000';
  end if;

  if not (contract -> 'features' @> '["platform.agents.external-email.v1"]'::jsonb) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || '["platform.agents.external-email.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
