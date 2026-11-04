begin;
select plan(12);

select ok((select relrowsecurity from pg_class where oid='private.agent_direct_emails'::regclass),
  'The direct email ledger has row level security');
select ok(not bool_or(has_table_privilege(r,'private.agent_direct_emails','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
  or has_any_column_privilege(r,'private.agent_direct_emails','SELECT,INSERT,UPDATE')),
  'No browser, service or server role directly reads or changes email contents')
from unnest(array['anon','authenticated','service_role','hub_app_server']) r;
select ok(has_function_privilege('authenticated','hub.prepare_agent_direct_email(text,text,text,uuid)','EXECUTE')
  and not has_function_privilege('anon','hub.prepare_agent_direct_email(text,text,text,uuid)','EXECUTE'),
  'Only a signed-in owner may request a draft and the function checks their command session');
select ok(not has_function_privilege('authenticated','private.agent_direct_email_begin_send(uuid,integer)','EXECUTE')
  and has_function_privilege('hub_app_server','private.agent_direct_email_begin_send(uuid,integer)','EXECUTE'),
  'Only the Hub server begins delivery');
select ok(not has_function_privilege('authenticated','private.agent_direct_email_finish_send(uuid,integer,text,text)','EXECUTE')
  and has_function_privilege('hub_app_server','private.agent_direct_email_finish_send(uuid,integer,text,text)','EXECUTE'),
  'Only the Hub server settles delivery');
select ok((select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p
  where p.oid='private.agent_direct_email_begin_send(uuid,integer)'::regprocedure),
  'The send reservation is a pinned security definer');
select ok((select position('hub.authorize_app_command()' in pg_get_functiondef(p.oid))>0 from pg_proc p
  where p.oid='hub.prepare_agent_direct_email(text,text,text,uuid)'::regprocedure),
  'The prepare operation requires the owner command session');
select ok((select position('decided_by is null' in pg_get_functiondef(p.oid))>0 from pg_proc p
  where p.oid='private.agent_direct_email_begin_send(uuid,integer)'::regprocedure),
  'An unapproved email is refused at the send boundary');
select throws_ok($$select private.agent_direct_email_begin_send(gen_random_uuid(),1)$$,'42501','Application server required.',
  'A direct database caller cannot send');
select throws_ok($$select private.agent_direct_email_finish_send(gen_random_uuid(),1,'sent',null)$$,'42501','Application server required.',
  'A direct database caller cannot settle an email');
set local role authenticated;
select throws_ok($$select hub.prepare_agent_direct_email('test@example.com','A test subject','A synthetic non-sensitive test message.',gen_random_uuid())$$,
  '28000','Current administrator session required.','A login without the owner command assurance cannot prepare a message');
reset role;
select ok(hub.get_backend_contract()->'features' @> '["platform.agents.direct-email.v1"]'::jsonb,
  'The direct email feature is declared only after its guarded operations');
select * from finish();
rollback;
