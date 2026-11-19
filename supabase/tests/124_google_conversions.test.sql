begin;
select plan(7);

-- Leads from Google search ads reported to Google (20261119120000_google_conversions.sql).
select is((select kind from private.hub_settings where key = 'ads.google_conversion_action'), 'text', 'The Google Ads conversion action id has a text row');
select is((select value from private.hub_settings where key = 'ads.google_conversion_action'), null::jsonb, 'It starts empty, so nothing is reported to Google');

select lives_ok($$select private.lead_record('intel', jsonb_build_object('version', 1, 'source', 'intel', 'kind', 'trial_signup',
  'externalId', 'pgtap-google-conversion-1', 'occurredAt', now(), 'contact', jsonb_build_object('email', 'pat@agency-pgtap.example.org'),
  'attribution', jsonb_build_object('utmSource', 'google', 'utmMedium', 'cpc', 'gclid', 'Cj0KCQiA_pgtap-1', 'firstSeenAt', now() - interval '1 hour')))$$,
  'A lead from a Google ad click is accepted');
select lives_ok($$insert into private.ads_conversions(lead_id, platform, status, code)
  select id, 'google', 'sent', null from private.leads where source = 'intel' and external_id = 'pgtap-google-conversion-1'$$,
  'A lead can be recorded as reported to Google');
select throws_ok($$insert into private.ads_conversions(lead_id, platform, status, code)
  select id, 'bing', 'sent', null from private.leads where source = 'intel' and external_id = 'pgtap-google-conversion-1'$$,
  '23514', null, 'No platform but Meta, LinkedIn and Google');

select ok(position('''google''' in pg_get_functiondef('private.ads_conversion_candidates(text,integer)'::regprocedure)) > 0
  and position('private.require_hub_app_server()' in pg_get_functiondef('private.ads_conversion_candidates(text,integer)'::regprocedure)) > 0,
  'The Hub server, and only it, may read the leads to report to Google');
select ok(has_function_privilege('hub_app_server', 'private.ads_conversion_candidates(text,integer)', 'execute')
  and not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r where has_function_privilege(r, 'private.ads_conversion_candidates(text,integer)', 'execute')),
  'Only the Hub server may run it');

select * from finish();
rollback;
