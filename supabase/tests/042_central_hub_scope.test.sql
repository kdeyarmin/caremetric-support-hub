begin;
select no_plan();
select is((select array_agg(slug order by slug) from hub.products where private.hub_application_enabled(id)),array['breathe','carebase','caremetric-intel'],'only the three selected applications are enabled');
select is((select count(*)::integer from hub.products where slug in ('pennsync','caremetric-emr','caremetric-go') and status='retired' and not support_enabled),3,'excluded product identities remain as retired history');
select ok(exists(select 1 from hub.products where slug='advisors' and status='active' and support_enabled and not private.hub_application_enabled(id)),'Healthcare Advisors is administered from the Hub but stays out of customer-facing features');
select is((select count(*)::integer from private.billing_app_keys k join hub.products p on p.id=k.product_id where p.slug not in ('carebase','breathe','caremetric-intel') and k.revoked_at is null),0,'excluded app credentials are revoked');
select is((select count(*)::integer from private.self_service_connections c join hub.products p on p.id=c.product_id where p.slug not in ('carebase','breathe','caremetric-intel') and c.revoked_at is null),0,'excluded native connections are revoked');
select ok(exists(select 1 from hub.content_publications cp join hub.products p on p.id=cp.product_id where p.slug='pennsync'),'historical learning publications are retained');
select ok(not has_function_privilege('authenticated','private.hub_application_enabled(uuid)','execute'),'customer sessions cannot call the private configuration helper');

insert into auth.users(id,email,raw_user_meta_data,is_anonymous) values
 ('97280000-0000-4000-8000-000000000001','historical-one@example.invalid','{"display_name":"Historical requester"}',false),
 ('97280000-0000-4000-8000-000000000002','historical-two@example.invalid','{"display_name":"Other requester"}',false);
insert into hub.tenants(id,slug,name) values
 ('97280000-0000-4000-8000-000000000010','historical-scope-a','Historical account A'),
 ('97280000-0000-4000-8000-000000000011','historical-scope-b','Historical account B');
insert into hub.tenant_products(tenant_id,product_id)
 select t.id,p.id from hub.tenants t cross join hub.products p
 where t.id in ('97280000-0000-4000-8000-000000000010','97280000-0000-4000-8000-000000000011') and p.slug='pennsync';
insert into hub.tenant_product_memberships(tenant_id,product_id,user_id,role,case_scope)
 select '97280000-0000-4000-8000-000000000010',id,'97280000-0000-4000-8000-000000000001','customer','own'
 from hub.products where slug='pennsync';
insert into hub.support_cases(id,tenant_id,product_id,requester_id,requester_display_name,subject)
 select ('97280000-0000-4000-8000-'||lpad((100+n)::text,12,'0'))::uuid,
  case when n=3 then '97280000-0000-4000-8000-000000000011'::uuid else '97280000-0000-4000-8000-000000000010'::uuid end,p.id,
  case when n=2 then '97280000-0000-4000-8000-000000000002'::uuid else '97280000-0000-4000-8000-000000000001'::uuid end,
  'Historical requester','Archived support request'
 from generate_series(1,3) n cross join hub.products p where p.slug='pennsync';
create function pg_temp.archived_case_visible(p_case uuid) returns boolean language sql as $$
 select private.can_view_case(c.id,c.tenant_id,c.product_id,c.requester_id) from hub.support_cases c where c.id=p_case;
$$;
select set_config('request.jwt.claims','{"sub":"97280000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',true);
select ok(pg_temp.archived_case_visible('97280000-0000-4000-8000-000000000101'),'requester retains access to their old case after the app disconnects');
select ok(not pg_temp.archived_case_visible('97280000-0000-4000-8000-000000000102'),'historical access does not expose another employee private case');
select ok(not pg_temp.archived_case_visible('97280000-0000-4000-8000-000000000103'),'historical access refuses another organization');
select ok(not private.is_active_member('97280000-0000-4000-8000-000000000010',(select id from hub.products where slug='pennsync')),'archival access does not restore active intake');
update hub.tenant_product_memberships set status='suspended',revoked_at=now() where user_id='97280000-0000-4000-8000-000000000001';
select ok(not pg_temp.archived_case_visible('97280000-0000-4000-8000-000000000101'),'membership revocation still closes historical access');
select * from finish();
rollback;
