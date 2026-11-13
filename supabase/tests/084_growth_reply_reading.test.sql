begin;
select plan(30);

-- The reading is pure, closed to every role, and both reply capture and the inbox fallback use it.
select ok((select provolatile = 'i' and not prosecdef from pg_proc where oid = 'private.growth_reply_reading(text)'::regprocedure),
  'The reply reading is pure');
select ok(not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r
                      where has_function_privilege(r, 'private.growth_reply_reading(text)', 'execute')),
  'No role may call the reading directly');
select ok(position('private.growth_reply_reading(v_body)' in pg_get_functiondef('private.growth_inquiry(uuid)'::regprocedure)) > 0
  and position('(v_reading->>''optOut'')::boolean' in pg_get_functiondef('private.growth_inquiry(uuid)'::regprocedure)) > 0,
  'Reply capture reads the sender''s own words');
select ok(position('private.growth_reply_reading(new.body)' in pg_get_functiondef('private.growth_inbound_trigger()'::regprocedure)) > 0,
  'The inbox fallback reads a request to stop as capture does');
select ok(has_function_privilege('hub_app_server', 'private.growth_inquiry(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.growth_inquiry(uuid)', 'execute'),
  'Reply capture keeps its grants');

-- Quoted text and our own footer are not the sender's words.
select is(private.growth_reply_reading(E'Yes, tell me more.\n\nOn Thu, Nov 12, 2026 at 9:14 AM CareMetric <hello@caremetric.ai> wrote:\n> If you are interested, book a demo.\n> Unsubscribe from these emails: https://support.caremetric.ai/api/growth/unsubscribe/abc'),
  '{"kind": "positive_reply", "optOut": false, "sales": false}'::jsonb, 'A reply above the quoted old footer is not a request to stop');
select is(private.growth_reply_reading(E'Thanks for the note.\n\nOn Thu, Nov 12, 2026 at 9:14 AM CareMetric <\nhello@caremetric.ai> wrote:\n\n> If you are interested, book a demo.\n> Opt out of these emails: https://x.example/p/a')->>'kind',
  'reply', 'A quoted "if you are interested" does not make a reply positive, with the attribution wrapped');
select is(private.growth_reply_reading(E'Thanks.\n\nOn Thu, Nov 12, 2026, CareMetric wrote:\n\nIf you are interested, book a demo.\nUnsubscribe from these emails: https://x.example/u/a'),
  '{"kind": "reply", "optOut": false, "sales": false}'::jsonb, 'An unmarked quote under "wrote:" (an HTML-only email) is not read');
select is(private.growth_reply_reading(E'Who are you?\n\n________________________________\nFrom: CareMetric <hello@caremetric.ai>\nSent: Thursday, November 12, 2026 9:14 AM\nSubject: A question\n\nIf you are interested, book a demo.\nUnsubscribe from these emails: https://x.example/u/a'),
  '{"kind": "reply", "optOut": false, "sales": false}'::jsonb, 'An Outlook-style original is not read');
select is(private.growth_reply_reading(E'Sure\n-----Original Message-----\nIf you are interested, remove me.')->>'kind', 'reply', 'Reading stops at "Original Message"');
select is(private.growth_reply_reading(E'Answer one\n\nOn Thu, CareMetric wrote:\n> Which counties?\nAllegheny and Butler.\n> Want a demo?\nYes please, interested.')->>'kind',
  'positive_reply', 'Answers written between quoted lines are read');
select is((private.growth_reply_reading(E'CareMetric\nOpt out of these emails <https://x.example/p/abc>')->>'optOut')::boolean, false,
  'The footer line, with its link reduced to text, is not a request to stop');
select is((private.growth_reply_reading('Contact me at jane@agency.example or https://agency.example/unsubscribe')->>'optOut')::boolean, false,
  'Links and addresses are not read');

-- Refusals, "not now" and interest.
select is(private.growth_reply_reading('Not really interested, thanks.')->>'kind', 'negative_reply', '"Not really interested" is a refusal');
select is(private.growth_reply_reading('No longer interested.')->>'kind', 'negative_reply', '"No longer interested" is a refusal');
select is(private.growth_reply_reading(E'I don’t think we’d be interested.')->>'kind', 'negative_reply', 'A refusal with typographic apostrophes');
select is(private.growth_reply_reading('No, thank you.')->>'kind', 'negative_reply', '"No, thank you" is a refusal');
select is(private.growth_reply_reading('Not a good fit for us right now.')->>'kind', 'negative_reply', '"Not a good fit" is a refusal');
select is(private.growth_reply_reading('Not sure about timing but definitely interested.')->>'kind', 'positive_reply', 'A doubt before "but interested" is interest');
select is(private.growth_reply_reading('Not right now, maybe next quarter.')->>'kind', 'not_now', '"Not right now" is not now');
select is(private.growth_reply_reading('Circle back in January please.')->>'kind', 'not_now', '"Circle back in" is not now');
select is(private.growth_reply_reading('I am interested. Can we book a demo?'), '{"kind": "positive_reply", "optOut": false, "sales": true}'::jsonb,
  'Interest still reads as interest, and as a sales inquiry');

-- Cancellations.
select is(private.growth_reply_reading('I want to cancel my account.')->>'kind', 'cancel_requested', 'A cancellation');
select is(private.growth_reply_reading(E'I need to cancel tomorrow’s call, can we move it?')->>'kind', 'reply', 'Cancelling a call is not cancelling the account');
select is(private.growth_reply_reading('I don''t want to cancel my subscription, just change the card.')->>'kind', 'reply', 'Not cancelling is not a cancellation');

-- Requests to stop.
select is((private.growth_reply_reading('Please opt me out.')->>'optOut')::boolean, true, '"Opt me out" is a request to stop');
select is((private.growth_reply_reading('Take me off your list')->>'optOut')::boolean, true, '"Take me off" is a request to stop');
select is((private.growth_reply_reading('No, thank you. Please remove me from your list.')->>'optOut')::boolean, true, '"Remove me" is still a request to stop');
select is((private.growth_reply_reading(E'I don’t want to unsubscribe, just send less often.')->>'optOut')::boolean, false,
  '"I don''t want to unsubscribe" is not a request to stop');
select is(private.growth_reply_reading(null), '{"kind": "reply", "optOut": false, "sales": false}'::jsonb, 'An empty message is a plain reply');

select * from finish();
rollback;
