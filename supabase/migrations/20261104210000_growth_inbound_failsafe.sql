-- An inbound email is saved whatever happens to growth capture. Capture ran inside the inbox insert, so any error in it rolled
-- back the customer's message and failed the email webhook: for example a sales email from a one-letter, underscore or
-- non-Latin domain, which the inbox accepts but the growth organization check rejects. Capture now runs in its own
-- subtransaction. When it fails, nothing of it is kept, the reply still cancels unsent outreach queued to its sender (as capture
-- itself would have), and an audit row records the message, its conversation and the error code: never an address, name or
-- text. The trigger also skips messages that did not arrive through the email webhook before taking the growth lock, because
-- capture ignores them. No table, grant or declared feature changes.
create or replace function private.growth_inbound_trigger() returns trigger language plpgsql security definer set search_path='' as $$
declare v_state text;
begin
 if new.direction='inbound' and session_user='hub_app_server' and new.provider_message_id like 'email:%' then
  begin
   perform private.growth_inquiry(new.id);
  exception when others then
   v_state:=sqlstate;
   begin
    perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
    update private.growth_messages m set status='cancelled'
    from private.communications c join private.growth_contacts g on g.email=lower(btrim(c.contact_email))
    where c.id=new.communication_id and m.contact_id=g.id and m.status in ('draft','proposed');
    insert into private.audit_events(action,entity_type,entity_id,metadata)
    values('growth.inquiry_failed','communication_message',new.id,jsonb_build_object('communicationId',new.communication_id,'sqlstate',v_state));
   exception when others then
    raise warning 'Growth capture skipped an inbound email (%)', v_state;
   end;
  end;
 end if;
 return new;
end; $$;
revoke all on function private.growth_inbound_trigger() from public,anon,authenticated,service_role,hub_app_server;
