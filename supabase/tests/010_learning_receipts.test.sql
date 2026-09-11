begin;
select no_plan();
create function pg_temp.rid(n integer) returns uuid language sql immutable as $$select ('abf00000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
insert into auth.users(id,aud,role,email,is_anonymous,created_at,updated_at)
select pg_temp.rid(n),'authenticated','authenticated','receipt-'||n||'@test.invalid',false,now(),now() from generate_series(1,3) n;
insert into private.staff_permissions(user_id,permission) values(pg_temp.rid(1),'platform.admin');
insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values(pg_temp.rid(4),pg_temp.rid(1),'totp','verified',now(),now());
insert into auth.sessions(id,user_id,factor_id,aal,created_at,updated_at) values(pg_temp.rid(5),pg_temp.rid(1),pg_temp.rid(4),'aal2',now()-interval '1 hour',now());
create function pg_temp.access(user_id uuid default pg_temp.rid(2),tenant_id uuid default pg_temp.rid(10)) returns jsonb language sql as $$
  select hub.provision_learning_receipt_access(pg_temp.rid(1),pg_temp.rid(5),pg_temp.rid(11),pg_temp.rid(12),pg_temp.rid(13),tenant_id,'Receipt tenant',user_id);
$$;
select ok(not has_function_privilege('authenticated','hub.provision_learning_receipt_access(uuid,uuid,uuid,uuid,uuid,uuid,text,uuid)','execute'),'browser cannot invent verified native identities');
select ok(not has_table_privilege('service_role','private.learning_receipt_inbox','insert'),'service role must use guarded receipt RPC');
select lives_ok('select pg_temp.access()','empty Hub can provision explicit tenant and existing principal');
select is((select count(*) from hub.tenants where id=pg_temp.rid(10)),1::bigint,'exactly one canonical tenant created');
select is((select enabled from private.case_intake_settings where tenant_id=pg_temp.rid(10)),false,'new case intake remains disabled');
select is((select role::text||'/'||case_scope::text||'/'||can_manage_members::text from hub.tenant_product_memberships where tenant_id=pg_temp.rid(10)),'customer/own/false','membership grants only product customer access');
select lives_ok('select pg_temp.access()','same identity setup is idempotent');
select is((select count(*) from private.federated_tenants where hub_tenant_id=pg_temp.rid(10)),1::bigint,'learning reuses canonical tenant registry');
select is((select count(*) from private.federated_principals where hub_user_id=pg_temp.rid(2)),1::bigint,'learning reuses canonical principal registry');
select is((select enabled from private.federation_issuers where issuer='https://xsqobvvreaovwibxwyvv.supabase.co/auth/v1'),false,'identity setup does not enable JWT federation');
select is(private.carebase_external_identity_hash('ABF00000-0000-4000-8000-000000000013'),private.carebase_external_identity_hash(pg_temp.rid(13)),'identity hash canonicalizes UUID case');
select throws_ok('select pg_temp.access(pg_temp.rid(3))','40001','Native principal cannot be repointed.','no automatic account merge or repointing');
select is(pg_temp.access(pg_temp.rid(2),pg_temp.rid(99))->>'hubTenantId',pg_temp.rid(10)::text,'exact native tenant mapping is reused and never repointed');
insert into hub.content_items(id,content_key,kind,status,access_level,source_system)
values(pg_temp.rid(14),'receipt.fixture','course','published','public','penntrain');
insert into private.learning_source_snapshots(id,item_id,source_course_id,source_version_id,source_revision,sequence,publication_state,source_payload,staged_by)
values(pg_temp.rid(15),pg_temp.rid(14),pg_temp.rid(16),pg_temp.rid(17),repeat('a',64),1,'published','{"course":{"title":"Synthetic receipt policy"}}',pg_temp.rid(1));
create function pg_temp.prepare() returns jsonb language sql as $$ select hub.prepare_learning_receipt_mapping(pg_temp.rid(1),pg_temp.rid(5),pg_temp.rid(18),pg_temp.rid(15),pg_temp.rid(11),pg_temp.rid(12),pg_temp.rid(10),pg_temp.rid(2)); $$;
select lives_ok('select pg_temp.prepare()','reviewed snapshot and explicit access can prepare mapping');
select is((select state from private.learning_receipt_mappings where id=pg_temp.rid(18)),'pending','mapping remains pending before native agreement');
select hub.set_learning_receipt_mapping_state(pg_temp.rid(1),pg_temp.rid(5),pg_temp.rid(18),'active');
create temporary table receipt_fixture(document jsonb);
insert into receipt_fixture values(jsonb_build_object('contract','caremetric.learning-receipt.v1','source','carebase','eventId',pg_temp.rid(20),'kind','completed','sequence',1,'mappingId',pg_temp.rid(18),
  'assignmentId',pg_temp.rid(21),'sourceCourseId',pg_temp.rid(16),'sourceVersionId',pg_temp.rid(17),'mappingRevision',repeat('a',64),'assignmentRevision',repeat('a',64),'completionRevision',repeat('a',64),
  'hubTenantId',pg_temp.rid(10),'hubUserId',pg_temp.rid(2),'completedAt','2026-09-11T15:00:00Z','evidenceSha256',repeat('b',64),'finalExamScore',90,
  'certificate',jsonb_build_object('id',pg_temp.rid(22),'issuedAt','2026-09-11T15:00:00Z','expiresAt',null,'providerEvidenceSha256',repeat('c',64)),
  'credits','[]'::jsonb,'attestations','[]'::jsonb,'quizEvidenceSha256',repeat('d',64),'renewalEvidenceSha256',repeat('e',64)));
create function pg_temp.ingest(doc jsonb) returns jsonb language sql as $$ select hub.ingest_learning_receipt(pg_temp.rid(1),pg_temp.rid(5),doc::text,encode(extensions.digest(doc::text,'sha256'),'hex')); $$;
select throws_ok($$select hub.ingest_learning_receipt(pg_temp.rid(1),pg_temp.rid(5),document::text,repeat('f',64)) from receipt_fixture$$,'22023','Receipt checksum or size is invalid.','tampered evidence checksum rejected');
select throws_ok($$select pg_temp.ingest(document||'{"email":"private@test.invalid"}'::jsonb) from receipt_fixture$$,'22023','Receipt does not match the source contract.','unapproved learner PII cannot enter receipt');
select throws_ok($$select pg_temp.ingest(document||jsonb_build_object('hubUserId',pg_temp.rid(3))) from receipt_fixture$$,'42501','Active explicit receipt mapping required.','receipt cannot cross principal mapping');
select throws_ok($$select pg_temp.ingest(document||jsonb_build_object('completionRevision',repeat('f',64))) from receipt_fixture$$,'40001','Receipt policy drift requires separate review.','completion policy must match exact reviewed source');
select is((select pg_temp.ingest(document)->>'accepted' from receipt_fixture),'true','verified receipt accepted');
select is((select pg_temp.ingest(document)->>'replayed' from receipt_fixture),'true','worker retry is idempotent');
select is((select count(*) from private.learning_receipt_inbox where assignment_id=pg_temp.rid(21)),1::bigint,'retry does not duplicate evidence');
update private.federated_principals set revoked_at=now() where hub_user_id=pg_temp.rid(2);
select throws_ok($$select pg_temp.ingest(document||jsonb_build_object('assignmentId',pg_temp.rid(61),'eventId',pg_temp.rid(62))) from receipt_fixture$$,'42501','Active explicit receipt mapping required.','canonical principal revocation blocks new receipt consumption');
update private.federated_principals set revoked_at=null where hub_user_id=pg_temp.rid(2);
select is((select count(*) from private.learning_enrollments where user_id=pg_temp.rid(2)),0::bigint,'receipt ingestion never creates enrollment or completion writer');
select throws_ok($$select pg_temp.ingest(document||'{"finalExamScore":80}'::jsonb) from receipt_fixture$$,'40001','Receipt event ID was reused.','same event ID cannot alter immutable evidence');
select lives_ok($$select pg_temp.ingest(document||jsonb_build_object('eventId',pg_temp.rid(23),'kind','retracted','sequence',2)) from receipt_fixture$$,'withdrawal advances the receipt head');
select is((hub.get_learning_receipt_status(pg_temp.rid(1),pg_temp.rid(5))->'receipts'->0->>'kind'),'retracted','status projects latest withdrawal');
select lives_ok($$select pg_temp.ingest(document) from receipt_fixture$$,'old exact event can be retried without replacing head');
select is((hub.get_learning_receipt_status(pg_temp.rid(1),pg_temp.rid(5))->'receipts'->0->>'kind'),'retracted','completion replay never resurrects withdrawn evidence');
select lives_ok($$select pg_temp.ingest(document||jsonb_build_object('assignmentId',pg_temp.rid(31),'eventId',pg_temp.rid(32),'kind','retracted','sequence',2)) from receipt_fixture$$,'withdrawal can arrive before a lost completion acknowledgement');
select throws_ok($$select pg_temp.ingest(document||jsonb_build_object('assignmentId',pg_temp.rid(31),'eventId',pg_temp.rid(33))) from receipt_fixture$$,'40001','Receipt event is stale or changes immutable completion evidence.','late completion cannot override earlier tombstone');
select hub.set_learning_receipt_mapping_state(pg_temp.rid(1),pg_temp.rid(5),pg_temp.rid(18),'revoked');
select throws_ok('select pg_temp.prepare()','40001','A receipt mapping cannot be repointed or reactivated.','revoked mapping cannot reactivate by retry');
select throws_ok($$select pg_temp.ingest(document||jsonb_build_object('assignmentId',pg_temp.rid(41),'eventId',pg_temp.rid(42))) from receipt_fixture$$,'42501','Active explicit receipt mapping required.','revoked mapping rejects new completion');
select lives_ok($$select pg_temp.ingest(document||jsonb_build_object('assignmentId',pg_temp.rid(41),'eventId',pg_temp.rid(43),'kind','retracted','sequence',2)) from receipt_fixture$$,'revoked mapping can still withdraw central evidence');
update auth.users set banned_until=now()+interval '1 day' where id=pg_temp.rid(1);
select throws_ok('select hub.get_learning_receipt_status(pg_temp.rid(1),pg_temp.rid(5))','42501','Current administrator command session required.','banned actor cannot reconcile');
update auth.users set banned_until=null where id=pg_temp.rid(1);
update private.staff_permissions set revoked_at=now() where user_id=pg_temp.rid(1);
select throws_ok('select hub.get_learning_receipt_status(pg_temp.rid(1),pg_temp.rid(5))','42501','Current administrator command session required.','permission revocation checked on every RPC');
update private.staff_permissions set revoked_at=null where user_id=pg_temp.rid(1);
delete from auth.sessions where id=pg_temp.rid(5);
select throws_ok('select hub.get_learning_receipt_status(pg_temp.rid(1),pg_temp.rid(5))','42501','Current administrator command session required.','deleted actor session cannot reconcile');
select * from finish();
rollback;
