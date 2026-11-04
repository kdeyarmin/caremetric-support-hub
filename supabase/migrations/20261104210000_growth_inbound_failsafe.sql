-- An inbound email is saved whatever happens to growth capture. Capture ran inside the inbox insert, so any error in it rolled
-- back the customer's message and failed the email webhook: for example a sales email from a one-letter, underscore or
-- non-Latin domain, which the inbox accepts but the growth organization check rejects.
--
-- The trigger now takes the growth lock in a block of its own, so the lock is held until the inbox commits even when capture
-- rolls back: a send claim queued behind the reply runs after the fallback and finds its message cancelled. Lock waits are
-- bounded by a 3-second lock timeout, well inside the webhook's 12-second statement timeout; when the lock is busy for longer,
-- capture is skipped for that message. Capture then runs in its own subtransaction. When it fails or is skipped, nothing of it
-- is kept and the fallback still does what capture would have done for a sender who is already a growth contact: an
-- unsubscribe request opts the contact out and suppresses the address (with capture's wording rule and address hash), and the
-- reply cancels unsent outreach queued to that contact. A webhook retry finds the saved message and skips it, so the fallback
-- is the only chance to keep an opt-out. An audit row records the message, its conversation and the error codes: never an
-- address, name or text. Messages that did not arrive through the email webhook are skipped before any of this, because
-- capture ignores them. No table, grant or declared feature changes.
create or replace function private.growth_inbound_trigger() returns trigger language plpgsql security definer
set search_path='' set lock_timeout='3s' as $$
declare v_state text; v_fallback text; v_contact uuid; v_email text;
begin
 if new.direction='inbound' and session_user='hub_app_server' and new.provider_message_id like 'email:%' then
  begin
   perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
  exception when others then
   v_state:=sqlstate;
  end;
  if v_state is null then
   begin
    perform private.growth_inquiry(new.id);
   exception when others then
    v_state:=sqlstate;
   end;
  end if;
  if v_state is not null then
   begin
    select g.id,g.email into v_contact,v_email from private.communications c join private.growth_contacts g on g.email=lower(btrim(c.contact_email))
    where c.id=new.communication_id;
    if v_contact is not null then
     if new.body ~* '\m(unsubscribe|do not contact|stop emailing|remove me)\M' then
      update private.growth_contacts set eligibility='opted_out',version=version+1 where id=v_contact;
      insert into private.email_suppressions(email_hash) values(encode(extensions.digest(v_email,'sha256'),'hex')) on conflict do nothing;
     end if;
     update private.growth_messages set status='cancelled' where contact_id=v_contact and status in ('draft','proposed');
    end if;
   exception when others then
    v_fallback:=sqlstate;
   end;
   begin
    insert into private.audit_events(action,entity_type,entity_id,metadata)
    values('growth.inquiry_failed','communication_message',new.id,
     jsonb_strip_nulls(jsonb_build_object('communicationId',new.communication_id,'sqlstate',v_state,'fallbackSqlstate',v_fallback)));
   exception when others then
    raise warning 'Growth capture skipped an inbound email (%, %)', v_state, coalesce(v_fallback,'-');
   end;
  end if;
 end if;
 return new;
end; $$;
revoke all on function private.growth_inbound_trigger() from public,anon,authenticated,service_role,hub_app_server;
