begin;
select plan(7);
select ok(hub.get_backend_contract() -> 'features' @> '["platform.agents.social-video.v1"]'::jsonb, 'Durable video publication is declared');
select ok((select relrowsecurity from pg_class where oid = 'private.social_video_publications'::regclass), 'Video state has row level security');
select is((select count(*) from pg_policies where schemaname = 'private' and tablename = 'social_video_publications'), 0::bigint, 'No direct row access policies');
select ok(not exists(select 1 from unnest(array['anon','authenticated','service_role','hub_app_server']) actor
  where has_table_privilege(actor,'private.social_video_publications','select,insert,update,delete')), 'No application role has direct video-state access');
select ok((select prosecdef and coalesce(proconfig @> array['search_path=""'],false) from pg_proc where oid = 'private.social_video_stage(uuid,integer,text,text)'::regprocedure), 'Video transitions use a pinned security definer');
select ok(has_function_privilege('hub_app_server','private.social_video_stage(uuid,integer,text,text)','execute')
  and not has_function_privilege('anon','private.social_video_stage(uuid,integer,text,text)','execute')
  and not has_function_privilege('authenticated','private.social_video_stage(uuid,integer,text,text)','execute')
  and not has_function_privilege('service_role','private.social_video_stage(uuid,integer,text,text)','execute'), 'Only Hub server can request a transition');
select throws_ok($$select private.social_video_stage(gen_random_uuid(),1,'read',null)$$,'42501',null,'Other sessions cannot use the definer');
select * from finish();
rollback;
