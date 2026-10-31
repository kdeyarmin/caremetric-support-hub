begin;
select no_plan();

-- Applications change their own customers' plans only through the Hub server.
select ok(bool_and(has_function_privilege('hub_app_server',signature,'execute')),'the Hub server runs plan changes for an application''s own customer')
from unnest(array['private.app_customer_billing_tenant(uuid,text)','private.app_customer_billing_context(uuid,text,jsonb)',
 'private.app_save_customer_billing_quote(uuid,text,text,uuid,text,uuid,jsonb,jsonb,integer,text)',
 'private.app_claim_customer_billing_quote(uuid,text,text,uuid,boolean)','private.app_customer_checkout_status(uuid,text,uuid)']) signature;
select ok(not bool_or(has_function_privilege(role_name,signature,'execute')),'browsers, visitors and the service role cannot read or change an application customer''s plan')
from unnest(array['anon','authenticated','service_role']) role_name,
unnest(array['private.app_customer_billing_tenant(uuid,text)','private.app_customer_billing_context(uuid,text,jsonb)',
 'private.app_save_customer_billing_quote(uuid,text,text,uuid,text,uuid,jsonb,jsonb,integer,text)',
 'private.app_claim_customer_billing_quote(uuid,text,text,uuid,boolean)','private.app_customer_checkout_status(uuid,text,uuid)']) signature;
-- The shared workspace and reservation run only inside the requester functions that check who is asking.
select ok(not bool_or(has_function_privilege(role_name,signature,'execute')),'nobody calls the shared workspace or reservation directly')
from unnest(array['anon','authenticated','service_role','hub_app_server']) role_name,
unnest(array['private.customer_billing_workspace(uuid,uuid,uuid,text,jsonb,boolean)',
 'private.claim_customer_billing_quote_for(private.customer_billing_quotes,boolean,boolean)']) signature;
select ok(has_function_privilege('hub_app_server','private.customer_billing_context(uuid)','execute')
 and has_function_privilege('hub_app_server','private.claim_customer_billing_quote(uuid,boolean)','execute'),'the Hub customer center keeps its own requester functions');
select ok(not has_table_privilege('hub_app_server','private.customer_billing_quotes','SELECT,INSERT,UPDATE,DELETE'),'quotes stay closed to the server role');

-- A quote is either a Hub customer's or an application administrator's, never a mixture.
select ok(exists(select 1 from pg_constraint where conrelid='private.customer_billing_quotes'::regclass and conname='customer_billing_quotes_requester'),'every quote names exactly one kind of requester');
insert into hub.tenants(id,slug,name) values('97000000-0000-4000-8000-000000000045','app-plan-changes-test','App plan changes test');
select throws_ok($$insert into private.customer_billing_quotes(id,app_actor,actor_id,tenant_id,product_id,request_key,quote,execution,baseline_version)
 select gen_random_uuid(),'native-admin',(select id from auth.users limit 1),'97000000-0000-4000-8000-000000000045',id,gen_random_uuid(),'{}','{}',0 from hub.products where slug='carebase'$$,
 '23514',null,'an application quote cannot also claim a Hub user');
select throws_ok($$insert into private.customer_billing_quotes(id,tenant_id,product_id,request_key,quote,execution,baseline_version)
 select gen_random_uuid(),'97000000-0000-4000-8000-000000000045',id,gen_random_uuid(),'{}','{}',0 from hub.products where slug='carebase'$$,
 '23514',null,'a quote always names its requester');
select lives_ok($$insert into private.customer_billing_quotes(id,app_actor,tenant_id,product_id,request_key,quote,execution,baseline_version)
 select gen_random_uuid(),'native-admin','97000000-0000-4000-8000-000000000045',id,gen_random_uuid(),'{}','{}',0 from hub.products where slug='carebase'$$,
 'an application administrator owns their own quote');
select * from finish();
rollback;
