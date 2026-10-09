-- Additive deployment gate for ordered course delivery: units open in course order, a published
-- course ends with a graded post-test after its last lesson, and the certificate reports the
-- post-test score. A frontend that relies on these rules must not deploy against a backend
-- that still accepts out-of-order units or publishes a course without a post-test.
do $$ declare contract jsonb:=hub.get_backend_contract(); begin
  if (contract @> '{"api_version":4,"features":["learning.runtime.v1"]}'::jsonb) is not true then
    raise exception 'Apply the Hub learning runtime first' using errcode='55000';
  end if;
  if position('Complete the earlier lessons in order before continuing.'
      in pg_get_functiondef('hub.submit_learning_unit(uuid,uuid,jsonb,boolean,uuid)'::regprocedure))=0
    or position('last_lesson is null'
      in pg_get_functiondef('private.validate_learning_document(jsonb,boolean)'::regprocedure))=0
    or position('finalScore'
      in pg_get_functiondef('hub.get_learning_certificate(uuid)'::regprocedure))=0 then
    raise exception 'Apply the ordered course delivery migration first' using errcode='55000';
  end if;
  if not (contract->'features' @> '["learning.sequence.v1"]'::jsonb) then
    contract:=jsonb_set(contract,'{features}',(contract->'features')||'["learning.sequence.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
