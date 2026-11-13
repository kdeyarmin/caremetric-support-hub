begin;
select plan(10);

-- Main's own reply reading and trial link (20261113150000, 20261113170000) stay what capture and billing run.
select ok(position('private.growth_reply_reading(v_body)' in pg_get_functiondef('private.growth_inquiry(uuid)'::regprocedure)) > 0,
  'Replies are still read from the sender''s own words');
select ok(position('growth.customer_linked' in pg_get_functiondef('private.growth_ensure_customer(uuid,text)'::regprocedure)) > 0,
  'A trial still finds the prospect it was');
select ok(private.growth_free_mail('gmail.com') and not private.growth_free_mail('valleyhospice.org'), 'Free mail services are told apart from businesses');

-- Only the Hub server captures leads and records the Sales Executive's reading; linking a customer stays inside billing.
select ok(has_function_privilege('hub_app_server', 'private.growth_lead_capture(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.growth_lead_capture(uuid)', 'execute'), 'Only the server captures a lead');
select ok(has_function_privilege('hub_app_server', 'private.growth_reply_disposition(uuid,text,text)', 'execute')
  and not has_function_privilege('authenticated', 'private.growth_reply_disposition(uuid,text,text)', 'execute'), 'Only the server records the Sales Executive''s reading');
select throws_ok($$select private.growth_reply_disposition(gen_random_uuid(), 'interested')$$, '42501', null, 'It is refused to anyone else');
select ok(not has_function_privilege('hub_app_server', 'private.growth_ensure_customer(uuid,text)', 'execute'), 'Linking a customer is internal');
select ok(exists (select 1 from pg_constraint where conrelid = 'private.growth_contacts'::regclass and conname = 'growth_contacts_source_kind_check'
  and pg_get_constraintdef(oid) like '%inbound%' and pg_get_constraintdef(oid) like '%imported%'), 'Contacts record where they came from');
select is((select kind from private.hub_settings where key = 'growth.inbound_followup'), 'flag', 'Following up website leads is a switch');
select ok(hub.get_backend_contract() -> 'features' ? 'platform.agents.growth-inbound.v1', 'The inbound feature is declared');

select * from finish();
rollback;
