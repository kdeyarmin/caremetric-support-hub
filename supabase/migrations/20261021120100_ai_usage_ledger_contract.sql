-- Additive deployment gate for the AI usage ledger. Declaring the feature changes
-- no behavior: recording stays reachable only by the Hub server role and the
-- summary stays behind the current administrator session.
do $$ declare contract jsonb:=hub.get_backend_contract(); signature text; begin
  if (contract @> '{"api_version":4,"features":["app.sms.v1","support.ai-assistance.v1","support.ai-automation-server.v1"]}'::jsonb) is not true then
    raise exception 'Apply the Hub SMS and AI assistance foundations first' using errcode='55000';
  end if;
  if to_regclass('private.ai_usage') is null
    or not (select relrowsecurity from pg_class where oid=to_regclass('private.ai_usage'))
    or has_table_privilege('anon','private.ai_usage','SELECT,INSERT,UPDATE,DELETE')
    or has_table_privilege('authenticated','private.ai_usage','SELECT,INSERT,UPDATE,DELETE')
    or has_table_privilege('hub_app_server','private.ai_usage','SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'The AI usage ledger must exist and remain closed' using errcode='55000';
  end if;
  signature:='private.record_ai_usage(uuid,text,text,text,text,integer,integer,integer)';
  if to_regprocedure(signature) is null or has_function_privilege('anon',signature,'EXECUTE')
    or has_function_privilege('authenticated',signature,'EXECUTE') or not has_function_privilege('hub_app_server',signature,'EXECUTE') then
    raise exception 'AI usage must be recorded by the Hub server only' using errcode='55000';
  end if;
  signature:='hub.get_ai_usage_summary(integer)';
  if to_regprocedure(signature) is null or has_function_privilege('anon',signature,'EXECUTE')
    or not has_function_privilege('authenticated',signature,'EXECUTE')
    or position('hub.authorize_app_admin()' in pg_get_functiondef(signature::regprocedure))=0 then
    raise exception 'The AI usage summary requires the current administrator session' using errcode='55000';
  end if;
  if not (contract->'features' @> '["support.ai-usage.v1"]'::jsonb) then
    contract:=jsonb_set(contract,'{features}',(contract->'features')||'["support.ai-usage.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
