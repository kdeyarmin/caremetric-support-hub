begin;
select no_plan();
insert into hub.tenants(id,slug,name) values('99000000-0000-4000-8000-000000000010','pennsync-support-only','Support-only test');
insert into auth.users(id,email,is_anonymous) values('99000000-0000-4000-8000-000000000001','support-only@example.invalid',false);
insert into private.sms_identities(user_id,phone_e164,verified_at) values('99000000-0000-4000-8000-000000000001','+12025550191',now());
insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at)
 select '99000000-0000-4000-8000-000000000002',repeat('c',64),user_id,identity_version,now()+interval '1 hour'
 from private.sms_identities where user_id='99000000-0000-4000-8000-000000000001';
insert into hub.tenant_products(tenant_id,product_id) select '99000000-0000-4000-8000-000000000010',id from hub.products where slug in ('pennsync','carebase');
insert into hub.tenant_product_memberships(tenant_id,product_id,user_id,role,case_scope)
 select '99000000-0000-4000-8000-000000000010',id,'99000000-0000-4000-8000-000000000001','tenant_admin','own' from hub.products where slug='pennsync';
insert into private.self_service_connections(id,user_id,tenant_id,product_id,source_account,source_user,role,facilities,capabilities)
 select '99000000-0000-4000-8000-000000000003','99000000-0000-4000-8000-000000000001','99000000-0000-4000-8000-000000000010',id,
 'synthetic-agency','synthetic-user','organization_admin','[]','["training.profile.v1"]' from hub.products where slug='pennsync';
grant usage on schema extensions to hub_app_server,authenticated;
set session authorization hub_app_server;
select set_config('request.jwt.claims','{"sub":"99000000-0000-4000-8000-000000000001","role":"authenticated","sms_session_id":"99000000-0000-4000-8000-000000000002"}',true);
select throws_ok($$select private.customer_billing_context('99000000-0000-4000-8000-000000000003')$$,'42501','PennSync does not accept payments','even a verified agency administrator cannot load PennSync purchasing');
set local role authenticated;
select throws_ok($$select hub.prepare_self_service_operation('99000000-0000-4000-8000-000000000003','{"action":"billing.authorize","facility_id":null}')$$,'42501','PennSync does not accept payments','the SQL capability issuer refuses payment authorization');
select lives_ok($$select hub.prepare_self_service_operation('99000000-0000-4000-8000-000000000003','{"action":"scope.read"}')$$,'support connection verification remains available');
select lives_ok($$select hub.prepare_self_service_operation('99000000-0000-4000-8000-000000000003','{"action":"profile.read","cursor":0}')$$,'personal training records remain available');
select is(hub.my_billing()->'tenants','[]'::jsonb,'a PennSync membership grants no access to shared payment records');
select throws_ok($$select hub.authorize_tenant_billing('99000000-0000-4000-8000-000000000010')$$,'42501','You do not manage billing for this organization.','a PennSync administrator cannot open the payment portal');
reset role;
reset session authorization;
insert into hub.tenant_product_memberships(tenant_id,product_id,user_id,role,case_scope)
 select '99000000-0000-4000-8000-000000000010',id,'99000000-0000-4000-8000-000000000001','tenant_admin','own' from hub.products where slug='carebase';
set session authorization hub_app_server;
set local role authenticated;
select is(jsonb_array_length(hub.my_billing()->'tenants'),1,'a separate paid-app administrator membership retains billing access');
reset role;
reset session authorization;
select is((select count(*)::integer from hub.content_publications cp join hub.content_items i on i.id=cp.item_id join hub.products p on p.id=cp.product_id where p.slug='pennsync' and i.content_key='self-service.subscriptions'),0,'PennSync does not receive payment instructions in search, AI or manuals');
select ok(exists(select 1 from hub.content_publications cp join hub.content_items i on i.id=cp.item_id join hub.products p on p.id=cp.product_id where p.slug='pennsync' and i.content_key='self-service.training-profile'),'PennSync keeps its published training guidance');
select ok(exists(select 1 from hub.content_publications cp join hub.content_items i on i.id=cp.item_id join hub.products p on p.id=cp.product_id where p.slug='carebase' and i.content_key='self-service.subscriptions'),'other applications keep their payment guidance');
select * from finish();
rollback;
