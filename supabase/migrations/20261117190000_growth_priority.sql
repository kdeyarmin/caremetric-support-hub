-- Growth priority (AI workforce review 2026-11-17, stage 2; docs/AI_WORKFORCE_REVIEW_2026-11-17.md): the day's ten cold emails go to
-- the best prospects first and inside the owner's hours, and interest is acted on. Every new behaviour has a switch in Settings ->
-- Customer growth that starts off (or empty); the brief rule is a plain fix.
--
-- 1. Settings: "Send to the best prospects first" (growth.send_priority), "Send cold email from this hour" / "until this hour"
--    (growth.send_from_hour, growth.send_until_hour), "Test a short first email" (growth.short_first_email), "Follow up when a prospect
--    who replied goes quiet" (growth.quiet_followup), "Give the Sales Executive the account brief" (growth.sales_context).
-- 2. Send priority. Which approved email went first was decided by the action's age and drafting read the pipeline by id, so the ten a
--    day went to whoever was approved first. With the switch on, private.agent_actions_ready orders growth emails (after every other
--    kind of action, which keeps its old order) by band, fit and waiting time (private.growth_action_score; waiting adds at most what
--    three bands are worth, so nothing waits forever), and the pipeline snapshot is read band by band. Bands
--    (private.growth_priority_band): 1 a follow-up to an agency that opened its report, 2 a first email with an account brief to a named
--    person whose mailbox was confirmed, 3 a first email with a brief, 4 the rest. A capped email waits for the next Eastern day instead
--    of being tried every 15 minutes (90 tries a day each).
-- 3. A report opened for the first time brings the second email forward to the policy's own gap after the first (switch of 2).
-- 4. Send hours. The send claim refuses a cold email outside the owner's Eastern weekday hours ('outside_hours'), and the email waits for
--    the next opening (private.growth_next_send_at). The claim returns it only once the owner sets the hours, after the server that
--    defers it is deployed. Replies and customer emails are never held.
-- 5. Account briefs only for an agency whose contact is permitted: ten of the 22 written by 2026-11-16 were for agencies with no address.
-- 6. private.growth_quiet_candidates: prospects who replied with interest or a question, were answered, and have been quiet since (step 1
--    four days after the answer, step 2 five days after step 1), for "Follow up when a prospect who replied goes quiet".
-- 7. The weekly memo's facts (private.growth_learning_facts) count, per arm, the emails that linked the agency's own report and how many
--    of those agencies opened it, and the reader's weakness codes, so arms can be compared on opens until there are replies.
-- 8. private.sales_growth_context: the account brief's writer part, the email that was answered and whether the report was opened, for
--    "Give the Sales Executive the account brief".
--
-- Nothing is sent by this migration. 20261117190100_growth_priority_contract.sql declares platform.agents.growth-priority.v1.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values
  ('growth.send_priority', 'flag'), ('growth.send_from_hour', 'number'), ('growth.send_until_hour', 'number'),
  ('growth.short_first_email', 'flag'), ('growth.quiet_followup', 'flag'), ('growth.sales_context', 'flag')
on conflict (key) do nothing;

-- ---- Send priority ---------------------------------------------------------------------------------------------------------------------

create or replace function private.growth_send_priority_on() returns boolean
language sql stable set search_path = '' as $$
  select coalesce((select s.value = 'true'::jsonb from private.hub_settings s where s.key = 'growth.send_priority'), false);
$$;
revoke all on function private.growth_send_priority_on() from public, anon, authenticated, service_role;

-- 1 a follow-up to an agency that opened its report; 2 a first email with a brief to a named person whose mailbox was confirmed; 3 a first
-- email with a brief; 4 the rest.
create or replace function private.growth_priority_band(p_opportunity uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select case
    when t.touches > 0 and o.memory ? 'reportViewedAt' then 1
    when t.touches = 0 and b.briefed and c.source_kind <> 'role_address' and coalesce(btrim(c.name), '') <> '' and c.mailbox_result = 'verified' then 2
    when t.touches = 0 and b.briefed then 3
    else 4 end
  from private.growth_opportunities o
  left join private.growth_contacts c on c.id = o.contact_id
  cross join lateral (select count(*) as touches from private.growth_messages m
    where m.opportunity_id = o.id and m.purpose = 'marketing' and m.attempted_at is not null and m.primary_message_id is null) t
  cross join lateral (select exists (select 1 from private.growth_briefs x where x.opportunity_id = o.id) as briefed) b
  where o.id = p_opportunity;
$$;
revoke all on function private.growth_priority_band(uuid) from public, anon, authenticated, service_role;

-- An approved growth email's place in the queue: its band (1000 a band), its fit (0 to 100) and ten an hour waiting, at most 3000.
create or replace function private.growth_action_score(p_action uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select ((5 - coalesce(private.growth_priority_band(m.opportunity_id), 4)) * 1000 + coalesce(o.fit, 0)
    + least(floor(extract(epoch from (now() - a.created_at)) / 3600)::integer * 10, 3000))::integer
  from private.agent_actions a
  join private.growth_messages m on m.action_id = a.id
  join private.growth_opportunities o on o.id = m.opportunity_id
  where a.id = p_action
  order by m.created_at desc limit 1;
$$;
revoke all on function private.growth_action_score(uuid) from public, anon, authenticated, service_role;

-- The ready queue: unchanged with the switch off. With it on, every other kind of action keeps its place first, oldest first, and growth
-- emails follow, best first.
create or replace function private.agent_actions_ready(p_limit integer, p_kinds text[], p_exclude_kinds text[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_priority boolean := private.growth_send_priority_on(); begin
 perform private.require_hub_app_server();
 if p_limit is null or p_limit<1 or p_limit>50 then raise exception 'List between 1 and 50 actions.' using errcode='22023'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'kind',x.kind,'agentKey',x.agent_key) order by x.lane,x.score desc,x.created_at,x.id),'[]'::jsonb)
 from (select a.id,a.kind,a.agent_key,a.created_at,
     case when v_priority and a.kind='growth.message' then 1 else 0 end as lane,
     case when v_priority and a.kind='growth.message' then coalesce(private.growth_action_score(a.id),0) else 0 end as score
   from private.agent_actions a
   where a.status in ('approved','auto_approved') and (a.not_before is null or a.not_before<=now())
   and (p_kinds is null or a.kind=any(p_kinds)) and (p_exclude_kinds is null or a.kind<>all(p_exclude_kinds))
   and not exists(select 1 from private.agent_tasks t where t.id=a.task_id and t.status='cancelled')
   order by lane,score desc,a.created_at,a.id limit p_limit) x);
end; $$;
revoke all on function private.agent_actions_ready(integer, text[], text[]) from public, anon, authenticated, service_role;
grant execute on function private.agent_actions_ready(integer, text[], text[]) to hub_app_server;

-- The drafting sweep reads the pipeline band by band, by fit and by how long the work has been due, when the switch is on (by id
-- otherwise). The band goes with each item, and is kept with each email's arms. No waiting time: the order must hold between pages.
-- `first_form` is the form of the opportunity's first email ('short' or 'standard' while "Test a short first email" splits them): after a
-- short first email the second offers the trial and its card terms (server/growth/draft.mjs).
do $$
declare d text := pg_get_functiondef('private.growth_snapshot(integer)'::regprocedure);
begin
  if position('as priority_band' in d) > 0 then return; end if;
  if position($q$ as outreach_stopped
 from private.growth_opportunities o join private.growth_organizations g on g.id=o.organization_id left join private.growth_contacts c on c.id=o.contact_id order by o.id limit 100 offset p_offset) x));$q$ in d) = 0 then
    raise exception 'The growth snapshot changed; update this migration' using errcode = '55000';
  end if;
  execute replace(d, $q$ as outreach_stopped
 from private.growth_opportunities o join private.growth_organizations g on g.id=o.organization_id left join private.growth_contacts c on c.id=o.contact_id order by o.id limit 100 offset p_offset) x));$q$,
    $q$ as outreach_stopped,
 private.growth_priority_band(o.id) as priority_band,
 (select m.arms->>'form' from private.growth_messages m where m.opportunity_id=o.id and m.purpose='marketing' and m.attempted_at is not null and m.primary_message_id is null order by m.attempted_at limit 1) as first_form
 from private.growth_opportunities o join private.growth_organizations g on g.id=o.organization_id left join private.growth_contacts c on c.id=o.contact_id
 order by case when private.growth_send_priority_on() then private.growth_priority_band(o.id) end, case when private.growth_send_priority_on() then o.fit end desc nulls last,
  case when private.growth_send_priority_on() then o.next_at end, o.id limit 100 offset p_offset) x));$q$);
end $$;

-- ---- Send hours --------------------------------------------------------------------------------------------------------------------

-- The first moment at or after `p_at` inside the owner's Eastern weekday send hours: `p_at` itself when no hours are set, when they are
-- not a valid range or when `p_at` is inside them.
create or replace function private.growth_next_send_at(p_at timestamptz) returns timestamptz
language plpgsql stable set search_path = '' as $$
declare v_from integer; v_until integer; v_local timestamp; v_day date; v_open timestamp; v_close timestamp; begin
 select case when jsonb_typeof(s.value) = 'number' and (s.value #>> '{}') ~ '^[0-9]{1,2}$' then (s.value #>> '{}')::integer end into v_from
   from private.hub_settings s where s.key = 'growth.send_from_hour';
 select case when jsonb_typeof(s.value) = 'number' and (s.value #>> '{}') ~ '^[0-9]{1,2}$' then (s.value #>> '{}')::integer end into v_until
   from private.hub_settings s where s.key = 'growth.send_until_hour';
 if p_at is null or (v_from is null and v_until is null) then return p_at; end if;
 v_from := coalesce(v_from, 0); v_until := coalesce(v_until, 24);
 if v_from > 23 or v_until < 1 or v_until > 24 or v_from >= v_until then return p_at; end if;
 v_local := p_at at time zone 'America/New_York';
 for i in 0..7 loop
  v_day := v_local::date + i;
  if extract(isodow from v_day) <= 5 then
   v_open := v_day + make_interval(hours => v_from); v_close := v_day + make_interval(hours => v_until);
   if v_local >= v_open and v_local < v_close then return p_at; end if;
   if v_local < v_open then return v_open at time zone 'America/New_York'; end if;
  end if;
 end loop;
 return p_at;
end; $$;
revoke all on function private.growth_next_send_at(timestamptz) from public, anon, authenticated, service_role;

-- The send claim refuses a cold email outside the hours; the server defers it to the next opening.
do $$
declare d text := pg_get_functiondef('private.growth_claim_message(uuid,uuid)'::regprocedure);
begin
  if position('outside_hours' in d) > 0 then return; end if;
  if position($q$
 update private.growth_messages set status='sending',attempted_at=now() where id=m.id;$q$ in d) = 0 then
    raise exception 'The send claim changed; update this migration' using errcode = '55000';
  end if;
  execute replace(d, $q$
 update private.growth_messages set status='sending',attempted_at=now() where id=m.id;$q$, $q$
 -- Send hours (20261117190000_growth_priority.sql): cold email only inside the owner's Eastern weekday hours.
 if v_cold and private.growth_next_send_at(now())>now() then return jsonb_build_object('send',false,'status','outside_hours'); end if;
 update private.growth_messages set status='sending',attempted_at=now() where id=m.id;$q$);
end $$;

-- Server: a growth email that could not go now waits. Over the day's cap, with "Send to the best prospects first" on, until the next
-- Eastern day (it was tried every 15 minutes); outside the send hours, until the next opening; a cold email never before the next
-- opening; anything else 15 minutes, as before.
create or replace function private.growth_defer_action(p_id uuid, p_execution integer, p_reason text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_at timestamptz := now() + interval '15 minutes'; v_cold boolean; v_deferred boolean; begin
 perform private.require_hub_app_server();
 if p_reason in ('daily_limit', 'outside_hours') then
  select private.growth_message_class(a.agent_key, m.purpose, c.source_kind) = 'growth.cold_email' into v_cold
    from private.agent_actions a join private.growth_messages m on m.action_id = a.id join private.growth_contacts c on c.id = m.contact_id
   where a.id = p_id order by m.created_at desc limit 1;
  if p_reason = 'daily_limit' and private.growth_send_priority_on() then
   v_at := (date_trunc('day', now() at time zone 'America/New_York') + interval '1 day') at time zone 'America/New_York';
  end if;
  if coalesce(v_cold, false) then v_at := private.growth_next_send_at(v_at); end if;
 end if;
 update private.agent_actions set status=case when decided_by is null then 'auto_approved' else 'approved' end,
 executing_at=null,not_before=v_at,updated_at=now()
 where id=p_id and kind='growth.message' and status='executing' and executions=p_execution
 returning true into v_deferred;
 return coalesce(v_deferred,false);
end; $$;
revoke all on function private.growth_defer_action(uuid, integer, text) from public, anon, authenticated, service_role;
grant execute on function private.growth_defer_action(uuid, integer, text) to hub_app_server;

-- ---- A report opened brings the second email forward --------------------------------------------------------------------------------

-- On an agency's first open of its report, with "Send to the best prospects first" on, its next email is due as soon as the policy's own
-- gap after the last one allows (it waited four days). No new version: that would cancel the touch's waiting emails to colleagues.
create or replace function private.growth_report_open_followup() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 if not private.growth_send_priority_on() then return new; end if;
 if exists (select 1 from private.customer_activity_events e where e.organization_id = new.organization_id and e.product = new.product
   and e.kind = 'report_viewed' and e.id <> new.id) then return new; end if;
 update private.growth_opportunities o set next_at = greatest(now(), x.last + make_interval(hours => x.gap)), updated_at = now()
   from (select y.id, max(m.attempted_at) as last, p.min_gap_hours as gap
     from private.growth_opportunities y
     join private.growth_policies p on p.product = y.product
     join private.growth_messages m on m.opportunity_id = y.id and m.purpose = 'marketing' and m.attempted_at is not null
    where y.organization_id = new.organization_id and y.product = new.product and y.stage = 'contacted'
    group by y.id, p.min_gap_hours) x
  where o.id = x.id and o.next_at > greatest(now(), x.last + make_interval(hours => x.gap));
 return new;
end; $$;
revoke all on function private.growth_report_open_followup() from public, anon, authenticated, service_role;
drop trigger if exists growth_report_open_followup on private.customer_activity_events;
create trigger growth_report_open_followup after insert on private.customer_activity_events
  for each row when (new.kind = 'report_viewed') execute function private.growth_report_open_followup();

-- ---- Account briefs only for an agency that can be emailed ------------------------------------------------------------------------

do $$
declare d text := pg_get_functiondef('private.growth_brief_next(integer)'::regprocedure);
begin
  if position('c.eligibility = ''permitted'')
  order by' in d) > 0 then return; end if;
  if position($q$    and not exists (select 1 from private.growth_brief_log l where l.opportunity_id = o.id and l.started_at > now() - interval '1 day')
  order by$q$ in d) = 0 then
    raise exception 'The brief queue changed; update this migration' using errcode = '55000';
  end if;
  execute replace(d, $q$    and not exists (select 1 from private.growth_brief_log l where l.opportunity_id = o.id and l.started_at > now() - interval '1 day')
  order by$q$, $q$    and not exists (select 1 from private.growth_brief_log l where l.opportunity_id = o.id and l.started_at > now() - interval '1 day')
    -- Only an agency that can be emailed (20261117190000_growth_priority.sql): half the briefs were for agencies with no address.
    and exists (select 1 from private.growth_contacts c where c.id = o.contact_id and c.eligibility = 'permitted')
  order by$q$);
end $$;

-- ---- A prospect who replied and went quiet --------------------------------------------------------------------------------------------

-- Server: prospects whose latest word was a reply with interest or a question, which we answered by email, and who have not written since:
-- step 1 four days after our answer, step 2 five days after step 1's email. A later reply, a no, a "not now", a meeting, a trial, an
-- opt-out or a complaint ends it (the send claim checks again before each email).
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

-- ---- The weekly memo: report opens per arm and the reader's weaknesses ---------------------------------------------------------

-- 2.7 Report opens per arm, and the reader's weaknesses (review 2026-11-17). Learning waited for replies: 20 sends an arm and two replies,
-- which ten cold emails a day had not reached. Each arm now also counts the sent emails that linked the agency's own market report
-- (`reported`: the body carries an Intel /report/ link; the review page and product pages are not counted) and, of those, how many the
-- agency opened within 30 days of the email (`opened`: Intel's report_viewed events, recorded at least two minutes after the first email,
-- never a person), so the weekly memo can compare arms on opens until replies exist (server/growth/learning.mjs composeMemo). The
-- reader's review (critic.2) records a weakness code in a first email's arms; `weaknesses` counts them over the window's drafts, 'none'
-- left out. Counts only, as before: no message text, name or address leaves this function. No contract pins its text; its grants are
-- kept by create or replace.
create or replace function private.growth_learning_facts(p_product text, p_days integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 perform private.require_hub_app_server();
 if p_product not in ('carebase', 'caremetric-intel') or p_days is null or p_days < 7 or p_days > 365 then raise exception 'Invalid window' using errcode = '22023'; end if;
 return (with sent as (
   select m.id,
     -- growth.11 did not persist its prompt version or actual length treatment. Conservatively omit
     -- legacy cold first touches created since report-led copy began, including drafts sent later.
     case when p_product = 'caremetric-intel' and not (m.arms ? 'length_basis')
       and m.created_at >= timestamptz '2026-11-15 00:00:00+00'
       and coalesce(m.arms ->> 'trigger', '') <> 'inbound'
       and coalesce(m.arms ->> 'trigger', '') not like 'reask_%'
       and not exists (select 1 from private.growth_messages prior
         where prior.opportunity_id = m.opportunity_id and prior.purpose = 'marketing'
           and prior.primary_message_id is null and prior.attempted_at < m.created_at)
       then m.arms - 'length' else m.arms end as arms, m.memo_version, m.attempted_at, o.organization_id, m.status,
     -- The agency's own market report (report-link.mjs: https://www.caremetricintel.com/report/<token>), not the review page.
     position('caremetricintel.com/report/' in coalesce(m.body, '')) > 0 as reported
   from private.growth_messages m join private.growth_opportunities o on o.id = m.opportunity_id
   where o.product = p_product and m.purpose = 'marketing' and m.attempted_at is not null and m.attempted_at >= now() - make_interval(days => p_days)
     and m.primary_message_id is null),
 outcome as (
   select s.*,
     (select e.kind from private.customer_activity_events e where e.organization_id = s.organization_id and e.occurred_at >= s.attempted_at
        and e.occurred_at < s.attempted_at + interval '30 days' and e.kind in ('reply', 'positive_reply', 'negative_reply', 'not_now')
      order by e.occurred_at limit 1) as reply,
     s.status in ('bounced', 'complaint') or exists (select 1 from private.growth_delivery_events d where d.message_id = s.id and d.kind in ('bounced', 'complaint')) as bounced,
     s.reported and exists (select 1 from private.customer_activity_events e where e.organization_id = s.organization_id and e.product = p_product
        and e.kind = 'report_viewed' and e.occurred_at >= s.attempted_at and e.occurred_at < s.attempted_at + interval '30 days') as opened
   from sent s),
 arms as (
   select a.key as arm, a.value as value, count(*) as sent, count(*) filter (where o.reply is not null) as replied,
     count(*) filter (where o.reply = 'positive_reply') as positive, count(*) filter (where o.reply = 'negative_reply') as negative,
     count(*) filter (where o.reply = 'not_now') as not_now, count(*) filter (where o.bounced) as bounced,
     count(*) filter (where o.reported) as reported, count(*) filter (where o.opened) as opened
   from outcome o, jsonb_each_text(o.arms) a group by a.key, a.value)
 select jsonb_build_object(
   'product', p_product, 'days', p_days,
   'sent', (select count(*) from outcome), 'replied', (select count(*) from outcome where reply is not null),
   'positive', (select count(*) from outcome where reply = 'positive_reply'), 'bounced', (select count(*) from outcome where bounced),
   'reported', (select count(*) from outcome where reported), 'opened', (select count(*) from outcome where opened),
   'arms', coalesce((select jsonb_agg(jsonb_build_object('arm', arm, 'value', value, 'sent', sent, 'replied', replied, 'positive', positive,
       'negative', negative, 'notNow', not_now, 'bounced', bounced, 'reported', reported, 'opened', opened) order by arm, value) from arms), '[]'::jsonb),
   'memos', coalesce((select jsonb_agg(jsonb_build_object('version', memo_version, 'sent', n, 'replied', r) order by memo_version) from (
       select memo_version, count(*) n, count(*) filter (where reply is not null) r from outcome where memo_version is not null group by memo_version) x), '[]'::jsonb),
   'objections', coalesce((select jsonb_object_agg(objection, n) from (
       select e.facts ->> 'objection' as objection, count(*) n from private.customer_activity_events e
        where e.product = p_product and e.facts ? 'objection' and e.occurred_at >= now() - make_interval(days => p_days)
          and e.facts ->> 'objection' ~ '^[a-z_]{1,30}$' group by 1) x), '{}'::jsonb),
   'ownerNotes', coalesce((select jsonb_agg(left(note, 300)) from (
       select a.decision_note as note from private.agent_actions a join private.growth_messages m on m.action_id = a.id
        join private.growth_opportunities o on o.id = m.opportunity_id
        where a.kind = 'growth.message' and a.status = 'rejected' and o.product = p_product and nullif(btrim(a.decision_note), '') is not null
          and a.decided_at >= now() - make_interval(days => p_days) and m.primary_message_id is null
        order by a.decided_at desc limit 5) x), '[]'::jsonb),
   -- Why drafts were thrown away by the code checks (the pipeline sweep's `rejected` counts, draft.mjs codes), across products.
   'draftChecks', coalesce((select jsonb_object_agg(code, n) from (
       select r.key as code, sum((r.value #>> '{}')::numeric)::integer as n
       from private.agent_tasks t cross join lateral jsonb_each(case when jsonb_typeof(t.result -> 'rejected') = 'object' then t.result -> 'rejected' else '{}'::jsonb end) r
       where t.kind = 'growth.pipeline' and t.status = 'done' and t.finished_at >= now() - make_interval(days => p_days)
         and r.key ~ '^[a-z_]{1,80}$' and jsonb_typeof(r.value) = 'number'
       group by 1 order by 2 desc limit 30) x), '{}'::jsonb),
   -- The reader's weakest point of each first email drafted in the window, whatever became of the draft (critic.2 codes; 'none' left out).
   'weaknesses', coalesce((select jsonb_object_agg(code, n) from (
       select m.arms ->> 'weakness' as code, count(*) n from private.growth_messages m join private.growth_opportunities o on o.id = m.opportunity_id
        where o.product = p_product and m.purpose = 'marketing' and m.primary_message_id is null and m.created_at >= now() - make_interval(days => p_days)
          and m.arms ->> 'weakness' ~ '^[a-z_]{1,30}$' and m.arms ->> 'weakness' <> 'none'
        group by 1) x), '{}'::jsonb),
   'rejectedDrafts', (select count(*) from private.agent_actions a join private.growth_messages m on m.action_id = a.id
        join private.growth_opportunities o on o.id = m.opportunity_id
        where a.kind = 'growth.message' and a.status = 'rejected' and o.product = p_product and a.decided_at >= now() - make_interval(days => p_days)
          and m.primary_message_id is null))
 );
end; $$;
revoke all on function private.growth_learning_facts(text, integer) from public, anon, authenticated, service_role;
grant execute on function private.growth_learning_facts(text, integer) to hub_app_server;

-- ---- The Sales Executive's context ----------------------------------------------------------------------------------------------

-- 2.9 The Sales Executive's context (Settings → Customer growth → "Give the Sales Executive the account brief", growth.sales_context).
-- It answered a prospect from up to two earlier messages and a stage. For a growth prospect it may now also read the account brief's
-- writer part (what the first-email writer reads: the summary, the problems as questions, the angle and the cited opening; never the
-- research part, so never a leader's name, a fit score or the agency's own standing), which of our emails was answered, and whether the
-- agency opened its market report (yes or no). The prospect is found as private.sales_handoff finds it: the email conversation's address
-- among the growth contacts of an open, not internal opportunity for the conversation's product. The data is returned whatever the
-- switch; the server uses it only when the switch is on (server/agents/sales/reply.mjs).
--
-- private.sales_growth_context_read is the reading, closed to every role (so pgTAP can read it as the owner of the database);
-- private.sales_growth_context is the server's call to it.
create or replace function private.sales_growth_context_read(p_communication uuid, p_message uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c private.communications%rowtype; m private.communication_messages%rowtype; v_product text; v_opportunity uuid; v_contact uuid;
 v_org uuid; v_memory jsonb; v_writer jsonb; g private.growth_messages%rowtype; v_primary_at timestamptz; v_touch integer; begin
 select * into c from private.communications where id = p_communication;
 if not found or c.contact_email is null then return null; end if;
 select * into m from private.communication_messages where id = p_message and communication_id = c.id and direction = 'inbound';
 if not found or coalesce(m.provider_message_id, '') not like 'email:%' then return null; end if;
 select p.slug into v_product from hub.products p where p.id = c.product_id;
 select o.id, gc.id, o.organization_id, o.memory into v_opportunity, v_contact, v_org, v_memory
  from private.growth_contacts gc
  join private.growth_opportunities o on o.organization_id = gc.organization_id
  join private.growth_organizations x on x.id = o.organization_id
  where gc.email = lower(btrim(c.contact_email)) and not x.internal
   and o.stage in ('identified', 'researched', 'qualified', 'contacted', 'engaged', 'demo', 'nurture')
   and (v_product is null or o.product = v_product)
  order by o.updated_at desc, o.id limit 1;
 if v_opportunity is null then return null; end if;
 -- The writer part only, and only its plain fields: the summary, the problems as questions, the angle, the cited opening.
 select b.writer into v_writer from private.growth_briefs b where b.opportunity_id = v_opportunity;
 -- The latest of our emails to this person that could have been read before the message arrived.
 select * into g from private.growth_messages gm
  where gm.opportunity_id = v_opportunity and gm.contact_id = v_contact and gm.attempted_at is not null and gm.attempted_at <= m.created_at
   and gm.status in ('accepted', 'delivered', 'unknown')
  order by gm.attempted_at desc, gm.id desc limit 1;
 if g.id is not null then
  v_primary_at := coalesce((select p.attempted_at from private.growth_messages p where p.id = g.primary_message_id), g.attempted_at);
  select count(*) into v_touch from private.growth_messages x where x.opportunity_id = v_opportunity and x.purpose = g.purpose
   and x.primary_message_id is null and x.attempted_at is not null and x.attempted_at <= v_primary_at;
 end if;
 return jsonb_strip_nulls(jsonb_build_object(
  'brief', case when jsonb_typeof(v_writer) = 'object' then jsonb_strip_nulls(jsonb_build_object(
    'summary', nullif(left(v_writer ->> 'summary', 600), ''),
    'angle', case when coalesce(v_writer ->> 'angle', '') ~ '^[a-z_]{1,40}$' then v_writer ->> 'angle' end,
    'pains', (select nullif(jsonb_agg(left(p ->> 'question', 300)) filter (where coalesce(p ->> 'question', '') <> ''), '[]'::jsonb)
      from jsonb_array_elements(case when jsonb_typeof(v_writer -> 'pains') = 'array' then v_writer -> 'pains' else '[]'::jsonb end) with ordinality as t(p, n)
      where n <= 3),
    'hook', nullif(left(v_writer -> 'hook' ->> 'sentence', 400), ''))) end,
  'answered', case when g.id is not null then jsonb_strip_nulls(jsonb_build_object('touch', greatest(v_touch, 1), 'purpose', g.purpose,
    'subject', left(g.subject, 150), 'form', case when coalesce(g.arms ->> 'form', '') ~ '^[a-z_]{1,20}$' then g.arms ->> 'form' end)) end,
  'reportOpened', coalesce(v_memory ? 'reportViewedAt', false) or exists (select 1 from private.customer_activity_events e
    where e.organization_id = v_org and e.product = 'caremetric-intel' and e.kind = 'report_viewed')));
end; $$;
revoke all on function private.sales_growth_context_read(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function private.sales_growth_context(p_communication uuid, p_message uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
 perform private.require_hub_app_server();
 return private.sales_growth_context_read(p_communication, p_message);
end; $$;
revoke all on function private.sales_growth_context(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function private.sales_growth_context(uuid, uuid) to hub_app_server;
