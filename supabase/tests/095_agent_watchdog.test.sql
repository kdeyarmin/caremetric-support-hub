begin;
select plan(7);

select ok(exists (select 1 from private.hub_settings where key = 'agents.watchdog_idle_days' and kind = 'number'), 'The idle days are a setting');
select is((select array[min_reviewed, max_rejected_pct] from private.agent_autonomy_steps where category = 'social_posts'), array[10, 20], 'A step asks for ten decisions with at most a fifth turned down');
select ok(not has_function_privilege('authenticated', 'private.agent_watchdog_facts()', 'execute'), 'Only the Hub server reads the watchdog facts');
select throws_ok($$select private.agent_watchdog_facts()$$, '42501', null, 'They are refused to anyone else');

-- The owner turned down one of the step's own actions during supervision; a decision on another kind does not count.
insert into auth.users(id, email, is_anonymous) values ('00000000-0000-4000-8000-00000000c0de', 'watchdog-owner@test.invalid', false);
update private.agent_autonomy_steps set status = 'supervised', supervised_since = now() - interval '8 days', automatic_at = now() - interval '1 minute' where category = 'social_posts';
insert into private.agent_actions(agent_key, kind, target_kind, target_id, preview, status, decided_by, decided_at) values
  ('social_manager', 'social.post', 'social_post', 'facebook:2026-11-09:1', 'A post.', 'rejected', '00000000-0000-4000-8000-00000000c0de', now()),
  ('social_manager', 'social.post', 'social_post', 'facebook:2026-11-09:2', 'A post.', 'approved', '00000000-0000-4000-8000-00000000c0de', now()),
  ('social_manager', 'social.reply', 'social_item', 'facebook:comment:1', 'A reply.', 'rejected', '00000000-0000-4000-8000-00000000c0de', now());
select is((select private.agent_autonomy_evidence('social_posts') - 'since'), '{"reviewed": 2, "rejected": 1}'::jsonb, 'The step''s own decisions are counted');
select ok(position('not_enough_reviews' in pg_get_functiondef('private.agent_autonomy_graduate(text)'::regprocedure)) > 0, 'Too few decisions give one more supervised week');
select ok(hub.get_backend_contract() -> 'features' ? 'platform.agents.watchdog.v1', 'The watchdog feature is declared');

select * from finish();
rollback;
