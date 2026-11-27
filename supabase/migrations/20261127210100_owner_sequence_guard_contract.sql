-- Declares platform.agents.owner-sequence-guard.v1 once the Marketing Manager's cold email leaves an owner sequence's agency alone (by its
-- domain or the CCN the roster tied to it) and a sequence's check leaves out an agency the Marketing Manager emailed, by its CCN too.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.owner-sequence-guard.v1';
  d text;
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.owner-sequences.v1"]}'::jsonb) is not true then
    raise exception 'Apply the owner sequences migrations first' using errcode = '55000';
  end if;
  d := pg_get_functiondef('private.growth_outreach_stopped(uuid)'::regprocedure);
  if position('owner_sequence_recipients' in d) = 0 or position('growth_roster_targets' in d) = 0 or position('outreach_do_not_contact' in d) = 0 then
    raise exception 'The Marketing Manager''s cold email must leave a sequence''s agency alone' using errcode = '55000';
  end if;
  d := pg_get_functiondef('private.owner_sequence_check_people(jsonb)'::regprocedure);
  if position('growth_roster_targets' in d) = 0 then
    raise exception 'A sequence must leave out an agency the Marketing Manager emailed, by its CCN too' using errcode = '55000';
  end if;
  if exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) x
             where has_function_privilege(x, 'private.owner_sequence_check_people(jsonb)', 'execute')) then
    raise exception 'The people check must not be run directly' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
