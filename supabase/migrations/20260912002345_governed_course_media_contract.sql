-- This feature declares source-reference compatibility, not native media enablement.
-- Native capabilities remain independently disabled until their reviewed release.
do $$ declare contract jsonb:=hub.get_backend_contract(); begin
 if not (contract @> '{"api_version":4,"features":["app.sms.v1","learning.sources.v1"]}'::jsonb) then
  raise exception 'Apply the governed source and SMS foundations first' using errcode='55000'; end if;
 if private.governed_learning_schema()::jsonb#>'{properties,blocks,items,properties,mediaAsset}' is null
  or position('Source media attachment is invalid.' in pg_get_functiondef('private.validate_governed_learning_source(text,text)'::regprocedure))=0
  or has_function_privilege('authenticated','private.validate_governed_learning_source(text,text)','execute')
  or has_function_privilege('anon','private.validate_governed_learning_source(text,text)','execute') then
  raise exception 'Private immutable source media validation is required' using errcode='55000'; end if;
 if not (contract->'features' @> '["learning.media.v1"]'::jsonb) then
  contract:=jsonb_set(contract,'{features}',(contract->'features')||'["learning.media.v1"]'::jsonb); end if;
 execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
