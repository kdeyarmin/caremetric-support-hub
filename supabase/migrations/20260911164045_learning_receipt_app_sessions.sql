-- Add SMS as its own verified method; never relabel an app session as AAL2.
alter function private.require_receipt_command_actor(uuid,uuid) rename to require_receipt_totp_actor;
create function private.require_receipt_command_actor(p_actor_id uuid,p_session_id uuid) returns void
language plpgsql stable security definer set search_path='' as $$
declare actor jsonb;
begin
  if p_actor_id=(select auth.uid()) and p_session_id::text=(select auth.jwt()->>'sms_session_id')
    and private.current_app_session_verified() then
    actor:=hub.authorize_app_command();
    if actor->>'method'='sms' and actor->>'user_id'=p_actor_id::text and actor->>'session_id'=p_session_id::text then return; end if;
  end if;
  perform private.require_receipt_totp_actor(p_actor_id,p_session_id);
end;
$$;
revoke all on function private.require_receipt_command_actor(uuid,uuid),private.require_receipt_totp_actor(uuid,uuid) from public,anon,authenticated,service_role,hub_app_server;
grant execute on function hub.prepare_learning_receipt_mapping(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid),
  hub.set_learning_receipt_mapping_state(uuid,uuid,uuid,text),hub.provision_learning_receipt_access(uuid,uuid,uuid,uuid,uuid,uuid,text,uuid),
  hub.ingest_learning_receipt(uuid,uuid,text,text),hub.get_learning_receipt_status(uuid,uuid) to hub_app_server;
alter table private.app_delegations drop constraint app_delegations_audience_check;
alter table private.app_delegations add constraint app_delegations_audience_check
  check(audience in ('carebase','breathe','caremetric-emr','pennsync','carebase.command','carebase.learning','media'));
do $$ begin
  if to_regprocedure('hub.authorize_app_command()') is null or to_regprocedure('hub.ingest_learning_receipt(uuid,uuid,text,text)') is null
    or to_regprocedure('hub.provision_learning_receipt_access(uuid,uuid,uuid,uuid,uuid,uuid,text,uuid)') is null
    or to_regclass('private.learning_receipt_inbox') is null or to_regclass('private.learning_employee_bindings') is null then
    raise exception 'Apply reviewed receipt, identity and app session migrations first'; end if;
end; $$;
create or replace function hub.get_backend_contract() returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('api_version',4,'features',jsonb_build_array('learning.runtime.v1','platform.admin.read.v1','app.sms.v1',
    'learning.sources.v1','platform.admin.command.v1','learning.receipts.v1'));
$$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
