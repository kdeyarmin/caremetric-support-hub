begin;
select plan(11);

-- The outgoing email review of 2026-11-17 (20261117220000_email_review.sql).
select ok(has_function_privilege('hub_app_server', 'private.growth_withdraw_message(uuid,text)', 'execute')
  and not has_function_privilege('authenticated', 'private.growth_withdraw_message(uuid,text)', 'execute')
  and not has_function_privilege('service_role', 'private.growth_withdraw_message(uuid,text)', 'execute')
  and not has_function_privilege('anon', 'private.growth_withdraw_message(uuid,text)', 'execute'),
  'Only the server withdraws a claimed growth email');
select ok(position('''quiet''' in pg_get_functiondef('private.growth_claim_message(uuid,uuid)'::regprocedure)) > 0,
  'The send claim says which email is a quiet follow-up, so it is signed by the founder');
select ok(has_function_privilege('hub_app_server', 'private.agent_communication_snapshot(uuid,uuid,integer,integer)', 'execute')
  and not has_function_privilege('authenticated', 'private.agent_communication_snapshot(uuid,uuid,integer,integer)', 'execute'),
  'The Concierge''s snapshot stays the server''s');

-- Stub only the session-user guard (as 103 and 114 do); the rollback restores it.
create or replace function private.require_hub_app_server() returns void language plpgsql stable set search_path = '' as $$ begin return; end; $$;
select throws_ok($$ select private.growth_withdraw_message(gen_random_uuid(), 'Not a code') $$, '22023', 'Name why the email is withdrawn.',
  'A withdrawal names its reason as a short code');
select is(private.growth_withdraw_message(gen_random_uuid(), 'trial_terms'), false, 'Only a claimed email that never reached the provider is withdrawn');

-- Who wrote, as flags only. The support sender is the default (support@caremetric.ai) unless Settings says otherwise.
create temporary table review_conversations (label text primary key, id uuid) on commit drop;
with seeded as (
  insert into private.communications (channel, source_system, source_key, subject, contact_email)
  values ('email', 'hub.email', 'review-machine', 'Your G2 Bi-Weekly Digest', 'noreply@g2.example'),
         ('email', 'hub.email', 'review-vendor-noreply', 'Secondary Auth Token Promoted', 'microsoft-noreply@vendor.example'),
         ('email', 'hub.email', 'review-ours', 'Welcome to CareMetric Intel', 'Support@CareMetric.ai'),
         ('email', 'hub.email', 'review-internal', 'A note from a colleague', 'kevin@caremetric.ai'),
         ('email', 'hub.email', 'review-customer', 'How do I export the roster?', 'pat@agency.example')
  returning id, source_key)
insert into review_conversations select source_key, id from seeded;
select is(private.agent_communication_snapshot((select id from review_conversations where label = 'review-machine'), null, 0, 1000) -> 'sender',
  '{"machine": true, "ours": false, "internal": false, "answersOurEmail": false}'::jsonb, 'A noreply sender is a machine');
select is(private.agent_communication_snapshot((select id from review_conversations where label = 'review-vendor-noreply'), null, 0, 1000) #>> '{sender,machine}',
  'true', 'So is a sender whose address ends in -noreply');
select is(private.agent_communication_snapshot((select id from review_conversations where label = 'review-ours'), null, 0, 1000) -> 'sender',
  '{"machine": false, "ours": true, "internal": true, "answersOurEmail": false}'::jsonb, 'The Hub''s own support sender is ours, whatever its case');
select is(private.agent_communication_snapshot((select id from review_conversations where label = 'review-internal'), null, 0, 1000) -> 'sender',
  '{"machine": false, "ours": false, "internal": true, "answersOurEmail": false}'::jsonb, 'Another address on our own domain is internal');
select is(private.agent_communication_snapshot((select id from review_conversations where label = 'review-customer'), null, 0, 1000) -> 'sender',
  '{"machine": false, "ours": false, "internal": false, "answersOurEmail": false}'::jsonb, 'A customer is none of them');
select ok(position('agency.example' in private.agent_communication_snapshot((select id from review_conversations where label = 'review-customer'), null, 0, 1000)::text) = 0,
  'The snapshot still never carries the address itself');

select * from finish();
rollback;
