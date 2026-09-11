-- Additive compatibility only: Stripe/native configuration remains runtime state.
do $$
declare signature text;
begin
  if to_regprocedure('hub.get_backend_contract()') is null then
    raise exception 'Apply the reviewed billing portal foundation first' using errcode='55000';
  end if;
  if (hub.get_backend_contract() @> '{"api_version":4,"features":["learning.runtime.v1","platform.admin.read.v1","app.sms.v1","learning.sources.v1","platform.admin.command.v1","learning.receipts.v1","learning.authoring.v1","knowledge.publications.v1","support.readiness.v1","platform.admin.intel.v1","learning.draft-editing.v1"]}'::jsonb) is not true then
    raise exception 'Apply the reviewed combined editing contract before billing portal declaration' using errcode='55000';
  end if;
  if to_regclass('private.billing_portal_intents') is null
    or to_regtype('private.billing_portal_action') is null then
    raise exception 'Apply the reviewed billing portal intent table and action enum first' using errcode='55000';
  end if;
  foreach signature in array array[
    'hub.authorize_app_command()',
    'private.current_app_session_verified()',
    'private.billing_portal_actor()',
    'private.billing_portal_intent_view(private.billing_portal_intents)',
    'private.require_billing_portal_intent(uuid)',
    'private.resume_billing_portal(uuid)',
    'private.reserve_billing_portal(jsonb)',
    'private.dispatch_billing_portal_preview(uuid)',
    'private.remember_billing_portal_preview(uuid,jsonb)',
    'private.claim_billing_portal(uuid,text)',
    'private.record_billing_portal_result(uuid,jsonb)',
    'private.discard_billing_portal(uuid)'
  ] loop
    if to_regprocedure(signature) is null then
      raise exception 'Apply reviewed billing portal migration first; missing function %',signature using errcode='55000';
    end if;
  end loop;
  if enum_range(null::private.billing_portal_action)::text[] is distinct from array['billing.portal.create']::text[]
    or not exists(select 1 from pg_catalog.pg_attribute a
      where a.attrelid='private.billing_portal_intents'::regclass and a.attname='action'
        and not a.attisdropped and a.attnotnull and a.atttypid='private.billing_portal_action'::regtype)
    or position('''billing.portal.create''' in pg_catalog.pg_get_functiondef('private.reserve_billing_portal(jsonb)'::regprocedure))=0 then
    raise exception 'Apply the reviewed closed billing portal action contract first' using errcode='55000';
  end if;
end;
$$;
create or replace function hub.get_backend_contract() returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('api_version',4,'features',jsonb_build_array(
    'learning.runtime.v1','platform.admin.read.v1','app.sms.v1','learning.sources.v1',
    'platform.admin.command.v1','learning.receipts.v1','learning.authoring.v1',
    'knowledge.publications.v1','support.readiness.v1','platform.admin.intel.v1',
    'learning.draft-editing.v1','billing.portal.v1'));
$$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
