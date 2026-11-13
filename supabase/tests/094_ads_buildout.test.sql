begin;
select plan(9);

select is((select value from private.hub_settings where key = 'ads.server_conversions'), null::jsonb, 'Reporting leads to the ad platforms starts off');
select is((select value from private.hub_settings where key = 'ads.monthly_budget_cents'), null::jsonb, 'No monthly number, no new campaigns');

select lives_ok($$select private.lead_record('intel', jsonb_build_object('version', 1, 'source', 'intel', 'kind', 'trial_signup',
  'externalId', 'pgtap-ads-1', 'occurredAt', now(), 'contact', jsonb_build_object('email', 'jane@agency-pgtap.example.org'),
  'attribution', jsonb_build_object('utmSource', 'facebook', 'fbclid', 'IwAR0abc_DEF', 'liFatId', 'bad value', 'firstSeenAt', now() - interval '1 day')))$$,
  'A lead with ad click IDs is accepted');
select is((select click_ids from private.leads where external_id = 'pgtap-ads-1'), '{"fbclid": "IwAR0abc_DEF"}'::jsonb, 'Its well-formed click ID is kept, a malformed one is not');
select throws_ok($$select private.lead_record('intel', jsonb_build_object('version', 1, 'source', 'intel', 'kind', 'trial_signup',
  'externalId', 'pgtap-ads-2', 'occurredAt', now(), 'contact', jsonb_build_object('email', 'jane@agency-pgtap.example.org'), 'attribution', jsonb_build_object('other', 'x')))$$,
  '22023', null, 'Other attribution fields are still refused');

select lives_ok($$insert into private.agent_actions(agent_key, kind, target_kind, target_id, preview, status)
  values ('social_manager', 'social.campaign_create', 'social_item', 'linkedin:caremetric-intel:2026-11', 'A campaign.', 'proposed')$$, 'A new campaign waits for the owner');
select throws_ok($$insert into private.agent_actions(agent_key, kind, target_kind, target_id, preview, status)
  values ('social_manager', 'social.google_campaign', 'social_item', 'google:caremetric-intel:2026-11', 'A campaign.', 'auto_approved')$$, '23514', null,
  'A new campaign is never approved automatically');
select ok(not bool_or(has_function_privilege(r, 'private.ads_conversion_candidates(text,integer)', 'execute')), 'Only the Hub server reads leads to report')
  from unnest(array['anon', 'authenticated', 'service_role']) r;
select ok(hub.get_backend_contract() -> 'features' ? 'platform.agents.ads.v1', 'The paid ads feature is declared');

select * from finish();
rollback;
