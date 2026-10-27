begin;
select plan(7);

select ok((select relrowsecurity from pg_class where oid='private.customer_checkout_holds'::regclass),'initial payment holds have row level security');
select ok(not bool_or(has_table_privilege(role_name,'private.customer_checkout_holds','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')),'clients and server sessions cannot change receipt holds directly')
from unnest(array['anon','authenticated','service_role','hub_app_server']) role_name;
select ok(not bool_or(has_function_privilege(role_name,signature,'EXECUTE')),'payment receipts, recovery lookups and checkout bindings are server-only')
from unnest(array['anon','authenticated','service_role']) role_name,
unnest(array['private.complete_customer_checkout(uuid,text,text,text)','private.bind_customer_checkout(uuid,text,text)','private.customer_checkout_work(uuid)','private.customer_checkout_for_session(text)','private.customer_checkout_status(uuid,uuid)','private.lock_customer_subscription_start(uuid,uuid)']) signature;
select ok(not has_function_privilege('hub_app_server','private.billing_sync_before_checkout(text,jsonb,timestamptz)','EXECUTE'),'the server cannot bypass payment holds through the former mirror function');
select ok(hub.get_backend_contract()->'features' ? 'billing.customer-checkout.v1','the contract declares the initial purchase and receipt boundary');

set local role authenticated;
select throws_ok('select private.complete_customer_checkout(null,null,null,null)','42501','permission denied for function complete_customer_checkout','a browser cannot fabricate initial payment confirmation');
reset role;
select throws_ok('select private.customer_checkout_work(null)','42501','Application server required.','even the database owner must use a real server connection for checkout work');
select * from finish();
rollback;
