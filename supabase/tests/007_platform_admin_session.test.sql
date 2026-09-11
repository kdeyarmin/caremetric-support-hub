begin;
select plan(14);

insert into auth.users (id,aud,role,email,email_confirmed_at,is_anonymous,created_at,updated_at)
values ('99000000-0000-4000-8000-000000000001','authenticated','authenticated','platform-session@test.invalid',now(),false,now(),now());
update hub.profiles set display_name='Platform session test'
where id='99000000-0000-4000-8000-000000000001';
insert into private.staff_permissions (user_id,permission,product_id)
values ('99000000-0000-4000-8000-000000000001','platform.admin',null);
insert into auth.mfa_factors (id,user_id,factor_type,status,created_at,updated_at)
values ('99000000-0000-4000-8000-000000000002','99000000-0000-4000-8000-000000000001','totp','verified',now(),now());
insert into auth.sessions (id,user_id,factor_id,aal,created_at,updated_at)
values ('99000000-0000-4000-8000-000000000003','99000000-0000-4000-8000-000000000001','99000000-0000-4000-8000-000000000002','aal2',now(),now());

select ok(not has_function_privilege('anon','hub.authorize_platform_admin()','execute'),'anonymous callers cannot invoke delegated authorization');
select ok(has_function_privilege('authenticated','hub.authorize_platform_admin()','execute'),'authenticated callers can request authorization');
set local request.jwt.claims='{"sub":"99000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2","session_id":"99000000-0000-4000-8000-000000000003"}';
set local role authenticated;
select is(hub.authorize_platform_admin(),'{"user_id":"99000000-0000-4000-8000-000000000001","role":"platform_admin","aal":"aal2"}'::jsonb,'current MFA administrator succeeds with identity only');
reset role;
update private.staff_permissions set revoked_at=now() where user_id='99000000-0000-4000-8000-000000000001';
select throws_ok('select hub.authorize_platform_admin()','42501','Portfolio administrator permission required.','revoked permission denies an unexpired session');
update private.staff_permissions set revoked_at=null,product_id=(select id from hub.products order by id limit 1) where user_id='99000000-0000-4000-8000-000000000001';
select throws_ok('select hub.authorize_platform_admin()','42501','Portfolio administrator permission required.','product-scoped permission cannot become portfolio authority');
update private.staff_permissions set product_id=null where user_id='99000000-0000-4000-8000-000000000001';
update auth.sessions set not_after=now()-interval '1 minute' where id='99000000-0000-4000-8000-000000000003';
select throws_ok('select hub.authorize_platform_admin()','28000','Current administrator session required.','expired session is denied');
update auth.sessions set not_after=null,aal='aal1' where id='99000000-0000-4000-8000-000000000003';
select throws_ok('select hub.authorize_platform_admin()','28000','Current administrator session required.','downgraded server session is denied despite stale AAL2 claim');
update auth.sessions set aal='aal2' where id='99000000-0000-4000-8000-000000000003';
update auth.mfa_factors set status='unverified' where id='99000000-0000-4000-8000-000000000002';
select throws_ok('select hub.authorize_platform_admin()','28000','Current administrator session required.','unverified factor is denied');
update auth.mfa_factors set status='verified' where id='99000000-0000-4000-8000-000000000002';
update auth.users set banned_until=now()+interval '1 day' where id='99000000-0000-4000-8000-000000000001';
select throws_ok('select hub.authorize_platform_admin()','28000','Current administrator session required.','banned user is denied');
update auth.users set banned_until=null,is_anonymous=true where id='99000000-0000-4000-8000-000000000001';
select throws_ok('select hub.authorize_platform_admin()','28000','Current administrator session required.','anonymous principal is denied');
update auth.users set is_anonymous=false where id='99000000-0000-4000-8000-000000000001';
set local request.jwt.claims='{"sub":"99000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1","session_id":"99000000-0000-4000-8000-000000000003"}';
select throws_ok('select hub.authorize_platform_admin()','28000','Current administrator session required.','AAL1 claim is denied');
set local request.jwt.claims='{"sub":"99000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2","session_id":"not-a-session"}';
select throws_ok('select hub.authorize_platform_admin()','28000','Current administrator session required.','malformed session identifier is denied');
set local request.jwt.claims='{"sub":"99000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2","session_id":"99000000-0000-4000-8000-000000000004"}';
select throws_ok('select hub.authorize_platform_admin()','28000','Current administrator session required.','deleted or absent session is denied');
select ok((hub.get_backend_contract()->>'api_version')::integer>=2,'release2 and later require learning and delegated authorization');
select * from finish();
rollback;
