begin;
select plan(12);
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
set session authorization hub_app_server;
set local role authenticated;
select is(hub.get_learning_editor_access(),true,'verified SMS grants current editor permissions');
select is(hub.authorize_app_admin()->>'method','sms','app delegation declares SMS without pretending to be AAL2');
reset session authorization;
reset role;
update auth.users set banned_until=now()+interval '1 day' where id='99100000-0000-4000-8000-000000000001';
set session authorization hub_app_server;
set local role authenticated;
select is(hub.get_learning_editor_access(),false,'banned account loses app access immediately');
reset session authorization;
reset role;
update auth.users set banned_until=null where id='99100000-0000-4000-8000-000000000001';
update private.sms_sessions set expires_at=now()-interval '1 second';
set session authorization hub_app_server;
set local role authenticated;
select is(hub.get_learning_editor_access(),false,'expired session is denied');
reset session authorization;
reset role;
update private.sms_sessions set expires_at=now()+interval '1 hour';
update private.sms_identities set phone_e164='+12025550198';
select isnt((select identity_version from private.sms_identities where user_id='99100000-0000-4000-8000-000000000001'),'99100000-0000-4000-8000-000000000002'::uuid,'number change rotates identity version');
select is((select verified_at from private.sms_identities where user_id='99100000-0000-4000-8000-000000000001'),null::timestamptz,'new number requires verification');
set session authorization hub_app_server;
set local role authenticated;
select is(hub.get_learning_editor_access(),false,'old number session cannot authorize new identity');
select throws_ok($$select hub.authorize_app_admin()$$,'28000','Current administrator session required.','delegation also rejects changed identity');
reset session authorization;
reset role;
select * from finish();
rollback;
