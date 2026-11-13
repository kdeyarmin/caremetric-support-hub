-- Declares platform.agents.growth-learning.v1 once drafts record their memo, only the Hub server reads the counts and proposes memos,
-- only the owner decides them, the memos are closed to every role and the setting exists.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.growth-learning.v1';
begin
  if (contract @> '{"api_version":4,"features":["platform.settings.v1","platform.agents.growth-reengage.v1"]}'::jsonb) is not true then
    raise exception 'Apply the Hub settings and re-ask migrations first' using errcode = '55000';
  end if;
  if not exists (select 1 from private.hub_settings where key = 'growth.learning_memo' and kind = 'flag') then
    raise exception 'The learning setting is missing' using errcode = '55000';
  end if;
  if not exists (select 1 from pg_attribute where attrelid = 'private.growth_messages'::regclass and attname = 'memo_version' and not attisdropped)
    or position('memoVersion' in pg_get_functiondef('private.growth_draft(uuid,uuid,jsonb)'::regprocedure)) = 0 then
    raise exception 'Drafts must record the memo they were written with' using errcode = '55000';
  end if;
  if exists (select 1 from unnest(array['private.growth_learning_facts(text,integer)', 'private.growth_learning_propose(text,text,jsonb)',
      'private.growth_learning_active(text)']) f
      where not has_function_privilege('hub_app_server', f, 'execute')
        or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r where has_function_privilege(r, f, 'execute')))
    or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r where has_table_privilege(r, 'private.growth_learning_memos', 'select'))
    or not (select relrowsecurity from pg_class where oid = 'private.growth_learning_memos'::regclass) then
    raise exception 'Only the Hub server may read the counts and propose memos' using errcode = '55000';
  end if;
  if position('authorize_app_command' in pg_get_functiondef('hub.growth_learning_decide(uuid,text)'::regprocedure)) = 0
    or position('authorize_app_admin' in pg_get_functiondef('hub.growth_learning(integer)'::regprocedure)) = 0 then
    raise exception 'Only the owner may read and decide memos' using errcode = '55000';
  end if;
  if not exists (select 1 from private.agent_schedules where agent_key = 'marketing_manager' and task_kind = 'growth.learn') then
    raise exception 'The weekly memo is not scheduled' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
