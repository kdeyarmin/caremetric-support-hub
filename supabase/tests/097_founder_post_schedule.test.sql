begin;
select plan(4);

select ok(position('kind = ''social.founder_post''' in pg_get_functiondef('private.social_schedule(uuid,integer)'::regprocedure)) > 0
  and position('kind = ''social.post''' in pg_get_functiondef('private.social_schedule(uuid,integer)'::regprocedure)) > 0,
  'A founder post is held until its time slot, as a page post is');
select ok((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = 'private.social_schedule(uuid,integer)'::regprocedure)
  and position('private.require_hub_app_server()' in pg_get_functiondef('private.social_schedule(uuid,integer)'::regprocedure)) > 0,
  'The hold is still a Hub-server-only security definer');
select ok(has_function_privilege('hub_app_server', 'private.social_schedule(uuid,integer)', 'execute')
  and not has_function_privilege('anon', 'private.social_schedule(uuid,integer)', 'execute')
  and not has_function_privilege('authenticated', 'private.social_schedule(uuid,integer)', 'execute')
  and not has_function_privilege('service_role', 'private.social_schedule(uuid,integer)', 'execute'),
  'Only the Hub server may hold a post');
select throws_ok($$select private.social_schedule(gen_random_uuid(), null)$$, '42501', null, 'Any other session is refused a hold');

select * from finish();
rollback;
