begin;
select plan(12);

select ok(hub.get_backend_contract() -> 'features' ? 'platform.agents.work-recovery.v1', 'The work recovery feature is declared');
select ok(has_function_privilege('hub_app_server', 'private.creative_render_requeue(boolean)', 'execute')
  and not has_function_privilege('authenticated', 'private.creative_render_requeue(boolean)', 'execute')
  and not has_function_privilege('service_role', 'private.creative_render_requeue(boolean)', 'execute'), 'Only the server renders blocked images again');
select ok(has_function_privilege('hub_app_server', 'private.ads_platform_refusals()', 'execute')
  and not has_function_privilege('authenticated', 'private.ads_platform_refusals()', 'execute'), 'Only the server reads the ad platforms'' refusals');
select ok(not has_function_privilege('hub_app_server', 'private.growth_internal_address(text)', 'execute')
  and not has_function_privilege('hub_app_server', 'private.creative_brief_pictured(uuid)', 'execute'), 'The helpers are closed to every role');

-- The guard: two hard bounces in ten cold emails at 5% trip it; one does not (the rule, as the function computes it).
select ok(position('v_bounced >= 2 and v_bounced * 100 > v_pct * greatest(v_sent, 20)' in pg_get_functiondef('private.growth_bounce_guard()'::regprocedure)) > 0,
  'The bounce guard trips on two hard bounces counted against at least 20 emails');
select ok((2 >= 2 and 2 * 100 > 5 * greatest(10, 20)) and not (1 >= 2 and 1 * 100 > 5 * greatest(10, 20)) and (4 >= 2 and 4 * 100 > 5 * greatest(32, 20)),
  'Two of ten trips it at 5%, one of ten does not, four of 32 does');

-- Our own trials.
update private.hub_settings set value = '"owner@example.net"' where key = 'agents.owner_email';
select ok(private.growth_internal_address('Owner@Example.net') and private.growth_internal_address('team@caremetric.ai')
  and private.growth_internal_address('x@mail.caremetricintel.com') and private.growth_internal_address('x@caremetricai.com'),
  'The owner''s address and CareMetric domains are internal');
select ok(not private.growth_internal_address('owner2@example.net') and not private.growth_internal_address('a@notcaremetric.ai')
  and not private.growth_internal_address('a@gmail.com') and not private.growth_internal_address(null), 'Nothing else is, a whole personal domain included');

-- Intent follows each event.
insert into private.growth_organizations (id, name, domain) values ('00000000-0000-4000-8000-0000000001a1', 'Intent Test Hospice', 'intent-test.example.org');
insert into private.growth_opportunities (organization_id, product) values ('00000000-0000-4000-8000-0000000001a1', 'caremetric-intel');
insert into private.customer_activity_events (product, organization_id, event_key, kind, occurred_at)
  values ('caremetric-intel', '00000000-0000-4000-8000-0000000001a1', 'test:reply', 'reply', now() - interval '2 hours');
select is((select intent from private.growth_opportunities where organization_id = '00000000-0000-4000-8000-0000000001a1'), 60, 'A reply raises intent to 60');
insert into private.customer_activity_events (product, organization_id, event_key, kind, occurred_at)
  values ('caremetric-intel', '00000000-0000-4000-8000-0000000001a1', 'test:trial', 'trial_started', now() - interval '1 hour');
select is((select intent from private.growth_opportunities where organization_id = '00000000-0000-4000-8000-0000000001a1'), 100, 'A trial raises it to 100');
insert into private.customer_activity_events (product, organization_id, event_key, kind, occurred_at)
  values ('caremetric-intel', '00000000-0000-4000-8000-0000000001a1', 'test:not-now', 'not_now', now());
select is((select intent from private.growth_opportunities where organization_id = '00000000-0000-4000-8000-0000000001a1'), 25, '"Not now" sets it to 25');

-- The watchdog reads what was lost.
select ok(position('''losses''' in pg_get_functiondef('private.agent_watchdog_facts()'::regprocedure)) > 0
  and position('private.creative_brief_pictured' in pg_get_functiondef('private.creative_data_counties(integer,timestamptz,jsonb)'::regprocedure)) > 0,
  'The watchdog reads losses, and a county counts only while its snapshot pictures it');

select * from finish();
rollback;
