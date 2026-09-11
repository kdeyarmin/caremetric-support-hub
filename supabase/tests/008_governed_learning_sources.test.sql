begin;
select plan(38);
insert into auth.users(id,email,raw_user_meta_data,is_anonymous) values
('99000000-0000-4000-8000-000000000001','source-editor@test.invalid','{"display_name":"Source editor"}',false),
('99000000-0000-4000-8000-000000000002','source-learner@test.invalid','{}',false),
('99000000-0000-4000-8000-000000000003','source-scoped@test.invalid','{}',false);
insert into private.staff_permissions(user_id,permission,granted_by) values
('99000000-0000-4000-8000-000000000001','content.write','99000000-0000-4000-8000-000000000001');
insert into private.staff_permissions(user_id,product_id,permission,granted_by)
select '99000000-0000-4000-8000-000000000003',id,'content.write','99000000-0000-4000-8000-000000000001' from hub.products where slug='pennsync';
create temporary table source_fixture(document jsonb, original_payload text, original_revision text, result jsonb, latest_result jsonb);
insert into source_fixture(document) values($fixture${"contract":"carebase.course.v1","sourceCourseId":"99100000-0000-0000-0000-000000000001","sourceVersionId":"99100000-0000-0000-0000-000000000002","sourceVersionNumber":2,"publicationState":"published","sourceVersionState":"published","course":{"title":"Synthetic policy fixture","description":"No real course, learner, provider, or asset data.","category":"Testing","estimatedDurationMinutes":240,"catalogCode":"SYNTHETIC-COURSE","recurrenceIntervalDays":365,"legacyTrainingTypeId":null,"renewalTrainingTypeId":"99200000-0000-0000-0000-000000000001","creditedDurationCheckExempt":true},"version":{"title":"Original version title","description":"Original version description","label":"2026.2","contentStandard":"comprehensive","creditedDurationRationale":"Synthetic provider rationale demonstrating a duration variance for testing.","aiGenerated":false,"aiReviewedAt":null},"blocks":[{"id":"99300000-0000-0000-0000-000000000001","type":"text","sortOrder":-1,"title":"Practice","body":{"content":"Synthetic scenario.","activity_type":"practice","estimated_minutes":20,"prompt":"Describe the safe action.","objectives":["Explain the policy"]},"documentId":null,"videoLocatorSha256":null,"quiz":null},{"id":"99300000-0000-0000-0000-000000000002","type":"quiz","sortOrder":1,"title":"Final exam","body":{"estimated_minutes":10},"documentId":null,"videoLocatorSha256":null,"quiz":{"id":"99400000-0000-0000-0000-000000000001","title":"Final examination","passingScore":90,"maxAttempts":null,"kind":"final_exam","shuffleQuestions":true,"shuffleAnswers":true,"revealsAnswersAfterAttempt":false,"questions":[{"id":"99500000-0000-0000-0000-000000000001","sortOrder":0,"prompt":"Select both safe actions.","type":"multiple_choice","points":101,"topicCode":"SAFE.ACTION","topicLabel":"Safe actions","explanation":"Synthetic explanation withheld during examination retakes.","options":[{"id":"99600000-0000-0000-0000-000000000001","sortOrder":0,"text":"Safe action one","correct":true},{"id":"99600000-0000-0000-0000-000000000002","sortOrder":1,"text":"Safe action two","correct":true},{"id":"99600000-0000-0000-0000-000000000003","sortOrder":2,"text":"Unsafe action","correct":false}]}]}},{"id":"99300000-0000-0000-0000-000000000003","type":"attestation","sortOrder":2,"title":"Attest","body":{"attestation_text":"I attest that I completed this synthetic educational exercise myself.","attestation_version":"SYNTHETIC-2026.2","estimated_minutes":1},"documentId":null,"videoLocatorSha256":null,"quiz":null},{"id":"99300000-0000-0000-0000-000000000004","type":"video","sortOrder":3,"title":"Video","body":{"script":"Synthetic transcript","estimated_minutes":5},"documentId":null,"videoLocatorSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","quiz":null},{"id":"99300000-0000-0000-0000-000000000005","type":"pdf","sortOrder":4,"title":"Document","body":null,"documentId":"99700000-0000-0000-0000-000000000001","videoLocatorSha256":null,"quiz":null},{"id":"99300000-0000-0000-0000-000000000006","type":"scorm","sortOrder":5,"title":"Package","body":{},"documentId":null,"videoLocatorSha256":null,"quiz":null}],"credits":[{"id":"99800000-0000-0000-0000-000000000001","trainingTypeId":"99200000-0000-0000-0000-000000000002","topicCode":"SYNTHETIC","creditHours":"4.00","mode":"automatic","citationNote":"Synthetic citation","active":true},{"id":"99800000-0000-0000-0000-000000000002","trainingTypeId":"99200000-0000-0000-0000-000000000003","topicCode":"SYNTHETIC.VERIFIED","creditHours":"0.50","mode":"verified_only","citationNote":"Synthetic verification requirement","active":false}],"provider":{"id":"99900000-0000-0000-0000-000000000001","fullName":"Synthetic Provider","professionalTitle":"Fixture educator","credential":"Fixture credential","credentialNumber":"SYNTHETIC-ONLY","credentialIssuingOrganization":"Example training organization","credentialExpiresOn":"2027-01-01","courseAuthor":"Synthetic author","signatureName":"Synthetic signature","signatureRecordedAt":"2026-01-01T00:00:00+00:00","contentVersion":"2026.2","lastClinicalReviewDate":"2026-01-01","reviewedBy":"Synthetic reviewer","nextReviewDue":"2027-01-01","regulationReviewDate":"2026-01-01","reviewNotes":"Synthetic maintenance note"},"packages":[{"id":"99900000-0000-0000-0000-000000000002","standard":"scorm_1_2","contentSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","entryPoint":"index.html","manifest":{"version":"1.2"},"capabilities":["completion"],"connectivityMode":"online_only","validationStatus":"accepted"}]}$fixture$::jsonb);
update source_fixture set original_payload=document::text,original_revision=encode(extensions.digest(document::text,'sha256'),'hex');
select is(hub.get_backend_contract(),'{"api_version":3}'::jsonb,'release3 exposes the governed source preservation API');
select lives_ok($$select private.validate_governed_learning_source(payload,encode(extensions.digest(payload,'sha256'),'hex'))
from (select jsonb_set(document,'{sourceVersionId}','"AAAAAAAA-0000-0000-0000-000000000000"')::text payload from source_fixture) s$$,
'server schema accepts opaque uppercase source UUIDs like the client');
create function pg_temp.stage_source(doc jsonb,expected text) returns jsonb language sql as $$
  select hub.stage_learning_source(doc::text,encode(extensions.digest(doc::text,'sha256'),'hex'),expected);
$$;
grant select on source_fixture to authenticated;

select ok(not has_function_privilege('anon','hub.stage_learning_source(text,text,text)','execute'),'anonymous callers cannot stage');
select ok(not has_table_privilege('authenticated','private.learning_source_snapshots','select'),'source answer keys have no direct table access');
select ok(not has_function_privilege('authenticated','private.validate_governed_learning_source(text,text)','execute'),'source validator stays private');
set local request.jwt.claims='{"sub":"99000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select throws_ok($$select pg_temp.stage_source(document,null) from source_fixture$$,'42501','Sign in with the required verification to continue.','source staging requires staff MFA');
set local request.jwt.claims='{"sub":"99000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok($$select pg_temp.stage_source(document,null) from source_fixture$$,'42501','Shared-course editor access required.','a learner cannot upload a policy or answer key');
set local request.jwt.claims='{"sub":"99000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2"}';
select throws_ok($$select pg_temp.stage_source(document,null) from source_fixture$$,'42501','Shared-course editor access required.','a product editor cannot change shared source snapshots');
set local request.jwt.claims='{"sub":"99000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
select throws_ok($$select pg_temp.stage_source(document,null) from source_fixture$$,'22023','Source course is not registered in the central catalog.','source provenance must resolve to a registered native catalog course');

insert into hub.content_items(id,content_key,kind,status,access_level,source_system)
values('99010000-0000-4000-8000-000000000001','source.fixture','course','published','public','penntrain');
insert into hub.content_revisions(id,item_id,revision_no,title,review_state,approved_at)
values('99010000-0000-4000-8000-000000000002','99010000-0000-4000-8000-000000000001',1,'Native live course','approved',now());
insert into hub.content_publications(item_id,revision_id,product_id)
select '99010000-0000-4000-8000-000000000001','99010000-0000-4000-8000-000000000002',id from hub.products where slug='pennsync';
insert into hub.course_links(content_item_id,penntrain_course_id,source_version,launch_path)
values('99010000-0000-4000-8000-000000000001','99100000-0000-0000-0000-000000000001','99100000-0000-0000-0000-000000000002','/app/courses/99100000-0000-0000-0000-000000000001');
insert into private.learning_courses(item_id,draft,updated_by) values
('99010000-0000-4000-8000-000000000001','{"title":"An independently edited draft"}','99000000-0000-4000-8000-000000000001');
select lives_ok($$update source_fixture set result=pg_temp.stage_source(document,null)$$,'a native policy richer than generic Hub courses is preserved');
select is((hub.get_learning_source_snapshot((select (result->>'snapshotId')::uuid from source_fixture))->>'payload')::jsonb,(select document from source_fixture),'all source content and policy fields survive a complete round trip');
select is(hub.get_learning_source_snapshot((select (result->>'snapshotId')::uuid from source_fixture))->>'payload',(select original_payload from source_fixture),'exact source payload bytes are preserved for integrity checks');
select is(pg_temp.stage_source((select document from source_fixture),null)->>'replayed','true','same-source retry is idempotent even after a lost response');
select is((select count(*) from private.learning_source_snapshots),1::bigint,'retry creates no second snapshot');
update source_fixture set document=jsonb_set(document,'{course,recurrenceIntervalDays}','730');
select lives_ok($$update source_fixture set latest_result=pg_temp.stage_source(document,original_revision)$$,'a changed native policy can append a revision without changing native version UUID');
select is((select (latest_result->>'sequence')::integer from source_fixture),2,'policy updates advance the immutable sequence');
select is(hub.get_learning_source_snapshot((select (result->>'snapshotId')::uuid from source_fixture))->>'payload',(select original_payload from source_fixture),'later policy updates do not rewrite earlier evidence');
select is((select count(distinct source_version_id) from private.learning_source_snapshots),1::bigint,'policy and content hashes refine rather than replace the native version identity');
select throws_ok($$select pg_temp.stage_source(jsonb_set(document,'{publicationState}','"archived"'),original_revision) from source_fixture$$,'40001','A newer source snapshot was staged. Reload the export preview before continuing.','stale imports cannot silently replace newer source policy');
select throws_ok($$select hub.stage_learning_source(original_payload,repeat('a',64),null) from source_fixture$$,'22023','Source revision checksum or size is invalid.','server independently verifies the checksum');
select throws_ok($$select hub.stage_learning_source('invalid',encode(extensions.digest('invalid','sha256'),'hex'),null)$$,'22023','Source payload is not valid JSON.','malformed JSON receives a fixed error without echoing source payload');
select throws_ok($$select pg_temp.stage_source(document||'{"employeeId":"private"}'::jsonb,null) from source_fixture$$,'22023','Source snapshot does not match carebase.course.v1.','server rejects unknown identity fields even when browser validation is bypassed');
select throws_ok($$select pg_temp.stage_source(jsonb_set(document,'{blocks}',(document->'blocks')||(document->'blocks'->0)),null) from source_fixture$$,'22023','The source snapshot repeats a content identifier.','server rejects duplicate source block identifiers');
select throws_ok($$select pg_temp.stage_source(jsonb_set(document,'{blocks,1,quiz,revealsAnswersAfterAttempt}','true'),null) from source_fixture$$,'22023','Source quiz configuration is invalid.','server rejects examination answer reveal');
select throws_ok($$select pg_temp.stage_source(jsonb_set(document,'{blocks,0,body,content}','"https://video.invalid/play?token=private"'),null) from source_fixture$$,'22023','Remove playback credentials from the source export before staging.','credential-bearing authored URLs cannot enter the snapshot store');
update source_fixture set document=jsonb_set(document,'{publicationState}','"archived"');
select lives_ok($$update source_fixture set latest_result=pg_temp.stage_source(document,latest_result->>'sourceRevision')$$,'source retirement is explicitly retained as new review evidence');
select is((pg_temp.stage_source((select original_payload::jsonb from source_fixture),null)->>'headRevision'),(select latest_result->>'sourceRevision' from source_fixture),'replaying old published content cannot undo a later retirement snapshot');
select is((select count(*) from private.learning_source_snapshots),3::bigint,'retirement and replay preserve exactly three immutable revisions');
select is((select source_system::text from hub.content_items where id='99010000-0000-4000-8000-000000000001'),'penntrain','source ownership remains native');
select is((select launch_path from hub.course_links where content_item_id='99010000-0000-4000-8000-000000000001'),'/app/courses/99100000-0000-0000-0000-000000000001','snapshot imports preserve native launch');
select is((select revision_id from hub.content_publications where item_id='99010000-0000-4000-8000-000000000001'),'99010000-0000-4000-8000-000000000002'::uuid,'source retirement review does not silently retire the live Hub catalog');
select is((select draft->>'title' from private.learning_courses where item_id='99010000-0000-4000-8000-000000000001'),'An independently edited draft','source snapshots cannot overwrite independent author edits');
select throws_ok($$select hub.publish_learning_course('99010000-0000-4000-8000-000000000001',1,true)$$,'55000','Imported CareBase courses remain drafts until quiz, credit, and completion reporting are connected. Continue using the existing CareBase course.','staging does not remove the publication parity gate');
select ok(hub.list_learning_source_heads()::text not like '%Synthetic Provider%' and hub.list_learning_source_heads()::text not like '%explanation%','head discovery returns metadata only');
set local request.jwt.claims='{"sub":"99000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}';
set local role authenticated;
select throws_ok($$select hub.get_learning_source_snapshot((select (result->>'snapshotId')::uuid from source_fixture))$$,'42501','Shared-course editor access required.','actual learner role cannot read source answer keys');
reset role;
set local request.jwt.claims='{"sub":"99000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2"}';
select throws_ok($$select hub.list_learning_source_heads()$$,'42501','Shared-course editor access required.','scoped editor cannot enumerate shared snapshot metadata');
set local request.jwt.claims='{"sub":"99000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
update auth.users set banned_until=now()+interval '1 day' where id='99000000-0000-4000-8000-000000000001';
select throws_ok($$select hub.list_learning_source_heads()$$,'42501','Sign in with the required verification to continue.','banned editor cannot use stale claims to retrieve source policy');
update auth.users set banned_until=null where id='99000000-0000-4000-8000-000000000001';
delete from private.staff_permissions where user_id='99000000-0000-4000-8000-000000000001';
select throws_ok($$select pg_temp.stage_source(document,latest_result->>'sourceRevision') from source_fixture$$,'42501','Shared-course editor access required.','revocation applies before even an idempotent replay');
select * from finish();
rollback;
