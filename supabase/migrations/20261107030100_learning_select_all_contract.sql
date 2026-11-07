-- Additive deployment gate for select-all-that-apply questions and CareMetric PennSync course
-- placement. The editor and player handle both whether or not the feature is declared: an older
-- validator refuses the new key and placement, so nothing is saved that it cannot grade. Every test fails closed.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'learning.select-all.v1';
  pennsync hub.products%rowtype;
begin
  if (contract @> '{"api_version":4,"features":["learning.runtime.v1","learning.sequence.v1"]}'::jsonb) is not true then
    raise exception 'Apply the Hub learning runtime and ordered course delivery first' using errcode = '55000';
  end if;
  if position('correctOptionIds' in pg_get_functiondef('private.validate_learning_document(jsonb,boolean)'::regprocedure)) = 0
    or position('p.slug = ''pennsync''' in pg_get_functiondef('private.validate_learning_document(jsonb,boolean)'::regprocedure)) = 0
    or position('correctOptionIds' in pg_get_functiondef('hub.submit_learning_unit(uuid,uuid,jsonb,boolean,uuid)'::regprocedure)) = 0
    or position('''multiple''' in pg_get_functiondef('private.learning_public_document(jsonb)'::regprocedure)) = 0 then
    raise exception 'Apply the select-all and PennSync placement migration first' using errcode = '55000';
  end if;
  -- Placement reopens courses only. Support, billing and native connections stay closed.
  select * into pennsync from hub.products where slug = 'pennsync';
  if not found or pennsync.status <> 'retired' or pennsync.support_enabled
    or private.hub_application_enabled(pennsync.id) then
    raise exception 'CareMetric PennSync must remain disconnected outside course placement' using errcode = '55000';
  end if;

  if not (contract -> 'features' @> jsonb_build_array(feature)) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || jsonb_build_array(feature));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
