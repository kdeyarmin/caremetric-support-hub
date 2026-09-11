-- Registration is separate from granting app access. Preserve every reviewed
-- feature already present, including course controls released independently.
do $migration$
declare signature text; contract jsonb;
begin
  if to_regprocedure('hub.get_backend_contract()') is null then raise exception 'Apply the Hub foundation first' using errcode='55000';end if;
  contract:=hub.get_backend_contract();
  if (contract @> '{"api_version":4,"features":["app.sms.v1","support.customer-onboarding.v1","learning.receipts.v1"]}'::jsonb) is not true
    or to_regclass('private.support_registration_reviews') is null or to_regclass('private.support_registration_invitations') is null then
    raise exception 'Apply the reviewed registration foundation first' using errcode='55000';end if;
  foreach signature in array array[
    'private.validate_registration_identity(jsonb)','private.registration_available(jsonb,text)',
    'private.support_native_issuer(text)',
    'private.registration_issuer_current(private.support_registration_invitations)',
    'private.start_registration_challenge(text,text,text,text,uuid)',
    'private.inspect_registration_challenge(uuid,text)','private.complete_support_registration(uuid,text)',
    'hub.prepare_support_registration(uuid,uuid,jsonb,text,text,text)',
    'hub.inspect_support_registration(uuid,uuid,uuid,text)',
    'hub.issue_support_registration(uuid,uuid,uuid,text,uuid,text,jsonb,boolean)',
    'hub.list_support_registrations(uuid,uuid,integer)','hub.revoke_support_registration(uuid,uuid,uuid,boolean)'
  ] loop
    if to_regprocedure(signature) is null then raise exception 'Missing reviewed registration function %',signature using errcode='55000';end if;
    if has_function_privilege('anon',signature,'execute') or has_function_privilege('authenticated',signature,'execute') then
      raise exception 'Registration functions must remain private: %',signature using errcode='55000';end if;
  end loop;
  if private.support_native_issuer('carebase') is distinct from 'https://xsqobvvreaovwibxwyvv.supabase.co/auth/v1'
    or private.validate_support_identity('{"product":"carebase","sourceUserId":"11111111-1111-4111-8111-111111111111","sourceAccountId":"22222222-2222-4222-8222-222222222222","accountKind":"organization","relationship":"organization_member","revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'::jsonb) is distinct from 'carebase' then
    raise exception 'Apply canonical CareBase support pairing first' using errcode='55000';end if;
  if not (contract->'features' @> '["support.customer-registration.v1"]'::jsonb) then
    contract:=jsonb_set(contract,'{features}',(contract->'features')||'["support.customer-registration.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select '||quote_literal(contract::text)||'::jsonb');
end;
$migration$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
