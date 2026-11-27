-- Declares platform.agents.owner-sequence-open.v1 once the weekly batch and Hunter's owner lookups take every Pennsylvania roster agency,
-- smallest first (20261127240000): neither leaves an agency out for its owners or its offices any longer, both still leave out the owner's
-- home area, an agency that is stopped (the guard), one the Marketing Manager wrote to and one in a sequence, and both stay the Hub server's.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.owner-sequence-open.v1';
  d text;
  fn text;
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.owner-sequence-batches.v1","platform.agents.growth-hunter.v1"]}'::jsonb) is not true then
    raise exception 'Apply the owner sequence batches and Hunter migrations first' using errcode = '55000';
  end if;
  foreach fn in array array['private.owner_sequence_batch_candidates(integer)', 'private.growth_hunter_next(integer)'] loop
    d := pg_get_functiondef(fn::regprocedure);
    if position('growth_outreach_stopped' in d) = 0 or position('owner_sequence_recipients' in d) = 0 or position('growth_messages' in d) = 0
       or position('''42021''' in d) = 0 or position('require_hub_app_server' in d) = 0 then
      raise exception 'Every batch must still leave out stopped agencies, agencies already written to or in a sequence, and the owner''s home area' using errcode = '55000';
    end if;
    if position('''Proprietary''' in d) > 0 or position('as offices' in d) = 0 then
      raise exception 'No agency is off limits for its owners or offices; smaller organizations come first' using errcode = '55000';
    end if;
  end loop;
  if has_function_privilege('hub_app_server', 'private.owner_sequence_batch_candidates(integer)', 'execute')
     or not has_function_privilege('hub_app_server', 'private.growth_hunter_next(integer)', 'execute')
     or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) x
                where has_function_privilege(x, 'private.growth_hunter_next(integer)', 'execute')
                   or has_function_privilege(x, 'private.owner_sequence_batch_candidates(integer)', 'execute')) then
    raise exception 'The candidates stay the batch plan''s and Hunter''s queue the Hub server''s' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
