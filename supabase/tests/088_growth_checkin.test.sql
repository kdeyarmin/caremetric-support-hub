begin;
select plan(12);

select ok(not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r
                      where has_function_privilege(r, 'private.growth_checkin_due(uuid)', 'execute')),
  'No role may call the check-in rule directly');
select ok(position('growth_checkin_due(o.id) is null' in pg_get_functiondef('private.growth_claim_message(uuid,uuid)'::regprocedure)) > 0
  and position('not v_checkin and v_n>=p.max_touches' in pg_get_functiondef('private.growth_claim_message(uuid,uuid)'::regprocedure)) > 0,
  'The claim sends a check-in only while it is due, and past the touch limit');
select ok(position('checkin_due' in pg_get_functiondef('private.growth_snapshot(integer)'::regprocedure)) > 0
  and has_function_privilege('hub_app_server', 'private.growth_snapshot(integer)', 'execute')
  and not has_function_privilege('authenticated', 'private.growth_claim_message(uuid,uuid)', 'execute'),
  'The snapshot says when a check-in is due, and the grants are unchanged');

-- Fixtures: four prospects with one contact and one Intel opportunity each.
insert into private.growth_organizations (id, name, domain) values
  ('a0880000-0000-4000-8000-000000000001', 'Checkin Alpha', 'checkin-alpha.example'),
  ('a0880000-0000-4000-8000-000000000002', 'Checkin Beta', 'checkin-beta.example'),
  ('a0880000-0000-4000-8000-000000000003', 'Checkin Gamma', 'checkin-gamma.example'),
  ('a0880000-0000-4000-8000-000000000004', 'Checkin Delta', 'checkin-delta.example');
insert into private.growth_contacts (id, organization_id, email, eligibility) select
  ('c0880000-0000-4000-8000-00000000000' || n)::uuid, ('a0880000-0000-4000-8000-00000000000' || n)::uuid, 'owner@checkin-' || x || '.example', 'permitted'
  from (values (1, 'alpha'), (2, 'beta'), (3, 'gamma'), (4, 'delta')) v(n, x);
insert into private.growth_opportunities (id, organization_id, product, contact_id, stage) select
  ('b0880000-0000-4000-8000-00000000000' || n)::uuid, ('a0880000-0000-4000-8000-00000000000' || n)::uuid, 'caremetric-intel',
  ('c0880000-0000-4000-8000-00000000000' || n)::uuid, s
  from (values (1, 'nurture'), (2, 'nurture'), (3, 'contacted'), (4, 'contacted')) v(n, s);
create function pg_temp.sent(p_n integer, p_days integer, p_kind text default 'outreach') returns void language sql as $$
  with w as (insert into private.customer_success_plans (opportunity_id, trigger_key, kind, action, success_criterion, owner_agent, due_at)
             values (('b0880000-0000-4000-8000-00000000000' || p_n)::uuid, p_kind || ':' || p_days || ':' || gen_random_uuid(), p_kind,
                     'Synthetic work.', 'Synthetic outcome.', 'marketing_manager', now()) returning id)
  insert into private.growth_messages (opportunity_id, work_id, contact_id, purpose, subject, body, opportunity_version, contact_version,
                                       policy_version, status, unsubscribe_hash, attempted_at)
  select ('b0880000-0000-4000-8000-00000000000' || p_n)::uuid, w.id, ('c0880000-0000-4000-8000-00000000000' || p_n)::uuid, 'marketing',
         'A question', 'Synthetic body.', 1, 1, 1, 'delivered', repeat('a', 64), now() - make_interval(days => p_days) from w;
$$;
create function pg_temp.replied(p_n integer, p_kind text, p_days integer) returns void language sql as $$
  insert into private.customer_activity_events (product, organization_id, event_key, kind, occurred_at)
  values ('caremetric-intel', ('a0880000-0000-4000-8000-00000000000' || p_n)::uuid, 'checkin-test:' || p_n || ':' || p_kind || ':' || p_days, p_kind,
          now() - make_interval(days => p_days));
$$;
create function pg_temp.due(p_n integer) returns text language sql as $$
  select private.growth_checkin_due(('b0880000-0000-4000-8000-00000000000' || p_n)::uuid);
$$;

-- Alpha said "not now" 100 days ago, after one email 120 days ago.
do $$ begin perform pg_temp.sent(1, 120); perform pg_temp.replied(1, 'not_now', 100); end $$;
select is(pg_temp.due(1), 'not_now', 'A "not now" from 100 days ago is asked again');
do $$ begin perform pg_temp.sent(1, 2, 'checkin'); end $$;
select is(pg_temp.due(1), null, 'Once per "not now"');
-- Beta said "not now", then "no thank you".
do $$ begin perform pg_temp.sent(2, 200); perform pg_temp.replied(2, 'not_now', 180); perform pg_temp.replied(2, 'negative_reply', 150); end $$;
select is(pg_temp.due(2), null, 'A refusal is never asked again');
-- Gamma never answered three touches, the last 100 days ago.
do $$ begin perform pg_temp.sent(3, 140); perform pg_temp.sent(3, 120); perform pg_temp.sent(3, 100); end $$;
select is(pg_temp.due(3), 'no_reply', 'A business that never answered the touches is asked once more');
do $$ begin perform pg_temp.sent(3, 1, 'checkin'); end $$;
select is(pg_temp.due(3), null, 'Only once');
-- Delta never answered, but its last touch was 30 days ago, and it has only had two.
do $$ begin perform pg_temp.sent(4, 60); perform pg_temp.sent(4, 30); end $$;
select is(pg_temp.due(4), null, 'Not while a touch is left, nor within 90 days of the last email');
do $$ begin perform pg_temp.sent(4, 10); end $$;
select is(pg_temp.due(4), null, 'Not within 90 days of the last touch');
update private.growth_messages set attempted_at = attempted_at - interval '90 days' where contact_id = 'c0880000-0000-4000-8000-000000000004';
select is(pg_temp.due(4), 'no_reply', 'Then it is due');
update private.growth_opportunities set owner_agent = 'account_manager' where id = 'b0880000-0000-4000-8000-000000000004';
select is(pg_temp.due(4), null, 'Never for an opportunity the Account Manager owns');

select * from finish();
rollback;
