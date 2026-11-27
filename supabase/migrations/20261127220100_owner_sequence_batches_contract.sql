-- Declares platform.agents.owner-sequence-batches.v1 once the AI team can build the owner's next batch (20261127220000): the three
-- settings exist, the plan and queue functions are the Hub server's alone and require its connection, the candidates and due checks
-- cannot be run directly, the candidates read the guard (growth_outreach_stopped) and the owner sequences, and a queued batch is a request
-- in the owner's name.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.owner-sequence-batches.v1';
  d text;
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.owner-sequence-requests.v1","platform.agents.owner-sequence-guard.v1"]}'::jsonb) is not true then
    raise exception 'Apply the owner sequence requests and guard migrations first' using errcode = '55000';
  end if;
  if (select count(*) from private.hub_settings where key in ('growth.owner_sequence_batches', 'growth.owner_sequence_batch_size', 'growth.owner_sequence_batch_approve')) <> 3 then
    raise exception 'The batch settings are missing' using errcode = '55000';
  end if;
  if exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) x
             where has_function_privilege(x, 'private.owner_sequence_batch_plan(integer)', 'execute')
                or has_function_privilege(x, 'private.owner_sequence_batch_queue(jsonb)', 'execute'))
     or not has_function_privilege('hub_app_server', 'private.owner_sequence_batch_plan(integer)', 'execute')
     or not has_function_privilege('hub_app_server', 'private.owner_sequence_batch_queue(jsonb)', 'execute') then
    raise exception 'The batch plan and queue must be the Hub server''s alone' using errcode = '55000';
  end if;
  if exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) x
             where has_function_privilege(x, 'private.owner_sequence_batch_due()', 'execute')
                or has_function_privilege(x, 'private.owner_sequence_batch_candidates(integer)', 'execute')) then
    raise exception 'The batch checks must not be run directly' using errcode = '55000';
  end if;
  if position('require_hub_app_server' in pg_get_functiondef('private.owner_sequence_batch_plan(integer)'::regprocedure)) = 0
     or position('require_hub_app_server' in pg_get_functiondef('private.owner_sequence_batch_queue(jsonb)'::regprocedure)) = 0 then
    raise exception 'The batch plan and queue must require the Hub server connection' using errcode = '55000';
  end if;
  d := pg_get_functiondef('private.owner_sequence_batch_candidates(integer)'::regprocedure);
  if position('growth_outreach_stopped' in d) = 0 or position('owner_sequence_recipients' in d) = 0 or position('''Proprietary''' in d) = 0
     or position('growth_messages' in d) = 0 or position('''42021''' in d) = 0 then
    raise exception 'A batch must leave out agencies that are stopped, already written to, in a sequence, not proprietary or in the owner''s home area' using errcode = '55000';
  end if;
  d := pg_get_functiondef('private.owner_sequence_batch_queue(jsonb)'::regprocedure);
  if position('owner_sequence_requests' in d) = 0 or position('growth.owner_sequence_batch_approve' in d) = 0 then
    raise exception 'A batch must be queued as a request, approved only per the setting' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
