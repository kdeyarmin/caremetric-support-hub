-- Keep the deployed feature union, including any independently reviewed feature.
do $migration$
declare signature text; contract jsonb;
begin
  if to_regprocedure('hub.get_backend_contract()') is null then
    raise exception 'Apply the combined Hub contract first' using errcode='55000';
  end if;
  contract:=hub.get_backend_contract();
  if (contract @> '{"api_version":4,"features":["learning.runtime.v1","platform.admin.read.v1","app.sms.v1","learning.sources.v1","platform.admin.command.v1","learning.receipts.v1","learning.authoring.v1","knowledge.publications.v1","support.readiness.v1","platform.admin.intel.v1","learning.draft-editing.v1","billing.portal.v1"]}'::jsonb) is not true
    or to_regclass('private.support_onboarding_intents') is null then
    raise exception 'Apply reviewed onboarding and the combined Hub foundation first' using errcode='55000';
  end if;
  foreach signature in array array[
    'private.require_support_onboarding_actor(uuid,uuid)', 'private.validate_support_identity(jsonb)',
    'private.support_onboarding_user(uuid)', 'private.support_onboarding_state(jsonb,uuid,uuid)',
    'hub.prepare_support_onboarding(uuid,uuid,jsonb,uuid,text)',
    'hub.inspect_support_onboarding(uuid,uuid,uuid,text,uuid)',
    'hub.apply_support_onboarding(uuid,uuid,uuid,text,uuid,jsonb,boolean)'
  ] loop
    if to_regprocedure(signature) is null then raise exception 'Missing reviewed onboarding function %',signature using errcode='55000'; end if;
  end loop;
  if not (contract->'features' @> '["support.customer-onboarding.v1"]'::jsonb) then
    contract:=jsonb_set(contract,'{features}',(contract->'features')||'["support.customer-onboarding.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select '||quote_literal(contract::text)||'::jsonb');
end;
$migration$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
