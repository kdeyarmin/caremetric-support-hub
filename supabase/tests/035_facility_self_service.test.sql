begin;
select no_plan();

select ok(bool_and((select relrowsecurity from pg_class where oid=to_regclass(name))), 'self-service state has RLS')
from unnest(array['private.self_service_handoffs','private.self_service_connections','private.self_service_operations','private.facility_billing_configuration','private.facility_billing_allocations','private.customer_billing_quotes']) name;
select ok(not bool_or(has_table_privilege(role_name,name,'SELECT,INSERT,UPDATE,DELETE')), 'client and service roles cannot read connection, quote, or capability state directly')
from unnest(array['anon','authenticated','service_role','hub_app_server']) role_name,
unnest(array['private.self_service_handoffs','private.self_service_connections','private.self_service_operations','private.customer_billing_quotes']) name;
select ok(not has_function_privilege('authenticated','private.refresh_self_service_scope(uuid,jsonb)','EXECUTE'),'a browser cannot grant itself cached native authority');
select ok(not has_function_privilege('authenticated','private.settle_customer_billing_quote(uuid,text,text,text,text)','EXECUTE'),'a browser cannot settle a purchase');
select ok(hub.get_backend_contract()->'features' ? 'customer.self-service.v1','backend contract advertises the implemented customer interfaces');

insert into hub.tenants(id,slug,name) values
 ('97000000-0000-4000-8000-000000000010','self-service-test-a','Self service test A'),
 ('97000000-0000-4000-8000-000000000011','self-service-test-b','Self service test B');
insert into hub.tenant_products(tenant_id,product_id) select t.id,p.id from hub.tenants t cross join hub.products p
where t.id in ('97000000-0000-4000-8000-000000000010','97000000-0000-4000-8000-000000000011') and p.slug='carebase';
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,confirmation_token,recovery_token,email_change_token_new,email_change,email_change_token_current,reauthentication_token,is_sso_user,is_anonymous)
select '00000000-0000-0000-0000-000000000000',('97000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'authenticated','authenticated',
 'hub-self-service-'||n||'@example.invalid','x',now(),'{}',jsonb_build_object('display_name','Synthetic user '||n),now(),now(),'','','','','','',false,false from generate_series(1,5) n;
insert into hub.tenant_product_memberships(tenant_id,product_id,user_id,role,case_scope)
select case when n=5 then '97000000-0000-4000-8000-000000000011'::uuid else '97000000-0000-4000-8000-000000000010'::uuid end,p.id,
 ('97000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'customer','own' from generate_series(1,5) n cross join hub.products p where p.slug='carebase';
insert into private.self_service_connections(user_id,tenant_id,product_id,source_account,source_user,role,facilities,capabilities)
select ('97000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'97000000-0000-4000-8000-000000000010',p.id,'native-account','native-user-'||n,
 case when n=3 then 'organization_admin' else 'facility_admin' end,
 jsonb_build_array(jsonb_build_object('id',case when n=2 then 'site-b' else 'site-a' end,'name','Synthetic site','permissions',jsonb_build_array('support.manage'))),'[]'::jsonb
 from generate_series(1,3) n cross join hub.products p where p.slug='carebase';
insert into hub.support_cases(id,tenant_id,product_id,requester_id,requester_display_name,subject,facility_id,facility_shared)
select ('97000000-0000-4000-8000-'||lpad((100+n)::text,12,'0'))::uuid,
 case when n=4 then '97000000-0000-4000-8000-000000000011'::uuid else '97000000-0000-4000-8000-000000000010'::uuid end,p.id,
 case when n=4 then '97000000-0000-4000-8000-000000000005'::uuid else '97000000-0000-4000-8000-000000000004'::uuid end,
 'Synthetic requester','Support request '||n,case when n=3 then 'site-b' else 'site-a' end,n<>2
 from generate_series(1,4) n cross join hub.products p where p.slug='carebase';
create function pg_temp.case_visible(p_case uuid) returns boolean language sql as $$
 select private.can_view_case(c.id,c.tenant_id,c.product_id,c.requester_id) from hub.support_cases c where c.id=p_case;
$$;
select set_config('request.jwt.claims','{"sub":"97000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
select ok(pg_temp.case_visible('97000000-0000-4000-8000-000000000101'),'delegated support manager sees an explicitly shared case at their facility');
select ok(not pg_temp.case_visible('97000000-0000-4000-8000-000000000102'),'an employee private case stays private');
select ok(not pg_temp.case_visible('97000000-0000-4000-8000-000000000103'),'delegation refuses another facility');
select ok(not pg_temp.case_visible('97000000-0000-4000-8000-000000000104'),'delegation refuses another organization');
select set_config('request.jwt.claims','{"sub":"97000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2"}',true);
select ok(pg_temp.case_visible('97000000-0000-4000-8000-000000000103'),'organization administrator sees shared cases across its facilities');
select ok(not pg_temp.case_visible('97000000-0000-4000-8000-000000000102'),'organization administrator does not gain access to a private employee case');
select set_config('request.jwt.claims','{"sub":"97000000-0000-4000-8000-000000000004","role":"authenticated","aal":"aal2"}',true);
select ok(pg_temp.case_visible('97000000-0000-4000-8000-000000000102'),'requester retains their own private ticket');
update private.self_service_connections set scope_checked_at=now()-interval '2 minutes' where user_id='97000000-0000-4000-8000-000000000001';
select set_config('request.jwt.claims','{"sub":"97000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
select ok(not pg_temp.case_visible('97000000-0000-4000-8000-000000000101'),'expired native scope cannot expose shared facility cases');
select is((select count(*)::integer from hub.content_items where content_key like 'self-service.%'),6,'maintained customer guides are published');
select is((select count(*)::integer from hub.content_publications cp join hub.content_items i on i.id=cp.item_id join hub.products p on p.id=cp.product_id where i.content_key like 'self-service.%' and p.slug='caremetric-go'),0,'CareBase self-service does not change Go guidance or billing');
select * from finish();
rollback;
