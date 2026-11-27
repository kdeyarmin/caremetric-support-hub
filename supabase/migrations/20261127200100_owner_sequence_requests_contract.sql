-- Declares platform.agents.owner-sequence-requests.v1 once: owner sequences are declared; the requests table is closed to every role (only a
-- database operator queues one); only the Hub server takes, checks and finishes a request; a request is prepared only for an active
-- CareMetric admin and approved only when it asked; the shared save, check and approval cannot be run directly; and the owner's commands
-- still need the owner's session and use the shared functions.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.owner-sequence-requests.v1';
  server_fns constant text[] := array['private.owner_sequence_request_next()', 'private.owner_sequence_request_check(uuid,jsonb)',
    'private.owner_sequence_request_finish(uuid,jsonb,jsonb,text)'];
  helpers constant text[] := array['private.owner_sequence_save(uuid,jsonb)', 'private.owner_sequence_check_people(jsonb)',
    'private.owner_sequence_approve_as(uuid,uuid,integer,text)'];
  fn text; r text; d text;
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.owner-sequences.v1"]}'::jsonb) is not true then
    raise exception 'Apply the owner sequences migrations first' using errcode = '55000';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'private.owner_sequence_requests'::regclass) then
    raise exception 'The requests must have row level security' using errcode = '55000';
  end if;
  foreach r in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
    if has_table_privilege(r, 'private.owner_sequence_requests', 'select') or has_table_privilege(r, 'private.owner_sequence_requests', 'insert')
      or has_table_privilege(r, 'private.owner_sequence_requests', 'update') or has_table_privilege(r, 'private.owner_sequence_requests', 'delete') then
      raise exception 'The requests must be closed to %', r using errcode = '55000';
    end if;
  end loop;
  foreach fn in array server_fns loop
    if not has_function_privilege('hub_app_server', fn, 'execute')
      or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) x where has_function_privilege(x, fn, 'execute'))
      or position('private.require_hub_app_server()' in pg_get_functiondef(fn::regprocedure)) = 0 then
      raise exception 'Only the Hub server may run %', fn using errcode = '55000';
    end if;
  end loop;
  foreach fn in array helpers loop
    if exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) x where has_function_privilege(x, fn, 'execute')) then
      raise exception '% must not be run directly', fn using errcode = '55000';
    end if;
  end loop;
  if position('platform.admin' in pg_get_functiondef('private.owner_sequence_request_next()'::regprocedure)) = 0 then
    raise exception 'A request must be prepared only for a CareMetric admin' using errcode = '55000';
  end if;
  d := pg_get_functiondef('private.owner_sequence_request_finish(uuid,jsonb,jsonb,text)'::regprocedure);
  if position('if r.approve then' in d) = 0 or position('owner_sequence_save(r.requested_by' in d) = 0 then
    raise exception 'A request must be saved in its requester''s name and approved only when it asked' using errcode = '55000';
  end if;
  if position('hub.authorize_app_command()' in pg_get_functiondef('hub.owner_sequence_create(jsonb)'::regprocedure)) = 0
    or position('private.owner_sequence_save' in pg_get_functiondef('hub.owner_sequence_create(jsonb)'::regprocedure)) = 0
    or position('hub.authorize_app_command()' in pg_get_functiondef('hub.owner_sequence_approve(uuid,integer)'::regprocedure)) = 0
    or position('private.owner_sequence_approve_as' in pg_get_functiondef('hub.owner_sequence_approve(uuid,integer)'::regprocedure)) = 0
    or position('hub.authorize_app_admin()' in pg_get_functiondef('hub.owner_sequence_check(jsonb)'::regprocedure)) = 0 then
    raise exception 'The owner''s commands must need the owner''s session and use the shared functions' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
