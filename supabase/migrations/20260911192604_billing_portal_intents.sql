-- Hub preserves review ownership only. CareBase owns the Stripe reservation,
-- idempotency key and session URL. Provider URLs never enter this database.
create type private.billing_portal_action as enum ('billing.portal.create');
create table private.billing_portal_intents (
  request_id uuid primary key,
  actor_id uuid not null references hub.profiles(id),
  session_id uuid not null references private.sms_sessions(id),
  organization_id uuid not null,
  action private.billing_portal_action not null default 'billing.portal.create',
  request jsonb not null check(octet_length(request::text)<=4096),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  preview_dispatched_at timestamptz,
  command_id uuid unique,
  preview jsonb check(octet_length(preview::text)<=8192),
  preview_expires_at timestamptz,
  dispatched_at timestamptz,
  result jsonb check(octet_length(result::text)<=4096),
  retry_at timestamptz,
  discarded_at timestamptz,
  check((preview is null)=(command_id is null)),
  check((preview is null)=(preview_expires_at is null)),
  check(result is null or dispatched_at is not null),
  check(discarded_at is null or preview_dispatched_at is null)
);
create index billing_portal_intents_actor_idx on private.billing_portal_intents(actor_id,created_at);
create index billing_portal_intents_session_idx on private.billing_portal_intents(session_id,organization_id,created_at);
create index billing_portal_intents_created_idx on private.billing_portal_intents(created_at);
create index billing_portal_intents_expiry_idx on private.billing_portal_intents(expires_at);
alter table private.billing_portal_intents enable row level security;
revoke all on private.billing_portal_intents from public,anon,authenticated,service_role,hub_app_server;

create function private.billing_portal_actor() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if session_user<>'hub_app_server' then raise exception 'Application server required.' using errcode='42501'; end if;
  return hub.authorize_app_command();
end;
$$;
create function private.billing_portal_intent_view(p_intent private.billing_portal_intents) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('request',p_intent.request,'preview',p_intent.preview,'result',p_intent.result,
    'createdAt',p_intent.created_at,'expiresAt',p_intent.expires_at,'previewDispatchedAt',p_intent.preview_dispatched_at,
    'dispatchedAt',p_intent.dispatched_at,'retryAt',p_intent.retry_at);
$$;
create function private.require_billing_portal_intent(p_request_id uuid) returns private.billing_portal_intents
language plpgsql security definer set search_path='' as $$
declare actor jsonb; intent private.billing_portal_intents%rowtype;
begin
  actor:=private.billing_portal_actor();
  select * into intent from private.billing_portal_intents where request_id=p_request_id for update;
  if not found or intent.actor_id is distinct from (actor->>'user_id')::uuid
    or intent.session_id is distinct from (actor->>'session_id')::uuid or intent.expires_at<=now() or intent.discarded_at is not null then
    raise exception 'This billing review is unavailable.' using errcode='42501';
  end if;
  return intent;
end;
$$;
create function private.resume_billing_portal(p_organization_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor jsonb; intent private.billing_portal_intents%rowtype;
begin
  actor:=private.billing_portal_actor();
  select * into intent from private.billing_portal_intents where organization_id=p_organization_id
    and actor_id=(actor->>'user_id')::uuid and session_id=(actor->>'session_id')::uuid
    and expires_at>now() and discarded_at is null order by created_at desc,request_id desc limit 1;
  if not found then return null; end if;
  return private.billing_portal_intent_view(intent);
end;
$$;
create function private.reserve_billing_portal(p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor jsonb; intent private.billing_portal_intents%rowtype; request_id uuid; organization_id uuid;
begin
  actor:=private.billing_portal_actor();
  if p_request is null or jsonb_typeof(p_request)<>'object' or octet_length(p_request::text)>4096
    or not(p_request ?& array['operation','requestId','action','targetId','parameters','reason'])
    or p_request-array['operation','requestId','action','targetId','parameters','reason']<>'{}'::jsonb
    or p_request->>'operation' is distinct from 'preview' or p_request->>'action' is distinct from 'billing.portal.create'
    or p_request->'parameters' is distinct from '{}'::jsonb or jsonb_typeof(p_request->'reason') is distinct from 'string'
    or coalesce(length(p_request->>'reason'),0) not between 10 and 500 or p_request->>'reason'<>btrim(p_request->>'reason')
    or p_request->>'reason' ~ '[[:cntrl:]]' then
    raise exception 'Invalid billing review.' using errcode='22023';
  end if;
  begin request_id:=(p_request->>'requestId')::uuid; organization_id:=(p_request->>'targetId')::uuid;
  exception when others then raise exception 'Invalid billing identity.' using errcode='22023'; end;
  if request_id is null or organization_id is null then raise exception 'Invalid billing identity.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('billing.portal.reserve',0));
  -- Private request metadata expires; native financial/session audit remains native.
  delete from private.billing_portal_intents where expires_at<now()-interval '30 days';
  select * into intent from private.billing_portal_intents i where i.request_id=reserve_billing_portal.request_id;
  if found then
    intent:=private.require_billing_portal_intent(request_id);
    if intent.request is distinct from p_request then raise exception 'This request key has a different review.' using errcode='40001'; end if;
    return private.billing_portal_intent_view(intent);
  end if;
  if exists(select 1 from private.billing_portal_intents i where i.organization_id=reserve_billing_portal.organization_id
    and actor_id=(actor->>'user_id')::uuid and session_id=(actor->>'session_id')::uuid and expires_at>now() and discarded_at is null
    and (result is null or result->>'outcome'='pending')
    and (dispatched_at is not null or preview_expires_at>now() or (preview is null and created_at>now()-interval '6 minutes'))) then
    raise exception 'Resume the existing billing review before starting another.' using errcode='40001';
  end if;
  if (select count(*) from private.billing_portal_intents where created_at>now()-interval '1 hour')>=200
    or (select count(*) from private.billing_portal_intents where actor_id=(actor->>'user_id')::uuid and created_at>now()-interval '1 hour')>=20 then
    raise exception 'Billing review limit reached.' using errcode='54000';
  end if;
  insert into private.billing_portal_intents(request_id,actor_id,session_id,organization_id,request,expires_at)
    values(request_id,(actor->>'user_id')::uuid,(actor->>'session_id')::uuid,organization_id,p_request,(actor->>'assurance_expires_at')::timestamptz)
    returning * into intent;
  return private.billing_portal_intent_view(intent);
end;
$$;
create function private.dispatch_billing_portal_preview(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent private.billing_portal_intents%rowtype;
begin
  intent:=private.require_billing_portal_intent(p_request_id);
  update private.billing_portal_intents set preview_dispatched_at=coalesce(preview_dispatched_at,now()) where request_id=p_request_id returning * into intent;
  return private.billing_portal_intent_view(intent);
end;
$$;
create function private.remember_billing_portal_preview(p_request_id uuid,p_preview jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent private.billing_portal_intents%rowtype; command_id uuid; expires timestamptz;
begin
  intent:=private.require_billing_portal_intent(p_request_id);
  if intent.preview_dispatched_at is null or p_preview is null or jsonb_typeof(p_preview)<>'object'
    or octet_length(p_preview::text)>8192 or not(p_preview ?& array['commandId','action','targetId','reason','expiresAt','previewDigest','summary'])
    or p_preview-array['commandId','action','targetId','reason','expiresAt','previewDigest','summary']<>'{}'::jsonb
    or p_preview->>'action' is distinct from 'billing.portal.create' or p_preview->>'targetId' is distinct from intent.request->>'targetId'
    or p_preview->>'reason' is distinct from intent.request->>'reason' or coalesce(p_preview->>'previewDigest','') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_preview->'summary') is distinct from 'object'
    or not(p_preview->'summary' ?& array['kind','organizationName','providerCustomerId','providerConfigurationId','returnPath'])
    or p_preview->'summary'-array['kind','organizationName','providerCustomerId','providerConfigurationId','returnPath']<>'{}'::jsonb
    or p_preview->'summary'->>'kind' is distinct from 'portal' or p_preview->'summary'->>'returnPath' is distinct from '/admin/enterprise'
    or coalesce(p_preview->'summary'->>'providerCustomerId','') !~ '^cus_[A-Za-z0-9]+$'
    or coalesce(p_preview->'summary'->>'providerConfigurationId','') !~ '^bpc_[A-Za-z0-9]+$'
    or jsonb_typeof(p_preview->'summary'->'organizationName') is distinct from 'string'
    or length(p_preview->'summary'->>'organizationName')>500 then
    raise exception 'Invalid native billing preview.' using errcode='22023';
  end if;
  begin command_id:=(p_preview->>'commandId')::uuid; expires:=(p_preview->>'expiresAt')::timestamptz;
  exception when others then raise exception 'Invalid billing preview identity.' using errcode='22023'; end;
  if command_id is null or expires is null or not isfinite(expires) or expires>clock_timestamp()+interval '5 minutes 1 second' then
    raise exception 'Invalid billing preview lifetime.' using errcode='22023';
  end if;
  if intent.preview is not null then
    if intent.preview is distinct from p_preview then raise exception 'The billing preview changed.' using errcode='40001'; end if;
    return private.billing_portal_intent_view(intent);
  end if;
  if expires<=clock_timestamp() then raise exception 'The billing preview expired.' using errcode='40001'; end if;
  update private.billing_portal_intents set command_id=remember_billing_portal_preview.command_id,preview=p_preview,preview_expires_at=expires
    where request_id=p_request_id returning * into intent;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values(intent.actor_id,'billing.portal.preview','native_organization',intent.organization_id,jsonb_build_object('command_id',command_id));
  return private.billing_portal_intent_view(intent);
end;
$$;
create function private.claim_billing_portal(p_command_id uuid,p_expected_digest text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent private.billing_portal_intents%rowtype; request_id uuid;
begin
  perform private.billing_portal_actor();
  select i.request_id into request_id from private.billing_portal_intents i where i.command_id=p_command_id;
  intent:=private.require_billing_portal_intent(request_id);
  if p_expected_digest is distinct from intent.preview->>'previewDigest' then raise exception 'Billing review changed.' using errcode='40001'; end if;
  if intent.dispatched_at is null and intent.preview_expires_at<=clock_timestamp() then raise exception 'Billing review expired.' using errcode='40001'; end if;
  update private.billing_portal_intents set dispatched_at=coalesce(dispatched_at,now()) where billing_portal_intents.request_id=intent.request_id returning * into intent;
  return private.billing_portal_intent_view(intent);
end;
$$;
create function private.record_billing_portal_result(p_command_id uuid,p_result jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent private.billing_portal_intents%rowtype; request_id uuid; outcome text;
begin
  perform private.billing_portal_actor();
  select i.request_id into request_id from private.billing_portal_intents i where i.command_id=p_command_id;
  intent:=private.require_billing_portal_intent(request_id);
  outcome:=p_result->>'outcome';
  if intent.dispatched_at is null or p_result is null or jsonb_typeof(p_result)<>'object' or octet_length(p_result::text)>4096
    or not(p_result ?& array['commandId','action','targetId','outcome','replayed','completedAt','retryAfterSeconds','session'])
    or p_result-array['commandId','action','targetId','outcome','replayed','completedAt','retryAfterSeconds','session']<>'{}'::jsonb
    or p_result->>'commandId' is distinct from p_command_id::text or p_result->>'targetId' is distinct from intent.organization_id::text
    or p_result->>'action' is distinct from 'billing.portal.create' or coalesce(outcome,'') not in ('created','pending','failed')
    or jsonb_typeof(p_result->'replayed') is distinct from 'boolean'
    or (outcome='pending' and (p_result->'completedAt' is distinct from 'null'::jsonb or p_result->'retryAfterSeconds' is distinct from '30'::jsonb))
    or (outcome<>'pending' and (jsonb_typeof(p_result->'completedAt') is distinct from 'string' or p_result->'retryAfterSeconds' is distinct from 'null'::jsonb))
    or (outcome<>'created' and p_result->'session' is distinct from 'null'::jsonb)
    or (outcome='created' and (jsonb_typeof(p_result->'session') is distinct from 'object'
      or not(p_result->'session' ?& array['kind','id','expiresAt','livemode'])
      or p_result->'session'-array['kind','id','expiresAt','livemode']<>'{}'::jsonb
      or p_result->'session'->>'kind' is distinct from 'portal' or coalesce(p_result->'session'->>'id','') !~ '^bps_[A-Za-z0-9]+$'
      or p_result->'session'->'expiresAt' is distinct from 'null'::jsonb or jsonb_typeof(p_result->'session'->'livemode') is distinct from 'boolean')) then
    raise exception 'Invalid redacted billing result.' using errcode='22023';
  end if;
  if intent.result is not null and intent.result->>'outcome'<>'pending' then
    -- A slower concurrent pending observation cannot regress a terminal receipt.
    if outcome='pending' then return private.billing_portal_intent_view(intent); end if;
    if intent.result-'replayed' is distinct from p_result-'replayed' then raise exception 'The native billing outcome changed.' using errcode='40001'; end if;
    return private.billing_portal_intent_view(intent);
  end if;
  update private.billing_portal_intents set result=p_result,retry_at=case when outcome='pending' then now()+interval '30 seconds' end
    where billing_portal_intents.request_id=intent.request_id returning * into intent;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values(intent.actor_id,'billing.portal.result','native_organization',intent.organization_id,jsonb_build_object('command_id',p_command_id,'outcome',outcome));
  return private.billing_portal_intent_view(intent);
end;
$$;
create function private.discard_billing_portal(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent private.billing_portal_intents%rowtype;
begin
  intent:=private.require_billing_portal_intent(p_request_id);
  if intent.preview_dispatched_at is not null or intent.dispatched_at is not null then raise exception 'A dispatched review must retain its request identity.' using errcode='40001'; end if;
  update private.billing_portal_intents set discarded_at=now() where request_id=p_request_id;
  return jsonb_build_object('discarded',true);
end;
$$;

revoke all on function private.billing_portal_actor(),private.billing_portal_intent_view(private.billing_portal_intents),private.require_billing_portal_intent(uuid),
  private.resume_billing_portal(uuid),private.reserve_billing_portal(jsonb),private.dispatch_billing_portal_preview(uuid),private.remember_billing_portal_preview(uuid,jsonb),
  private.claim_billing_portal(uuid,text),private.record_billing_portal_result(uuid,jsonb),private.discard_billing_portal(uuid) from public,anon,authenticated,service_role,hub_app_server;
grant execute on function private.resume_billing_portal(uuid),private.reserve_billing_portal(jsonb),private.dispatch_billing_portal_preview(uuid),private.remember_billing_portal_preview(uuid,jsonb),
  private.claim_billing_portal(uuid,text),private.record_billing_portal_result(uuid,jsonb),private.discard_billing_portal(uuid) to hub_app_server;
