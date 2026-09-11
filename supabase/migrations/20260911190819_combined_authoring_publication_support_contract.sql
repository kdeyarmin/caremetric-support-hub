-- Declare only reviewed, additive capabilities after their SQL boundaries exist.
-- This metadata grants no actor authority and does not attest native deployment.
do $$
declare signature text; relation_name text;
begin
  if to_regprocedure('hub.get_backend_contract()') is null then
    raise exception 'Apply the reviewed API 4 foundation first' using errcode='55000';
  end if;
  if not (hub.get_backend_contract() @> '{"api_version":4,"features":["learning.runtime.v1","platform.admin.read.v1","app.sms.v1","learning.sources.v1","platform.admin.command.v1","learning.receipts.v1"]}'::jsonb) then
    raise exception 'Apply the reviewed API 4 foundation and receipt features first' using errcode='55000';
  end if;
  foreach signature in array array[
    'hub.authorize_app_admin()',
    'hub.authorize_app_command()',
    'private.current_app_session_verified()',
    'hub.get_learning_editor_access()',
    'hub.remember_learning_authoring_preview(uuid,jsonb)',
    'hub.get_learning_authoring_intent(uuid,text)',
    'hub.record_learning_authoring_result(uuid,text,jsonb)',
    'private.publication_import_access()',
    'private.stage_publication_import(uuid,jsonb)',
    'private.get_publication_import(uuid)',
    'private.get_publication_import_context(uuid)',
    'private.verify_publication_asset(uuid,text,text,integer,text)',
    'private.store_publication_preview(uuid,jsonb)',
    'private.commit_publication_import(uuid,jsonb)',
    'private.publication_object(uuid,text,text)',
    'private.publication_media_info(uuid)',
    'private.publication_public_object(uuid,text)',
    'private.publication_public_media_info(uuid)',
    'private.issue_publication_public_download(text,uuid,text,text)',
    'private.consume_publication_public_download(text)',
    'private.issue_publication_cleanup(text)',
    'private.consume_publication_cleanup(text)',
    'private.finish_publication_cleanup(uuid)',
    'private.support_usable_member_count(uuid,uuid)',
    'hub.get_support_readiness()',
    'hub.list_support_intake_tenants(uuid,integer,integer)',
    'hub.set_support_intake(uuid,uuid,boolean,boolean,timestamp with time zone)'
  ] loop
    if to_regprocedure(signature) is null then
      raise exception 'Apply reviewed feature migrations first; missing function %',signature using errcode='55000';
    end if;
  end loop;
  foreach relation_name in array array[
    'private.learning_authoring_intents',
    'private.publication_import_settings',
    'private.publication_imports',
    'private.publication_import_assets',
    'private.publication_revision_provenance',
    'private.publication_public_downloads',
    'private.publication_cleanup_tokens',
    'private.case_intake_settings',
    'private.app_delegations'
  ] loop
    if to_regclass(relation_name) is null then
      raise exception 'Apply reviewed feature migrations first; missing table %',relation_name using errcode='55000';
    end if;
  end loop;
  -- Intel uses the existing live administrator procedure and its own closed
  -- delegation audience. No browser/native role is inferred from this feature.
  if not exists(select 1 from pg_catalog.pg_constraint c
    where c.conrelid='private.app_delegations'::regclass
      and c.conname='app_delegations_audience_check' and c.contype='c' and c.convalidated
      and position('''intel''::text' in pg_catalog.pg_get_expr(c.conbin,c.conrelid))>0) then
    raise exception 'Apply the reviewed Intel delegation audience first' using errcode='55000';
  end if;
end;
$$;

create or replace function hub.get_backend_contract() returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('api_version',4,'features',jsonb_build_array(
    'learning.runtime.v1','platform.admin.read.v1','app.sms.v1','learning.sources.v1',
    'platform.admin.command.v1','learning.receipts.v1','learning.authoring.v1',
    'knowledge.publications.v1','support.readiness.v1','platform.admin.intel.v1'));
$$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
