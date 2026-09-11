-- Hub owns reviewed request/session recovery. Native CareBase alone owns the
-- organization-wide reservation, immutable provider parameters and Stripe key.
create type private.billing_checkout_action as enum ('billing.checkout.create','billing.checkout.recover');
create table private.billing_checkout_intents (
  request_id uuid primary key,
  actor_id uuid not null references hub.profiles(id),
  session_id uuid not null references private.sms_sessions(id),
  organization_id uuid not null,
  action private.billing_checkout_action not null default 'billing.checkout.create',
  request jsonb not null check(octet_length(request::text)<=4096),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  preview_dispatched_at timestamptz,
  command_id uuid unique,
  preview jsonb check(octet_length(preview::text)<=8192),
  preview_expires_at timestamptz,
  dispatched_at timestamptz,
  observation_id uuid,
  provider_session_id text check(provider_session_id ~ '^cs_(test|live)_[A-Za-z0-9]+$' and length(provider_session_id)<=255),
  result jsonb check(octet_length(result::text)<=4096),
  recovery jsonb check(octet_length(recovery::text)<=256),
  retry_at timestamptz,
  discarded_at timestamptz,
  check((preview is null)=(command_id is null)),
  check((preview is null)=(preview_expires_at is null)),
  check(result is null or dispatched_at is not null),
  check(observation_id is null or dispatched_at is not null),
  check(discarded_at is null or preview_dispatched_at is null)
);
create index billing_checkout_actor_idx on private.billing_checkout_intents(actor_id,created_at);
create index billing_checkout_session_idx on private.billing_checkout_intents(session_id,organization_id,created_at);
create index billing_checkout_created_idx on private.billing_checkout_intents(created_at);
create index billing_checkout_expiry_idx on private.billing_checkout_intents(expires_at);
alter table private.billing_checkout_intents enable row level security;
revoke all on private.billing_checkout_intents from public,anon,authenticated,service_role,hub_app_server;

create function private.billing_checkout_intent_view(p_intent private.billing_checkout_intents) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('request',p_intent.request,'preview',p_intent.preview,'result',p_intent.result,
    'createdAt',p_intent.created_at,'expiresAt',p_intent.expires_at,'previewDispatchedAt',p_intent.preview_dispatched_at,
    'dispatchedAt',p_intent.dispatched_at,'retryAt',p_intent.retry_at,'recovery',p_intent.recovery);
$$;
create function private.require_billing_checkout_intent(p_request_id uuid) returns private.billing_checkout_intents
language plpgsql security definer set search_path='' as $$
declare v_actor jsonb; v_intent private.billing_checkout_intents;
begin
  -- Reuse the existing billing actor boundary, including the dedicated server
  -- session_user and current Hub/SMS authority. No browser role grants.
  v_actor:=private.billing_portal_actor();
  select * into v_intent from private.billing_checkout_intents where request_id=p_request_id for update;
  if not found or v_intent.actor_id is distinct from (v_actor->>'user_id')::uuid
    or v_intent.session_id is distinct from (v_actor->>'session_id')::uuid or v_intent.expires_at<=now() or v_intent.discarded_at is not null then
    raise exception 'Checkout review unavailable.' using errcode='42501';
  end if;
  return v_intent;
end;
$$;
create function private.resume_billing_checkout(p_organization_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_actor jsonb; v_intent private.billing_checkout_intents;
begin
  v_actor:=private.billing_portal_actor();
  select * into v_intent from private.billing_checkout_intents where organization_id=p_organization_id
    and actor_id=(v_actor->>'user_id')::uuid and session_id=(v_actor->>'session_id')::uuid
    and expires_at>now() and discarded_at is null order by created_at desc,request_id desc limit 1;
  if not found then return null; end if;
  return private.billing_checkout_intent_view(v_intent);
end;
$$;
create function private.reserve_billing_checkout(p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_actor jsonb; v_intent private.billing_checkout_intents; v_request_id uuid; v_organization_id uuid; v_package_id uuid;
begin
  v_actor:=private.billing_portal_actor();
  if p_request is null or jsonb_typeof(p_request)<>'object' or octet_length(p_request::text)>4096
    or jsonb_typeof(p_request->'reason') is distinct from 'string' or coalesce(length(p_request->>'reason'),0) not between 10 and 500
    or p_request->>'reason'<>btrim(p_request->>'reason') or p_request->>'reason' ~ '[[:cntrl:]]' then
    raise exception 'Invalid checkout review.' using errcode='22023';
  end if;
  if p_request->>'operation'='recover' and p_request->>'action'='billing.checkout.recover' then
    if not(p_request ?& array['operation','requestId','action','targetId','reason'])
      or p_request-array['operation','requestId','action','targetId','reason']<>'{}'::jsonb then
      raise exception 'Invalid checkout recovery.' using errcode='22023';
    end if;
  elsif p_request->>'operation'='preview' and p_request->>'action'='billing.checkout.create' then
    if not(p_request ?& array['operation','requestId','action','targetId','parameters','reason'])
      or p_request-array['operation','requestId','action','targetId','parameters','reason']<>'{}'::jsonb
      or jsonb_typeof(p_request->'parameters') is distinct from 'object'
      or not((p_request->'parameters') ?& array['packageId','billingInterval'])
      or (p_request->'parameters')-array['packageId','billingInterval']<>'{}'::jsonb
      or coalesce(p_request#>>'{parameters,billingInterval}','') not in ('month','year') then
      raise exception 'Invalid checkout review.' using errcode='22023';
    end if;
    begin v_package_id:=(p_request#>>'{parameters,packageId}')::uuid;
    exception when others then raise exception 'Invalid checkout package.' using errcode='22023'; end;
    if v_package_id is null then raise exception 'Invalid checkout package.' using errcode='22023'; end if;
  else raise exception 'Invalid checkout action.' using errcode='22023'; end if;
  begin v_request_id:=(p_request->>'requestId')::uuid; v_organization_id:=(p_request->>'targetId')::uuid;
  exception when others then raise exception 'Invalid checkout identity.' using errcode='22023'; end;
  if v_request_id is null or v_organization_id is null then raise exception 'Invalid checkout identity.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('billing.checkout.reserve',0));
  delete from private.billing_checkout_intents where expires_at<now()-interval '30 days';
  select * into v_intent from private.billing_checkout_intents where request_id=v_request_id;
  if found then
    v_intent:=private.require_billing_checkout_intent(v_request_id);
    if v_intent.request is distinct from p_request then raise exception 'Checkout request key changed.' using errcode='40001'; end if;
    return private.billing_checkout_intent_view(v_intent);
  end if;
  if p_request->>'operation'<>'recover' and exists(select 1 from (select * from private.billing_checkout_intents where organization_id=v_organization_id
    and actor_id=(v_actor->>'user_id')::uuid and session_id=(v_actor->>'session_id')::uuid and expires_at>now() and discarded_at is null order by created_at desc,request_id desc limit 1) latest
    where (result is null or result->'canStartNewCheckout' is distinct from 'true'::jsonb)
    and (recovery is null or recovery->'canStartNewCheckout' is distinct from 'true'::jsonb)
    and (dispatched_at is not null or preview_expires_at>now() or (preview is null and created_at>now()-interval '6 minutes'))) then
    raise exception 'Resume the reserved checkout.' using errcode='40001';
  end if;
  if (select count(*) from private.billing_checkout_intents where created_at>now()-interval '1 hour')>=200
    or (select count(*) from private.billing_checkout_intents where actor_id=(v_actor->>'user_id')::uuid and created_at>now()-interval '1 hour')>=20 then
    raise exception 'Checkout review limit reached.' using errcode='54000';
  end if;
  insert into private.billing_checkout_intents(request_id,actor_id,session_id,organization_id,action,request,expires_at)
    values(v_request_id,(v_actor->>'user_id')::uuid,(v_actor->>'session_id')::uuid,v_organization_id,(p_request->>'action')::private.billing_checkout_action,p_request,(v_actor->>'assurance_expires_at')::timestamptz)
    returning * into v_intent;
  return private.billing_checkout_intent_view(v_intent);
end;
$$;
create function private.dispatch_billing_checkout_preview(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_intent private.billing_checkout_intents;
begin
  v_intent:=private.require_billing_checkout_intent(p_request_id);
  update private.billing_checkout_intents set preview_dispatched_at=coalesce(preview_dispatched_at,now())
    where request_id=p_request_id returning * into v_intent;
  return private.billing_checkout_intent_view(v_intent);
end;
$$;
create function private.remember_billing_checkout_preview(p_request_id uuid,p_preview jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_intent private.billing_checkout_intents; v_summary jsonb; v_command_id uuid; v_expires timestamptz;
begin
  v_intent:=private.require_billing_checkout_intent(p_request_id); v_summary:=p_preview->'summary';
  if v_intent.action<>'billing.checkout.create' or v_intent.preview_dispatched_at is null or p_preview is null or jsonb_typeof(p_preview)<>'object'
    or octet_length(p_preview::text)>8192 or not(p_preview ?& array['commandId','action','targetId','reason','expiresAt','previewDigest','summary'])
    or p_preview-array['commandId','action','targetId','reason','expiresAt','previewDigest','summary']<>'{}'::jsonb
    or p_preview->>'action' is distinct from 'billing.checkout.create' or p_preview->>'targetId' is distinct from v_intent.request->>'targetId'
    or p_preview->>'reason' is distinct from v_intent.request->>'reason' or coalesce(p_preview->>'previewDigest','') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(v_summary) is distinct from 'object'
    or not(v_summary ?& array['kind','organizationName','packageId','billingInterval','intervalCount','currency','billingMetric','quantity','providerPriceId','providerCustomerId','trialDays'])
    or v_summary-array['kind','organizationName','packageId','billingInterval','intervalCount','currency','billingMetric','quantity','providerPriceId','providerCustomerId','trialDays']<>'{}'::jsonb
    or v_summary->>'kind' is distinct from 'checkout'
    or v_summary->>'packageId' is distinct from v_intent.request#>>'{parameters,packageId}'
    or v_summary->>'billingInterval' is distinct from v_intent.request#>>'{parameters,billingInterval}'
    or coalesce(v_summary->>'currency','') !~ '^[a-z]{3}$'
    or coalesce(v_summary->>'billingMetric','') not in ('flat','active_learner','active_user','active_resident','facility')
    or jsonb_typeof(v_summary->'intervalCount') is distinct from 'number' or coalesce(v_summary->>'intervalCount','') !~ '^[0-9]+$'
    or (v_summary->>'intervalCount')::numeric not between 1 and 36
    or jsonb_typeof(v_summary->'quantity') is distinct from 'number' or coalesce(v_summary->>'quantity','') !~ '^[0-9]+$'
    or (v_summary->>'quantity')::numeric not between 1 and 9007199254740991
    or jsonb_typeof(v_summary->'trialDays') is distinct from 'number' or coalesce(v_summary->>'trialDays','') !~ '^[0-9]+$'
    or (v_summary->>'trialDays')::numeric not between 0 and 90
    or coalesce(v_summary->>'providerPriceId','') !~ '^price_[A-Za-z0-9]+$'
    or (v_summary->'providerCustomerId'<>'null'::jsonb and coalesce(v_summary->>'providerCustomerId','') !~ '^cus_[A-Za-z0-9]+$')
    or jsonb_typeof(v_summary->'organizationName') is distinct from 'string' or length(v_summary->>'organizationName')>500 then
    raise exception 'Invalid native checkout preview.' using errcode='22023';
  end if;
  begin v_command_id:=(p_preview->>'commandId')::uuid; v_expires:=(p_preview->>'expiresAt')::timestamptz;
  exception when others then raise exception 'Invalid checkout preview identity.' using errcode='22023'; end;
  if v_command_id is null or v_expires is null or not isfinite(v_expires) or v_expires>clock_timestamp()+interval '5 minutes 1 second' then
    raise exception 'Invalid checkout preview lifetime.' using errcode='22023';
  end if;
  if v_intent.preview is not null then
    if v_intent.preview is distinct from p_preview then raise exception 'Checkout preview changed.' using errcode='40001'; end if;
    return private.billing_checkout_intent_view(v_intent);
  end if;
  if v_expires<=clock_timestamp() then raise exception 'Checkout preview expired.' using errcode='40001'; end if;
  update private.billing_checkout_intents set command_id=v_command_id,preview=p_preview,preview_expires_at=v_expires
    where request_id=p_request_id returning * into v_intent;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values(v_intent.actor_id,'billing.checkout.preview','native_organization',v_intent.organization_id,jsonb_build_object('command_id',v_command_id));
  return private.billing_checkout_intent_view(v_intent);
end;
$$;
create function private.claim_billing_checkout(p_command_id uuid,p_expected_digest text,p_check_only boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_intent private.billing_checkout_intents; v_request_id uuid;
begin
  perform private.billing_portal_actor();
  select request_id into v_request_id from private.billing_checkout_intents where command_id=p_command_id;
  v_intent:=private.require_billing_checkout_intent(v_request_id);
  if v_intent.action='billing.checkout.recover' and p_check_only is not true then raise exception 'Recovery cannot create checkout.' using errcode='42501'; end if;
  if p_check_only is null or p_expected_digest is distinct from v_intent.preview->>'previewDigest' then raise exception 'Checkout review changed.' using errcode='40001'; end if;
  if v_intent.dispatched_at is null and (p_check_only or v_intent.preview_expires_at<=clock_timestamp()) then
    raise exception 'Checkout has not been applied or its review expired.' using errcode='40001';
  end if;
  update private.billing_checkout_intents set dispatched_at=coalesce(dispatched_at,now()),observation_id=gen_random_uuid()
    where request_id=v_request_id returning * into v_intent;
  return jsonb_build_object('intent',private.billing_checkout_intent_view(v_intent),'observationId',v_intent.observation_id);
end;
$$;
create function private.record_billing_checkout_result(p_command_id uuid,p_observation_id uuid,p_result jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_intent private.billing_checkout_intents; v_request_id uuid; v_outcome text; v_session jsonb; v_checked timestamptz; v_expires timestamptz;
begin
  perform private.billing_portal_actor();
  select request_id into v_request_id from private.billing_checkout_intents where command_id=p_command_id;
  v_intent:=private.require_billing_checkout_intent(v_request_id);
  if p_observation_id is null or v_intent.observation_id is distinct from p_observation_id then
    raise exception 'Checkout observation superseded.' using errcode='40001';
  end if;
  v_outcome:=p_result->>'outcome'; v_session:=p_result->'session';
  if v_intent.dispatched_at is null or p_result is null or jsonb_typeof(p_result)<>'object' or octet_length(p_result::text)>4096
    or not(p_result ?& array['commandId','action','targetId','outcome','replayed','checkedAt','providerStatus','availability','canStartNewCheckout','retryAfterSeconds','session'])
    or p_result-array['commandId','action','targetId','outcome','replayed','checkedAt','providerStatus','availability','canStartNewCheckout','retryAfterSeconds','session']<>'{}'::jsonb
    or p_result->>'commandId' is distinct from p_command_id::text or p_result->>'targetId' is distinct from v_intent.organization_id::text
    or p_result->>'action' is distinct from v_intent.action::text or coalesce(v_outcome,'') not in ('open','complete','expired','pending','failed')
    or jsonb_typeof(p_result->'replayed') is distinct from 'boolean' or jsonb_typeof(p_result->'canStartNewCheckout') is distinct from 'boolean'
    or coalesce(p_result->>'availability','') not in ('available','unavailable')
    or jsonb_typeof(p_result->'checkedAt') not in ('string','null')
    or (p_result->'providerStatus'<>'null'::jsonb and coalesce(p_result->>'providerStatus','') not in ('open','complete','expired'))
    or (v_outcome in ('open','pending') and p_result->'canStartNewCheckout' is distinct from 'false'::jsonb)
    or (v_outcome='pending' and (p_result->'retryAfterSeconds' is distinct from '30'::jsonb or v_session is distinct from 'null'::jsonb))
    or (v_outcome<>'pending' and (p_result->>'availability' is distinct from 'available' or jsonb_typeof(p_result->'checkedAt') is distinct from 'string'
      or p_result->'retryAfterSeconds' is distinct from 'null'::jsonb))
    or (v_outcome in ('complete','expired') and p_result->>'providerStatus' is distinct from v_outcome)
    or (v_outcome='failed' and p_result->'providerStatus' is distinct from 'null'::jsonb)
    or (v_outcome<>'open' and v_session is distinct from 'null'::jsonb)
    or (v_outcome='open' and (p_result->>'providerStatus' is distinct from 'open' or jsonb_typeof(v_session) is distinct from 'object'
      or not(v_session ?& array['kind','id','expiresAt','livemode']) or v_session-array['kind','id','expiresAt','livemode']<>'{}'::jsonb
      or v_session->>'kind' is distinct from 'checkout' or coalesce(v_session->>'id','') !~ '^cs_(test|live)_[A-Za-z0-9]+$'
      or length(v_session->>'id')>255 or jsonb_typeof(v_session->'livemode') is distinct from 'boolean'
      or ((v_session->>'id' like 'cs_live_%') is distinct from (v_session->>'livemode')::boolean))) then
    raise exception 'Invalid redacted checkout result.' using errcode='22023';
  end if;
  begin
    v_checked:=(p_result->>'checkedAt')::timestamptz; v_expires:=(v_session->>'expiresAt')::timestamptz;
  exception when others then raise exception 'Invalid checkout result time.' using errcode='22023'; end;
  if (v_checked is not null and not isfinite(v_checked)) or (v_outcome='open' and (v_expires is null or not isfinite(v_expires) or v_expires<=clock_timestamp())) then
    raise exception 'Checkout result unavailable or expired.' using errcode='40001';
  end if;
  if v_outcome='open' and v_intent.provider_session_id is not null and v_intent.provider_session_id is distinct from v_session->>'id' then
    raise exception 'Native checkout session changed.' using errcode='40001';
  end if;
  update private.billing_checkout_intents set result=p_result,
    recovery=case when action='billing.checkout.recover' then jsonb_build_object('checkedAt',now(),'canStartNewCheckout',p_result->'canStartNewCheckout') end, retry_at=case when v_outcome='pending' then now()+interval '30 seconds' end,
    provider_session_id=coalesce(provider_session_id,v_session->>'id')
    where request_id=v_request_id returning * into v_intent;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values(v_intent.actor_id,'billing.checkout.result','native_organization',v_intent.organization_id,jsonb_build_object('command_id',p_command_id,'outcome',v_outcome));
  return private.billing_checkout_intent_view(v_intent);
end;
$$;
create function private.claim_billing_checkout_recovery(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_intent private.billing_checkout_intents;
begin
  v_intent:=private.require_billing_checkout_intent(p_request_id);
  if v_intent.action<>'billing.checkout.recover' then raise exception 'Recovery action required.' using errcode='42501'; end if;
  update private.billing_checkout_intents set preview_dispatched_at=coalesce(preview_dispatched_at,now()),
    dispatched_at=coalesce(dispatched_at,now()),observation_id=gen_random_uuid()
    where request_id=p_request_id returning * into v_intent;
  return jsonb_build_object('intent',private.billing_checkout_intent_view(v_intent),'observationId',v_intent.observation_id);
end;
$$;
create function private.remember_billing_checkout_recovery(p_request_id uuid,p_observation_id uuid,p_data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_intent private.billing_checkout_intents; v_preview jsonb; v_result jsonb; v_summary jsonb; v_command uuid; v_package uuid; v_expires timestamptz;
begin
  v_intent:=private.require_billing_checkout_intent(p_request_id);
  if v_intent.action<>'billing.checkout.recover' or v_intent.dispatched_at is null then raise exception 'Recovery action required.' using errcode='42501'; end if;
  if p_observation_id is null or v_intent.observation_id is distinct from p_observation_id then raise exception 'Checkout observation superseded.' using errcode='40001'; end if;
  if p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>12288
    or not(p_data ?& array['targetId','preview','result','canStartNewCheckout'])
    or p_data-array['targetId','preview','result','canStartNewCheckout']<>'{}'::jsonb
    or p_data->>'targetId' is distinct from v_intent.organization_id::text
    or jsonb_typeof(p_data->'canStartNewCheckout') is distinct from 'boolean' then
    raise exception 'Invalid checkout recovery result.' using errcode='22023';
  end if;
  v_preview:=p_data->'preview';v_result:=p_data->'result';v_summary:=v_preview->'summary';
  if v_preview='null'::jsonb and v_result='null'::jsonb then
    if v_intent.preview is not null then raise exception 'Original recovery command changed.' using errcode='40001'; end if;
    update private.billing_checkout_intents set recovery=jsonb_build_object('checkedAt',now(),'canStartNewCheckout',p_data->'canStartNewCheckout')
      where request_id=p_request_id returning * into v_intent;
    insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
      values(v_intent.actor_id,'billing.checkout.recover','native_organization',v_intent.organization_id,jsonb_build_object('request_id',p_request_id,'found',false));
    return private.billing_checkout_intent_view(v_intent);
  end if;
  if jsonb_typeof(v_preview) is distinct from 'object' or jsonb_typeof(v_result) is distinct from 'object'
    or not(v_preview ?& array['commandId','action','targetId','reason','expiresAt','previewDigest','summary'])
    or v_preview-array['commandId','action','targetId','reason','expiresAt','previewDigest','summary']<>'{}'::jsonb
    or v_preview->>'action' is distinct from 'billing.checkout.recover'
    or v_preview->>'targetId' is distinct from v_intent.organization_id::text or v_preview->>'reason' is distinct from v_intent.request->>'reason'
    or coalesce(v_preview->>'previewDigest','') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(v_summary) is distinct from 'object'
    or not(v_summary ?& array['kind','organizationName','packageId','billingInterval','intervalCount','currency','billingMetric','quantity','providerPriceId','providerCustomerId','trialDays'])
    or v_summary-array['kind','organizationName','packageId','billingInterval','intervalCount','currency','billingMetric','quantity','providerPriceId','providerCustomerId','trialDays']<>'{}'::jsonb
    or v_summary->>'kind' is distinct from 'checkout' or coalesce(v_summary->>'billingInterval','') not in ('month','year')
    or coalesce(v_summary->>'currency','') !~ '^[a-z]{3}$'
    or coalesce(v_summary->>'billingMetric','') not in ('flat','active_learner','active_user','active_resident','facility')
    or jsonb_typeof(v_summary->'intervalCount') is distinct from 'number' or coalesce(v_summary->>'intervalCount','') !~ '^[0-9]+$'
    or (v_summary->>'intervalCount')::numeric not between 1 and 36
    or jsonb_typeof(v_summary->'quantity') is distinct from 'number' or coalesce(v_summary->>'quantity','') !~ '^[0-9]+$'
    or (v_summary->>'quantity')::numeric not between 1 and 9007199254740991
    or jsonb_typeof(v_summary->'trialDays') is distinct from 'number' or coalesce(v_summary->>'trialDays','') !~ '^[0-9]+$'
    or (v_summary->>'trialDays')::numeric not between 0 and 90
    or coalesce(v_summary->>'providerPriceId','') !~ '^price_[A-Za-z0-9]+$' or length(v_summary->>'providerPriceId')>255
    or (v_summary->'providerCustomerId'<>'null'::jsonb and (coalesce(v_summary->>'providerCustomerId','') !~ '^cus_[A-Za-z0-9]+$' or length(v_summary->>'providerCustomerId')>255))
    or jsonb_typeof(v_summary->'organizationName') is distinct from 'string' or length(v_summary->>'organizationName')>500
    or v_result->'canStartNewCheckout' is distinct from p_data->'canStartNewCheckout' then
    raise exception 'Invalid original checkout terms.' using errcode='22023';
  end if;
  begin v_command:=(v_preview->>'commandId')::uuid;v_package:=(v_summary->>'packageId')::uuid;v_expires:=(v_preview->>'expiresAt')::timestamptz;
  exception when others then raise exception 'Invalid recovery identity.' using errcode='22023'; end;
  if v_command is null or v_package is null or v_expires is null or not isfinite(v_expires) or v_expires>clock_timestamp()+interval '5 minutes 1 second' then
    raise exception 'Invalid recovery lifetime.' using errcode='22023';
  end if;
  -- Recovery creates no provider capability. Its original inspection preview
  -- may expire while GET-only checks remain valid in the current SMS session.
  if v_intent.preview is not null and v_intent.preview is distinct from v_preview then raise exception 'Original recovery terms changed.' using errcode='40001'; end if;
  update private.billing_checkout_intents set command_id=v_command,preview=v_preview,preview_expires_at=v_expires where request_id=p_request_id;
  return private.record_billing_checkout_result(v_command,p_observation_id,v_result);
end;
$$;
create function private.discard_billing_checkout(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_intent private.billing_checkout_intents;
begin
  v_intent:=private.require_billing_checkout_intent(p_request_id);
  if v_intent.preview_dispatched_at is not null or v_intent.dispatched_at is not null then raise exception 'Dispatched checkout review must keep its identity.' using errcode='40001'; end if;
  update private.billing_checkout_intents set discarded_at=now() where request_id=p_request_id;
  return jsonb_build_object('discarded',true);
end;
$$;
revoke all on function private.billing_checkout_intent_view(private.billing_checkout_intents),private.require_billing_checkout_intent(uuid),
  private.resume_billing_checkout(uuid),private.reserve_billing_checkout(jsonb),private.dispatch_billing_checkout_preview(uuid),
  private.remember_billing_checkout_preview(uuid,jsonb),private.claim_billing_checkout(uuid,text,boolean),
  private.record_billing_checkout_result(uuid,uuid,jsonb),private.claim_billing_checkout_recovery(uuid),private.remember_billing_checkout_recovery(uuid,uuid,jsonb),private.discard_billing_checkout(uuid) from public,anon,authenticated,service_role,hub_app_server;
grant execute on function private.resume_billing_checkout(uuid),private.reserve_billing_checkout(jsonb),private.dispatch_billing_checkout_preview(uuid),
  private.remember_billing_checkout_preview(uuid,jsonb),private.claim_billing_checkout(uuid,text,boolean),
  private.record_billing_checkout_result(uuid,uuid,jsonb),private.claim_billing_checkout_recovery(uuid),private.remember_billing_checkout_recovery(uuid,uuid,jsonb),private.discard_billing_checkout(uuid) to hub_app_server;
