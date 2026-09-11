-- Preserve the already deployed SMS migration and combine independently shipped
-- features. API version 4 remains stable for additive, explicitly named features.
create function hub.authorize_app_command() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor jsonb; session private.sms_sessions%rowtype; expires timestamptz;
begin
  actor:=hub.authorize_app_admin();
  select * into session from private.sms_sessions
    where id::text=(select auth.jwt()->>'sms_session_id') and user_id=(select auth.uid());
  if not found or session.created_at<now()-interval '8 hours'
    or session.created_at>now()+interval '5 minutes' then
    raise exception 'Current administrator session required.' using errcode='28000';
  end if;
  expires:=least(session.expires_at,session.created_at+interval '8 hours');
  if expires<=now() then
    raise exception 'Current administrator session required.' using errcode='28000';
  end if;
  return actor || jsonb_build_object('session_id',session.id,
    'session_started_at',session.created_at,'assurance_expires_at',expires);
end;
$$;
revoke all on function hub.authorize_app_command() from public,anon;
grant execute on function hub.authorize_app_command() to authenticated;

alter table private.app_delegations drop constraint app_delegations_audience_check;
alter table private.app_delegations add constraint app_delegations_audience_check
  check(audience in ('carebase','breathe','caremetric-emr','pennsync','carebase.command','media'));

do $$
begin
  if to_regprocedure('hub.authorize_platform_admin()') is null
    or to_regprocedure('hub.authorize_platform_command()') is null
    or to_regprocedure('hub.authorize_app_admin()') is null
    or to_regprocedure('hub.authorize_app_command()') is null
    or to_regprocedure('private.current_app_session_verified()') is null
    or to_regprocedure('hub.stage_learning_source(text,text,text)') is null
    or to_regprocedure('hub.list_learning_source_heads()') is null
    or to_regprocedure('hub.get_learning_source_snapshot(uuid)') is null
    or to_regprocedure('hub.get_learning_editor_access()') is null
    or to_regprocedure('extensions.jsonb_matches_schema(json,jsonb)') is null
    or to_regclass('private.learning_source_snapshots') is null
    or to_regclass('private.sms_sessions') is null then
    raise exception 'Apply all reviewed learning, SMS and administrator migrations first';
  end if;
end;
$$;
create or replace function hub.get_backend_contract() returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('api_version',4,'features',jsonb_build_array(
    'learning.runtime.v1','platform.admin.read.v1','app.sms.v1',
    'learning.sources.v1','platform.admin.command.v1'));
$$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
