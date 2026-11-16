begin;
select plan(5);

select is((select array_agg(kind order by key) from private.hub_settings where key in ('creative.vision_review', 'creative.vision_min_score')),
  array['number', 'flag'], 'The image review is a switch with a least score');
select ok(has_function_privilege('hub_app_server', 'private.creative_data_counties(integer,timestamptz,jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'private.creative_data_counties(integer,timestamptz,jsonb)', 'execute')
  and not has_function_privilege('service_role', 'private.creative_data_counties(integer,timestamptz,jsonb)', 'execute'), 'Only the server picks counties from a list');
select ok(to_regprocedure('private.creative_data_counties(integer,timestamptz)') is not null, 'The older county choice stays for an older server');
select ok(position('interval ''56 days''' in pg_get_functiondef('private.creative_data_counties(integer,timestamptz,jsonb)'::regprocedure)) > 0,
  'A county rests eight weeks after it is pictured');
select ok(hub.get_backend_contract() -> 'features' ? 'platform.agents.creative-review.v1', 'The creative review feature is declared');

select * from finish();
rollback;
