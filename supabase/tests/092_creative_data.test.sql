begin;
select plan(7);

select is((select value from private.hub_settings where key = 'social.event_posts'), null::jsonb, 'Event posts start off');
select ok(exists (select 1 from private.hub_settings where key = 'creative.county_snapshots_per_week' and kind = 'number'), 'The weekly number of county snapshots is a setting');
select ok(exists (select 1 from private.hub_settings where key = 'agents.concurrent_tasks' and kind = 'number'), 'How many tasks run at once is a setting');
select ok(exists (select 1 from pg_attribute where attrelid = 'private.creative_briefs'::regclass and attname = 'facts'), 'A brief carries the figure it is about');
select ok(not bool_or(has_function_privilege(r, f, 'execute')), 'Only the Hub server picks counties and reads published articles')
  from unnest(array['anon', 'authenticated', 'service_role']) r
  cross join unnest(array['private.creative_data_counties(integer,timestamptz)', 'private.social_recent_articles(integer)']) f;
select throws_ok($$select private.creative_data_counties(3, now())$$, '42501', null, 'Counties are refused to anyone but the Hub server');
select ok(hub.get_backend_contract() -> 'features' ? 'platform.agents.creative-data.v1', 'The data creative feature is declared');

select * from finish();
rollback;
