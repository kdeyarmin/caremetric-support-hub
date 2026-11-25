-- The first-email settings and the hold on a reader score under 4 (20261125180000_outreach_intelligence.sql).
select is((select kind from private.hub_settings where key = 'growth.email_one_fact'), 'flag', 'One agency fact is a switch');
select is((select kind from private.hub_settings where key = 'growth.email_one_offer'), 'flag', 'The first-email offer is a switch');
select is((select kind from private.hub_settings where key = 'growth.booking_url'), 'text', 'The walkthrough link is text');
select ok(position('hold_review' in pg_get_functiondef('private.growth_propose(uuid,uuid)'::regprocedure)) > 0,
  'A reader score under 4 is not approved on its own');
select ok((hub.get_backend_contract() -> 'features') ? 'platform.agents.outreach-intelligence.v1',
  'The outreach intelligence feature is declared');
