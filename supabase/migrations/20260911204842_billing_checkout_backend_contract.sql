-- Hub compatibility is separate from native/Stripe configuration and readiness.
do $$
declare signature text;
begin
  if (hub.get_backend_contract() @> '{"api_version":4,"features":["learning.runtime.v1","platform.admin.read.v1","app.sms.v1","learning.sources.v1","platform.admin.command.v1","learning.receipts.v1","learning.authoring.v1","knowledge.publications.v1","support.readiness.v1","platform.admin.intel.v1","learning.draft-editing.v1","billing.portal.v1","support.customer-onboarding.v1","learning.structure.v1"]}'::jsonb) is not true then
    raise exception 'Apply the complete structure and portal foundation before checkout declaration' using errcode='55000';
  end if;
  if to_regclass('private.billing_checkout_intents') is null or to_regtype('private.billing_checkout_action') is null then
    raise exception 'Apply the reviewed checkout intent table and action enum first' using errcode='55000';
  end if;
  foreach signature in array array[
    'hub.authorize_app_command()', 'private.current_app_session_verified()', 'private.billing_portal_actor()',
    'private.billing_checkout_intent_view(private.billing_checkout_intents)', 'private.require_billing_checkout_intent(uuid)',
    'private.resume_billing_checkout(uuid)', 'private.reserve_billing_checkout(jsonb)', 'private.dispatch_billing_checkout_preview(uuid)',
    'private.remember_billing_checkout_preview(uuid,jsonb)', 'private.claim_billing_checkout(uuid,text,boolean)',
    'private.record_billing_checkout_result(uuid,uuid,jsonb)', 'private.claim_billing_checkout_recovery(uuid)', 'private.remember_billing_checkout_recovery(uuid,uuid,jsonb)', 'private.discard_billing_checkout(uuid)'
  ] loop
    if to_regprocedure(signature) is null then
      raise exception 'Missing reviewed checkout function %',signature using errcode='55000';
    end if;
  end loop;
  if enum_range(null::private.billing_checkout_action)::text[] is distinct from array['billing.checkout.create','billing.checkout.recover']::text[]
    or not exists(select 1 from pg_catalog.pg_attribute a where a.attrelid='private.billing_checkout_intents'::regclass
      and a.attname='action' and not a.attisdropped and a.attnotnull and a.atttypid='private.billing_checkout_action'::regtype)
    or position('''billing.checkout.create''' in pg_catalog.pg_get_functiondef('private.reserve_billing_checkout(jsonb)'::regprocedure))=0
    or position('''packageId''' in pg_catalog.pg_get_functiondef('private.reserve_billing_checkout(jsonb)'::regprocedure))=0 then
    raise exception 'Apply the closed checkout action and native plan contract first' using errcode='55000';
  end if;
  if position('Recovery cannot create checkout.' in pg_catalog.pg_get_functiondef('private.claim_billing_checkout(uuid,text,boolean)'::regprocedure))=0
    or position('p_check_only is not true' in pg_catalog.pg_get_functiondef('private.claim_billing_checkout(uuid,text,boolean)'::regprocedure))=0 then
    raise exception 'Apply the GET-only recovery boundary first' using errcode='55000';
  end if;
  if not exists(select 1 from pg_catalog.pg_attribute a where a.attrelid='private.billing_checkout_intents'::regclass
      and a.attname='observation_id' and not a.attisdropped and a.atttypid='uuid'::regtype)
    or not exists(select 1 from pg_catalog.pg_attribute a where a.attrelid='private.billing_checkout_intents'::regclass
      and a.attname='provider_session_id' and not a.attisdropped and a.atttypid='text'::regtype)
    or position('p_observation_id' in pg_catalog.pg_get_functiondef('private.record_billing_checkout_result(uuid,uuid,jsonb)'::regprocedure))=0
    or position('v_intent.observation_id is distinct from p_observation_id' in pg_catalog.pg_get_functiondef('private.record_billing_checkout_result(uuid,uuid,jsonb)'::regprocedure))=0
    or position('v_intent.provider_session_id' in pg_catalog.pg_get_functiondef('private.record_billing_checkout_result(uuid,uuid,jsonb)'::regprocedure))=0 then
    raise exception 'Apply the checkout observation and immutable session boundary first' using errcode='55000';
  end if;
end;
$$;
-- Preserve earlier independently reviewed features in a captured public literal.
do $declaration$
declare contract jsonb:=hub.get_backend_contract(); features jsonb;
begin
  features:=contract->'features';
  if jsonb_typeof(features) is distinct from 'array' or jsonb_array_length(features)>99
    or exists(select 1 from jsonb_array_elements(features) value where jsonb_typeof(value)<>'string')
    or (select count(*)<>count(distinct value) from jsonb_array_elements(features) value) then
    raise exception 'Invalid prior checkout feature declaration' using errcode='55000';
  end if;
  if not(features ? 'billing.checkout.v1') then features:=features||'["billing.checkout.v1"]'::jsonb; end if;
  contract:=jsonb_build_object('api_version',4,'features',features);
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    format('select %L::jsonb',contract::text));
end;
$declaration$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
