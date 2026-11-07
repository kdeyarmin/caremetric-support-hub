begin;
select plan(11);
insert into auth.users(id,email,raw_user_meta_data,is_anonymous)
values ('98900000-0000-4000-8000-000000000001','review-editor@test.invalid','{"display_name":"Editor"}',false);
insert into private.staff_permissions(user_id,permission,granted_by)
values('98900000-0000-4000-8000-000000000001','platform.admin','98900000-0000-4000-8000-000000000001');
set local request.jwt.claims='{"sub":"98900000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';

-- Two CareBase courses registered in the central catalog for import.
insert into hub.content_items(id,content_key,kind,status,access_level,source_system) values
('98910000-0000-4000-8000-000000000001','learning.review.text','course','published','public','penntrain'),
('98910000-0000-4000-8000-000000000002','learning.review.video','course','published','public','penntrain');
insert into hub.course_links(content_item_id,penntrain_course_id,source_version,launch_path) values
('98910000-0000-4000-8000-000000000001','98910000-0000-4000-8000-000000000011','98910000-0000-4000-8000-000000000012','/app/courses/98910000-0000-4000-8000-000000000011'),
('98910000-0000-4000-8000-000000000002','98910000-0000-4000-8000-000000000021','98910000-0000-4000-8000-000000000022','/app/courses/98910000-0000-4000-8000-000000000021');
create temporary table review_fixture(doc jsonb);
insert into review_fixture values(jsonb_build_object('title','Review import','summary','Test only','category','Test','accessLevel','public','durationMinutes',10,
  'productIds',jsonb_build_array((select id from hub.products where slug='carebase')),
  'units','[{"id":"98920000-0000-4000-8000-000000000001","type":"text","title":"Lesson one","body":"Read this test lesson."},
  {"id":"98920000-0000-4000-8000-000000000002","type":"quiz","title":"Post-test","passingScore":100,"maxAttempts":2,
  "questions":[{"id":"98920000-0000-4000-8000-000000000003","prompt":"Choose the correct option","points":1,"correctOptionId":"98920000-0000-4000-8000-000000000004",
    "options":[{"id":"98920000-0000-4000-8000-000000000004","text":"Correct"},{"id":"98920000-0000-4000-8000-000000000005","text":"Incorrect"}]}]}]'::jsonb));

-- Importing the same export again is a replay even when its placements differ (an app was retired or reopened for courses since).
select lives_ok($$select hub.import_learning_draft('98910000-0000-4000-8000-000000000011','98910000-0000-4000-8000-000000000012',doc) from review_fixture$$,'a CareBase course imports');
select lives_ok($$select hub.import_learning_draft('98910000-0000-4000-8000-000000000011','98910000-0000-4000-8000-000000000012',
  jsonb_set(doc,'{productIds}',jsonb_build_array((select id from hub.products where slug='carebase'),(select id from hub.products where slug='pennsync')))) from review_fixture$$,
  'importing the same export with different placements is a replay, not a conflict');
select is((select count(*) from private.learning_imports where source_course_id='98910000-0000-4000-8000-000000000011'),1::bigint,'the replay records nothing new');
select throws_ok($$select hub.import_learning_draft('98910000-0000-4000-8000-000000000011','98910000-0000-4000-8000-000000000012',jsonb_set(doc,'{title}','"Changed source"')) from review_fixture$$,
  '40001','This course was already imported. Review revisions in the course editor.','a changed source is still a conflict');
select throws_ok($$select hub.import_learning_draft('98910000-0000-4000-8000-000000000011','98910000-0000-4000-8000-000000000013',doc) from review_fixture$$,
  '40001','This course was already imported. Review revisions in the course editor.','another source revision is still a conflict');

-- An imported video's media may be added, not swapped.
insert into storage.objects(bucket_id,name,metadata) values
('hub-learning','learning/98930000-0000-4000-8000-000000000001/video.mp4','{"size":6,"mimetype":"video/mp4"}'),
('hub-learning','learning/98930000-0000-4000-8000-000000000001/captions.vtt','{"size":6,"mimetype":"text/vtt"}'),
('hub-learning','learning/98930000-0000-4000-8000-000000000001/transcript.txt','{"size":6,"mimetype":"text/plain"}'),
('hub-learning','learning/98930000-0000-4000-8000-000000000002/video.mp4','{"size":6,"mimetype":"video/mp4"}'),
('hub-learning','learning/98930000-0000-4000-8000-000000000002/captions.vtt','{"size":6,"mimetype":"text/vtt"}'),
('hub-learning','learning/98930000-0000-4000-8000-000000000002/transcript.txt','{"size":6,"mimetype":"text/plain"}');
select lives_ok($$select hub.register_learning_media('98930000-0000-4000-8000-000000000001','Imported video',repeat('c',64),true)$$,'the imported video is registered');
select lives_ok($$select hub.register_learning_media('98930000-0000-4000-8000-000000000002','Other video',repeat('d',64),true)$$,'another video is registered');
create temporary table review_video(doc jsonb);
insert into review_video select jsonb_set(doc,'{units,0}','{"id":"98920000-0000-4000-8000-000000000011","type":"video","title":"Video lesson","body":"Reviewed transcript","mediaAssetId":"98930000-0000-4000-8000-000000000001"}'::jsonb) from review_fixture;
select lives_ok($$select hub.import_learning_draft('98910000-0000-4000-8000-000000000021','98910000-0000-4000-8000-000000000022',doc) from review_video$$,'a course with its video imports');
select lives_ok($$select hub.save_learning_draft('98910000-0000-4000-8000-000000000002',jsonb_set(doc,'{units,0,mediaAssetId}','"98930000-0000-4000-8000-000000000002"'),1) from review_video$$,'the draft can be edited');
select throws_like($$select hub.publish_learning_course('98910000-0000-4000-8000-000000000002',2,true)$$,'%a lesson was added, removed, reordered, or rewritten after import%','swapping an imported video blocks publication here');
select lives_ok($$select hub.save_learning_draft('98910000-0000-4000-8000-000000000002',doc,2) from review_video$$,'restoring the imported video is allowed');

select * from finish();
rollback;
