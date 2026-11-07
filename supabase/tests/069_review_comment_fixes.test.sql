begin;
select plan(5);
insert into auth.users(id,email,raw_user_meta_data,is_anonymous)
values ('98970000-0000-4000-8000-000000000001','pennsync-editor@test.invalid','{"display_name":"Editor"}',false),
('98970000-0000-4000-8000-000000000002','pennsync-member@test.invalid','{"display_name":"Member"}',false),
('98970000-0000-4000-8000-000000000003','pennsync-other@test.invalid','{"display_name":"Other"}',false);
insert into private.staff_permissions(user_id,permission,granted_by)
values('98970000-0000-4000-8000-000000000001','platform.admin','98970000-0000-4000-8000-000000000001');
-- An agency on CareMetric PennSync with one member. The other learner belongs to no PennSync agency.
insert into hub.tenants(id,slug,name) values('98970000-0000-4000-8000-000000000010','pennsync-learning-agency','PennSync Learning Agency');
insert into hub.tenant_products(tenant_id,product_id) select '98970000-0000-4000-8000-000000000010',id from hub.products where slug='pennsync';
insert into hub.tenant_product_memberships(tenant_id,product_id,user_id)
select '98970000-0000-4000-8000-000000000010',id,'98970000-0000-4000-8000-000000000002' from hub.products where slug='pennsync';

create temporary table pennsync_fixture(doc jsonb,item_id uuid);
grant all on pennsync_fixture to authenticated;
-- A course for product members only ("Who can enroll?" set to product members), placed only on PennSync.
insert into pennsync_fixture(doc) values(jsonb_build_object('title','PennSync members course','summary','Test only','category','Test','accessLevel','customer','durationMinutes',10,
  'productIds',jsonb_build_array((select id from hub.products where slug='pennsync')),
  'units','[{"id":"98970000-0000-4000-8000-000000000101","type":"text","title":"Lesson one","body":"Read this test lesson."},
  {"id":"98970000-0000-4000-8000-000000000102","type":"quiz","title":"Post-test","passingScore":100,
  "questions":[{"id":"98970000-0000-4000-8000-000000000103","prompt":"Choose the correct option","points":1,"correctOptionId":"98970000-0000-4000-8000-000000000104",
    "options":[{"id":"98970000-0000-4000-8000-000000000104","text":"Correct"},{"id":"98970000-0000-4000-8000-000000000105","text":"Incorrect"}]}]}]'::jsonb));

set local role authenticated;
set local request.jwt.claims='{"sub":"98970000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
update pennsync_fixture set item_id=(hub.save_learning_draft(null,doc,0)->>'itemId')::uuid;
select lives_ok($$select hub.publish_learning_course(item_id,1,true) from pennsync_fixture$$,'a members-only course placed on PennSync publishes');

-- PennSync keeps support closed, yet its members reach the courses placed on it.
set local request.jwt.claims='{"sub":"98970000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}';
select ok((select hub.list_learning_catalog()::text like '%PennSync members course%'),'a PennSync member sees the members-only course');
select lives_ok($$select hub.enroll_learning_course(item_id) from pennsync_fixture$$,'and can enroll in it');

-- Membership still decides who sees it.
set local request.jwt.claims='{"sub":"98970000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}';
select ok((select hub.list_learning_catalog()::text not like '%PennSync members course%'),'a learner outside PennSync does not see it');
select throws_ok($$select hub.enroll_learning_course(item_id) from pennsync_fixture$$,null,null,'and cannot enroll in it');

select * from finish();
rollback;
