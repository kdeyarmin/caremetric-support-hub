begin;
select plan(10);
insert into auth.users(id,email,raw_user_meta_data,is_anonymous)
values ('98950000-0000-4000-8000-000000000001','decisions-editor@test.invalid','{"display_name":"Editor"}',false),
('98950000-0000-4000-8000-000000000002','decisions-learner@test.invalid','{"display_name":"Learner"}',false);
insert into private.staff_permissions(user_id,permission,granted_by)
values('98950000-0000-4000-8000-000000000001','platform.admin','98950000-0000-4000-8000-000000000001');
create temporary table decisions_fixture(doc jsonb,item_id uuid,pennsync_item uuid,enrollment_id uuid);
grant all on decisions_fixture to authenticated;
insert into decisions_fixture(doc) values(jsonb_build_object('title','Decisions test','summary','Test only','category','Test','accessLevel','public','durationMinutes',10,
  'productIds',jsonb_build_array((select id from hub.products where slug='carebase')),
  'units','[{"id":"98960000-0000-4000-8000-000000000001","type":"text","title":"Lesson one","body":"Read this test lesson."},
  {"id":"98960000-0000-4000-8000-000000000002","type":"quiz","title":"Post-test","passingScore":100,"maxAttempts":1,
  "questions":[{"id":"98960000-0000-4000-8000-000000000003","prompt":"Choose the correct option","points":1,"correctOptionId":"98960000-0000-4000-8000-000000000004",
    "options":[{"id":"98960000-0000-4000-8000-000000000004","text":"Correct"},{"id":"98960000-0000-4000-8000-000000000005","text":"Incorrect"}]}]}]'::jsonb));

set local request.jwt.claims='{"sub":"98950000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
update decisions_fixture set item_id=(hub.save_learning_draft(null,doc,0)->>'itemId')::uuid;
select lives_ok($$select hub.publish_learning_course(item_id,1,true) from decisions_fixture$$,'a course whose quiz allows one attempt publishes');
-- A course placed only on CareMetric PennSync.
update decisions_fixture set pennsync_item=(hub.save_learning_draft(null,jsonb_set(jsonb_set(doc,'{title}','"PennSync only"'),'{productIds}',
  jsonb_build_array((select id from hub.products where slug='pennsync'))),0)->>'itemId')::uuid;
select lives_ok($$select hub.publish_learning_course(pennsync_item,1,true) from decisions_fixture$$,'a course placed only on PennSync publishes');

-- Quizzes: a learner retakes as many times as they need, past the course's old limit.
set local request.jwt.claims='{"sub":"98950000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}';
update decisions_fixture set enrollment_id=hub.enroll_learning_course(item_id);
select lives_ok($$select hub.submit_learning_unit(enrollment_id,'98960000-0000-4000-8000-000000000001','{}',true,gen_random_uuid()) from decisions_fixture$$,'the lesson completes');
select is((select (hub.submit_learning_unit(enrollment_id,'98960000-0000-4000-8000-000000000002','{"98960000-0000-4000-8000-000000000003":"98960000-0000-4000-8000-000000000005"}',false,gen_random_uuid())->>'attemptCount')::integer from decisions_fixture),1,'a first failed attempt is recorded');
select is((select (hub.submit_learning_unit(enrollment_id,'98960000-0000-4000-8000-000000000002','{"98960000-0000-4000-8000-000000000003":"98960000-0000-4000-8000-000000000005"}',false,gen_random_uuid())->>'attemptCount')::integer from decisions_fixture),2,'a retake past the old limit of one is accepted');
select is((select (hub.submit_learning_unit(enrollment_id,'98960000-0000-4000-8000-000000000002','{"98960000-0000-4000-8000-000000000003":"98960000-0000-4000-8000-000000000004"}',false,gen_random_uuid())->>'passed')::boolean from decisions_fixture),true,'and the learner can still pass');
select isnt((select completed_at from private.learning_enrollments where id=(select enrollment_id from decisions_fixture)),null,'the course completes');

-- PennSync courses reach learners; PennSync itself stays closed for support and billing.
select ok((select hub.list_learning_catalog()::text like '%PennSync only%'),'a PennSync course is in the learner catalog');
select lives_ok($$select hub.enroll_learning_course(pennsync_item) from decisions_fixture$$,'a learner can enroll in a PennSync course');
select ok((select p.status = 'retired' and not p.support_enabled from hub.products p where p.slug = 'pennsync'),'PennSync stays retired for support');

select * from finish();
rollback;
