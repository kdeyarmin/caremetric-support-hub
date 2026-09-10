begin;
select no_plan();
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
select throws_ok($$select hub.submit_learning_unit(enrollment_id,'98100000-0000-4000-8000-000000000002','{"score":100}',false,gen_random_uuid()) from learning_fixture$$,'22023','Quiz answer is not a valid option.','client cannot supply its own grade');
update learning_fixture set result=hub.submit_learning_unit(enrollment_id,'98100000-0000-4000-8000-000000000002','{"98200000-0000-4000-8000-000000000001":"98300000-0000-4000-8000-000000000002"}',false,'98400000-0000-4000-8000-000000000001');
select is((select (result->>'score')::integer from learning_fixture),0,'wrong answer is graded on server');
select is(hub.submit_learning_unit((select enrollment_id from learning_fixture),'98100000-0000-4000-8000-000000000002','{"98200000-0000-4000-8000-000000000001":"98300000-0000-4000-8000-000000000002"}',false,'98400000-0000-4000-8000-000000000001'),(select result from learning_fixture),'network retry reuses attempt');
select throws_ok($$select hub.submit_learning_unit(enrollment_id,'98100000-0000-4000-8000-000000000002','{}',false,'98400000-0000-4000-8000-000000000001') from learning_fixture$$,'22023','Submission key already used for different content.','request-key reuse cannot change answers');
select is((hub.submit_learning_unit((select enrollment_id from learning_fixture),'98100000-0000-4000-8000-000000000002','{"98200000-0000-4000-8000-000000000001":"98300000-0000-4000-8000-000000000001"}',false,gen_random_uuid())->>'score')::integer,100,'correct answer passes');
select is((select completed_at from private.learning_enrollments where id=(select enrollment_id from learning_fixture)),null::timestamptz,'passing quiz alone does not complete other lessons');
set local request.jwt.claims='{"sub":"98000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}';
select throws_ok($$select hub.get_learning_course(item_id,enrollment_id) from learning_fixture$$,'42501','Enrollment unavailable.','another learner cannot read progress');
select throws_ok($$select hub.submit_learning_unit(enrollment_id,'98100000-0000-4000-8000-000000000001','{}',true,gen_random_uuid()) from learning_fixture$$,'42501','Enrollment unavailable.','another learner cannot modify progress');
select is(hub.list_my_learning(),'[]'::jsonb,'another learner cannot list private enrollments');
set local request.jwt.claims='{"sub":"98000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}';
select lives_ok($$select hub.submit_learning_unit(enrollment_id,'98100000-0000-4000-8000-000000000001','{}',true,gen_random_uuid()) from learning_fixture$$,'last lesson completes enrollment');
select is(hub.get_learning_certificate((select enrollment_id from learning_fixture))->>'learnerName','Learner One','certificate uses authenticated learner identity');
update hub.profiles set display_name='Renamed learner' where id='98000000-0000-4000-8000-000000000002';
select is(hub.get_learning_certificate((select enrollment_id from learning_fixture))->>'learnerName','Learner One','later profile edits cannot rewrite certificate identity');
set local request.jwt.claims='{"sub":"98000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
select lives_ok($$select hub.save_learning_draft(item_id,jsonb_set(doc,'{title}','"Revision two"'),1) from learning_fixture$$,'author can revise course');
select lives_ok($$select hub.publish_learning_course(item_id,2,true) from learning_fixture$$,'new publication is immutable');
set local request.jwt.claims='{"sub":"98000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}';
select is(hub.get_learning_certificate((select enrollment_id from learning_fixture))->>'courseTitle','Learning test','new publication preserves historical completion title');
select is(hub.get_learning_course((select item_id from learning_fixture),(select enrollment_id from learning_fixture))->'document'->>'title','Learning test','existing enrollment pins its original revision');
update auth.users set banned_until=now()+interval '1 day' where id='98000000-0000-4000-8000-000000000002';
select throws_ok($$select hub.list_my_learning()$$,'42501','Sign in with the required verification to continue.','banned users are rejected despite stale tokens');
select ok(not exists(select 1 from storage.buckets where id='hub-learning' and public),'central media bucket stays private');
select * from finish();
rollback;
