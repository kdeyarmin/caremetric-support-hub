-- The Nov 24 follow-up (20261124150000_first_replies.sql, 20261124159000_first_replies_contract.sql): Strict's hold and its settling are
-- internal, the holds, the mailbox record and the deferral are the Hub server's, the spread switch has a row, and the pace is the day's
-- last cold email plus the send hours divided by the day's number, only with the switch on and both hours set.
begin;
select plan(13);

select ok(hub.get_backend_contract() -> 'features' @> '["platform.agents.first-replies.v1"]'::jsonb, 'The contract declares platform.agents.first-replies.v1');
select ok(exists (select 1 from private.hub_settings where key = 'growth.send_spread' and kind = 'flag'), 'The spread switch has a row');
select ok(not has_function_privilege(r, f, 'execute'), f || ' is closed to ' || r)
  from unnest(array['private.growth_contact_to_review(uuid,text)', 'private.growth_hold_settle(uuid,text)', 'private.growth_cold_pace_at()']) f,
       unnest(array['authenticated', 'hub_app_server']) r;
select ok(has_function_privilege('hub_app_server', 'private.growth_send_hold(uuid)', 'execute')
  and has_function_privilege('hub_app_server', 'private.growth_draft_hold(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.growth_send_hold(uuid)', 'execute'), 'Only the Hub server asks for the holds');
select throws_ok($$select private.growth_send_hold(gen_random_uuid())$$, '42501', 'Application server required.', 'The send hold is the Hub server''s alone');

-- The pace: nothing while the switch is off or the hours are not both set.
update private.hub_settings set value = null where key in ('growth.send_spread', 'growth.send_from_hour', 'growth.send_until_hour', 'growth.cold_email_daily_cap');
select is(private.growth_cold_pace_at(), null, 'Off: no cold email waits for the pace');
update private.hub_settings set value = 'true'::jsonb where key = 'growth.send_spread';
select is(private.growth_cold_pace_at(), null, 'Without send hours: no cold email waits for the pace');

select ok(position('''paced''' in pg_get_functiondef('private.growth_claim_message(uuid,uuid)'::regprocedure)) > 0,
  'The send claim refuses a cold email that would come too soon');

select * from finish();
rollback;
