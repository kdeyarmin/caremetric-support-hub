begin;
select plan(9);
select ok(hub.get_backend_contract()->'features' @> '["platform.agents.app-growth.v1"]'::jsonb,'Canonical application activity is declared');
select ok((select bool_and(relrowsecurity) from pg_class where oid in('private.growth_billing_outbox'::regclass,'private.growth_lifecycle_start'::regclass)),'Lifecycle state has RLS');
select ok(not bool_or(has_table_privilege(r,t,'select,insert,update,delete')),'No application or browser role accesses lifecycle state directly')
 from unnest(array['anon','authenticated','service_role','hub_app_server']) r cross join unnest(array['private.growth_billing_outbox','private.growth_lifecycle_start']) t;
select ok(has_function_privilege('hub_app_server','private.growth_app_event(text,jsonb)','execute') and has_function_privilege('hub_app_server','private.growth_drain_billing()','execute'),'Only reviewed server entry points are available');
select ok(not bool_or(has_function_privilege(r,f,'execute')),'Browsers cannot authenticate events or drain billing')
 from unnest(array['anon','authenticated','service_role']) r cross join unnest(array['private.growth_app_event(text,jsonb)','private.growth_drain_billing()']) f;
select ok(not bool_or(has_function_privilege(r,f,'execute')),'Helpers have no callable server/client grant')
 from unnest(array['anon','authenticated','service_role','hub_app_server']) r cross join unnest(array['private.growth_ensure_customer(uuid,text)','private.growth_queue_paid(private.billing_invoices,boolean)','private.growth_capture_billing()','private.growth_maintenance_before_lifecycle()','private.agent_scorecard_facts_before_lifecycle(timestamptz,timestamptz)']) f;
select throws_ok($$select private.growth_app_event(repeat('a',64),'{}')$$,'42501','Application server required.','App event requires actual server session');
select throws_ok('select private.growth_drain_billing()','42501','Application server required.','Billing drain requires actual server session');
select ok((select started_at<=now() from private.growth_lifecycle_start),'Prospective measurement records its start');
select * from finish();
rollback;
