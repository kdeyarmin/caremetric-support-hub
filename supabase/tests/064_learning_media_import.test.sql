begin;
select plan(25);

-- Closed storage and a server-only entry boundary.
select ok(not has_table_privilege(role_name,'private.learning_media_imports','select,insert,update,delete'),
  format('%s cannot read or write staged imports directly',role_name))
from unnest(array['anon','authenticated','service_role','hub_app_server']) as role_name;
select ok(bool_and(has_function_privilege('hub_app_server',signature,'execute') and not has_function_privilege('authenticated',signature,'execute')
  and not has_function_privilege('anon',signature,'execute') and not has_function_privilege('service_role',signature,'execute')),
  'only the Hub server can enter the import functions')
from unnest(array['private.learning_media_import_begin(jsonb,text,integer,text,integer,text)','private.learning_media_import_prepare(text,uuid,text,bigint)',
  'private.learning_media_import_finish(text,uuid)','private.learning_media_import_fail(text,uuid,text)','private.learning_media_import_list()',
  'private.learning_media_import_register(uuid,boolean)','private.learning_media_import_attach(uuid)']) as signature;
select ok(not bool_or(has_function_privilege(role_name,signature,'execute')),'import helpers stay internal')
from unnest(array['private.learning_media_import_uuid(text)','private.learning_media_import_actor()',
  'private.learning_media_import_target(private.learning_media_imports)','private.learning_media_import_attach_item(private.learning_media_imports,uuid)']) as signature
cross join unnest(array['anon','authenticated','service_role','hub_app_server']) as role_name;
select ok(hub.get_backend_contract()->'features' @> '["learning.media-import.v1"]','the backend declares bulk media import');
select throws_ok($$select private.learning_media_import_list()$$,'42501','Application server required.','a database session that is not the Hub server cannot list imports');

-- The PennSync lesson identity is the conversion's own (learningSourceId('lesson', moduleId)).
select is(private.learning_media_import_uuid('caremetric.pennsync.learning.v2:lesson:65f1a2b3c4d5e6f708192a3b'),'f185124e-304d-8d4a-8a4e-2607fe5877ed'::uuid,'PennSync lesson identity vector one');
select is(private.learning_media_import_uuid('caremetric.pennsync.learning.v2:lesson:0123456789abcdef01234567'),'807cfb7b-8818-823f-a78f-42d7acfc1d0d'::uuid,'PennSync lesson identity vector two');

-- Fixtures: one editor, two drafts.
insert into auth.users(id,email,is_anonymous) values('99400000-0000-4000-8000-000000000001','media-import-test@test.invalid',false);
insert into hub.content_items(id,content_key,kind,status,access_level) values
  ('99410000-0000-4000-8000-000000000001','media.import.test.one','course','draft','staff'),
  ('99410000-0000-4000-8000-000000000002','media.import.test.two','course','draft','staff');
insert into private.learning_courses(item_id,draft) values
  ('99410000-0000-4000-8000-000000000001',jsonb_build_object('title','Fire safety','units',jsonb_build_array(
    jsonb_build_object('id','99420000-0000-4000-8000-000000000001','type','video','title','Exit  routes','body','t','mediaAssetId',null),
    jsonb_build_object('id','99420000-0000-4000-8000-000000000002','type','video','title','Drills','body','t','mediaAssetId','99430000-0000-4000-8000-000000000009'),
    jsonb_build_object('id','99420000-0000-4000-8000-000000000003','type','text','title','Overview','body','t'),
    jsonb_build_object('id','99420000-0000-4000-8000-000000000004','type','video','title','Recap','body','t','mediaAssetId',null),
    jsonb_build_object('id','99420000-0000-4000-8000-000000000005','type','video','title','recap','body','t','mediaAssetId',null)))),
  ('99410000-0000-4000-8000-000000000002',jsonb_build_object('title','Infection control','units',jsonb_build_array(
    jsonb_build_object('id','f185124e-304d-8d4a-8a4e-2607fe5877ed','type','video','title','Hand hygiene','body','t','mediaAssetId',null))));
create temporary table import_fixture(n integer,title text,source_record text,media_id uuid);
insert into import_fixture values
  (1,'Exit routes','99410000-0000-4000-8000-000000000001',null),
  (2,'Drills','99410000-0000-4000-8000-000000000001','99430000-0000-4000-8000-000000000001'),
  (3,'Drills','99410000-0000-4000-8000-000000000001','99430000-0000-4000-8000-000000000009'),
  (4,'Overview','99410000-0000-4000-8000-000000000001',null),
  (5,'Missing lesson','99410000-0000-4000-8000-000000000001',null),
  (6,'Recap','99410000-0000-4000-8000-000000000001',null),
  (7,'Exit routes','99410000-0000-4000-8000-000000000003',null),
  (8,'Hand hygiene','65f1a2b3c4d5e6f708192a3b',null),
  (9,'Not converted yet','0123456789abcdef01234567',null);
insert into private.learning_media_imports(item_key,product,course_title,lesson_title,source_record,heygen_video_id,duration_seconds,mp4_url,
  captions_file,transcript_file,captions_sha256,captions_bytes,transcript_sha256,transcript_bytes,manifest_sha256,state,failure_code,media_id,created_by,updated_by)
select p.product||':'||f.source_record||':render0'||f.n,p.product,'Course',f.title,f.source_record,'render0'||f.n,60,
  'https://resource2.heygen.ai/'||f.n||'.mp4','c'||f.n||'.vtt','t'||f.n||'.txt',repeat('a',64),10,repeat('b',64),10,repeat('c',64),'failed','source_unavailable',f.media_id,
  '99400000-0000-4000-8000-000000000001','99400000-0000-4000-8000-000000000001'
from import_fixture f cross join lateral (select case when f.source_record ~ '^[a-f0-9]{24}$' then 'pennsync' else 'carebase' end as product) p;
create temporary table targets as select i.lesson_title,i.source_record,i.media_id,private.learning_media_import_target(i) as target from private.learning_media_imports i
  where i.created_by='99400000-0000-4000-8000-000000000001';
select is((select target->>'state' from targets where lesson_title='Exit routes' and source_record like '99410000%1'),'ready','a named draft lesson matches by title, ignoring spacing and case');
select is((select target->>'unitId' from targets where lesson_title='Exit routes' and source_record like '99410000%1'),'99420000-0000-4000-8000-000000000001','the ready target names the exact video lesson');
select is((select target->>'state' from targets where lesson_title='Drills' and media_id='99430000-0000-4000-8000-000000000001'),'occupied','a lesson with another video is never replaced');
select is((select target->>'state' from targets where lesson_title='Drills' and media_id='99430000-0000-4000-8000-000000000009'),'attached','a lesson already holding this video reads as attached');
select is((select target->>'state' from targets where lesson_title='Overview'),'not_video','a text lesson cannot take a video');
select is((select target->>'state' from targets where lesson_title='Missing lesson'),'missing_lesson','an unknown lesson title is reported');
select is((select target->>'state' from targets where lesson_title='Recap'),'ambiguous','two matching video lessons are never guessed between');
select is((select target->>'state' from targets where source_record like '99410000%3'),'missing_draft','an unknown Hub draft item is reported');
select is((select target->>'state' from targets where lesson_title='Hand hygiene'),'ready','a PennSync TrainingModule id finds its converted draft lesson');
select is((select target->>'itemId' from targets where lesson_title='Hand hygiene'),'99410000-0000-4000-8000-000000000002','the PennSync target names its draft');
select is((select target->>'state' from targets where lesson_title='Not converted yet'),'missing_draft','a module without a converted draft waits');

-- State invariants hold even for direct writes.
select throws_ok($$update private.learning_media_imports set state='staged',failure_code=null where lesson_title='Overview'$$,'23514',null,'staging requires a media id, checksum and size');
select throws_ok($$update private.learning_media_imports set state='registered',failure_code=null,media_id=gen_random_uuid(),source_sha256=repeat('d',64),byte_size=10 where lesson_title='Overview'$$,'23514',null,'registration requires the approving editor');
select throws_ok($$update private.learning_media_imports set item_key='carebase:other:key' where lesson_title='Overview'$$,'23514',null,'the identity is product, source record and render');
select throws_ok($$update private.learning_media_imports set mp4_url='http://resource2.heygen.ai/x.mp4' where lesson_title='Overview'$$,'23514',null,'sources are https');
select * from finish();
rollback;
