-- Declares platform.agents.first-replies.v1 once the Nov 24 follow-up is in place (20261124150000_first_replies.sql,
-- 20261124151000_first_replies_concierge.sql; server/growth/first-replies.mjs): Strict holds a shared address until it is confirmed and
-- sends one that can never be to review through functions no role but the Hub server's holds may run; the send claim refuses a cold email
-- that would come too soon while the day's emails are spread over the hours, and its deferral waits for that moment; the spread switch has
-- a row; and a support message takes its sender's one product through a function executable by no role, which the Concierge's snapshot
-- also reports. Each test fails closed.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.first-replies.v1';
  internal_fns constant text[] := array['private.growth_hold_for(uuid,text)', 'private.growth_contact_to_review(uuid,text)', 'private.growth_hold_settle(uuid,text)',
    'private.growth_cold_pace_at()', 'private.communication_sender_product(text)'];
  server_fns constant text[] := array['private.growth_send_hold(uuid)', 'private.growth_draft_hold(uuid)', 'private.growth_mailbox_record(uuid,text)',
    'private.growth_defer_action(uuid,integer,text)'];
  claim text;
  fn text;
  r text;
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.growth-address-check.v1","platform.agents.growth-priority.v1","platform.agents.support-truth.v1","platform.settings.v1"]}'::jsonb) is not true then
    raise exception 'Apply the address check, growth priority, support answers and settings migrations first' using errcode = '55000';
  end if;
  foreach fn in array internal_fns loop
    if to_regprocedure(fn) is null then raise exception '% is missing', fn using errcode = '55000'; end if;
    foreach r in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
      if has_function_privilege(r, fn, 'execute') then raise exception '% must stay internal', fn using errcode = '55000'; end if;
    end loop;
  end loop;
  foreach fn in array server_fns loop
    if not has_function_privilege('hub_app_server', fn, 'execute')
       or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) x where has_function_privilege(x, fn, 'execute'))
       or position('private.require_hub_app_server()' in pg_get_functiondef(fn::regprocedure)) = 0 then
      raise exception '% must be the Hub server''s alone', fn using errcode = '55000';
    end if;
  end loop;
  if position('''address_unconfirmed''' in pg_get_functiondef('private.growth_hold_for(uuid,text)'::regprocedure)) = 0
     or position('''role_address''' in pg_get_functiondef('private.growth_hold_for(uuid,text)'::regprocedure)) = 0
     or position('growth_hold_settle' in pg_get_functiondef('private.growth_send_hold(uuid)'::regprocedure)) = 0
     or position('growth_hold_settle' in pg_get_functiondef('private.growth_draft_hold(uuid)'::regprocedure)) = 0
     or position('private.growth_bounce_guard_latch()' in pg_get_functiondef('private.growth_send_hold(uuid)'::regprocedure)) = 0
     or position('growth_contact_to_review' in pg_get_functiondef('private.growth_mailbox_record(uuid,text)'::regprocedure)) = 0
     or position('undeliverable' in pg_get_functiondef('private.growth_mailbox_record(uuid,text)'::regprocedure)) = 0
     or position('people_searched_at = null' in pg_get_functiondef('private.growth_contact_to_review(uuid,text)'::regprocedure)) = 0 then
    raise exception 'Strict must hold a shared address until it is confirmed, and send one that never can be to review' using errcode = '55000';
  end if;
  if not exists (select 1 from private.hub_settings where key = 'growth.send_spread' and kind = 'flag') then
    raise exception 'The spread switch is missing' using errcode = '55000';
  end if;
  claim := pg_get_functiondef('private.growth_claim_message(uuid,uuid)'::regprocedure);
  if position('private.growth_cold_pace_at()>now()' in claim) = 0 or position('''paced''' in claim) = 0
     or position('outside_hours' in claim) = 0 or position('c.eligibility<>''permitted''' in claim) = 0
     or position('''paced''' in pg_get_functiondef('private.growth_defer_action(uuid,integer,text)'::regprocedure)) = 0
     or position('growth_cold_pace_at' in pg_get_functiondef('private.growth_defer_action(uuid,integer,text)'::regprocedure)) = 0
     or position('growth_org_zone' in pg_get_functiondef('private.growth_defer_action(uuid,integer,text)'::regprocedure)) = 0 then
    raise exception 'The send claim must refuse a cold email that would come too soon, and its deferral wait for the pace' using errcode = '55000';
  end if;
  if not coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p
                    where p.oid = 'private.communication_sender_product(text)'::regprocedure), false)
     or position('communication_sender_product(v_email)' in pg_get_functiondef('private.ingest_inbound_communication(text,text,text,bigint,text,text,text,text,text,text)'::regprocedure)) = 0
     or position('''senderProduct''' in pg_get_functiondef('private.agent_communication_snapshot(uuid,uuid,integer,integer)'::regprocedure)) = 0 then
    raise exception 'A support message must take its sender''s one product, and the Concierge''s snapshot report it' using errcode = '55000';
  end if;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(r, 'private.agent_communication_snapshot(uuid,uuid,integer,integer)', 'execute') then
      raise exception 'The Concierge''s snapshot must stay the server''s' using errcode = '55000';
    end if;
  end loop;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
