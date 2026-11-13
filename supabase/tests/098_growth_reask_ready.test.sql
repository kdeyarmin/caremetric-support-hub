begin;
select plan(5);

select ok(not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r
                      cross join unnest(array['private.growth_contact_candidates(integer)', 'private.growth_discover(text,jsonb)', 'private.growth_reengage(integer)']) f
                      where has_function_privilege(r, f, 'execute'))
  and has_function_privilege('hub_app_server', 'private.growth_contact_candidates(integer)', 'execute')
  and has_function_privilege('hub_app_server', 'private.growth_discover(text,jsonb)', 'execute')
  and has_function_privilege('hub_app_server', 'private.growth_reengage(integer)', 'execute'),
  'Only the Hub server finds contacts, discovers and re-asks');
select ok(position('reengagedAt' in pg_get_functiondef('private.growth_contact_candidates(integer)'::regprocedure)) > 0
  and position('interval ''80 days''' in pg_get_functiondef('private.growth_contact_candidates(integer)'::regprocedure)) > 0,
  'The contact finder reads a pending re-ask''s site again when its role address or evidence is too old');
select ok(position('verified_at=now()' in pg_get_functiondef('private.growth_record_contact(uuid,text,text)'::regprocedure)) > 0,
  'Finding the same address again re-verifies it');
select ok(position('where v_stage in (''qualified'',''contacted'')' in pg_get_functiondef('private.growth_discover(text,jsonb)'::regprocedure)) > 0
  and position('tenant_id is null and not internal' in pg_get_functiondef('private.growth_discover(text,jsonb)'::regprocedure)) > 0,
  'Evidence seen again past research is dated now, and a customer is still never prospected');
select ok(position('c.source_kind = ''role_address'' or c.verified_at >= now() - interval ''80 days''' in pg_get_functiondef('private.growth_reengage(integer)'::regprocedure)) > 0,
  'A re-ask starts only for an address that can be current when it is sent');

select * from finish();
rollback;
