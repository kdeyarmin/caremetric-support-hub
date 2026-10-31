begin;
select no_plan();
select ok(has_function_privilege('hub_app_server','private.app_billing_portal_customer(uuid,text)','execute'),'the Hub server opens billing for an application''s own customer');
select ok(not has_function_privilege('authenticated','private.app_billing_portal_customer(uuid,text)','execute'),'browser sessions cannot look up billing customers');
select ok(not has_function_privilege('anon','private.app_billing_portal_customer(uuid,text)','execute'),'anonymous visitors cannot look up billing customers');
select ok(not has_function_privilege('service_role','private.app_billing_portal_customer(uuid,text)','execute'),'the service role cannot look up billing customers');
select * from finish();
rollback;
