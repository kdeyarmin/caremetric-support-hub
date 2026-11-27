begin;
select plan(5);

-- The AI team builds the owner's next batch (20261127220000_owner_sequence_batches.sql).
select ok((hub.get_backend_contract() -> 'features') ? 'platform.agents.owner-sequence-batches.v1', 'The owner sequence batches feature is declared');
select is((select count(*)::int from private.hub_settings where key in ('growth.owner_sequence_batches', 'growth.owner_sequence_batch_size', 'growth.owner_sequence_batch_approve')), 3,
  'The three batch settings exist');
select ok(has_function_privilege('hub_app_server', 'private.owner_sequence_batch_plan(integer)', 'execute')
  and has_function_privilege('hub_app_server', 'private.owner_sequence_batch_queue(jsonb)', 'execute'), 'The Hub server plans and queues batches');
select ok(not has_function_privilege('authenticated', 'private.owner_sequence_batch_queue(jsonb)', 'execute')
  and not has_function_privilege('hub_app_server', 'private.owner_sequence_batch_candidates(integer)', 'execute'), 'Nobody else can, nor read the candidates directly');
select is(private.owner_sequence_batch_due() ->> 'why', 'off', 'With the setting off, no batch is due');

select * from finish();
rollback;
