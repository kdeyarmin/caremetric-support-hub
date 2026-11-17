-- Where strong fits stop short of an address (the strategist's reach rule, review of its first note, 2026-11-16).
--
-- The first note's move was to double "Most address checks a day". The limit was 100 and was never reached: of the 92 strong fits with
-- no address, the people finder had searched every one, named nobody at 68 (53 of them not matched to a Medicare record, so only their
-- own websites could name anyone) and named someone but found no address at 24. The rule could not tell, because the facts did not say.
-- private.growth_strategy_facts_json is the same as in 20261117170000_weekly_strategist.sql, except that it also carries:
--
-- - prospects.noContactSteps: where each strong fit with no usable address stopped, as of the read: no website to search, not searched
--   by the people finder yet (or not yet researched), searched with nobody named (and how many of those are not matched to a Medicare
--   record), or someone named and no address found. The four add up to prospects.strongNoContact;
-- - addresses.finder: the people finder's runs in the week (growth.people results): agencies searched, addresses found, the Eastern
--   days it ran out of the day's address checks, and what the mail servers answered (confirmed, refused, accept any address, no answer);
-- - settings.addressChecks ("Most address checks a day", held to 0..500, ten when not set) and settings.addressMode ("Finding people's
--   addresses": none, published or verify).
--
-- Counts and setting values only, as before. The function stays closed to every role; private.growth_strategy_facts reads it.
set local lock_timeout = '10s';

create or replace function private.growth_strategy_facts_json(p_since timestamptz, p_until timestamptz) returns jsonb
language sql stable set search_path = '' as $$
with opp as (
  select o.id, o.stage, o.fit, o.contact_id, o.organization_id as org
  from private.growth_opportunities o join private.growth_organizations g on g.id = o.organization_id
  where o.product = 'caremetric-intel' and not g.internal
),
strong as (
  select opp.id, opp.org, opp.stage, exists (select 1 from private.growth_contacts c where c.id = opp.contact_id and c.eligibility = 'permitted') as reachable,
    -- An address found and waiting for the owner's permission (Growth), which the people finder no longer looks past.
    exists (select 1 from private.growth_contacts c where c.organization_id = opp.org and c.eligibility = 'review') as awaiting
  from opp where opp.fit >= 75 and opp.stage in ('identified', 'researched', 'qualified')
    and not exists (select 1 from private.growth_messages m where m.opportunity_id = opp.id and m.purpose = 'marketing' and m.attempted_at is not null)
),
-- Where each strong fit with no usable address stopped (the people finder: server/growth/people.mjs). A business without a website of
-- its own has nothing to search; the finder takes researched and qualified ones it has not searched in 60 days; it names people from
-- the business's website, and, for one matched to its Medicare record (a roster target), from CMS's owners and the NPI registry too.
stuck as (
  select case when g.domain is null or g.domain ~ '\.invalid$' then 'noWebsite'
              when s.stage = 'identified' or g.people_searched_at is null then 'notSearched'
              when not exists (select 1 from private.growth_people p where p.organization_id = s.org) then 'unnamed'
              else 'namedNoAddress' end as step,
         exists (select 1 from private.growth_roster_targets t where t.organization_id = s.org) as matched
  from strong s join private.growth_organizations g on g.id = s.org
  where not s.reachable and not s.awaiting
),
-- The people finder's runs in the week, as each recorded them (counts only).
finder as (
  select t.finished_at, t.result from private.agent_tasks t
  where t.kind = 'growth.people' and t.status = 'done' and t.finished_at >= p_since and t.finished_at < p_until and jsonb_typeof(t.result) = 'object'
),
finder_counts as (
  select coalesce(sum(case when jsonb_typeof(f.result -> 'searched') = 'number' then (f.result ->> 'searched')::numeric end), 0) as searched,
    coalesce(sum(case when jsonb_typeof(f.result -> 'found') = 'number' then (f.result ->> 'found')::numeric end), 0) as found,
    count(distinct (f.finished_at at time zone 'America/New_York')::date)
      filter (where jsonb_typeof(f.result -> 'noCredit') = 'number' and (f.result ->> 'noCredit')::numeric > 0) as ran_out_days,
    coalesce(sum(case when jsonb_typeof(f.result #> '{answers,verified}') = 'number' then (f.result #>> '{answers,verified}')::numeric end), 0) as confirmed,
    coalesce(sum(case when jsonb_typeof(f.result #> '{answers,rejected}') = 'number' then (f.result #>> '{answers,rejected}')::numeric end), 0) as refused,
    coalesce(sum(case when jsonb_typeof(f.result #> '{answers,catch_all}') = 'number' then (f.result #>> '{answers,catch_all}')::numeric end), 0) as accepts_all,
    coalesce(sum(case when jsonb_typeof(f.result #> '{answers,unknown}') = 'number' then (f.result #>> '{answers,unknown}')::numeric end), 0)
      + coalesce(sum(case when jsonb_typeof(f.result #> '{answers,unreachable}') = 'number' then (f.result #>> '{answers,unreachable}')::numeric end), 0) as no_answer
  from finder f
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
    'noContactSteps', jsonb_build_object(
      'noWebsite', (select count(*) from stuck where step = 'noWebsite'), 'notSearched', (select count(*) from stuck where step = 'notSearched'),
      'unnamed', (select count(*) from stuck where step = 'unnamed'), 'unnamedUnmatched', (select count(*) from stuck where step = 'unnamed' and not matched),
      'namedNoAddress', (select count(*) from stuck where step = 'namedNoAddress')),
    'briefed', (select count(*) from private.growth_briefs b join opp on opp.id = b.opportunity_id where b.created_at >= p_since and b.created_at < p_until)),
  'roster', jsonb_build_object(
    'unresolved', (select count(*) from private.growth_roster_targets t where t.status in ('new', 'resolving', 'unresolved')),
    'resolvedInWeek', (select count(*) from private.growth_roster_targets t where t.resolved_at >= p_since and t.resolved_at < p_until)),
  'addresses', jsonb_build_object(
    'checked', (select count(*) from private.growth_contacts c where c.mailbox_checked_at >= p_since and c.mailbox_checked_at < p_until),
    'unanswered', (select count(*) from private.growth_contacts c where c.mailbox_checked_at >= p_since and c.mailbox_checked_at < p_until
      and c.mailbox_result in ('unknown', 'unreachable')),
    'finder', (select jsonb_build_object('searched', searched, 'found', found, 'ranOutDays', ran_out_days, 'confirmed', confirmed, 'refused', refused,
      'acceptsAll', accepts_all, 'noAnswer', no_answer) from finder_counts)),
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
    'productDailyLimit', (select p.daily_limit from private.growth_policies p where p.product = 'caremetric-intel'),
    -- Settings -> Customer growth -> "Most address checks a day" and "Finding people's addresses", as the people finder reads them.
    'addressChecks', private.growth_enrichment_cap(),
    'addressMode', coalesce((select s.value #>> '{}' from private.hub_settings s where s.key = 'growth.enrichment_provider'
      and s.value in ('"none"'::jsonb, '"published"'::jsonb, '"verify"'::jsonb)), 'verify'))
);
$$;
revoke all on function private.growth_strategy_facts_json(timestamptz, timestamptz) from public, anon, authenticated, service_role, hub_app_server;
