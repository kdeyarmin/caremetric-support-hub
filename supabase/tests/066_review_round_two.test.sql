begin;
select plan(7);

-- Bulk email re-checks suppressions at every claim, not only when a campaign is queued.
select ok(position('email_suppressions' in pg_get_functiondef('private.claim_email_batch(integer)'::regprocedure)) > 0,
  'Claiming a bulk email batch checks unsubscribes again');
select ok(has_function_privilege('hub_app_server', 'private.claim_email_batch(integer)', 'execute')
  and not has_function_privilege('authenticated', 'private.claim_email_batch(integer)', 'execute'),
  'Only the Hub server claims bulk email');

-- An Account Manager email nobody approved needs the agent active, with its row held, like every other automatic send.
select ok(pg_get_functiondef('private.agent_lifecycle_begin_send(uuid,integer,text)'::regprocedure) ~ 'from private\.agents where key = v_action\.agent_key for share',
  'The lifecycle send holds the agent row');
select ok(position('v_agent.status is distinct from ''active''' in pg_get_functiondef('private.agent_lifecycle_begin_send(uuid,integer,text)'::regprocedure)) > 0,
  'A paused Account Manager sends nothing on its own');

-- A product's daily growth limit counts the Eastern day, like the cold-email cap.
select ok(position('date_trunc(''day'',now())' in pg_get_functiondef('private.growth_claim_message(uuid,uuid)'::regprocedure)) = 0
  and position('x.attempted_at>=private.agent_day_start()' in pg_get_functiondef('private.growth_claim_message(uuid,uuid)'::regprocedure)) > 0,
  'The per-product daily limit uses the Eastern day');
select is(private.agent_day_start(), (date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York'),
  'The agent day starts at midnight Eastern');
select ok(not has_function_privilege('authenticated', 'private.growth_claim_message(uuid,uuid)', 'execute'),
  'Growth sends stay server-only');

select * from finish();
rollback;
