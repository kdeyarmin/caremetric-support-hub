begin;
select plan(6);

select is((select value from private.hub_settings where key = 'social.founder_posts'), null::jsonb, 'Posts for the founder''s profile start off');
select lives_ok($$insert into private.agent_actions(agent_key, kind, target_kind, target_id, preview, status)
  values ('social_manager', 'social.founder_post', 'social_item', 'founder:2026-11-09:1', 'A post.', 'proposed')$$, 'A founder post waits for the owner');
select throws_ok($$insert into private.agent_actions(agent_key, kind, target_kind, target_id, preview, status)
  values ('social_manager', 'social.founder_post', 'social_item', 'founder:2026-11-09:2', 'A post.', 'auto_approved')$$, '23514', null,
  'A founder post is not approved automatically while the owner has not handed them over');
select throws_ok($$insert into private.agent_actions(agent_key, kind, target_kind, target_id, preview, status)
  values ('marketing_manager', 'social.founder_post', 'social_item', 'founder:2026-11-09:3', 'A post.', 'proposed')$$, '23514', null, 'Only the Social Media Manager writes them');
-- Since 2026-11-15 one step can hand them over (20261115200000_autonomy_handover.sql); it ships held, and no other step names them.
select is((select array_agg(s.category || ':' || s.status) from private.agent_autonomy_steps s, jsonb_array_elements(s.changes) c, jsonb_array_elements_text(coalesce(c -> 'values', '[]')) v
  where v.value = 'social.founder_post'), array['founder_posts:held'], 'Only the founder posts step hands them over, and it ships held');
select ok(hub.get_backend_contract() -> 'features' ? 'platform.agents.founder-posts.v1', 'The founder posts feature is declared');

select * from finish();
rollback;
