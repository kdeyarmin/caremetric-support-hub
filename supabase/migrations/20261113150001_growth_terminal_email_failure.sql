-- Preserve the event and scorecard vocabulary while separating suppression from delivery.
set local lock_timeout = '10s';

create or replace function private.growth_delivery_event(p_event text,p_message uuid,p_kind text,p_at timestamptz) returns boolean
language plpgsql security definer set search_path='' as $$ declare
 v_contact uuid;
 v_kind text := case when p_kind='unsuppressed_bounce' then 'bounced' else p_kind end; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
 insert into private.growth_delivery_events(event_id,message_id,kind,occurred_at) values(p_event,p_message,v_kind,p_at) on conflict do nothing;
 if not found then return false; end if;
 if p_kind in ('bounced','complaint','unsubscribe') then
  select contact_id into v_contact from private.growth_messages where id=p_message;
  update private.growth_contacts set eligibility='opted_out',version=version+1 where id=v_contact;
  insert into private.email_suppressions(email_hash) select encode(extensions.digest(email,'sha256'),'hex') from private.growth_contacts where id=v_contact on conflict do nothing;
  update private.growth_messages set status='cancelled' where contact_id=v_contact and status in ('draft','proposed');
 end if;
 update private.growth_messages set status=case when p_kind='unsubscribe' then 'cancelled' else v_kind end,delivered_at=case when p_kind='delivered' then p_at else delivered_at end where id=p_message
 and (p_kind<>'unsuppressed_bounce' or status in ('accepted','unknown','sending','bounced'))
 and (p_kind<>'delivered' or status in ('accepted','unknown','sending','delivered'));
 return true;
end; $$;
