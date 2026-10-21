begin;
select plan(13);

select ok((select bool_and(relrowsecurity) from pg_class where oid in
  ('private.communications'::regclass,'private.communication_messages'::regclass,'private.communication_rate_events'::regclass)),
  'every communication table has row level security');
select ok(not has_table_privilege('anon','private.communications','select')
  and not has_table_privilege('authenticated','private.communication_messages','select')
  and not has_table_privilege('hub_app_server','private.communications','select,insert,update,delete'),
  'no browser or server role can read or write conversation tables directly');
select ok(not has_function_privilege('anon','hub.list_communications(text,text,uuid,text,integer,integer)','execute')
  and not has_function_privilege('anon','hub.get_communication(uuid)','execute'),
  'anonymous callers cannot list or open conversations');
select ok(not has_function_privilege('authenticated','private.ingest_inbound_communication(text,text,text,bigint,text,text,text,text,text,text)','execute')
  and not has_function_privilege('authenticated','private.start_chat(text,text,text,text,text,text)','execute')
  and not has_function_privilege('authenticated','private.finish_communication_delivery(uuid,text,text)','execute'),
  'browsers cannot inject inbound messages, start chats or rewrite delivery outcomes');
select ok(has_function_privilege('hub_app_server','private.ingest_inbound_communication(text,text,text,bigint,text,text,text,text,text,text)','execute')
  and has_function_privilege('hub_app_server','private.read_chat(text)','execute'),
  'only the Hub server receives signed webhooks and serves chat');

insert into auth.users(id,email,is_anonymous) values('99200000-0000-4000-8000-000000000001','comms-contract@test.invalid',false);
set local request.jwt.claims='{"sub":"99200000-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;
select throws_ok($$select hub.list_communications(null,null,null,null,0,25)$$,'42501','Support staff access required.',
  'a signed-in non-staff account cannot read the inbox');
reset role;

select is(private.communication_product('PennFit'),(select id from hub.products where slug='breathe'),'PennFit routes to Breathe');
select is(private.communication_product('penntrain'),(select id from hub.products where slug='carebase'),'PennTrain routes to CareBase');
select is(private.communication_product('intel'),(select id from hub.products where slug='caremetric-intel'),'Intel routes to CareMetric Intel');
select is(private.communication_product('unknown-app'),null::uuid,'unknown applications stay unassigned for triage');
select is(private.communication_line(E'Subject\r\nwith\tcontrols','200'),'Subject with controls','single-line fields drop control characters');
select ok(hub.get_backend_contract()->'features' @> '["support.communications.v1"]'::jsonb,'unified communications are declared in release metadata');
select ok(position($q$'channel', c.channel$q$ in pg_get_functiondef('hub.begin_communication_reply(uuid,text,uuid,text[])'::regprocedure))>0,
  'a started reply tells the server which channel the conversation came from');

select * from finish();
rollback;
