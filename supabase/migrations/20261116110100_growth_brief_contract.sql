-- Declares platform.agents.growth-brief.v1 once the three settings exist, the brief and its log are closed to every role, only the Hub
-- server may hand out, save and read briefs, the server reads only a brief's writer part, the owner's reader needs a signed-in owner,
-- and the Marketing Manager's growth.brief task is scheduled.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.growth-brief.v1';
  server_fns constant text[] := array['private.growth_brief_next(integer)', 'private.growth_brief_save(uuid,jsonb)', 'private.growth_brief_writer(uuid)'];
  tables constant text[] := array['private.growth_briefs', 'private.growth_brief_log'];
  fn text; tbl text;
begin
  if (contract @> '{"api_version":4,"features":["platform.settings.v1","platform.agents.growth-autonomy.v1","platform.agents.growth-roster.v1","platform.agents.growth-research.v1"]}'::jsonb) is not true then
    raise exception 'Apply the Hub settings, growth autonomy, roster and research migrations first' using errcode = '55000';
  end if;
  if not exists (select 1 from private.hub_settings where key = 'growth.account_brief' and kind = 'flag')
    or not exists (select 1 from private.hub_settings where key = 'growth.brief_per_day' and kind = 'number')
    or not exists (select 1 from private.hub_settings where key = 'growth.brief_cents' and kind = 'number')
    or not exists (select 1 from private.hub_settings where key = 'growth.quality_writer' and kind = 'flag')
    or not exists (select 1 from private.hub_settings where key = 'growth.draft_critic' and kind = 'flag') then
    raise exception 'The account brief settings are missing' using errcode = '55000';
  end if;
  foreach tbl in array tables loop
    if not (select relrowsecurity from pg_class where oid = tbl::regclass)
      or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r
                 where has_table_privilege(r, tbl, 'select') or has_table_privilege(r, tbl, 'insert') or has_table_privilege(r, tbl, 'update') or has_table_privilege(r, tbl, 'delete')) then
      raise exception '% must be closed to every role', tbl using errcode = '55000';
    end if;
  end loop;
  foreach fn in array server_fns loop
    if not has_function_privilege('hub_app_server', fn, 'execute')
      or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r where has_function_privilege(r, fn, 'execute'))
      or position('private.require_hub_app_server()' in pg_get_functiondef(fn::regprocedure)) = 0 then
      raise exception 'Only the Hub server may run %', fn using errcode = '55000';
    end if;
  end loop;
  -- The writer never reads the research part: the agency's own figures stay out of every email.
  if position('select writer ||' in pg_get_functiondef('private.growth_brief_writer(uuid)'::regprocedure)) = 0
    or position('research' in pg_get_functiondef('private.growth_brief_writer(uuid)'::regprocedure)) > 0 then
    raise exception 'The writer must read only a brief''s writer part' using errcode = '55000';
  end if;
  if not has_function_privilege('authenticated', 'hub.growth_brief(uuid)', 'execute')
    or has_function_privilege('anon', 'hub.growth_brief(uuid)', 'execute')
    or position('hub.authorize_app_admin()' in pg_get_functiondef('hub.growth_brief(uuid)'::regprocedure)) = 0 then
    raise exception 'Only a signed-in owner may read a brief' using errcode = '55000';
  end if;
  if not exists (select 1 from private.agent_schedules where agent_key = 'marketing_manager' and task_kind = 'growth.brief') then
    raise exception 'The Marketing Manager''s brief task is not scheduled' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
