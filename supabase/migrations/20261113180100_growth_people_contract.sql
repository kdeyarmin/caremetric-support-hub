-- Declares platform.agents.growth-people.v1 once people and the credit ledger are closed to every role, only the Hub server may
-- reserve credits, record people and found addresses or import for the signed endpoint, the owner decides on every found person,
-- found addresses wait for review, and the settings exist.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.growth-people.v1';
  fn text;
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.growth-reengage.v1","platform.agents.growth-roster.v1"]}'::jsonb) is not true then
    raise exception 'Apply the roster and re-ask migrations first' using errcode = '55000';
  end if;
  if (select count(*) from private.hub_settings where (key, kind) in (('growth.enrichment_provider', 'text'), ('growth.enrichment_daily_credits', 'number'))) <> 2 then
    raise exception 'The contact lookup settings are missing' using errcode = '55000';
  end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'private' and c.relname in ('growth_people', 'growth_enrichment_days') and not c.relrowsecurity)
    or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r,
                 unnest(array['private.growth_people', 'private.growth_enrichment_days']) t
               where has_table_privilege(r, t, 'select') or has_table_privilege(r, t, 'insert') or has_table_privilege(r, t, 'update')) then
    raise exception 'People and credits must be closed to every role' using errcode = '55000';
  end if;
  foreach fn in array array['private.growth_enrichment_reserve(integer)', 'private.growth_people_candidates(integer)',
    'private.growth_people_record(uuid,jsonb)', 'private.growth_enriched_contact(uuid,text,text)', 'private.growth_import_server(jsonb)'] loop
    if not has_function_privilege('hub_app_server', fn, 'execute')
      or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r where has_function_privilege(r, fn, 'execute')) then
      raise exception 'Only the Hub server may run %', fn using errcode = '55000';
    end if;
  end loop;
  if position('''review'', now(), p.source_url, ''enriched''' in pg_get_functiondef('private.growth_enriched_contact(uuid,text,text)'::regprocedure)) = 0
    or position('email_suppressions' in pg_get_functiondef('private.growth_enriched_contact(uuid,text,text)'::regprocedure)) = 0
    or position('''review'', now(), ''imported''' in pg_get_functiondef('private.growth_import_rows(jsonb,uuid)'::regprocedure)) = 0 then
    raise exception 'A found or imported address must wait for the owner and honour unsubscribes' using errcode = '55000';
  end if;
  if position('hub.authorize_app_command()' in pg_get_functiondef('hub.growth_people_decide(uuid[],text)'::regprocedure)) = 0
    or position('hub.authorize_app_command()' in pg_get_functiondef('hub.growth_import(jsonb)'::regprocedure)) = 0
    or has_function_privilege('anon', 'hub.growth_people_decide(uuid[],text)', 'execute') then
    raise exception 'Only the owner decides on people and imports lists' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
