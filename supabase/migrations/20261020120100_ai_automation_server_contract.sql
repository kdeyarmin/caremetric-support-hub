-- Additive deployment gate for the AI auto-resolution loop running through the Hub
-- server role: every store step is a private.ai_automation_* operation that only
-- hub_app_server may execute, and the server role still holds no direct privilege on
-- the case, content or audit tables. A Hub server that runs the loop through these
-- operations must not deploy against a backend that predates them, where the sweep
-- would fail on its first query.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  signature text;
  role_name text;
  relation text;
begin
  if (contract @> '{"api_version":4,"features":["support.ai-automation.v1","support.go-live-readiness.v1"]}'::jsonb) is not true then
    raise exception 'Apply the AI go-live readiness contract first' using errcode='55000';
  end if;
  foreach signature in array array[
    'private.ai_automation_eligible_cases()', 'private.ai_automation_claim(uuid)',
    'private.ai_automation_active_cases()', 'private.ai_automation_work(uuid)',
    'private.ai_automation_knowledge(uuid)', 'private.ai_automation_post_message(uuid,text)',
    'private.ai_automation_post_note(uuid,text)', 'private.ai_automation_escalate(uuid)',
    'private.ai_automation_resolve(uuid)', 'private.ai_automation_save_state(uuid,jsonb)'
  ] loop
    if to_regprocedure(signature) is null or not has_function_privilege('hub_app_server', signature, 'execute') then
      raise exception 'Apply the AI automation server boundary first: missing %', signature using errcode='55000';
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
  foreach signature in array array['private.ai_automation_case_eligible(uuid)', 'private.ai_automation_state_for_step(uuid,text[])'] loop
    if to_regprocedure(signature) is null then
      raise exception 'Apply the AI automation server boundary first: missing %', signature using errcode='55000';
    end if;
    foreach role_name in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
      if has_function_privilege(role_name, signature, 'execute') then
        raise exception 'AI automation helper % must stay internal', signature using errcode='55000';
      end if;
    end loop;
  end loop;
  foreach relation in array array[
    'hub.support_cases', 'hub.case_messages', 'private.case_notes', 'hub.case_ai_automation',
    'private.audit_events', 'hub.content_publications', 'hub.content_items', 'hub.content_revisions'
  ] loop
    if has_table_privilege('hub_app_server', relation, 'select,insert,update,delete,truncate')
       or has_any_column_privilege('hub_app_server', relation, 'select,insert,update') then
      raise exception 'The Hub server role must not hold direct privileges on %', relation using errcode='55000';
    end if;
  end loop;
  if not (contract->'features' @> '["support.ai-automation-server.v1"]'::jsonb) then
    contract:=jsonb_set(contract,'{features}',(contract->'features')||'["support.ai-automation-server.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
