begin;
select plan(3);

-- The owner's sequences and the Marketing Manager's cold email keep out of each other's way (20261127210000_owner_sequence_guard.sql).
select ok((hub.get_backend_contract() -> 'features') ? 'platform.agents.owner-sequence-guard.v1', 'The owner sequence guard is declared');
select ok(position('owner_sequence_recipients' in pg_get_functiondef('private.growth_outreach_stopped(uuid)'::regprocedure)) > 0,
  'The Marketing Manager''s cold email leaves a sequence''s agency alone');
select ok(position('growth_roster_targets' in pg_get_functiondef('private.owner_sequence_check_people(jsonb)'::regprocedure)) > 0,
  'A sequence leaves out an agency the Marketing Manager emailed, by its CCN too');

select * from finish();
rollback;
