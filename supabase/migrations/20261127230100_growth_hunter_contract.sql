-- Declares platform.agents.growth-hunter.v1 once Hunter can find the owners' addresses for the owner's batches (20261127230000): the
-- settings exist, the lookups table is closed to every role, the next, begin and finish functions are the Hub server's alone and require
-- its connection, the lookups follow the setting and the daily number, the candidates are the batch's (the guard, the sequences, CMS's
-- control type, the owner's home area), and an address Hunter found is accepted but never permitted for the Marketing Manager on its own.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.growth-hunter.v1';
  d text;
  fn text;
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.growth-people-finder.v1","platform.agents.owner-sequence-guard.v1"]}'::jsonb) is not true then
    raise exception 'Apply the people finder and owner sequence guard migrations first' using errcode = '55000';
  end if;
  if (select count(*) from private.hub_settings where key in ('growth.hunter', 'growth.hunter_daily')) <> 2 then
    raise exception 'The Hunter settings are missing' using errcode = '55000';
  end if;
  if not (select c.relrowsecurity from pg_class c where c.oid = 'private.growth_hunter_lookups'::regclass)
     or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) x
                where has_table_privilege(x, 'private.growth_hunter_lookups', 'select,insert,update,delete')) then
    raise exception 'The Hunter lookups must be closed to hub_app_server and every other role' using errcode = '55000';
  end if;
  foreach fn in array array['private.growth_hunter_next(integer)', 'private.growth_hunter_begin(uuid,uuid)', 'private.growth_hunter_finish(uuid,text)'] loop
    if exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) x where has_function_privilege(x, fn, 'execute'))
       or not has_function_privilege('hub_app_server', fn, 'execute')
       or position('require_hub_app_server' in pg_get_functiondef(fn::regprocedure)) = 0 then
      raise exception 'The Hunter functions must be the Hub server''s alone and require its connection' using errcode = '55000';
    end if;
  end loop;
  d := pg_get_functiondef('private.growth_hunter_next(integer)'::regprocedure);
  if position('growth_outreach_stopped' in d) = 0 or position('owner_sequence_recipients' in d) = 0 or position('''Proprietary''' in d) = 0
     or position('''42021''' in d) = 0 or position('''growth.hunter''' in d) = 0 then
    raise exception 'Hunter must look up only the agencies the batch would take, while the setting is on' using errcode = '55000';
  end if;
  d := pg_get_functiondef('private.growth_hunter_begin(uuid,uuid)'::regprocedure);
  if position('growth_hunter_cap' in d) = 0 or position('''growth.hunter''' in d) = 0 then
    raise exception 'A Hunter lookup must be reserved under the daily number while the setting is on' using errcode = '55000';
  end if;
  d := pg_get_functiondef('private.growth_person_address(uuid,text,text,text,text)'::regprocedure);
  if position('''hunter''' in d) = 0 or position('p_found <> ''hunter''' in d) = 0 then
    raise exception 'An address Hunter found must be accepted and never permitted for the Marketing Manager on its own' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
