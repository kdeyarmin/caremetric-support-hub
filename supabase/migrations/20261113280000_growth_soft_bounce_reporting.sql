-- SES failures that are not the recipient's fault (a transient or undetermined bounce, a reject) are recorded as bounced without
-- opting the contact out. Bounced status, scorecard counts and deduplication are kept. Complaints and unsubscribes always suppress.
-- Legacy four-argument callers keep their existing policy, SendGrid included; old events are not replayed. The Hub uses the
-- five-argument form only once 20261113280100_growth_soft_bounce_contract.sql declares platform.agents.growth-soft-bounce.v1.
set local lock_timeout = '10s';

create function private.growth_delivery_event(p_event text,p_message uuid,p_kind text,p_at timestamptz,p_suppress boolean) returns boolean
language plpgsql security definer set search_path='' as $$ declare v_contact uuid; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
 insert into private.growth_delivery_events(event_id,message_id,kind,occurred_at) values(p_event,p_message,p_kind,p_at) on conflict do nothing;
 if not found then return false; end if;
 if p_kind in ('complaint','unsubscribe') or (p_kind='bounced' and coalesce(p_suppress,true)) then
  select contact_id into v_contact from private.growth_messages where id=p_message;
  update private.growth_contacts set eligibility='opted_out',version=version+1 where id=v_contact;
  insert into private.email_suppressions(email_hash) select encode(extensions.digest(email,'sha256'),'hex') from private.growth_contacts where id=v_contact on conflict do nothing;
  update private.growth_messages set status='cancelled' where contact_id=v_contact and status in ('draft','proposed');
 end if;
 update private.growth_messages set status=case when p_kind='unsubscribe' then 'cancelled' else p_kind end,delivered_at=case when p_kind='delivered' then p_at else delivered_at end where id=p_message
 and (p_kind<>'delivered' or status in ('accepted','unknown','sending','delivered'));
 return true;
end; $$;

revoke all on function private.growth_delivery_event(text,uuid,text,timestamptz,boolean) from public,anon,authenticated,service_role;
grant execute on function private.growth_delivery_event(text,uuid,text,timestamptz,boolean) to hub_app_server;

create or replace function private.growth_delivery_event(p_event text,p_message uuid,p_kind text,p_at timestamptz) returns boolean
language plpgsql security definer set search_path='' as $$ begin
 -- Keep the direct guard required by the existing customer-growth contract.
 perform private.require_hub_app_server();
 return private.growth_delivery_event(p_event,p_message,p_kind,p_at,true);
end; $$;

do $$
declare r text; f text;
begin
  foreach f in array array['private.growth_delivery_event(text,uuid,text,timestamptz,boolean)', 'private.growth_delivery_event(text,uuid,text,timestamptz)'] loop
    if not exists (select 1 from pg_proc where oid = f::regprocedure and prosecdef and proconfig @> array['search_path=""'] and prosrc like '%require_hub_app_server%')
       or not has_function_privilege('hub_app_server', f, 'execute') then
      raise exception '% must stay a guarded Hub server function', f using errcode = '55000';
    end if;
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(r, f, 'execute') then raise exception '% exposed to %', f, r using errcode = '55000'; end if;
    end loop;
  end loop;
  if position('coalesce(p_suppress,true)' in pg_get_functiondef('private.growth_delivery_event(text,uuid,text,timestamptz,boolean)'::regprocedure)) = 0
     or position('p_kind in (''complaint'',''unsubscribe'')' in pg_get_functiondef('private.growth_delivery_event(text,uuid,text,timestamptz,boolean)'::regprocedure)) = 0
     or position('private.growth_delivery_event(p_event,p_message,p_kind,p_at,true)' in pg_get_functiondef('private.growth_delivery_event(text,uuid,text,timestamptz)'::regprocedure)) = 0 then
    raise exception 'Complaints and unsubscribes must always suppress, and the four-argument form must keep suppressing bounces' using errcode = '55000';
  end if;
end $$;
