-- The weekly strategist: the one binding constraint on winning CareMetric Intel's first customers, at the top of the Monday scorecard
-- (owner decision 2026-11-16, docs/AI_WORKFORCE_REVIEW_2026-11-16.md "Not built in this pass").
--
-- Why. The Monday scorecard shows six numbers per product and what needs the owner, but not which stage of the funnel is holding the
-- rest back. On 2026-11-16, 91 of 110 strong-fit Intel agencies had no address the team may write to, the daily cap was reached on 3
-- days, and no first email had been answered: three different problems, each with a different fix, and only one of them binding.
--
-- 1. Settings -> AI team -> "Name the week's binding constraint" (agents.strategist): off until the owner turns it on.
-- 2. private.growth_strategy_facts(since, until): the week's Intel funnel, counts only (never a name, address or amount of a customer):
--    strong fits not yet written to, how many the team may write to, how many have an address waiting for the owner's permission and
--    how many have none, roster agencies resolved and still unresolved, addresses
--    checked, cold first emails and later touches sent, cold emails attempted, delivered, hard and soft bounces, complaints, agencies that
--    replied or opened their report, days the cold-email cap or Intel's own daily limit was reached, drafts waiting (and how many of
--    them are approved), briefs
--    written, trial starts, first value and paid,
--    the Marketing Manager's spend and the days its budget ran out, proposals waiting for the owner, the bounce guard's own window, and
--    the settings a move would change. Hub server only, at most 31 days. Snapshot figures (strong fits, waiting drafts, approvals) are
--    as of the read, so the strategist reads them for the week just ended only.
-- 3. private.agent_strategy_notes: one note per reported week (its Monday): the constraint, headline, why, the move, the figure to
--    watch next Monday, whether the model or the rules chose it, the candidates and the figures behind it. Closed to every role;
--    written by private.agent_strategy_save and read by private.agent_strategy_note (Hub server only). private.agent_strategy_pending
--    tells the scorecard the strategist's task is due or running, so a catch-up scorecard waits for the note.
-- 4. The Chief of Staff's strategy.weekly task, every morning at 07:35 Eastern; a scheduled run writes the week's note once, before
--    the scorecard at 07:50 reads it.
--
-- Nothing is sent by this migration. 20261117170100_weekly_strategist_contract.sql declares platform.agents.strategist.v1, and the
-- server uses these functions only once it is declared.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values ('agents.strategist', 'flag') on conflict (key) do nothing;

create table if not exists private.agent_strategy_notes (
  week date primary key check (extract(isodow from week) = 1),
  constraint_key text not null check (constraint_key in ('deliverability', 'supply', 'reach', 'permission', 'volume', 'engagement', 'conversion', 'activation', 'budget', 'approvals', 'none')),
  headline text not null check (length(headline) between 1 and 200),
  why text not null check (length(why) between 1 and 600),
  move text not null check (length(move) between 1 and 300),
  watch text check (watch in ('bounceRate', 'ready', 'strongNoContact', 'awaitingPermission', 'firstSent', 'openRate', 'replies', 'trialStarts', 'activated', 'budgetDays', 'approvals')),
  chosen_by text not null check (chosen_by in ('model', 'rules')),
  model text check (model ~ '^[a-z0-9.:_-]{1,80}$'),
  prompt_version text not null check (prompt_version ~ '^[a-z0-9._-]{1,40}$'),
  candidates jsonb not null default '[]'::jsonb check (jsonb_typeof(candidates) = 'array'),
  figures jsonb not null default '{}'::jsonb check (jsonb_typeof(figures) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((constraint_key = 'none') = (watch is null))
);
alter table private.agent_strategy_notes enable row level security;
revoke all on private.agent_strategy_notes from public, anon, authenticated, service_role, hub_app_server;

-- The week's funnel for CareMetric Intel. Internal organizations never count. Cold email is growth_message_class's: marketing to a role
-- address, an enriched or an imported contact. A first email is an opportunity's first primary marketing touch; colleagues' copies are
-- not touches. A hard bounce is one whose address the Hub suppressed, as the bounce guard counts it.
create or replace function private.growth_strategy_facts_json(p_since timestamptz, p_until timestamptz) returns jsonb
language sql stable set search_path = '' as $$
with opp as (
  select o.id, o.stage, o.fit, o.contact_id, o.organization_id as org
  from private.growth_opportunities o join private.growth_organizations g on g.id = o.organization_id
  where o.product = 'caremetric-intel' and not g.internal
),
strong as (
  select opp.id, exists (select 1 from private.growth_contacts c where c.id = opp.contact_id and c.eligibility = 'permitted') as reachable,
    -- An address found and waiting for the owner's permission (Growth), which the people finder no longer looks past.
    exists (select 1 from private.growth_contacts c where c.organization_id = opp.org and c.eligibility = 'review') as awaiting
  from opp where opp.fit >= 75 and opp.stage in ('identified', 'researched', 'qualified')
    and not exists (select 1 from private.growth_messages m where m.opportunity_id = opp.id and m.purpose = 'marketing' and m.attempted_at is not null)
),
cold as (
  select m.id, m.opportunity_id, m.attempted_at, m.primary_message_id, c.email
  from private.growth_messages m join private.growth_contacts c on c.id = m.contact_id
  where m.purpose = 'marketing' and m.attempted_at is not null
    and private.growth_message_class('marketing_manager', m.purpose, c.source_kind) = 'growth.cold_email'
),
intel_cold as (select cold.* from cold join opp on opp.id = cold.opportunity_id),
touches as (
  select ic.*, not exists (select 1 from intel_cold p where p.opportunity_id = ic.opportunity_id and p.primary_message_id is null and p.attempted_at < ic.attempted_at) as first_touch
  from intel_cold ic where ic.primary_message_id is null and ic.attempted_at >= p_since and ic.attempted_at < p_until
),
events as (
  select d.kind, ic.email from private.growth_delivery_events d join intel_cold ic on ic.id = d.message_id
  where d.occurred_at >= p_since and d.occurred_at < p_until
),
activity as (
  select e.organization_id, e.kind, e.occurred_at from private.customer_activity_events e join opp on opp.org = e.organization_id
  where e.product = 'caremetric-intel'
),
firsts as (
  select a.kind, count(distinct a.organization_id) as n from activity a
  where a.kind in ('trial_started', 'first_value', 'paid') and a.occurred_at >= p_since and a.occurred_at < p_until
    and not exists (select 1 from activity earlier where earlier.organization_id = a.organization_id and earlier.kind = a.kind and earlier.occurred_at < p_since)
  group by a.kind
),
guard as (select private.growth_bounce_guard() as value)
select jsonb_build_object(
  'since', p_since, 'until', p_until, 'product', 'caremetric-intel',
  'prospects', jsonb_build_object(
    'strong', (select count(*) from strong), 'strongReachable', (select count(*) from strong where reachable),
    'strongNoContact', (select count(*) from strong where not reachable and not awaiting),
    'strongAwaitingPermission', (select count(*) from strong where not reachable and awaiting),
    'briefed', (select count(*) from private.growth_briefs b join opp on opp.id = b.opportunity_id where b.created_at >= p_since and b.created_at < p_until)),
  'roster', jsonb_build_object(
    'unresolved', (select count(*) from private.growth_roster_targets t where t.status in ('new', 'resolving', 'unresolved')),
    'resolvedInWeek', (select count(*) from private.growth_roster_targets t where t.resolved_at >= p_since and t.resolved_at < p_until)),
  'addresses', jsonb_build_object(
    'checked', (select count(*) from private.growth_contacts c where c.mailbox_checked_at >= p_since and c.mailbox_checked_at < p_until),
    'unanswered', (select count(*) from private.growth_contacts c where c.mailbox_checked_at >= p_since and c.mailbox_checked_at < p_until
      and c.mailbox_result in ('unknown', 'unreachable'))),
  'email', jsonb_build_object(
    'firstSent', (select count(*) from touches where first_touch), 'followups', (select count(*) from touches where not first_touch),
    -- Every cold Intel email attempted in the week, colleagues' copies included: the hard-bounce rate's denominator, counted by message
    -- as the bounce guard counts it, so a delivery event that has not arrived yet never shrinks it.
    'sent', (select count(*) from intel_cold ic where ic.attempted_at >= p_since and ic.attempted_at < p_until),
    'delivered', (select count(*) from events where kind = 'delivered'),
    'bounced', (select count(*) from events e where e.kind = 'bounced'
      and exists (select 1 from private.email_suppressions s where s.email_hash = encode(extensions.digest(e.email, 'sha256'), 'hex'))),
    'softBounced', (select count(*) from events e where e.kind = 'bounced'
      and not exists (select 1 from private.email_suppressions s where s.email_hash = encode(extensions.digest(e.email, 'sha256'), 'hex'))),
    'complaints', (select count(*) from events where kind = 'complaint'),
    'replies', (select count(distinct a.organization_id) from activity a where a.kind in ('reply', 'positive_reply', 'negative_reply', 'not_now')
      and a.occurred_at >= p_since and a.occurred_at < p_until),
    'reportViews', (select count(distinct a.organization_id) from activity a where a.kind = 'report_viewed' and a.occurred_at >= p_since and a.occurred_at < p_until),
    -- The cap covers every cold email of both products, by the Eastern day (private.agent_day_start).
    'capDays', (select count(*) from (select (x.attempted_at at time zone 'America/New_York')::date as day, count(*) as n from cold x
      where x.attempted_at >= p_since and x.attempted_at < p_until group by 1) days where days.n >= coalesce(private.growth_cold_email_cap(), 10)),
    -- Intel's own daily limit (Growth -> the product's "Maximum messages per day", growth_policies.daily_limit) counts every Intel email
    -- of the Eastern day and is checked before the cold-email cap, so either can be the one that held sending back.
    'limitDays', (select count(*) from (select (x.attempted_at at time zone 'America/New_York')::date as day, count(*) as n
      from private.growth_messages x join private.growth_opportunities y on y.id = x.opportunity_id
      where y.product = 'caremetric-intel' and x.attempted_at >= p_since and x.attempted_at < p_until group by 1) days
      where days.n >= (select p.daily_limit from private.growth_policies p where p.product = 'caremetric-intel')),
    'waiting', (select count(*) from private.growth_messages m join opp on opp.id = m.opportunity_id join private.growth_contacts c on c.id = m.contact_id
      where m.status = 'proposed' and m.purpose = 'marketing' and private.growth_message_class('marketing_manager', m.purpose, c.source_kind) = 'growth.cold_email'),
    -- Of those, the ones approved (by the owner or on their own) and not expired: only these could go out if the cap allowed.
    'approvedWaiting', (select count(*) from private.growth_messages m join opp on opp.id = m.opportunity_id join private.growth_contacts c on c.id = m.contact_id
      join private.agent_actions a on a.id = m.action_id
      where m.status = 'proposed' and m.purpose = 'marketing' and private.growth_message_class('marketing_manager', m.purpose, c.source_kind) = 'growth.cold_email'
        and a.status in ('approved', 'auto_approved') and (a.expires_at is null or a.expires_at > now()))),
  'conversion', jsonb_build_object(
    'trialStarts', coalesce((select n from firsts where kind = 'trial_started'), 0), 'activated', coalesce((select n from firsts where kind = 'first_value'), 0),
    'paid', coalesce((select n from firsts where kind = 'paid'), 0)),
  'spend', jsonb_build_object(
    'marketingCents', (select round(coalesce(sum(r.cost_cents), 0))::integer from private.agent_runs r
      where r.agent_key = 'marketing_manager' and r.started_at >= p_since and r.started_at < p_until),
    'budgetCents', (select daily_budget_cents from private.agents where key = 'marketing_manager'),
    'budgetDays', (select count(distinct (r.started_at at time zone 'America/New_York')::date) from private.agent_runs r
      where r.agent_key = 'marketing_manager' and r.outcome = 'budget_exhausted' and r.started_at >= p_since and r.started_at < p_until)),
  'approvals', (select count(*) from private.agent_actions where status = 'proposed' and expires_at > now()),
  'guard', (select jsonb_build_object('on', coalesce((value ->> 'on')::boolean, false), 'since', value -> 'since',
      'sent', coalesce((value ->> 'sent')::integer, 0), 'bounced', coalesce((value ->> 'bounced')::integer, 0)) from guard),
  'settings', jsonb_build_object('coldEmailCap', coalesce(private.growth_cold_email_cap(), 10), 'presendCheck', private.growth_presend_mode(),
    -- Whether report opens are being recorded (Settings -> Customer growth): without it no open is counted, which is not zero opens.
    'reportViews', coalesce((select s.value = 'true'::jsonb from private.hub_settings s where s.key = 'growth.report_views'), false),
    'productDailyLimit', (select p.daily_limit from private.growth_policies p where p.product = 'caremetric-intel'))
);
$$;
revoke all on function private.growth_strategy_facts_json(timestamptz, timestamptz) from public, anon, authenticated, service_role, hub_app_server;

-- Server: the week's funnel. At most 31 days, ending after it starts.
create or replace function private.growth_strategy_facts(p_since timestamptz, p_until timestamptz) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  if p_since is null or p_until is null or p_since >= p_until or p_until - p_since > interval '31 days' then
    raise exception 'Choose a period of up to 31 days that ends after it starts.' using errcode = '22023';
  end if;
  return private.growth_strategy_facts_json(p_since, p_until);
end; $$;
revoke all on function private.growth_strategy_facts(timestamptz, timestamptz) from public, anon, authenticated, service_role;
grant execute on function private.growth_strategy_facts(timestamptz, timestamptz) to hub_app_server;

-- Server: save the week's note (a scheduled run once; "Run now" again, replacing it).
create or replace function private.agent_strategy_save(p_week date, p_note jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  if jsonb_typeof(p_note) is distinct from 'object' or jsonb_typeof(coalesce(p_note -> 'candidates', '[]'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_note -> 'figures', '{}'::jsonb)) <> 'object' or length((p_note -> 'figures')::text) > 8000
    or length(coalesce(p_note -> 'candidates', '[]'::jsonb)::text) > 8000 then
    raise exception 'Invalid note' using errcode = '22023';
  end if;
  insert into private.agent_strategy_notes (week, constraint_key, headline, why, move, watch, chosen_by, model, prompt_version, candidates, figures)
  values (p_week, p_note ->> 'constraint', p_note ->> 'headline', p_note ->> 'why', p_note ->> 'move', p_note ->> 'watch', p_note ->> 'chosenBy',
          p_note ->> 'model', p_note ->> 'promptVersion', coalesce(p_note -> 'candidates', '[]'::jsonb), coalesce(p_note -> 'figures', '{}'::jsonb))
  on conflict (week) do update set constraint_key = excluded.constraint_key, headline = excluded.headline, why = excluded.why, move = excluded.move,
    watch = excluded.watch, chosen_by = excluded.chosen_by, model = excluded.model, prompt_version = excluded.prompt_version,
    candidates = excluded.candidates, figures = excluded.figures, updated_at = now();
  return true;
exception when check_violation or not_null_violation then
  raise exception 'Invalid note' using errcode = '22023';
end; $$;
revoke all on function private.agent_strategy_save(date, jsonb) from public, anon, authenticated, service_role;
grant execute on function private.agent_strategy_save(date, jsonb) to hub_app_server;

-- Server: one week's note, or null.
create or replace function private.agent_strategy_note(p_week date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  return (select jsonb_build_object('week', n.week, 'constraint', n.constraint_key, 'headline', n.headline, 'why', n.why, 'move', n.move, 'watch', n.watch,
    'chosenBy', n.chosen_by, 'figures', n.figures, 'updatedAt', n.updated_at) from private.agent_strategy_notes n where n.week = p_week);
end; $$;
revoke all on function private.agent_strategy_note(date) from public, anon, authenticated, service_role;
grant execute on function private.agent_strategy_note(date) to hub_app_server;

-- Server: whether the strategist's task is running, or queued and due within five minutes. When the Hub catches up after both morning
-- times have passed, the strategist and the scorecard are claimed together; the scorecard waits a few minutes while this is true, so it
-- opens with the week's note instead of going out without it.
create or replace function private.agent_strategy_pending() returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  return exists (select 1 from private.agent_tasks t where t.agent_key = 'chief_of_staff' and t.kind = 'strategy.weekly'
    and t.created_at > now() - interval '1 day'
    and (t.status = 'running' or (t.status = 'queued' and coalesce(t.due_at, t.created_at) <= now() + interval '5 minutes')));
end; $$;
revoke all on function private.agent_strategy_pending() from public, anon, authenticated, service_role;
grant execute on function private.agent_strategy_pending() to hub_app_server;

insert into private.agent_schedules (agent_key, task_kind, cadence, every_seconds, at_local, timezone, requires_session, next_run_at)
values ('chief_of_staff', 'strategy.weekly', 'daily', null, '07:35', 'America/New_York', false,
        private.agent_schedule_next('daily', null, '07:35', 'America/New_York', now(), null))
on conflict (agent_key, task_kind) do nothing;
