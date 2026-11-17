-- Repairs from the review of 2026-11-17's releases (PRs #252 to #271). Three corrections; nothing is sent by this migration.
--
-- 1. The owner's own level for the Account Manager and the Support Concierge. 20261117240000_support_truth.sql and
--    20261117245000_trial_emails_auto_send.sql added the acknowledgment and the trial path's three emails to an automatic step's list
--    through private.agent_autonomy_change, which also sets the agent to Act (it is the step's own switch, written for
--    private.agent_autonomy_apply). An owner who had set the agent to Propose or Observe on the AI team page after handing the step
--    over had that choice replaced, silently: with the Account emails step automatic, every listed customer email then went out without
--    their approval. Where the audit trail shows the owner chose a lower level and nothing audited has raised it since, that level is
--    restored (private.agent_autonomy_owner_level) and the restoration is audited as an `agent.autonomy` event with no actor. The new
--    values stay on the lists: on an agent that does not act they send nothing, and they are there when the owner sets it to Act again.
--    A database that applies those two migrations now ends the same way, because this one runs after them. A migration that extends an
--    automatic step's list from now on adds the values to the agent's config itself and never calls private.agent_autonomy_change.
-- 2. An acknowledgment is not an answer, for quiet follow-ups too. private.growth_quiet_candidates took any sent outbound message after
--    the prospect's reply as our answer, so a prospect who got only the fixed "we have your request and will reply here" (the Sales
--    Executive's or the Concierge's template, private.agent_growth_acknowledgment) was sent "following up on our answer" four days later,
--    still waiting for the answer. It is the same as in 20261117190000_growth_priority.sql (same signature and grants) except for that.
-- 3. When each Intel trial live at the trial path's release first had its card confirmed. 20261117230000_trial_path.sql copied
--    private.billing_trial_cards.confirmed_at, which every confirming entitlement check rewrites, so those trials were counted from the last
--    check before the release, not from their card: their customer emails (setup help, the mid-trial email) were scheduled days late.
--    Only the rows that backfill wrote are corrected (written by the transaction that created the table, so a card first confirmed since
--    keeps its own time), to the trial's start, as the billing mirror counted those trials and as the emails were timed before: Intel
--    opens a trial when the card is set up, so its card cannot have been confirmed earlier. Counted in the audit trail, no identifier.
set local lock_timeout = '10s';

-- ---- 1. The owner's own level ---------------------------------------------------------------------------------------------------------

-- The level the audit trail gives an agent: the owner's latest choice on the AI team page (hub.set_agent_autonomy, `agent.autonomy` with
-- an actor), carried through every autonomy step change audited since for a step that names the agent (private.agent_autonomy_apply:
-- 'automatic' sets Act; 'supervised' and 'held' move Observe up to Propose). Null when the owner never chose a level. Closed to every role:
-- this migration and pgTAP read it as the database's owner.
create or replace function private.agent_autonomy_owner_level(p_agent text) returns text
language plpgsql stable set search_path = '' as $$
declare v_level text; v_at timestamptz; v_id bigint; v_status text; begin
 select e.metadata ->> 'to', e.created_at, e.id into v_level, v_at, v_id
   from private.audit_events e
  where e.action = 'agent.autonomy' and e.entity_type = 'agent' and e.actor_id is not null
    and e.metadata ->> 'agent' = p_agent and e.metadata ->> 'to' in ('observe', 'propose', 'act')
  order by e.created_at desc, e.id desc limit 1;
 if v_level is null then return null; end if;
 for v_status in
  select e.metadata ->> 'to' from private.audit_events e
   where e.action = 'agent.autonomy_step' and (e.created_at, e.id) > (v_at, v_id)
     and exists (select 1 from private.agent_autonomy_steps s cross join lateral jsonb_array_elements(s.changes) c
                  where s.category = e.metadata ->> 'category' and c ->> 'agent' = p_agent)
   order by e.created_at, e.id
 loop
  if v_status = 'automatic' then v_level := 'act';
  elsif v_status in ('supervised', 'held') and v_level = 'observe' then v_level := 'propose';
  end if;
 end loop;
 return v_level;
end; $$;
revoke all on function private.agent_autonomy_owner_level(text) from public, anon, authenticated, service_role, hub_app_server;

-- The two agents those migrations set to Act: back to the owner's level where it is lower. An agent the owner never set, one whose level
-- the trail explains, and one the owner has changed since all stay as they are.
do $$
declare v_agent text; v_level text;
begin
  foreach v_agent in array array['account_manager', 'support_concierge'] loop
    perform 1 from private.agents where key = v_agent for update;
    v_level := private.agent_autonomy_owner_level(v_agent);
    if v_level is null or v_level = 'act' then continue; end if;
    update private.agents set autonomy = v_level, updated_at = now() where key = v_agent and autonomy = 'act';
    if found then
      insert into private.audit_events (actor_id, action, entity_type, metadata)
      values (null, 'agent.autonomy', 'agent', jsonb_build_object('agent', v_agent, 'from', 'act', 'to', v_level, 'reason', 'owner_choice_restored'));
    end if;
  end loop;
end $$;

-- ---- 2. An acknowledgment is not an answer ------------------------------------------------------------------------------------------

-- Server: prospects whose latest word was a reply with interest or a question, which we answered by email, and who have not written since:
-- step 1 four days after our answer, step 2 five days after step 1's email. A later reply, a no, a "not now", a meeting, a trial, an
-- opt-out or a complaint ends it (the send claim checks again before each email). The fixed acknowledgment is not an answer
-- (20261117260000_review_repairs.sql).
create or replace function private.growth_quiet_candidates(p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 perform private.require_hub_app_server();
 if p_limit is null or p_limit < 1 or p_limit > 50 then raise exception 'List between 1 and 50 prospects.' using errcode = '22023'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('opportunityId', x.id, 'product', x.product, 'step', x.step, 'eventId', x.event_id,
     'repliedAt', x.replied_at, 'answeredAt', x.answered_at, 'key', 'quiet:' || x.event_id::text || ':' || x.step) order by x.answered_at, x.id)
   from (
    select o.id, o.product, r.id as event_id, r.occurred_at as replied_at, a.answered_at, q.sent + 1 as step
    from private.growth_opportunities o
    join private.growth_organizations g on g.id = o.organization_id
    join private.growth_contacts c on c.id = o.contact_id
    cross join lateral (select e.id, e.kind, e.occurred_at, e.facts from private.customer_activity_events e
      where e.organization_id = o.organization_id and e.product = o.product
        and e.kind in ('reply', 'positive_reply', 'negative_reply', 'not_now', 'meeting_booked', 'trial_started', 'signup', 'paid')
      order by e.occurred_at desc, e.id desc limit 1) r
    cross join lateral (select max(cm.created_at) as answered_at from private.communication_messages cm
      where cm.communication_id::text = r.facts ->> 'communicationId' and cm.direction = 'outbound' and cm.delivery = 'sent'
        and not private.agent_growth_acknowledgment(cm.request_key)
        and cm.created_at > r.occurred_at) a
    cross join lateral (select count(*) filter (where m.attempted_at is not null) as sent, max(m.attempted_at) as last,
        count(*) filter (where m.attempted_at is null and m.status in ('draft', 'proposed', 'sending', 'unknown')) as waiting
      from private.growth_messages m join private.customer_success_plans w on w.id = m.work_id
      where w.opportunity_id = o.id and w.trigger_key like 'quiet:' || r.id::text || ':%') q
    where o.owner_agent = 'marketing_manager' and o.stage = 'engaged' and o.product in ('carebase', 'caremetric-intel')
      and r.kind in ('reply', 'positive_reply') and a.answered_at is not null
      and not g.internal and g.tenant_id is null and c.eligibility = 'permitted'
      and not private.growth_outreach_stopped(o.organization_id)
      and not exists (select 1 from private.communication_messages cm where cm.communication_id::text = r.facts ->> 'communicationId'
        and cm.direction = 'inbound' and cm.created_at > a.answered_at)
      and q.waiting = 0 and q.sent < 2
      and ((q.sent = 0 and a.answered_at <= now() - interval '4 days') or (q.sent = 1 and q.last <= now() - interval '5 days'))
    order by a.answered_at, o.id limit p_limit) x), '[]'::jsonb);
end; $$;
revoke all on function private.growth_quiet_candidates(integer) from public, anon, authenticated, service_role;
grant execute on function private.growth_quiet_candidates(integer) to hub_app_server;

-- ---- 3. When each live trial's card was first confirmed -------------------------------------------------------------------------------

-- The backfill's rows were written by the transaction that created the table (its pg_class row was written by it too, and nothing has
-- altered the table since); a card the trigger recorded later has its own transaction. Once corrected, a row is no longer the backfill's,
-- so this runs once. A database whose table was created and filled apart corrects nothing.
with fixed as (
  update private.growth_trial_cards g set first_confirmed_at = s.trial_start
    from private.billing_subscriptions s
   where s.stripe_subscription_id = g.stripe_subscription_id and s.trial_start is not null and g.first_confirmed_at > s.trial_start
     and g.xmin = (select c.xmin from pg_catalog.pg_class c where c.oid = 'private.growth_trial_cards'::regclass)
  returning g.stripe_subscription_id
)
insert into private.audit_events (actor_id, action, entity_type, entity_id, metadata)
select null, 'growth.trial_cards_corrected', 'growth', null, jsonb_build_object('trials', count(*), 'reason', 'first_confirmation_backfill')
from fixed having count(*) > 0;
