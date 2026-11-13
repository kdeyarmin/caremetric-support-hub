-- Run after the new migration on an isolated test database.
begin;
select plan(12);

insert into private.growth_organizations(id,name,domain)
values ('d0000000-0000-4000-8000-000000000001','SES regression','ses-regression.example.test');
insert into private.growth_contacts(id,organization_id,email,eligibility)
values ('d0000000-0000-4000-8000-000000000002','d0000000-0000-4000-8000-000000000001','ses-regression@example.test','permitted');
insert into private.growth_opportunities(id,organization_id,contact_id,product)
values ('d0000000-0000-4000-8000-000000000003','d0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000002','carebase');
insert into private.growth_messages(id,opportunity_id,contact_id,purpose,subject,body,opportunity_version,contact_version,policy_version,status,unsubscribe_hash)
values ('d0000000-0000-4000-8000-000000000004','d0000000-0000-4000-8000-000000000003','d0000000-0000-4000-8000-000000000002','success','Fixture','Fixture',1,1,1,'accepted','ses-regression');

select ok(has_function_privilege('hub_app_server','private.growth_delivery_event(text,uuid,text,timestamptz,boolean)','execute'),'Server can record the event');
select ok(not has_function_privilege('authenticated','private.growth_delivery_event(text,uuid,text,timestamptz,boolean)','execute'),'Browser cannot record the event');
select throws_ok($$select private.growth_delivery_event('ses:unauthorized','d0000000-0000-4000-8000-000000000004','bounced',now(),false)$$,'42501','Application server required.','Session-user boundary remains enforced');
select throws_ok($$select private.growth_delivery_event('sg:unauthorized','d0000000-0000-4000-8000-000000000004','bounced',now())$$,'42501','Application server required.','Legacy wrapper also enforces the session-user boundary');

-- Supabase's postgres test login is not a superuser and cannot SET SESSION
-- AUTHORIZATION to hub_app_server. After checking the real boundary above,
-- stub only that guard for the behavioral assertions in this transaction.
-- ROLLBACK restores the original guard along with all synthetic fixture data.
create or replace function private.require_hub_app_server() returns void
language plpgsql stable set search_path='' as $$ begin return; end; $$;

select private.growth_delivery_event('ses:soft-regression','d0000000-0000-4000-8000-000000000004','bounced',now(),false);
select private.growth_delivery_event('ses:soft-regression','d0000000-0000-4000-8000-000000000004','bounced',now(),false);
select is((select status from private.growth_messages where id='d0000000-0000-4000-8000-000000000004'),'bounced','Soft bounce is terminal');
select is((select count(*)::integer from private.growth_delivery_events where event_id='ses:soft-regression'),1,'SNS replay is counted once');
select is((select kind from private.growth_delivery_events where event_id='ses:soft-regression'),'bounced','Scorecard uses the existing bounce category');
select is((select eligibility from private.growth_contacts where id='d0000000-0000-4000-8000-000000000002'),'permitted','Soft bounce is not an opt-out');
select is((select count(*)::integer from private.email_suppressions where email_hash=encode(extensions.digest('ses-regression@example.test','sha256'),'hex')),0,'Soft bounce does not suppress');

select private.growth_delivery_event('sg:legacy-regression','d0000000-0000-4000-8000-000000000004','bounced',now());
select is((select eligibility from private.growth_contacts where id='d0000000-0000-4000-8000-000000000002'),'opted_out','Legacy SendGrid/permanent bounce still opts out');
select is((select count(*)::integer from private.email_suppressions where email_hash=encode(extensions.digest('ses-regression@example.test','sha256'),'hex')),1,'Legacy bounce still suppresses');

update private.growth_contacts set eligibility='permitted' where id='d0000000-0000-4000-8000-000000000002';
select private.growth_delivery_event('ses:complaint-regression','d0000000-0000-4000-8000-000000000004','complaint',now(),false);
select is((select eligibility from private.growth_contacts where id='d0000000-0000-4000-8000-000000000002'),'opted_out','A false flag cannot bypass complaint suppression');
select * from finish();
rollback;
