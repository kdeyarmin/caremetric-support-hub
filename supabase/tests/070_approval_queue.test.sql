begin;
select plan(2);

select ok(
  position('limit 200' in pg_get_functiondef('hub.get_agent_team()'::regprocedure)) > 0,
  'the approval queue loads enough proposals to page through'
);

select ok(
  position('limit 50' in pg_get_functiondef('hub.get_agent_team()'::regprocedure)) = 0,
  'open proposals are no longer cut off at the first 50'
);

select * from finish();
rollback;
