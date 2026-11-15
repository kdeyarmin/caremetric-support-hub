begin;
select plan(25);

select ok(hub.get_backend_contract() -> 'features' ? 'platform.agents.autonomy-handover.v1', 'The four hand-over steps are declared in release metadata');

-- The steps ship held, each adding exactly its own values, with no minimum of decisions.
select is((select jsonb_object_agg(category, jsonb_build_array(status, requires_feature, min_reviewed, changes)) from private.agent_autonomy_steps
           where category in ('named_contacts', 'learning_memo', 'ad_campaigns', 'founder_posts')),
  '{"named_contacts": ["held", "platform.agents.autonomy-handover.v1", 0, [{"agent": "marketing_manager", "config_key": "auto_approve_kinds", "values": ["growth.named_contact"]}]],
    "learning_memo": ["held", "platform.agents.autonomy-handover.v1", 0, [{"agent": "marketing_manager", "config_key": "auto_approve_kinds", "values": ["growth.learning_memo"]}]],
    "ad_campaigns": ["held", "platform.agents.autonomy-handover.v1", 0, [{"agent": "social_manager", "config_key": "auto_approve_kinds", "values": ["social.campaign_create", "social.google_campaign"]}]],
    "founder_posts": ["held", "platform.agents.autonomy-handover.v1", 0, [{"agent": "social_manager", "config_key": "auto_approve_kinds", "values": ["social.founder_post"]}]]}'::jsonb,
  'The four steps ship held and hand over exactly their own values');
select is((select label from private.agent_autonomy_steps where category = 'named_contacts'), 'Named people''s email addresses', 'The steps are named in plain words');
select is((select (private.agent_autonomy_step_json(s)) ->> 'ready' from private.agent_autonomy_steps s where category = 'ad_campaigns'), 'true', 'Their code is on the Hub');

-- While held, nothing of these kinds is approved automatically, and their other checks stay.
select throws_ok($$insert into private.agent_actions(agent_key, kind, target_kind, target_id, preview, status)
  values ('social_manager', 'social.founder_post', 'social_item', 'founder:2026-11-16:1', 'A post.', 'auto_approved')$$, '23514', null,
  'A founder post is not approved automatically while its step is held');
select throws_ok($$insert into private.agent_actions(agent_key, kind, target_kind, target_id, preview, status)
  values ('social_manager', 'social.campaign_create', 'social_item', 'meta:caremetric-intel:2026-11', 'A campaign.', 'auto_approved')$$, '23514', null,
  'A campaign is not approved automatically while its step is held');
select throws_ok($$insert into private.agent_actions(agent_key, kind, target_kind, target_id, preview, status)
  values ('marketing_manager', 'social.founder_post', 'social_item', 'founder:2026-11-16:2', 'A post.', 'proposed')$$, '23514', null,
  'Only the Social Media Manager writes founder posts');
select throws_ok($$insert into private.agent_actions(agent_key, kind, target_kind, target_id, preview, status)
  values ('social_manager', 'social.google_campaign', 'social_item', 'google:caremetric-intel:next', 'A campaign.', 'proposed')$$, '23514', null,
  'A campaign still names its platform, product and month');
insert into private.agent_actions(id, agent_key, kind, target_kind, target_id, preview, status)
values ('01020000-0000-4000-8000-000000000001', 'social_manager', 'social.founder_post', 'social_item', 'founder:2026-11-16:3', 'A post.', 'proposed');
select throws_ok($$update private.agent_actions set status = 'auto_approved' where id = '01020000-0000-4000-8000-000000000001'$$, '23514', null,
  'A proposed founder post cannot be moved to automatically approved while held');

-- Founder posts handed over: the Social Media Manager acts and is trusted with them; campaigns still are not.
update private.agents set autonomy = 'propose', config = jsonb_set(config, '{auto_approve_kinds}', '[]') where key = 'social_manager';
select private.agent_autonomy_apply('founder_posts', 'automatic', null, 'pgtap');
select is((select array[autonomy, config ->> 'auto_approve_kinds'] from private.agents where key = 'social_manager'), array['act', '["social.founder_post"]'],
  'Making founder posts automatic sets the Social Media Manager to Act, trusted with them');
select lives_ok($$insert into private.agent_actions(agent_key, kind, target_kind, target_id, preview, status)
  values ('social_manager', 'social.founder_post', 'social_item', 'founder:2026-11-16:4', 'A post.', 'auto_approved')$$,
  'A founder post is approved automatically once its step is automatic');
select throws_ok($$insert into private.agent_actions(agent_key, kind, target_kind, target_id, preview, status)
  values ('social_manager', 'social.campaign_create', 'social_item', 'linkedin:caremetric-intel:2026-11', 'A campaign.', 'auto_approved')$$, '23514', null,
  'A campaign still is not, while its own step is held');

-- Campaigns handed over, then back.
select private.agent_autonomy_apply('ad_campaigns', 'automatic', null, 'pgtap');
select is((select config -> 'auto_approve_kinds' from private.agents where key = 'social_manager'), '["social.campaign_create", "social.founder_post", "social.google_campaign"]'::jsonb,
  'Making campaigns automatic adds both campaign kinds');
select lives_ok($$insert into private.agent_actions(agent_key, kind, target_kind, target_id, preview, status)
  values ('social_manager', 'social.google_campaign', 'social_item', 'google:caremetric-intel:2026-11', 'A campaign.', 'auto_approved')$$,
  'A campaign is approved automatically once its step is automatic');
select private.agent_autonomy_apply('ad_campaigns', 'hold', null, 'pgtap');
select private.agent_autonomy_apply('founder_posts', 'hold', null, 'pgtap');
select is((select config -> 'auto_approve_kinds' from private.agents where key = 'social_manager'), '[]'::jsonb, 'Keep approving takes the values back off');
select throws_ok($$insert into private.agent_actions(agent_key, kind, target_kind, target_id, preview, status)
  values ('social_manager', 'social.campaign_create', 'social_item', 'meta:carebase:2026-11', 'A campaign.', 'auto_approved')$$, '23514', null,
  'Held again, a campaign is refused an automatic approval');
-- A hand-back from an execution that had started keeps the approval it had, whatever the step is now.
update private.agent_actions set status = 'executing', executing_at = now() where target_id = 'founder:2026-11-16:4' and kind = 'social.founder_post';
select lives_ok($$update private.agent_actions set status = 'auto_approved', executing_at = null where target_id = 'founder:2026-11-16:4' and kind = 'social.founder_post'$$,
  'A started founder post handed back keeps its automatic approval');

-- The server boundary.
select ok(bool_and(p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false)), 'Every hand-over operation is a security definer with a pinned empty search path')
from pg_proc p where p.oid in ('private.agent_action_trusted(uuid,integer)'::regprocedure, 'private.ads_launch_reserve(uuid,integer,integer,integer,integer)'::regprocedure,
  'private.ads_launch_release(uuid,integer)'::regprocedure, 'private.agent_actions_handover_guard()'::regprocedure);
select ok(bool_and(has_function_privilege('hub_app_server', f, 'execute')
    and not has_function_privilege('anon', f, 'execute') and not has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('service_role', f, 'execute')),
  'Only the Hub server re-checks trust and reserves or releases a launch')
from unnest(array['private.agent_action_trusted(uuid,integer)', 'private.ads_launch_reserve(uuid,integer,integer,integer,integer)', 'private.ads_launch_release(uuid,integer)']) f;
select ok(not bool_or(has_function_privilege(r, f, 'execute')), 'The guard and the settings reader are internal')
from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r cross join unnest(array['private.agent_actions_handover_guard()', 'private.ads_setting_cents(text)']) f;
select throws_ok($$select private.ads_launch_reserve(gen_random_uuid(), 1, 500, 500, 10)$$, '42501', null, 'A reservation refuses anyone but the Hub server');
select ok((select relrowsecurity from pg_class where oid = 'private.ads_launch_reservations'::regclass)
  and not bool_or(has_table_privilege(r, 'private.ads_launch_reservations', 'select,insert,update,delete')), 'The launch reservations are closed to every role')
from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r;
select throws_ok($$insert into private.ads_launch_reservations(action_id, month, platform, daily_cents, days, committed_cents)
  values ('01020000-0000-4000-8000-000000000001', '2026-11', 'meta', 500, 10, 4000)$$, '23514', null, 'A reservation commits exactly its daily budget for its days');

-- Named people and the memo: on their own only under the hand-over.
select ok(position('''growth.named_contact''' in pg_get_functiondef('private.growth_person_address(uuid,text,text,text,text)'::regprocedure)) > 0
  and position('email_suppressions' in pg_get_functiondef('private.growth_person_address(uuid,text,text,text,text)'::regprocedure)) > 0
  and position('opted_out' in pg_get_functiondef('private.growth_person_address(uuid,text,text,text,text)'::regprocedure)) > 0,
  'A found address is permitted on its own only under the hand-over, never past an unsubscribe or an opt-out');
select ok(position('''growth.learning_memo''' in pg_get_functiondef('private.growth_learning_propose(text,text,jsonb)'::regprocedure)) > 0
  and position('growth.memo_activated' in pg_get_functiondef('private.growth_learning_propose(text,text,jsonb)'::regprocedure)) > 0,
  'A memo is used on its own only under the hand-over, audited as the owner''s choice is');

select * from finish();
rollback;
