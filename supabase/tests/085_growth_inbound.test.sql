begin;
select plan(12);

-- Replies are read from the sender's own words, negatives first.
select is(private.growth_reply_kind('Thanks, but we are not really interested.'), 'negative_reply', '"Not really interested" is a no');
select is(private.growth_reply_kind('No longer interested, we are all set.'), 'negative_reply', 'Other ways of saying no are a no');
select is(private.growth_reply_kind('Maybe later this year, too busy right now.'), 'not_now', 'Later is not now');
select is(private.growth_reply_kind('I am interested. Can we book a demo?'), 'positive_reply', 'Interest is a positive reply');
select is(private.growth_reply_kind('Who is this?'), 'reply', 'Anything unclear is a plain reply');
select is(private.growth_reply_text('Sounds good.' || chr(10) || '> Opt out of these emails' || chr(10) || '> unsubscribe'), 'Sounds good.', 'Quoted lines are not read');
select is(private.growth_reply_text('Yes please.' || chr(10) || chr(10) || 'On Tue, Nov 12, 2026 at 9:00 AM Founder wrote:' || chr(10) || 'Would you be interested?'), 'Yes please.', 'Nothing under a reply header is read');
select ok(private.growth_free_mail('gmail.com') and not private.growth_free_mail('valleyhospice.org'), 'Free mail services are told apart from businesses');

-- Only the Hub server captures leads and records the Sales Executive's reading; linking a customer stays inside billing.
select ok(has_function_privilege('hub_app_server', 'private.growth_lead_capture(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.growth_lead_capture(uuid)', 'execute'), 'Only the server captures a lead');
select ok(not has_function_privilege('hub_app_server', 'private.growth_ensure_customer(uuid,text)', 'execute'), 'Linking a customer is internal');
select is((select kind from private.hub_settings where key = 'growth.inbound_followup'), 'flag', 'Following up website leads is a switch');
select ok(hub.get_backend_contract() -> 'features' ? 'platform.agents.growth-inbound.v1', 'The inbound feature is declared');

select * from finish();
rollback;
