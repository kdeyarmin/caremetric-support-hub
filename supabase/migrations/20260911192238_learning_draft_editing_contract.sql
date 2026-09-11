-- The editing interface must not start against clone/publication-only intent SQL.
do $$
begin
  if to_regprocedure('private.learning_authoring_actions()') is null
    or to_regprocedure('hub.remember_learning_authoring_preview(uuid,jsonb)') is null
    or to_regprocedure('hub.record_learning_authoring_result(uuid,text,jsonb)') is null then
    raise exception 'Apply the reviewed draft editing intent migration first' using errcode='55000';
  end if;
  if (private.learning_authoring_actions() @> array['learning.patchDraft','learning.reviewDraft']::text[]) is not true
    or (hub.get_backend_contract() @> '{"api_version":4,"features":["learning.runtime.v1","platform.admin.read.v1","app.sms.v1","learning.sources.v1","platform.admin.command.v1","learning.receipts.v1","learning.authoring.v1","knowledge.publications.v1","support.readiness.v1","platform.admin.intel.v1"]}'::jsonb) is not true then
    raise exception 'Apply the reviewed draft editing and combined platform contract first' using errcode='55000';
  end if;
end;
$$;
create or replace function hub.get_backend_contract() returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('api_version',4,'features',jsonb_build_array(
    'learning.runtime.v1','platform.admin.read.v1','app.sms.v1','learning.sources.v1',
    'platform.admin.command.v1','learning.receipts.v1','learning.authoring.v1',
    'knowledge.publications.v1','support.readiness.v1','platform.admin.intel.v1','learning.draft-editing.v1'));
$$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
