-- Additive deployment gate for bulk email. Declaring the feature changes no
-- behavior: campaign tables stay private, administrator functions recheck the
-- current session (queuing and tests the command session), and delivery and
-- unsubscribe stay reachable only by the Hub server role.
do $$ declare contract jsonb:=hub.get_backend_contract(); signature text; tbl text; begin
  if (contract @> '{"api_version":4,"features":["app.sms.v1","platform.admin.read.v1","platform.admin.command.v1","support.communications.v1"]}'::jsonb) is not true then
    raise exception 'Apply the Hub SMS, administrator and communications foundations first' using errcode='55000';
  end if;
  foreach tbl in array array['private.email_campaigns','private.email_campaign_sources','private.email_audience_members','private.email_recipients','private.email_suppressions'] loop
    if to_regclass(tbl) is null
      or not (select relrowsecurity from pg_class where oid=to_regclass(tbl))
      or has_table_privilege('anon',tbl,'SELECT,INSERT,UPDATE,DELETE')
      or has_table_privilege('authenticated',tbl,'SELECT,INSERT,UPDATE,DELETE')
      or has_table_privilege('service_role',tbl,'SELECT,INSERT,UPDATE,DELETE')
      or has_table_privilege('hub_app_server',tbl,'SELECT,INSERT,UPDATE,DELETE') then
      raise exception 'Bulk email tables must exist and remain closed' using errcode='55000';
    end if;
  end loop;
  foreach signature in array array['private.email_housekeeping()','private.claim_email_batch(integer)','private.finish_email_delivery(uuid,text,text)','private.email_unsubscribe(text,boolean)'] loop
    if to_regprocedure(signature) is null or has_function_privilege('anon',signature,'EXECUTE')
      or has_function_privilege('authenticated',signature,'EXECUTE') or not has_function_privilege('hub_app_server',signature,'EXECUTE')
      or position('hub_app_server' in pg_get_functiondef(signature::regprocedure))=0 then
      raise exception 'Bulk email delivery must stay with the Hub server' using errcode='55000';
    end if;
  end loop;
  foreach signature in array array['hub.create_email_campaign(uuid[])','hub.next_email_audience_page(uuid)','hub.add_email_audience_page(uuid,uuid,integer,integer,jsonb)',
    'hub.get_email_campaign(uuid)','hub.list_email_campaigns()','hub.save_email_campaign(uuid,text,text,jsonb,integer)','hub.cancel_email_campaign(uuid)'] loop
    if to_regprocedure(signature) is null or has_function_privilege('anon',signature,'EXECUTE')
      or not has_function_privilege('authenticated',signature,'EXECUTE')
      or position('hub.authorize_app_admin()' in pg_get_functiondef(signature::regprocedure))=0 then
      raise exception 'Bulk email requires the current administrator session' using errcode='55000';
    end if;
  end loop;
  foreach signature in array array['hub.queue_email_campaign(uuid,integer,integer)','hub.authorize_email_test(uuid)'] loop
    if to_regprocedure(signature) is null or has_function_privilege('anon',signature,'EXECUTE')
      or not has_function_privilege('authenticated',signature,'EXECUTE')
      or position('hub.authorize_app_command()' in pg_get_functiondef(signature::regprocedure))=0 then
      raise exception 'Sending bulk email requires the current administrator command session' using errcode='55000';
    end if;
  end loop;
  if not (contract->'features' @> '["support.bulk-email.v1"]'::jsonb) then
    contract:=jsonb_set(contract,'{features}',(contract->'features')||'["support.bulk-email.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
