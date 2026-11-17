begin;
select plan(16);

-- Reach outside cold email (20261117250000_reach.sql, team review 2026-11-17, stage 6).
select ok(hub.get_backend_contract() -> 'features' ? 'platform.agents.reach.v1', 'Stage 6 is declared');
select is((select count(*)::integer from private.hub_settings where key in ('social.ad_comments', 'agents.content_county_topics') and kind = 'flag' and value is null), 2,
  'Both switches have rows, off until the owner turns them on');
select ok((select relrowsecurity from pg_class where oid = 'private.social_interest'::regclass)
  and not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r
                   where has_table_privilege(r, 'private.social_interest', 'select,insert,update,delete')),
  'Interest read in a comment is closed to every role');
select ok(not exists (select 1 from unnest(array['private.social_interest_record(text,text,text,text,text,boolean)', 'private.social_post_leads(timestamp with time zone)',
    'private.creative_expiring_warnings(integer)', 'private.content_roster_counties(integer)', 'private.ads_month_campaigns(text)']) fn
  where not has_function_privilege('hub_app_server', fn, 'execute') or has_function_privilege('authenticated', fn, 'execute') or has_function_privilege('service_role', fn, 'execute')),
  'Only the server records interest and reads leads per post, expiring images, roster counties and the month''s campaigns');

create or replace function private.require_hub_app_server() returns void language plpgsql stable set search_path = '' as $$ begin return; end; $$;

-- 1. Interest: recorded once, with no words from the comment; anything else refused.
select ok(private.social_interest_record('facebook', '1_118', 'https://facebook.com/c/118', 'caremetric-intel', 'pricing', true), 'A pricing comment on an ad is recorded');
select ok(not private.social_interest_record('facebook', '1_118', 'https://facebook.com/c/118', 'caremetric-intel', 'pricing', true), 'Once');
select throws_ok($$ select private.social_interest_record('facebook', '1_119', null, null, 'complaint', false) $$, '22023', null, 'Only interest or a price question');
select throws_ok($$ select private.social_interest_record('facebook', '1_119', 'javascript:alert(1)', null, 'interested', false) $$, '22023', null, 'A link is an https address');

-- 2. Website leads by each post's own utm_content, with what the team knows about the post.
insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input, status)
values ('social_manager', 'social.post', 'social_post', 'facebook:2026-11-09:1', 'Training hours piling up?',
  jsonb_build_object('platform', 'facebook', 'product', 'carebase', 'pillar', 'tip', 'message', E'Training hours piling up?\nKeep each one in one place.', 'utmContent', 'post-20261109-facebook-1'), 'executed');
insert into private.leads (kind, source, external_id, status, test, occurred_at, received_at, contact_email, utm_source, utm_medium, utm_content) values
  ('contact', 'carebase', 'reach-118-1', 'new', false, now() - interval '1 day', now() - interval '1 day', 'a@home.example', 'facebook', 'social', 'post-20261109-facebook-1'),
  ('contact', 'carebase', 'reach-118-2', 'new', false, now() - interval '2 days', now() - interval '2 days', 'b@home.example', 'facebook', 'social', 'post-20261109-facebook-1'),
  ('contact', 'carebase', 'reach-118-3', 'new', true, now() - interval '1 day', now() - interval '1 day', 'c@home.example', 'facebook', 'social', 'post-20261109-facebook-1'),
  ('contact', 'carebase', 'reach-118-4', 'new', false, now() - interval '1 day', now() - interval '1 day', 'd@home.example', 'facebook', 'social', 'reply'),
  ('contact', 'carebase', 'reach-118-5', 'new', false, now() - interval '1 day', now() - interval '1 day', 'e@home.example', 'meta', 'paid', 'post-20261109-facebook-1');
select is(private.social_post_leads(now() - interval '7 days') -> 'posts' -> 0,
  '{"content": "post-20261109-facebook-1", "leads": 2, "platform": "facebook", "product": "carebase", "pillar": "tip", "firstLine": "Training hours piling up?", "creativeAssetId": null}'::jsonb,
  'Leads from a post, not tests, replies or paid ads, with the post''s platform, product, pillar and first line');
select is(private.social_post_leads(now() - interval '7 days') - 'posts', '{"interested": 1, "interestedOnAds": 1}'::jsonb, 'And the comments read as interest');
select throws_ok($$ select private.social_post_leads(now() - interval '200 days') $$, '22023', null, 'At most 120 days back');

-- 3. A launch that fell back to a paused campaign with no ad does not take the month's flight; one held back by the month's number does.
insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input, status, result) values
  ('social_manager', 'social.campaign_create', 'social_item', 'meta:caremetric-intel:2030-01', 'x', '{"platform": "meta", "flightDays": 7}', 'executed', '{"created": true, "launched": false, "reason": "no_approved_creative"}'),
  ('social_manager', 'social.campaign_create', 'social_item', 'linkedin:caremetric-intel:2030-01', 'x', '{"platform": "linkedin", "flightDays": 7}', 'executed', '{"created": true, "launched": false, "reason": "monthly_budget_used"}'),
  ('social_manager', 'social.campaign_create', 'social_item', 'meta:carebase:2030-01', 'x', '{"platform": "meta", "flightDays": 7}', 'executed', '{"created": true, "launched": true, "adId": "603"}');
select is((select jsonb_agg(item ->> 'empty' order by item ->> 'targetId') from jsonb_array_elements(private.ads_month_campaigns('2030-01')) item),
  '["false", "false", "true"]'::jsonb, 'Only the campaign with no ad because no creative fit is empty');

-- 4. Images with a warning about to lapse.
insert into private.creative_briefs (id, product, goal, audience, platforms, formats, source, request_key)
values ('11111111-1111-4111-8111-111111111118', 'caremetric-intel', 'Drive reports', 'Agency owners', array['meta'], array['static'], 'owner', 'reach-118');
insert into private.agent_actions (id, agent_key, kind, target_kind, target_id, preview, input, status, expires_at) values
  ('22222222-2222-4222-8222-222222222218', 'creative_director', 'creative.asset', 'creative_asset', '33333333-3333-4333-8333-333333333318', 'x', '{}', 'proposed', now() + interval '20 hours'),
  ('22222222-2222-4222-8222-222222222219', 'creative_director', 'creative.asset', 'creative_asset', '33333333-3333-4333-8333-333333333319', 'x', '{}', 'proposed', now() + interval '20 hours'),
  ('22222222-2222-4222-8222-222222222220', 'creative_director', 'creative.asset', 'creative_asset', '33333333-3333-4333-8333-333333333320', 'x', '{}', 'proposed', now() + interval '5 days');
insert into private.creative_assets (id, brief_id, product, platform, placement, kind, layout, width, height, variant_label, hook_type, headline, status, compliance, action_id) values
  ('33333333-3333-4333-8333-333333333318', '11111111-1111-4111-8111-111111111118', 'caremetric-intel', 'meta', 'meta.feed_square', 'static', 'headline', 1080, 1080, 'A', 'proof', 'Where does your agency rank?', 'proposed', '{"verdict": "warn"}', '22222222-2222-4222-8222-222222222218'),
  ('33333333-3333-4333-8333-333333333319', '11111111-1111-4111-8111-111111111118', 'caremetric-intel', 'meta', 'meta.feed_square', 'static', 'headline', 1080, 1080, 'B', 'proof', 'Passed', 'proposed', '{"verdict": "pass"}', '22222222-2222-4222-8222-222222222219'),
  ('33333333-3333-4333-8333-333333333320', '11111111-1111-4111-8111-111111111118', 'caremetric-intel', 'meta', 'meta.feed_square', 'static', 'headline', 1080, 1080, 'C', 'proof', 'Later', 'proposed', '{"verdict": "warn"}', '22222222-2222-4222-8222-222222222220');
select is((select jsonb_agg(item ->> 'assetId') from jsonb_array_elements(private.creative_expiring_warnings(48)) item where item ->> 'assetId' like '33333333-3333-4333-8333-3333333333%'),
  '["33333333-3333-4333-8333-333333333318"]'::jsonb, 'Only an image with a warning that expires within the hours asked');
select throws_ok($$ select private.creative_expiring_warnings(0) $$, '22023', null, 'Between 1 and 168 hours');

-- 5. The roster's counties with the most agencies, leaving out excluded agencies.
insert into private.growth_roster_targets (ccn, name, setting, city, state, county_fips, period, claim, rank, status) values
  ('R18001', 'Reach One Home Health', 'home_health', 'Lancaster', 'PA', '99071', '2026Q3', 'CMS record.', 90, 'new'),
  ('R18002', 'Reach Two Hospice', 'hospice', 'Lancaster', 'PA', '99071', '2026Q3', 'CMS record.', 80, 'unresolved'),
  ('R18003', 'Reach Three Home Health', 'home_health', 'Erie', 'PA', '99049', '2026Q3', 'CMS record.', 70, 'new'),
  ('R18004', 'Reach Four Hospice', 'hospice', 'Erie', 'PA', '99049', '2026Q3', 'CMS record.', 60, 'excluded'),
  ('R18005', 'Reach Five Hospice', 'hospice', 'Erie', 'PA', '99049', '2026Q3', 'CMS record.', 50, 'excluded');
select is((select jsonb_agg(item order by (item ->> 'agencies')::integer desc, item ->> 'countyFips') from jsonb_array_elements(private.content_roster_counties(100)) item where item ->> 'countyFips' like '99%'),
  '[{"countyFips": "99071", "state": "PA", "agencies": 2}, {"countyFips": "99049", "state": "PA", "agencies": 1}]'::jsonb, 'Counties by their roster agencies, excluded ones left out');
select throws_ok($$ select private.content_roster_counties(0) $$, '22023', null, 'Between 1 and 100 counties');

select * from finish();
rollback;
