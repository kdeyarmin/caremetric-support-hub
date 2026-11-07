begin;
select plan(34);
insert into auth.users(id,email,raw_user_meta_data,is_anonymous)
values ('98700000-0000-4000-8000-000000000001','select-all-editor@test.invalid','{"display_name":"Editor"}',false),
('98700000-0000-4000-8000-000000000002','select-all-learner@test.invalid','{"display_name":"Learner"}',false);
insert into private.staff_permissions(user_id,permission,granted_by)
values('98700000-0000-4000-8000-000000000001','platform.admin','98700000-0000-4000-8000-000000000001');
-- Question one is select all that apply (A and C are correct); question two has one answer (E).
create temporary table select_all_fixture(doc jsonb,item_id uuid,enrollment_id uuid,result jsonb);
insert into select_all_fixture(doc) values(jsonb_build_object('title','Select-all test','summary','Test only','category','Test','accessLevel','public','durationMinutes',10,
  'productIds',jsonb_build_array((select id from hub.products where slug='carebase')),
  'units','[{"id":"98710000-0000-4000-8000-000000000001","type":"text","title":"Lesson one","body":"Read this test lesson."},
  {"id":"98710000-0000-4000-8000-000000000002","type":"quiz","title":"Post-test","passingScore":100,"maxAttempts":6,
  "questions":[{"id":"98720000-0000-4000-8000-000000000001","prompt":"Choose every correct option","points":1,
    "correctOptionIds":["98730000-0000-4000-8000-00000000000a","98730000-0000-4000-8000-00000000000c"],
    "options":[{"id":"98730000-0000-4000-8000-00000000000a","text":"A"},{"id":"98730000-0000-4000-8000-00000000000b","text":"B"},{"id":"98730000-0000-4000-8000-00000000000c","text":"C"}]},
   {"id":"98720000-0000-4000-8000-000000000002","prompt":"Choose the one correct option","points":1,"correctOptionId":"98730000-0000-4000-8000-00000000000e",
    "options":[{"id":"98730000-0000-4000-8000-00000000000d","text":"D"},{"id":"98730000-0000-4000-8000-00000000000e","text":"E"}]}]}]'::jsonb));
create temporary table select_all_keys(label text,doc jsonb);
insert into select_all_keys select label, jsonb_set((select doc from select_all_fixture),'{units,1,questions,0}',
  ((select doc from select_all_fixture)#>'{units,1,questions,0}') - 'correctOptionIds' || patch) from (values
  ('both keys','{"correctOptionIds":["98730000-0000-4000-8000-00000000000a"],"correctOptionId":"98730000-0000-4000-8000-00000000000a"}'::jsonb),
  ('empty set','{"correctOptionIds":[]}'::jsonb),
  ('unlisted option','{"correctOptionIds":["98730000-0000-4000-8000-00000000000a","98730000-0000-4000-8000-00000000000d"]}'::jsonb),
  ('repeated option','{"correctOptionIds":["98730000-0000-4000-8000-00000000000a","98730000-0000-4000-8000-00000000000A"]}'::jsonb),
  ('non-text key','{"correctOptionIds":[1]}'::jsonb),
  ('not a list','{"correctOptionIds":"98730000-0000-4000-8000-00000000000a"}'::jsonb)) as cases(label,patch);
set local request.jwt.claims='{"sub":"98700000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';

-- Authoring: a select-all key is one or more distinct listed options, never alongside a single key.
select throws_ok(format('select private.validate_learning_document(%L::jsonb)',doc),'22023','Choose one or more valid correct answers.','a select-all key refuses '||label)
  from select_all_keys order by label;
select lives_ok($$select private.validate_learning_document(doc) from select_all_fixture$$,'a select-all question with a valid set of correct options is accepted');
select throws_ok($$select private.validate_learning_document(jsonb_set(doc,'{units,1,questions,1,correctOptionId}','"98730000-0000-4000-8000-00000000000a"')) from select_all_fixture$$,
  '22023','Choose exactly one valid correct answer.','a single-answer question still needs one of its own options');

-- Placement: CareMetric PennSync takes courses again; the other retired apps still do not.
select lives_ok($$select private.validate_learning_document(jsonb_set(doc,'{productIds}',jsonb_build_array((select id from hub.products where slug='pennsync')))) from select_all_fixture$$,
  'a course can be placed on CareMetric PennSync');
select throws_ok($$select private.validate_learning_document(jsonb_set(doc,'{productIds}',jsonb_build_array((select id from hub.products where slug='caremetric-emr')))) from select_all_fixture$$,
  '22023','Course product is invalid or duplicated.','a course still cannot be placed on another retired app');
select is((select name from hub.products where slug='pennsync'),'CareMetric PennSync','the registry names the app CareMetric PennSync');
select ok((select status='retired' and not support_enabled and not private.hub_application_enabled(id) from hub.products where slug='pennsync'),
  'CareMetric PennSync stays disconnected from support, billing and native connections');
select ok(hub.get_backend_contract()->'features' @> '["learning.select-all.v1"]'::jsonb,'the backend declares select-all questions');

-- Publishing on CareMetric PennSync with another app records both placements.
update select_all_fixture set item_id=(hub.save_learning_draft(null,jsonb_set(doc,'{productIds}',
  jsonb_build_array((select id from hub.products where slug='carebase'),(select id from hub.products where slug='pennsync'))),0)->>'itemId')::uuid;
select lives_ok($$select hub.publish_learning_course(item_id,1,true) from select_all_fixture$$,'a reviewed select-all course placed on CareMetric PennSync publishes');
select is((select count(*) from hub.content_publications p join hub.products pr on pr.id=p.product_id
  where p.item_id=(select item_id from select_all_fixture) and pr.slug in ('carebase','pennsync') and p.expires_at is null),2::bigint,'both placements are published');

-- An imported course publishes only with its answers unchanged, including a select-all answer set.
insert into private.learning_imports(source_course_id,source_version_id,document_sha256,item_id,source_document)
  select '98750000-0000-4000-8000-000000000001','98750000-0000-4000-8000-000000000002',repeat('0',64),item_id,doc from select_all_fixture;
select is(private.learning_import_preservation_error(item_id,doc),null,'an unchanged imported select-all quiz is preserved') from select_all_fixture;
select is(private.learning_import_preservation_error(item_id,jsonb_set(doc,'{units,1,questions,0,correctOptionIds}','["98730000-0000-4000-8000-00000000000a"]')),'quiz',
  'changing an imported select-all answer set is a quiz change') from select_all_fixture;
select is(private.learning_import_preservation_error(item_id,jsonb_set(doc,'{units,1,questions,0}',(doc#>'{units,1,questions,0}') - 'correctOptionIds'
  || '{"correctOptionId":"98730000-0000-4000-8000-00000000000a"}')),'quiz','turning an imported select-all question into one answer is a quiz change') from select_all_fixture;
delete from private.learning_imports where source_course_id='98750000-0000-4000-8000-000000000001';

-- Learners see which question takes several answers, never which answers are correct.
set local request.jwt.claims='{"sub":"98700000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}';
select is((select jsonb_agg(q.value->'multiple' order by q.position) from jsonb_array_elements(hub.get_learning_course((select item_id from select_all_fixture))#>'{document,units,1,questions}') with ordinality q(value,position)),
  '[true,false]'::jsonb,'the learner document marks the select-all question');
select ok((hub.get_learning_course((select item_id from select_all_fixture))::text not like '%correctOptionId%'),'the learner document has no answer keys');
update select_all_fixture set enrollment_id=hub.enroll_learning_course(item_id);
select lives_ok($$select hub.submit_learning_unit(enrollment_id,'98710000-0000-4000-8000-000000000001','{}',true,gen_random_uuid()) from select_all_fixture$$,'the lesson completes');

-- Answers: a select-all answer is a non-empty set of distinct listed options; a single answer is one option.
select throws_ok(format($$select hub.submit_learning_unit(enrollment_id,'98710000-0000-4000-8000-000000000002',%L::jsonb,false,gen_random_uuid()) from select_all_fixture$$,answers),
  '22023','Quiz answer is not a valid option.',label)
  from (values
    ('a select-all answer must be a list','{"98720000-0000-4000-8000-000000000001":"98730000-0000-4000-8000-00000000000a","98720000-0000-4000-8000-000000000002":"98730000-0000-4000-8000-00000000000e"}'),
    ('a select-all answer cannot be empty','{"98720000-0000-4000-8000-000000000001":[],"98720000-0000-4000-8000-000000000002":"98730000-0000-4000-8000-00000000000e"}'),
    ('a select-all answer cannot repeat an option','{"98720000-0000-4000-8000-000000000001":["98730000-0000-4000-8000-00000000000a","98730000-0000-4000-8000-00000000000a"],"98720000-0000-4000-8000-000000000002":"98730000-0000-4000-8000-00000000000e"}'),
    ('a select-all answer names only listed options','{"98720000-0000-4000-8000-000000000001":["98730000-0000-4000-8000-00000000000a","98730000-0000-4000-8000-00000000000d"],"98720000-0000-4000-8000-000000000002":"98730000-0000-4000-8000-00000000000e"}'),
    ('a select-all answer holds option ids only','{"98720000-0000-4000-8000-000000000001":[{"id":"98730000-0000-4000-8000-00000000000a"}],"98720000-0000-4000-8000-000000000002":"98730000-0000-4000-8000-00000000000e"}'),
    ('a select-all answer uses the listed option ids exactly','{"98720000-0000-4000-8000-000000000001":["98730000-0000-4000-8000-00000000000A","98730000-0000-4000-8000-00000000000c"],"98720000-0000-4000-8000-000000000002":"98730000-0000-4000-8000-00000000000e"}'),
    ('a single-answer question still takes one option','{"98720000-0000-4000-8000-000000000001":["98730000-0000-4000-8000-00000000000a","98730000-0000-4000-8000-00000000000c"],"98720000-0000-4000-8000-000000000002":["98730000-0000-4000-8000-00000000000e"]}')
  ) as cases(label,answers);
select is((select (attempt_count) from private.learning_unit_progress where enrollment_id=(select enrollment_id from select_all_fixture) and unit_id='98710000-0000-4000-8000-000000000002'),
  null::integer,'refused answers use no attempt');

-- Grading: points only for exactly the correct set, in any order.
select is((hub.submit_learning_unit((select enrollment_id from select_all_fixture),'98710000-0000-4000-8000-000000000002',
  '{"98720000-0000-4000-8000-000000000001":["98730000-0000-4000-8000-00000000000a"],"98720000-0000-4000-8000-000000000002":"98730000-0000-4000-8000-00000000000e"}',false,gen_random_uuid())->>'score')::integer,
  50,'part of the correct set earns nothing for that question');
select is((hub.submit_learning_unit((select enrollment_id from select_all_fixture),'98710000-0000-4000-8000-000000000002',
  '{"98720000-0000-4000-8000-000000000001":["98730000-0000-4000-8000-00000000000a","98730000-0000-4000-8000-00000000000b","98730000-0000-4000-8000-00000000000c"],"98720000-0000-4000-8000-000000000002":"98730000-0000-4000-8000-00000000000e"}',false,gen_random_uuid())->>'score')::integer,
  50,'choosing every option earns nothing for that question');
select is((hub.submit_learning_unit((select enrollment_id from select_all_fixture),'98710000-0000-4000-8000-000000000002',
  '{"98720000-0000-4000-8000-000000000001":["98730000-0000-4000-8000-00000000000c","98730000-0000-4000-8000-00000000000a"],"98720000-0000-4000-8000-000000000002":"98730000-0000-4000-8000-00000000000d"}',false,gen_random_uuid())->>'score')::integer,
  50,'the exact set in any order earns the select-all question');
select is((hub.submit_learning_unit((select enrollment_id from select_all_fixture),'98710000-0000-4000-8000-000000000002',
  '{"98720000-0000-4000-8000-000000000001":["98730000-0000-4000-8000-00000000000a","98730000-0000-4000-8000-00000000000c"],"98720000-0000-4000-8000-000000000002":"98730000-0000-4000-8000-00000000000e"}',false,gen_random_uuid())->>'passed')::boolean,
  true,'every question correct passes the post-test');
select isnt((select completed_at from private.learning_enrollments where id=(select enrollment_id from select_all_fixture)),null::timestamptz,'passing completes the course');
select * from finish();
rollback;
