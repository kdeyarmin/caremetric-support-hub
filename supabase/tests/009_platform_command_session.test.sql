begin;
select plan(17);
insert into auth.users(id,aud,role,email,email_confirmed_at,is_anonymous,created_at,updated_at)
values('99200000-0000-4000-8000-000000000001','authenticated','authenticated','command-session@test.invalid',now(),false,now(),now());
insert into private.staff_permissions(user_id,permission,product_id)
values('99200000-0000-4000-8000-000000000001','platform.admin',null);
insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at)
values('99200000-0000-4000-8000-000000000002','99200000-0000-4000-8000-000000000001','totp','verified',now(),now());
insert into auth.sessions(id,user_id,factor_id,aal,created_at,updated_at)
values('99200000-0000-4000-8000-000000000003','99200000-0000-4000-8000-000000000001','99200000-0000-4000-8000-000000000002','aal2',now()-interval '1 hour',now());
select set_config('request.jwt.claims',jsonb_build_object('sub','99200000-0000-4000-8000-000000000001','role','authenticated','aal','aal2','session_id','99200000-0000-4000-8000-000000000003','iat',extract(epoch from now())::bigint)::text,true);
select ok(not has_function_privilege('anon','hub.authorize_platform_command()','execute'),'anonymous cannot request command authority');
select ok(has_function_privilege('authenticated','hub.authorize_platform_command()','execute'),'authenticated can request current authority');
set local role authenticated;
select is(hub.authorize_platform_command()->>'session_id','99200000-0000-4000-8000-000000000003','actual current session is returned');
select is((hub.authorize_platform_command()->>'session_started_at')::timestamptz,now()-interval '1 hour','original session time is returned');
select is((hub.authorize_platform_command()->>'assurance_expires_at')::timestamptz,now()+interval '7 hours','refresh does not extend authority');
select is(hub.authorize_platform_admin(),'{"user_id":"99200000-0000-4000-8000-000000000001","role":"platform_admin","aal":"aal2"}'::jsonb,'read contract remains unchanged');
reset role;
update auth.sessions set not_after=now()+interval '2 hours' where id='99200000-0000-4000-8000-000000000003';
select is((hub.authorize_platform_command()->>'assurance_expires_at')::timestamptz,now()+interval '2 hours','earlier native session deadline limits command authority');
update auth.sessions set not_after=null,created_at=now()-interval '480 minutes' where id='99200000-0000-4000-8000-000000000003';
select lives_ok('select hub.authorize_platform_command()','exact native freshness boundary is accepted');
update auth.sessions set created_at=now()-interval '480 minutes 1 second' where id='99200000-0000-4000-8000-000000000003';
select throws_ok('select hub.authorize_platform_command()','28000','Sign in again before changing application access.','fresh JWT cannot refresh expired privileged session');
update auth.sessions set created_at=now()+interval '6 minutes' where id='99200000-0000-4000-8000-000000000003';
select throws_ok('select hub.authorize_platform_command()','28000','Sign in again before changing application access.','future session timestamp is rejected');
update auth.sessions set created_at=now() where id='99200000-0000-4000-8000-000000000003';
select set_config('request.jwt.claims',(current_setting('request.jwt.claims')::jsonb || jsonb_build_object('iat',extract(epoch from now()+interval '6 minutes')::bigint))::text,true);
select throws_ok('select hub.authorize_platform_command()','28000','Sign in again before changing application access.','future issued JWT is rejected');
select set_config('request.jwt.claims',(current_setting('request.jwt.claims')::jsonb || '{"iat":"not-a-time"}'::jsonb)::text,true);
select throws_ok('select hub.authorize_platform_command()','28000','Sign in again before changing application access.','malformed issued time is rejected');
select set_config('request.jwt.claims',(current_setting('request.jwt.claims')::jsonb - 'iat')::text,true);
select throws_ok('select hub.authorize_platform_command()','28000','Sign in again before changing application access.','missing issued time is rejected');
select set_config('request.jwt.claims',(current_setting('request.jwt.claims')::jsonb || jsonb_build_object('iat',extract(epoch from now())::bigint))::text,true);
update private.staff_permissions set revoked_at=now() where user_id='99200000-0000-4000-8000-000000000001';
select throws_ok('select hub.authorize_platform_command()','42501','Portfolio administrator permission required.','revocation denies command authority');
update private.staff_permissions set revoked_at=null where user_id='99200000-0000-4000-8000-000000000001';
update auth.sessions set not_after=now()-interval '1 second' where id='99200000-0000-4000-8000-000000000003';
select throws_ok('select hub.authorize_platform_command()','28000','Current administrator session required.','expired session is rejected');
update auth.sessions set not_after=null where id='99200000-0000-4000-8000-000000000003';
update auth.mfa_factors set status='unverified' where id='99200000-0000-4000-8000-000000000002';
select throws_ok('select hub.authorize_platform_command()','28000','Current administrator session required.','factor revocation denies command authority');
update auth.mfa_factors set status='verified' where id='99200000-0000-4000-8000-000000000002';
delete from auth.sessions where id='99200000-0000-4000-8000-000000000003';
select throws_ok('select hub.authorize_platform_command()','28000','Current administrator session required.','deleted session denies command authority');
select * from finish();
rollback;
