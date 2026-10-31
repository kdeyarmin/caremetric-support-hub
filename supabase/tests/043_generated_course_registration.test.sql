begin;
select no_plan();
select ok(has_function_privilege('hub_app_server','private.register_generated_course(uuid,uuid,text,text)','execute'),'the Hub server records AI-written courses in the catalog');
select ok(not has_function_privilege('authenticated','private.register_generated_course(uuid,uuid,text,text)','execute'),'browser sessions cannot record catalog courses');
select ok(not has_function_privilege('anon','private.register_generated_course(uuid,uuid,text,text)','execute'),'anonymous visitors cannot record catalog courses');
select ok(not has_function_privilege('service_role','private.register_generated_course(uuid,uuid,text,text)','execute'),'the service role cannot record catalog courses');
select throws_ok($$select private.register_generated_course(gen_random_uuid(),gen_random_uuid(),'{}',repeat('0',64))$$,'42501',null,'only the application server, for a signed-in course editor, can record a course');
select * from finish();
rollback;
