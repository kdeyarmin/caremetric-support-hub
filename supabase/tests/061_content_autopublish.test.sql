begin;
select plan(5);

select ok(hub.get_backend_contract() -> 'features' @> '["platform.agents.content-autopublish.v1"]'::jsonb, 'Article publishing on its own is declared in release metadata');
select ok((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = 'private.agent_content_publish(uuid,integer)'::regprocedure),
  'Publishing is still a security definer with a pinned empty search path');
select ok(has_function_privilege('hub_app_server', 'private.agent_content_publish(uuid,integer)', 'execute')
  and not bool_or(has_function_privilege(role_name, 'private.agent_content_publish(uuid,integer)', 'execute')),
  'Only the Hub server publishes')
from unnest(array['public', 'anon', 'authenticated', 'service_role']) role_name;
select ok(position('auto_approve_kinds' in pg_get_functiondef('private.agent_content_publish(uuid,integer)'::regprocedure)) > 0
  and position('approval_required' in pg_get_functiondef('private.agent_content_publish(uuid,integer)'::regprocedure)) > 0,
  'An article nobody approved is published only while the Content Marketer is trusted with publishing');
select is((select changes from private.agent_autonomy_steps where category = 'articles'),
  '[{"agent": "content_marketer", "values": ["content.publish"], "config_key": "auto_approve_kinds"}]'::jsonb,
  'The articles step hands over exactly content.publish');

select * from finish();
rollback;
