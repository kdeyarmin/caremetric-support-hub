begin;
select plan(3);

-- No agency is off limits; smaller organizations first (20261127240000_owner_sequence_open.sql).
select ok((hub.get_backend_contract() -> 'features') ? 'platform.agents.owner-sequence-open.v1', 'The open screening is declared');
select ok(position('''Proprietary''' in pg_get_functiondef('private.owner_sequence_batch_candidates(integer)'::regprocedure)) = 0
  and position('''Proprietary''' in pg_get_functiondef('private.growth_hunter_next(integer)'::regprocedure)) = 0, 'Neither the batch nor Hunter leaves an agency out for its owners');
select ok(position('''42021''' in pg_get_functiondef('private.owner_sequence_batch_candidates(integer)'::regprocedure)) > 0, 'The owner''s home area is still left out');

select * from finish();
rollback;
