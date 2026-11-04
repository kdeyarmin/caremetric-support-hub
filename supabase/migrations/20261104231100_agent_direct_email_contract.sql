-- A reviewed, additive feature flag. Refuse to advertise unless the private email ledger,
-- owner command operation and server-only one-use send operations are installed and closed.
do $$
declare c jsonb:=hub.get_backend_contract();
begin
  if not (c->'features' @> '["platform.agents.hardening.v1"]'::jsonb)
    or to_regclass('private.agent_direct_emails') is null
    or not coalesce((select relrowsecurity from pg_class where oid='private.agent_direct_emails'::regclass),false)
    or to_regprocedure('hub.prepare_agent_direct_email(text,text,text,uuid)') is null
    or to_regprocedure('private.agent_direct_email_begin_send(uuid,integer)') is null
    or to_regprocedure('private.agent_direct_email_finish_send(uuid,integer,text,text)') is null
    or not has_function_privilege('authenticated','hub.prepare_agent_direct_email(text,text,text,uuid)','execute')
    or has_function_privilege('anon','hub.prepare_agent_direct_email(text,text,text,uuid)','execute')
    or has_function_privilege('authenticated','private.agent_direct_email_begin_send(uuid,integer)','execute')
    or has_function_privilege('authenticated','private.agent_direct_email_finish_send(uuid,integer,text,text)','execute')
    or not has_function_privilege('hub_app_server','private.agent_direct_email_begin_send(uuid,integer)','execute')
    or not has_function_privilege('hub_app_server','private.agent_direct_email_finish_send(uuid,integer,text,text)','execute')
    or has_table_privilege('hub_app_server','private.agent_direct_emails','select,insert,update,delete') then
    raise exception 'Owner-direct email security boundary is not ready.' using errcode='55000';
  end if;
  if not (c->'features' @> '["platform.agents.direct-email.v1"]'::jsonb) then
    c:=jsonb_set(c,'{features}',(c->'features')||'["platform.agents.direct-email.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select '||quote_literal(c::text)||'::jsonb');
end $$;
