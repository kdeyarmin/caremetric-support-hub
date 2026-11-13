-- Declares platform.agents.founder-posts.v1 once founder posts are an action of their own that can never be approved automatically and
-- the settings exist.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.founder-posts.v1';
  founder_def text;
begin
  if (contract @> '{"api_version":4,"features":["platform.settings.v1","platform.agents.social.v1"]}'::jsonb) is not true then
    raise exception 'Apply the Hub settings and Social Media Manager migrations first' using errcode = '55000';
  end if;
  if (select count(*) from private.hub_settings where (key, kind) in (('social.founder_posts', 'flag'), ('social.founder_posts_per_week', 'number'))) <> 2 then
    raise exception 'The founder post settings are missing' using errcode = '55000';
  end if;
  if position('''social.founder_post''' in coalesce((select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'private.agent_actions'::regclass
      and conname = 'agent_actions_kind_check'), '')) = 0 then
    raise exception 'Founder posts must be an action of their own' using errcode = '55000';
  end if;
  founder_def := coalesce((select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'private.agent_actions'::regclass
    and conname = 'agent_actions_founder_post_check' and convalidated), '');
  if position('auto_approved' in founder_def) = 0 or position('social_manager' in founder_def) = 0 then
    raise exception 'A founder post must never be approved automatically' using errcode = '55000';
  end if;
  if exists (select 1 from private.agent_autonomy_steps s, jsonb_array_elements(s.changes) c, jsonb_array_elements_text(coalesce(c -> 'values', '[]')) v
      where v.value = 'social.founder_post') then
    raise exception 'No autonomy step may hand founder posts over' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
