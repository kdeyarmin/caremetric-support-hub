begin;
select no_plan();
select ok(hub.get_backend_contract()->'features' ? 'billing.facility-entitlements.v1','the backend publishes the scoped entitlement contract');
select ok(bool_and((select relrowsecurity from pg_class where oid=to_regclass(name))),'facility revisions and legacy reservations have RLS')
 from unnest(array['private.facility_entitlement_revisions','private.billing_usage_reservations']) name;
select ok(not bool_or(has_table_privilege(role_name,name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')),'only private owner functions can access stored scope and reservation state')
 from unnest(array['anon','authenticated','service_role','hub_app_server']) role_name,
 unnest(array['private.facility_entitlement_revisions','private.billing_usage_reservations']) name;
select ok(not bool_or(has_function_privilege(role_name,signature,'EXECUTE')),'customer and service sessions cannot fabricate entitlement or usage answers')
 from unnest(array['anon','authenticated','service_role']) role_name,
 unnest(array['private.scoped_app_billing_entitlements(uuid,text)','private.app_facility_entitlement_snapshot(uuid,text,jsonb)',
 'private.prepare_scoped_billing_usage(uuid,text,text,integer,uuid)','private.lock_scoped_billing_usage(uuid,uuid)','private.complete_scoped_billing_usage(uuid,uuid,integer)']) signature;
select ok(bool_and(has_function_privilege('hub_app_server',signature,'EXECUTE')),'the application server has only the reviewed scoped entry points')
 from unnest(array['private.scoped_app_billing_entitlements(uuid,text)','private.app_facility_entitlement_snapshot(uuid,text,jsonb)',
 'private.prepare_scoped_billing_usage(uuid,text,text,integer,uuid)','private.lock_scoped_billing_usage(uuid,uuid)','private.complete_scoped_billing_usage(uuid,uuid,integer)']) signature;
select ok(not has_function_privilege('hub_app_server','private.facility_billing_products(uuid,uuid,text,jsonb)','EXECUTE'),'the server cannot pass a fabricated paid base to the product helper');
select throws_ok($$select private.app_facility_entitlement_snapshot((select id from hub.products where slug='carebase'),'synthetic-account','[]')$$,'42501','Application server required.','an owner connection cannot impersonate an authenticated app server');
select ok((select count(*)=3 from pg_trigger where tgname in('facility_entitlement_configuration_revision','facility_entitlement_allocation_revision','facility_entitlement_subscription_revision')),'configuration, allocation and provider revisions all invalidate native snapshots');
select * from finish();
rollback;
