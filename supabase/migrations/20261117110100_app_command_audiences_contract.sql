-- Declares platform.admin.app-commands.v1 once Breathe and CareMetric Intel have command audiences of their own. Declaring it grants
-- nothing: every change still needs the owner's current SMS or password session (hub.authorize_app_command(), at most 8 hours
-- old), a one-use capability bound to the exact operation, and the application's own check of its mapped administrator. The
-- Hub server offers these changes only while this feature is declared.
do $$ declare contract jsonb:=hub.get_backend_contract(); begin
  if (contract @> '{"api_version":4,"features":["app.sms.v1","platform.admin.read.v1","platform.admin.command.v1","platform.admin.intel.v1"]}'::jsonb) is not true
    or to_regprocedure('hub.authorize_app_command()') is null then
    raise exception 'Apply the Hub SMS, administrator command and Intel foundations first' using errcode='55000';
  end if;
  if not exists(select 1 from pg_catalog.pg_constraint c
      where c.conrelid='private.app_delegations'::regclass and c.conname='app_delegations_audience_check' and c.contype='c' and c.convalidated
        and position('''breathe.command''::text' in pg_catalog.pg_get_expr(c.conbin,c.conrelid))>0
        and position('''intel.command''::text' in pg_catalog.pg_get_expr(c.conbin,c.conrelid))>0
        and position('''carebase.command''::text' in pg_catalog.pg_get_expr(c.conbin,c.conrelid))>0
        and position('''advisors''::text' in pg_catalog.pg_get_expr(c.conbin,c.conrelid))>0
        and position('''carebase.learning''::text' in pg_catalog.pg_get_expr(c.conbin,c.conrelid))>0) then
    raise exception 'Apply 20261117110000_app_command_audiences.sql first' using errcode='55000';
  end if;
  if not (contract->'features' @> '["platform.admin.app-commands.v1"]'::jsonb) then
    contract:=jsonb_set(contract,'{features}',(contract->'features')||'["platform.admin.app-commands.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
