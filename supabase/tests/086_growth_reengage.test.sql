begin;
select plan(8);

select is(private.growth_message_class('marketing_manager', 'marketing', 'enriched'), 'growth.cold_email', 'A contact-data address is cold email');
select is(private.growth_message_class('marketing_manager', 'marketing', 'imported'), 'growth.cold_email', 'An imported address is cold email');
select is(private.growth_message_class('marketing_manager', 'marketing', 'inbound'), 'growth.sales_followup', 'A person who asked is a follow-up');
select is(private.growth_recontact_days(), 90, 'The re-ask waits ninety days until the owner saves a number');
update private.hub_settings set value = '10' where key = 'growth.recontact_days';
select is(private.growth_recontact_days(), 30, 'The wait is never shorter than thirty days');
select ok(position('e.kind in (''negative_reply'',''meeting_booked'',''trial_started'',''signup'')' in pg_get_functiondef('private.growth_claim_message(uuid,uuid)'::regprocedure)) > 0,
  'A no, a meeting, a trial or a sign-up stops outreach whenever it happened');
select ok(not has_function_privilege('authenticated', 'private.growth_reengage(integer)', 'execute'), 'Only the server re-asks');
select ok(hub.get_backend_contract() -> 'features' ? 'platform.agents.growth-reengage.v1', 'The re-ask feature is declared');

select * from finish();
rollback;
