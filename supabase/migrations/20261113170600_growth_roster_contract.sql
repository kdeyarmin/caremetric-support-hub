-- Declares platform.agents.growth-roster.v1 once the roster tables are closed to every role, only the Hub server may save, hand
-- out and resolve roster agencies, the owner's read is the Growth screen's, and the three roster settings exist.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.growth-roster.v1';
  server_fns constant text[] := array['private.growth_roster_sync_state()', 'private.growth_roster_sync_save(jsonb)',
    'private.growth_roster_upsert(text,jsonb)', 'private.growth_roster_next(integer,integer)', 'private.growth_roster_resolved(text,jsonb)'];
  fn text;
begin
  if (contract @> '{"api_version":4,"features":["platform.settings.v1","platform.agents.customer-growth.v1","platform.agents.growth-autonomy.v1"]}'::jsonb) is not true then
    raise exception 'Apply the Hub settings, customer growth and growth autonomy migrations first' using errcode = '55000';
  end if;
  if (select count(*) from private.hub_settings where (key, kind) in (('growth.roster', 'flag'), ('growth.roster_states', 'list'),
      ('growth.roster_daily_resolutions', 'number'))) <> 3 then
    raise exception 'The roster settings are missing' using errcode = '55000';
  end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'private' and c.relname in ('growth_roster_targets', 'growth_roster_sync') and not c.relrowsecurity)
    or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r,
                 unnest(array['private.growth_roster_targets', 'private.growth_roster_sync']) t
               where has_table_privilege(r, t, 'select') or has_table_privilege(r, t, 'insert') or has_table_privilege(r, t, 'update')
                  or has_table_privilege(r, t, 'delete')) then
    raise exception 'The roster tables must be closed to every role' using errcode = '55000';
  end if;
  foreach fn in array server_fns loop
    if not has_function_privilege('hub_app_server', fn, 'execute')
      or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r where has_function_privilege(r, fn, 'execute')) then
      raise exception 'Only the Hub server may run %', fn using errcode = '55000';
    end if;
  end loop;
  if exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r
             where has_function_privilege(r, 'private.growth_roster_evidence(text)', 'execute')) then
    raise exception 'The roster evidence writer must be closed to every role' using errcode = '55000';
  end if;
  if has_function_privilege('anon', 'hub.growth_roster(integer)', 'execute')
    or position('hub.authorize_app_admin()' in pg_get_functiondef('hub.growth_roster(integer)'::regprocedure)) = 0 then
    raise exception 'The roster read must be the owner''s' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
