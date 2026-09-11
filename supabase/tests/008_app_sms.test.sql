begin;
-- Real app-role connections are exercised in server/integration.mjs.
select plan(8);
insert into auth.users(id,email,raw_user_meta_data,is_anonymous)
values('99100000-0000-4000-8000-000000000001','sms-contract@test.invalid','{"display_name":"SMS admin"}',false);
insert into private.staff_permissions(user_id,permission,granted_by)
values('99100000-0000-4000-8000-000000000001','platform.admin','99100000-0000-4000-8000-000000000001');
insert into private.sms_identities(user_id,phone_e164,identity_version,verified_at)
values('99100000-0000-4000-8000-000000000001','+12025550199','99100000-0000-4000-8000-000000000002',now());
insert into private.sms_sessions(id,user_id,identity_version,token_hash,expires_at)
values('99100000-0000-4000-8000-000000000003','99100000-0000-4000-8000-000000000001','99100000-0000-4000-8000-000000000002','fixture-not-a-token',now()+interval '1 hour');
set local request.jwt.claims='{"sub":"99100000-0000-4000-8000-000000000001","role":"authenticated","sms_session_id":"99100000-0000-4000-8000-000000000003"}';
select is(private.current_app_session_verified(),false,'JWT fields alone cannot impersonate the app server');
select ok(not has_table_privilege('authenticated','private.sms_sessions','select'),'browser roles cannot read session tokens');
select ok(not has_table_privilege('hub_app_server','auth.users','select'),'app server cannot read the Auth directory');
select ok(not has_column_privilege('hub_app_server','private.sms_identities','phone_e164','update'),'app server cannot rebind a number');
select is(hub.get_learning_editor_access(),false,'forged app session cannot grant editing');
select throws_ok($$select hub.authorize_app_admin()$$,'28000','Current administrator session required.','forged app session cannot grant delegation');
update private.sms_identities set phone_e164='+12025550198';
select isnt((select identity_version from private.sms_identities where user_id='99100000-0000-4000-8000-000000000001'),'99100000-0000-4000-8000-000000000002'::uuid,'number change rotates identity version');
select is((select verified_at from private.sms_identities where user_id='99100000-0000-4000-8000-000000000001'),null::timestamptz,'new number requires verification');
select * from finish();
rollback;
