-- Additive deployment gate for unified communications. Declaring the feature
-- changes no behavior: inbound webhooks still require their provider signature
-- or secret, chat still requires its opaque token, and every staff read or
-- write still requires a verified SMS session with case permissions.
do $$ declare contract jsonb:=hub.get_backend_contract(); tbl text; signature text; begin
  if (contract @> '{"api_version":4,"features":["app.sms.v1","platform.admin.read.v1","platform.admin.advisors.v1"]}'::jsonb) is not true then
    raise exception 'Apply the Hub SMS, administrator and Advisors foundations first' using errcode='55000';
  end if;
  foreach tbl in array array['private.communications','private.communication_messages','private.communication_rate_events'] loop
    if to_regclass(tbl) is null then
      raise exception 'Apply the unified communications tables first' using errcode='55000';
    end if;
    if not (select relrowsecurity from pg_class where oid=to_regclass(tbl))
      or has_table_privilege('anon',tbl,'SELECT,INSERT,UPDATE,DELETE')
      or has_table_privilege('authenticated',tbl,'SELECT,INSERT,UPDATE,DELETE')
      or has_table_privilege('hub_app_server',tbl,'SELECT,INSERT,UPDATE,DELETE') then
      raise exception 'Private communication tables must remain closed' using errcode='55000';
    end if;
  end loop;
  foreach signature in array array['hub.list_communications(text,text,uuid,text,integer,integer)','hub.get_communication(uuid)',
    'hub.update_communication(uuid,text,text,uuid,boolean,uuid,boolean,timestamptz)','hub.add_communication_note(uuid,text,uuid)',
    'hub.begin_communication_reply(uuid,text,uuid,text[])','hub.import_communications(text,jsonb)'] loop
    if to_regprocedure(signature) is null or has_function_privilege('anon',signature,'EXECUTE')
      or not has_function_privilege('authenticated',signature,'EXECUTE') then
      raise exception 'Staff communication functions require a signed-in session' using errcode='55000';
    end if;
  end loop;
  if position('hub.authorize_app_admin()' in pg_get_functiondef('hub.import_communications(text,jsonb)'::regprocedure))=0
    or position('private.current_app_session_verified()' in pg_get_functiondef('hub.begin_communication_reply(uuid,text,uuid,text[])'::regprocedure))=0 then
    raise exception 'Imports and replies require the current Hub administrator session' using errcode='55000';
  end if;
  foreach signature in array array['private.finish_communication_delivery(uuid,text,text)',
    'private.ingest_inbound_communication(text,text,text,bigint,text,text,text,text,text,text)',
    'private.start_chat(text,text,text,text,text,text)','private.read_chat(text)','private.post_chat_message(text,text,text)'] loop
    if to_regprocedure(signature) is null or has_function_privilege('anon',signature,'EXECUTE')
      or has_function_privilege('authenticated',signature,'EXECUTE')
      or not has_function_privilege('hub_app_server',signature,'EXECUTE') then
      raise exception 'Inbound channel functions must be reachable only by the Hub server' using errcode='55000';
    end if;
  end loop;
  if not (contract->'features' @> '["support.communications.v1"]'::jsonb) then
    contract:=jsonb_set(contract,'{features}',(contract->'features')||'["support.communications.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
