-- Additive deployment gate for the Healthcare Advisors administration bridge.
-- Registering the feature grants nothing: every read still requires the
-- current SMS administrator session, a one-use 'advisors' capability, and the
-- Advisors server's own allow-list check before any consultation request leaves it.
do $$ declare contract jsonb:=hub.get_backend_contract(); begin
  if (contract @> '{"api_version":4,"features":["app.sms.v1","platform.admin.read.v1","platform.admin.intel.v1"]}'::jsonb) is not true then
    raise exception 'Apply the Hub SMS and administrator foundations first' using errcode='55000';
  end if;
  if not exists(select 1 from hub.products where slug='advisors' and support_enabled and status<>'retired')
    or not exists(select 1 from pg_catalog.pg_constraint c
      where c.conrelid='private.app_delegations'::regclass and c.conname='app_delegations_audience_check'
        and c.contype='c' and c.convalidated
        and position('''advisors''::text' in pg_catalog.pg_get_expr(c.conbin,c.conrelid))>0
        and position('''intel''::text' in pg_catalog.pg_get_expr(c.conbin,c.conrelid))>0
        and position('''carebase.learning''::text' in pg_catalog.pg_get_expr(c.conbin,c.conrelid))>0)
    or to_regprocedure('hub.authorize_app_admin()') is null then
    raise exception 'Apply the reviewed Advisors application registration first' using errcode='55000';
  end if;
  if not (contract->'features' @> '["platform.admin.advisors.v1"]'::jsonb) then
    contract:=jsonb_set(contract,'{features}',(contract->'features')||'["platform.admin.advisors.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
