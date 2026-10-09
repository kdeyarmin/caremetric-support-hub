begin;
select plan(74);
insert into auth.users(id,email,raw_user_meta_data,is_anonymous)
values ('98000000-0000-4000-8000-000000000001','learning-editor@test.invalid','{"display_name":"Editor"}',false),
('98000000-0000-4000-8000-000000000002','learning-one@test.invalid','{"display_name":"Learner One"}',false),
('98000000-0000-4000-8000-000000000003','learning-two@test.invalid','{"display_name":"Learner Two"}',false);
insert into private.staff_permissions(user_id,permission,granted_by)
values('98000000-0000-4000-8000-000000000001','content.write','98000000-0000-4000-8000-000000000001');
create temporary table learning_fixture(doc jsonb,item_id uuid,enrollment_id uuid,result jsonb);
insert into learning_fixture(doc) values(jsonb_build_object('title','Learning test','summary','Test only','category','Test','accessLevel','public','durationMinutes',10,
  'productIds',jsonb_build_array((select id from hub.products where slug='pennsync')),
  'units','[{"id":"98100000-0000-4000-8000-000000000001","type":"text","title":"Lesson one","body":"Read this test lesson."},
  {"id":"98100000-0000-4000-8000-000000000002","type":"quiz","title":"Assessment","passingScore":100,"maxAttempts":2,
  "questions":[{"id":"98200000-0000-4000-8000-000000000001","prompt":"Choose the correct option","points":1,"correctOptionId":"98300000-0000-4000-8000-000000000001","secretExplanation":"must never leave the server","options":[{"id":"98300000-0000-4000-8000-000000000001","text":"Correct"},{"id":"98300000-0000-4000-8000-000000000002","text":"Incorrect"}]}]}]'::jsonb));
select ok(not has_table_privilege('authenticated','private.learning_versions','select'),'answer keys are not directly readable');
select ok(not has_table_privilege('authenticated','private.learning_enrollments','insert'),'learners cannot forge enrollments');
select ok(not has_function_privilege('anon','hub.enroll_learning_course(uuid)','execute'),'anonymous enrollment is denied');
select ok(not has_function_privilege('authenticated','private.learning_public_document(jsonb)','execute'),'projection helper is private');
set local request.jwt.claims='{"sub":"98000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select throws_ok($$select hub.save_learning_draft(null,(select doc from learning_fixture),0)$$,'42501','Sign in with the required verification to continue.','authoring requires MFA');
set local request.jwt.claims='{"sub":"98000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
update learning_fixture set item_id=(hub.save_learning_draft(null,doc,0)->>'itemId')::uuid;
select is((hub.save_learning_draft((select item_id from learning_fixture),(select doc from learning_fixture),0)->>'itemId')::uuid,(select item_id from learning_fixture),'a retry with the same creation id returns the existing draft');
select throws_ok($$select hub.save_learning_draft(item_id,doc,-1) from learning_fixture$$,'40001','This draft changed. Reload it before saving.','stale saves do not overwrite revisions');
select throws_ok($$select hub.publish_learning_course(item_id,1,false) from learning_fixture$$,'22023','Review the course for accuracy and confirm it contains no private data before publishing.','publication requires review');
select lives_ok($$select hub.publish_learning_course(item_id,1,true) from learning_fixture$$,'reviewed course publishes');
select lives_ok($$select hub.publish_learning_course(item_id,1,true) from learning_fixture$$,'publishing retries are idempotent');
select is((select count(*) from private.learning_versions where item_id=(select item_id from learning_fixture)),1::bigint,'duplicate publication creates one immutable version');
set local request.jwt.claims='{"sub":"98000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}';
select throws_ok($$select hub.get_learning_draft(item_id) from learning_fixture$$,'42501','Shared-course editor access required.','learners cannot read drafts or answer keys');
select ok((hub.get_learning_course((select item_id from learning_fixture))::text not like '%correctOptionId%'),'learner projection removes answer keys');
select ok((hub.get_learning_course((select item_id from learning_fixture))::text not like '%secretExplanation%'),'future author-only fields cannot leak');
update learning_fixture set enrollment_id=hub.enroll_learning_course(item_id);
select is(hub.enroll_learning_course((select item_id from learning_fixture)),(select enrollment_id from learning_fixture),'enrollment is idempotent');
select throws_ok($$select hub.get_learning_certificate(enrollment_id) from learning_fixture$$,'42501','Certificate unavailable.','unfinished courses cannot receive certificates');
select throws_ok($$select hub.submit_learning_unit(enrollment_id,'98100000-0000-4000-8000-000000000002','{"98200000-0000-4000-8000-000000000001":"98300000-0000-4000-8000-000000000001"}',false,gen_random_uuid()) from learning_fixture$$,'22023','Complete the earlier lessons in order before continuing.','the post-test stays locked until earlier lessons are complete');
select lives_ok($$select hub.submit_learning_unit(enrollment_id,'98100000-0000-4000-8000-000000000001','{}',true,gen_random_uuid()) from learning_fixture$$,'the first lesson opens immediately');
select is((select completed_at from private.learning_enrollments where id=(select enrollment_id from learning_fixture)),null::timestamptz,'completing lessons alone does not complete the course');
select throws_ok($$select hub.submit_learning_unit(enrollment_id,'98100000-0000-4000-8000-000000000002','{"score":100}',false,gen_random_uuid()) from learning_fixture$$,'22023','Quiz answer is not a valid option.','client cannot supply its own grade');
update learning_fixture set result=hub.submit_learning_unit(enrollment_id,'98100000-0000-4000-8000-000000000002','{"98200000-0000-4000-8000-000000000001":"98300000-0000-4000-8000-000000000002"}',false,'98400000-0000-4000-8000-000000000001');
select is((select (result->>'score')::integer from learning_fixture),0,'wrong answer is graded on server');
select is(hub.submit_learning_unit((select enrollment_id from learning_fixture),'98100000-0000-4000-8000-000000000002','{"98200000-0000-4000-8000-000000000001":"98300000-0000-4000-8000-000000000002"}',false,'98400000-0000-4000-8000-000000000001'),(select result from learning_fixture),'network retry reuses attempt');
select throws_ok($$select hub.submit_learning_unit(enrollment_id,'98100000-0000-4000-8000-000000000002','{}',false,'98400000-0000-4000-8000-000000000001') from learning_fixture$$,'22023','Submission key already used for different content.','request-key reuse cannot change answers');
select is((hub.submit_learning_unit((select enrollment_id from learning_fixture),'98100000-0000-4000-8000-000000000002','{"98200000-0000-4000-8000-000000000001":"98300000-0000-4000-8000-000000000001"}',false,gen_random_uuid())->>'score')::integer,100,'correct answer passes');
select isnt((select completed_at from private.learning_enrollments where id=(select enrollment_id from learning_fixture)),null::timestamptz,'passing the post-test after every lesson completes the course');
set local request.jwt.claims='{"sub":"98000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}';
select throws_ok($$select hub.get_learning_course(item_id,enrollment_id) from learning_fixture$$,'42501','Enrollment unavailable.','another learner cannot read progress');
select throws_ok($$select hub.submit_learning_unit(enrollment_id,'98100000-0000-4000-8000-000000000001','{}',true,gen_random_uuid()) from learning_fixture$$,'42501','Enrollment unavailable.','another learner cannot modify progress');
select is(hub.list_my_learning(),'[]'::jsonb,'another learner cannot list private enrollments');
set local request.jwt.claims='{"sub":"98000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}';
select is((hub.get_learning_certificate((select enrollment_id from learning_fixture))->>'finalScore')::integer,100,'certificate reports the post-test score');
select is(hub.get_learning_certificate((select enrollment_id from learning_fixture))->>'learnerName','Learner One','certificate uses authenticated learner identity');
update hub.profiles set display_name='Renamed learner' where id='98000000-0000-4000-8000-000000000002';
select is(hub.get_learning_certificate((select enrollment_id from learning_fixture))->>'learnerName','Learner One','later profile edits cannot rewrite certificate identity');
set local request.jwt.claims='{"sub":"98000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
select lives_ok($$select hub.save_learning_draft(item_id,jsonb_set(doc,'{title}','"Revision two"'),1) from learning_fixture$$,'author can revise course');
select lives_ok($$select hub.publish_learning_course(item_id,2,true) from learning_fixture$$,'new publication is immutable');
select throws_ok($$select hub.publish_learning_course((hub.save_learning_draft(null,jsonb_set(doc,'{units}',jsonb_build_array(doc->'units'->0)),0)->>'itemId')::uuid,1,true) from learning_fixture$$,'22023','End the course with a graded post-test after the last lesson.','a course without a post-test cannot publish');
select throws_ok($$select hub.publish_learning_course((hub.save_learning_draft(null,jsonb_set(doc,'{units}',jsonb_build_array(doc->'units'->1)),0)->>'itemId')::uuid,1,true) from learning_fixture$$,'22023','End the course with a graded post-test after the last lesson.','a quiz-only course has no lesson to test and cannot publish');
select throws_ok($$select hub.publish_learning_course((hub.save_learning_draft(null,jsonb_set(doc,'{units}',jsonb_build_array(doc->'units'->1,doc->'units'->0)),0)->>'itemId')::uuid,1,true) from learning_fixture$$,'22023','End the course with a graded post-test after the last lesson.','a lesson after the post-test blocks publication');
select lives_ok($$select hub.publish_learning_course((hub.save_learning_draft(null,jsonb_set(doc,'{units}',(doc->'units')||'[{"id":"98100000-0000-4000-8000-000000000003","type":"attestation","title":"Attestation","body":"I completed this course myself."}]'::jsonb),0)->>'itemId')::uuid,1,true) from learning_fixture$$,'a closing attestation may follow the post-test');
set local request.jwt.claims='{"sub":"98000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}';
select is(hub.get_learning_certificate((select enrollment_id from learning_fixture))->>'courseTitle','Learning test','new publication preserves historical completion title');
select is(hub.get_learning_course((select item_id from learning_fixture),(select enrollment_id from learning_fixture))->'document'->>'title','Learning test','existing enrollment pins its original revision');
update auth.users set banned_until=now()+interval '1 day' where id='98000000-0000-4000-8000-000000000002';
select throws_ok($$select hub.list_my_learning()$$,'42501','Sign in with the required verification to continue.','banned users are rejected despite stale tokens');
select ok(not exists(select 1 from storage.buckets where id='hub-learning' and public),'central media bucket stays private');

-- Imported content must retain its existing runtime even after a draft is edited.
set local request.jwt.claims='{"sub":"98000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
insert into hub.content_items(id,content_key,kind,status,access_level,source_system)
values('98500000-0000-4000-8000-000000000001','learning.test.source','course','published','public','penntrain');
insert into hub.content_revisions(id,item_id,revision_no,title,review_state,approved_at)
values('98500000-0000-4000-8000-000000000002','98500000-0000-4000-8000-000000000001',1,'Existing source course','approved',now());
insert into hub.content_publications(item_id,revision_id,product_id)
select '98500000-0000-4000-8000-000000000001','98500000-0000-4000-8000-000000000002',id
from hub.products where slug='pennsync';
insert into hub.course_links(content_item_id,penntrain_course_id,source_version,launch_path)
values('98500000-0000-4000-8000-000000000001','98500000-0000-4000-8000-000000000003','98500000-0000-4000-8000-000000000004','/app/courses/98500000-0000-4000-8000-000000000003');
select lives_ok($$select hub.import_learning_draft('98500000-0000-4000-8000-000000000003','98500000-0000-4000-8000-000000000004',doc) from learning_fixture$$,'source course can be imported for draft review');
select lives_ok($$select hub.save_learning_draft('98500000-0000-4000-8000-000000000001',jsonb_set(doc,'{title}','"Edited source draft"'),1) from learning_fixture$$,'source draft remains editable without changing its live course');
select throws_ok($$select hub.publish_learning_course('98500000-0000-4000-8000-000000000001',2,true)$$,'55000','Imported CareBase courses remain drafts until quiz, credit, and completion reporting are connected. Continue using the existing CareBase course.','review does not bypass the source runtime migration gate');
select is((select source_system::text from hub.content_items where id='98500000-0000-4000-8000-000000000001'),'penntrain','source ownership survives import, editing, and denied publication');
select is((select launch_path from hub.course_links where content_item_id='98500000-0000-4000-8000-000000000001'),'/app/courses/98500000-0000-4000-8000-000000000003','existing CareBase launch is preserved');
select is((select revision_id from hub.content_publications where item_id='98500000-0000-4000-8000-000000000001'),'98500000-0000-4000-8000-000000000002'::uuid,'existing source publication is preserved');
select is((select count(*) from private.learning_versions where item_id='98500000-0000-4000-8000-000000000001'),0::bigint,'denied source publication creates no central revision');
select is((hub.import_learning_draft('98500000-0000-4000-8000-000000000003','98500000-0000-4000-8000-000000000004',(select doc from learning_fixture))->'document'->>'title'),'Edited source draft','retrying a source import preserves later draft edits');

-- Exercise customer visibility and Storage SELECT authorization as actual
-- authenticated callers. Fixture objects contain metadata only, not real files.
update auth.users set banned_until=null where id='98000000-0000-4000-8000-000000000002';
insert into auth.users(id,email,raw_user_meta_data,is_anonymous)
values('98000000-0000-4000-8000-000000000004','learning-scoped-editor@test.invalid','{"display_name":"Scoped Editor"}',false);
insert into private.staff_permissions(user_id,product_id,permission,granted_by)
select '98000000-0000-4000-8000-000000000004',id,'content.write','98000000-0000-4000-8000-000000000001'
from hub.products where slug='pennsync';
insert into hub.tenants(id,slug,name)
values('98600000-0000-4000-8000-000000000001','learning-customer-a','Learning Customer A'),
('98600000-0000-4000-8000-000000000002','learning-customer-b','Learning Customer B');
insert into hub.tenant_products(tenant_id,product_id)
select '98600000-0000-4000-8000-000000000001',id from hub.products where slug='pennsync';
insert into hub.tenant_products(tenant_id,product_id)
select '98600000-0000-4000-8000-000000000002',id from hub.products where slug='breathe';
insert into storage.objects(bucket_id,name,metadata)
values('hub-learning','learning/98700000-0000-4000-8000-000000000001/video.mp4','{"size":6,"mimetype":"video/mp4"}'),
('hub-learning','learning/98700000-0000-4000-8000-000000000001/captions.vtt','{"size":6,"mimetype":"text/vtt"}'),
('hub-learning','learning/98700000-0000-4000-8000-000000000001/transcript.txt','{"size":6,"mimetype":"text/plain"}');
select lives_ok($$select hub.register_learning_media('98700000-0000-4000-8000-000000000001','Reviewed fixture video',repeat('a',64),true)$$,'portfolio editor can register a complete reviewed media fixture');
create temporary table learning_access_fixture(doc jsonb,item_id uuid,enrollment_id uuid);
insert into learning_access_fixture(doc)
select jsonb_build_object('title','Customer learning','summary','Entitlement fixture','category','Testing','accessLevel','customer','durationMinutes',10,
  'productIds',jsonb_build_array(id),'units','[{"id":"98700000-0000-4000-8000-000000000002","type":"video","title":"Private lesson","body":"Reviewed transcript","mediaAssetId":"98700000-0000-4000-8000-000000000001"},
  {"id":"98700000-0000-4000-8000-000000000003","type":"quiz","title":"Post-test","passingScore":80,"maxAttempts":null,
  "questions":[{"id":"98700000-0000-4000-8000-000000000004","prompt":"Choose the correct option","points":1,"correctOptionId":"98700000-0000-4000-8000-000000000005","options":[{"id":"98700000-0000-4000-8000-000000000005","text":"Correct"},{"id":"98700000-0000-4000-8000-000000000006","text":"Incorrect"}]}]}]'::jsonb)
from hub.products where slug='pennsync';
update learning_access_fixture set item_id=(hub.save_learning_draft(null,doc,0)->>'itemId')::uuid;
select lives_ok($$select hub.publish_learning_course(item_id,1,true) from learning_access_fixture$$,'new Hub-authored customer course can publish');
grant select on learning_fixture,learning_access_fixture to authenticated;

set local request.jwt.claims='{"sub":"98000000-0000-4000-8000-000000000004","role":"authenticated","aal":"aal2"}';
set local role authenticated;
select is(hub.get_learning_editor_access(),false,'one-product content permission cannot edit shared courses');
select throws_ok($$select hub.save_learning_draft(null,doc,0) from learning_access_fixture$$,'42501','Shared-course editor access required.','product-scoped editor cannot create portfolio drafts');
select throws_ok($$select hub.publish_learning_course(item_id,1,true) from learning_access_fixture$$,'42501','Shared-course editor access required.','product-scoped editor cannot publish portfolio courses');
select is(private.can_upload_learning_object('learning/98700000-0000-4000-8000-000000000001/video.mp4'),false,'product-scoped editor cannot upload shared media');
reset role;

set local request.jwt.claims='{"sub":"98000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}';
set local role authenticated;
select throws_ok($$select hub.enroll_learning_course(item_id) from learning_access_fixture$$,'42501','Course unavailable.','a learner without membership cannot enroll in a customer course');
select throws_ok($$select hub.get_learning_course(item_id) from learning_access_fixture$$,'42501','Course unavailable.','a learner without membership cannot read customer lessons');
select ok(not exists(select 1 from jsonb_array_elements(hub.list_learning_catalog()) c where c->>'itemId'=(select item_id::text from learning_access_fixture)),'customer course is omitted from an unentitled learner catalog');
reset role;
insert into hub.tenant_product_memberships(tenant_id,product_id,user_id)
select '98600000-0000-4000-8000-000000000002',id,'98000000-0000-4000-8000-000000000003' from hub.products where slug='breathe';
set local role authenticated;
select throws_ok($$select hub.enroll_learning_course(item_id) from learning_access_fixture$$,'42501','Course unavailable.','membership in another product does not grant course access');
reset role;

insert into hub.tenant_product_memberships(tenant_id,product_id,user_id)
select '98600000-0000-4000-8000-000000000001',id,'98000000-0000-4000-8000-000000000002' from hub.products where slug='pennsync';
set local request.jwt.claims='{"sub":"98000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}';
update learning_access_fixture set enrollment_id=hub.enroll_learning_course(item_id);
set local role authenticated;
select lives_ok($$select hub.get_learning_course(item_id,enrollment_id) from learning_access_fixture$$,'active customer membership grants its own enrolled lesson');
select is(hub.get_learning_media_paths('98700000-0000-4000-8000-000000000001',(select enrollment_id from learning_access_fixture))->>'video','learning/98700000-0000-4000-8000-000000000001/video.mp4','enrolled learner can resolve their video for signing');
select is((select count(*) from storage.objects where bucket_id='hub-learning' and name like 'learning/98700000-0000-4000-8000-000000000001/%'),3::bigint,'Storage SELECT permits enrolled media and its sidecars');
reset role;

-- Give learner two the same product entitlement, but no enrollment. Ownership,
-- not simply product access, must still gate another learner's signed media.
insert into hub.tenant_product_memberships(tenant_id,product_id,user_id)
select '98600000-0000-4000-8000-000000000001',id,'98000000-0000-4000-8000-000000000003' from hub.products where slug='pennsync';
set local request.jwt.claims='{"sub":"98000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}';
set local role authenticated;
select throws_ok($$select hub.get_learning_media_paths('98700000-0000-4000-8000-000000000001',enrollment_id) from learning_access_fixture$$,'42501','Video unavailable.','another entitled learner cannot resolve someone else''s enrollment media');
select is((select count(*) from storage.objects where bucket_id='hub-learning' and name like 'learning/98700000-0000-4000-8000-000000000001/%'),0::bigint,'Storage SELECT denies media without a personal enrollment');
reset role;

set local request.jwt.claims='{"sub":"98000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}';
update hub.tenant_products set status='suspended'
where tenant_id='98600000-0000-4000-8000-000000000001' and product_id=(select id from hub.products where slug='pennsync');
set local role authenticated;
select throws_ok($$select hub.enroll_learning_course(item_id) from learning_access_fixture$$,'42501','Course unavailable.','suspended tenant entitlement blocks enrollment');
select throws_ok($$select hub.get_learning_course(item_id,enrollment_id) from learning_access_fixture$$,'42501','Course unavailable.','suspended entitlement blocks an existing enrollment');
select throws_ok($$select hub.submit_learning_unit(enrollment_id,'98700000-0000-4000-8000-000000000002','{}',true,gen_random_uuid()) from learning_access_fixture$$,'42501','Course access unavailable.','suspended entitlement cannot issue a completion');
select throws_ok($$select hub.get_learning_media_paths('98700000-0000-4000-8000-000000000001',enrollment_id) from learning_access_fixture$$,'42501','Video unavailable.','suspended entitlement cannot resolve new media access');
select is((select count(*) from storage.objects where bucket_id='hub-learning' and name like 'learning/98700000-0000-4000-8000-000000000001/%'),0::bigint,'Storage SELECT immediately denies suspended entitlement');
reset role;

update hub.tenant_products set status='active'
where tenant_id='98600000-0000-4000-8000-000000000001' and product_id=(select id from hub.products where slug='pennsync');
update hub.tenant_product_memberships set status='suspended',revoked_at=now()
where tenant_id='98600000-0000-4000-8000-000000000001' and user_id='98000000-0000-4000-8000-000000000002';
set local role authenticated;
select throws_ok($$select hub.get_learning_course(item_id,enrollment_id) from learning_access_fixture$$,'42501','Course unavailable.','revoked membership blocks an existing enrollment with an otherwise active tenant');
select is((select count(*) from storage.objects where bucket_id='hub-learning' and name like 'learning/98700000-0000-4000-8000-000000000001/%'),0::bigint,'Storage SELECT immediately denies revoked membership');
reset role;

update hub.tenant_product_memberships set status='active',revoked_at=null
where tenant_id='98600000-0000-4000-8000-000000000001' and user_id='98000000-0000-4000-8000-000000000002';
update auth.users set banned_until=now()+interval '1 day' where id='98000000-0000-4000-8000-000000000002';
set local role authenticated;
select throws_ok($$select hub.get_learning_media_paths('98700000-0000-4000-8000-000000000001',enrollment_id) from learning_access_fixture$$,'42501','Sign in with the required verification to continue.','banned learner cannot resolve media with a stale token');
select throws_ok($$select hub.submit_learning_unit(enrollment_id,'98700000-0000-4000-8000-000000000002','{}',true,gen_random_uuid()) from learning_access_fixture$$,'42501','Sign in with the required verification to continue.','banned learner cannot submit a completion with a stale token');
select is((select count(*) from storage.objects where bucket_id='hub-learning' and name like 'learning/98700000-0000-4000-8000-000000000001/%'),0::bigint,'Storage SELECT denies banned learner despite retained membership');
reset role;
select * from finish();
rollback;
