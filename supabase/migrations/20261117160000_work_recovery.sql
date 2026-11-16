-- Work recovery (AI workforce review 2026-11-17, docs/AI_WORKFORCE_REVIEW_2026-11-17.md): the team's finished work was being thrown away
-- by its own checks, and nothing said so. This migration changes no table and adds no setting.
--
-- Creative:
-- - A county counts as pictured only while its snapshot is still in the works or one of its images survived the checks. Every snapshot
--   rendered on 2026-11-16 was blocked by the render's own reading of its figure, and each still used the week and kept its county out for
--   eight weeks. A county whose snapshot failed waits a week, and no more than twice the week's number of snapshots is opened in a week.
-- - private.creative_render_requeue: images blocked only by the first image review (creative-vision.1, which blocked the brand's own small
--   print) or, for a county snapshot, only by the render's reading of its own figure are rendered once more by the server that fixes both.
--
-- Ads:
-- - private.ads_month_campaigns also says why a campaign failed and when, and private.ads_platform_refusals says which ad platform last
--   refused the team and when it was last reconnected, so the month's one flight is never spent on a platform that is not connected.
--
-- Customer growth:
-- - The bounce guard trips on two or more hard bounces above the owner's percentage, counted against at least 20 emails: at ten cold
--   emails a day the window that each save restarts never held 20, so it could never trip.
-- - A decision-maker's address the people finder confirmed with the business's mail server is recorded as confirmed, not checked again.
-- - An opportunity's intent is set when a reply, a trial, a sign-up or a payment is recorded (it was set only by the fit assessment, which
--   stops before anyone replies).
-- - A trial started from the owner's own address or a CareMetric address is marked internal, so the scorecard and the customer emails
--   leave it alone; the three test trials open on 2026-11-16 are marked once.
--
-- The watchdog (private.agent_watchdog_facts) also counts what was lost: work blocked by the team's own checks, a launch that failed,
-- drafts held for more than a day, the bounce rate, the cap reached with a queue behind it, strong fits with no address and an ad budget
-- with nothing delivering.
set local lock_timeout = '10s';

-- ---- Creative: counties --------------------------------------------------------------------------------------------------------------

-- Whether a county snapshot brief still pictures its county: in the works, or with an image that survived the checks.
create or replace function private.creative_brief_pictured(p_brief uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.creative_briefs b where b.id = p_brief
    and (b.status in ('open', 'drafting')
      or exists (select 1 from private.creative_assets a where a.brief_id = b.id and a.status not in ('blocked', 'failed'))));
$$;
revoke all on function private.creative_brief_pictured(uuid) from public, anon, authenticated, service_role;

-- Server: up to the week's room of counties to picture, from the roster's own counties and `p_counties` ([{ countyFips, state }], every
-- county of the roster's states, or null), the least recently pictured first, then those with the most roster agencies. Only a snapshot
-- that still pictures its county counts (private.creative_brief_pictured): one whose images were all blocked frees its county after a
-- week and gives the week its room back, up to twice the week's number of snapshots opened.
create or replace function private.creative_data_counties(p_per_week integer, p_week_start timestamptz, p_counties jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_room integer; begin
  perform private.require_hub_app_server();
  if p_per_week is null or p_per_week < 0 or p_per_week > 7 or p_week_start is null
    or (p_counties is not null and (jsonb_typeof(p_counties) <> 'array' or jsonb_array_length(p_counties) > 5000)) then
    raise exception 'Invalid request' using errcode = '22023';
  end if;
  v_room := least(
    p_per_week - (select count(*) from private.creative_briefs b where b.source = 'data.county' and b.created_at >= p_week_start and private.creative_brief_pictured(b.id)),
    p_per_week * 2 - (select count(*) from private.creative_briefs b where b.source = 'data.county' and b.created_at >= p_week_start));
  if v_room <= 0 then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('countyFips', c.fips, 'state', c.state, 'agencies', c.agencies, 'homeHealth', c.home_health,
      'hospice', c.hospice, 'lastSetting', c.last_setting) order by c.last_at nulls first, c.agencies desc, c.fips)
    from (
      select k.fips, k.state,
             count(t.ccn)::int as agencies,
             count(t.ccn) filter (where t.setting = 'home_health')::int as home_health,
             count(t.ccn) filter (where t.setting = 'hospice')::int as hospice,
             (select max(b.created_at) from private.creative_briefs b where b.source = 'data.county' and b.facts ->> 'countyFips' = k.fips
               and private.creative_brief_pictured(b.id)) as last_at,
             (select b.facts ->> 'setting' from private.creative_briefs b where b.source = 'data.county' and b.facts ->> 'countyFips' = k.fips
               order by b.created_at desc limit 1) as last_setting
        from (select distinct on (x.fips) x.fips, x.state from (
                select t.county_fips as fips, t.state from private.growth_roster_targets t where t.county_fips is not null and t.status <> 'excluded'
                union all
                select e ->> 'countyFips', e ->> 'state' from jsonb_array_elements(coalesce(p_counties, '[]'::jsonb)) e
                 where jsonb_typeof(e) = 'object' and (e ->> 'countyFips') ~ '^[0-9]{5}$' and (e ->> 'state') ~ '^[A-Z]{2}$') x
              order by x.fips, x.state) k
        left join private.growth_roster_targets t on t.county_fips = k.fips and t.status <> 'excluded'
       where not exists (select 1 from private.creative_briefs b where b.source = 'data.county' and b.facts ->> 'countyFips' = k.fips
                           and b.created_at >= now() - interval '56 days' and private.creative_brief_pictured(b.id))
         and not exists (select 1 from private.creative_briefs b where b.source = 'data.county' and b.facts ->> 'countyFips' = k.fips
                           and b.created_at >= now() - interval '7 days')
       group by k.fips, k.state
       order by last_at nulls first, agencies desc, k.fips
       limit v_room) c), '[]'::jsonb);
end; $$;

revoke all on function private.creative_data_counties(integer, timestamptz, jsonb) from public, anon, authenticated, service_role;
grant execute on function private.creative_data_counties(integer, timestamptz, jsonb) to hub_app_server;

-- ---- Creative: images blocked by checks this release corrects --------------------------------------------------------------------------

-- Server, from each render run: static images blocked in the last 30 days only by the first image review (while the review is on, so
-- none passes unseen), or county snapshots blocked at render only by the copy rules reading their own figure, go back to the render queue
-- with a fresh count of attempts. Rendering them again rewrites their compliance result under the new versions, so none is queued twice.
create or replace function private.creative_render_requeue(p_vision boolean) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  perform private.require_hub_app_server();
  with eligible as (
    select a.id from private.creative_assets a
     where a.kind = 'static' and a.status = 'blocked' and a.updated_at >= now() - interval '30 days'
       and jsonb_typeof(a.compliance -> 'reasons') = 'array'
       and exists (select 1 from jsonb_array_elements(a.compliance -> 'reasons') r where r ->> 'level' = 'block')
       and ((coalesce(p_vision, false) and a.compliance -> 'review' ->> 'version' = 'creative-vision.1'
             and not exists (select 1 from jsonb_array_elements(a.compliance -> 'reasons') r where r ->> 'level' = 'block' and r ->> 'rule' <> 'vision_defect'))
         or (a.layout = 'stat' and a.compliance ->> 'version' = 'creative-compliance.2' and a.rendered_at is not null
             and exists (select 1 from private.creative_briefs b where b.id = a.brief_id and b.source = 'data.county')
             and not exists (select 1 from jsonb_array_elements(a.compliance -> 'reasons') r where r ->> 'level' = 'block' and r ->> 'rule' <> 'fact_sheet')))
     for update skip locked
  )
  update private.creative_assets a set status = 'draft', render_attempts = 0, render_error = null, render_job = null, updated_at = now()
    from eligible where a.id = eligible.id;
  get diagnostics v_count = row_count;
  if v_count > 0 then
    insert into private.audit_events (actor_id, action, entity_type, entity_id, metadata)
    values (null, 'creative.requeued', 'creative_asset', null, jsonb_build_object('assets', v_count, 'review', 'creative-vision.2', 'compliance', 'creative-compliance.3'));
  end if;
  return v_count;
end; $$;
revoke all on function private.creative_render_requeue(boolean) from public, anon, authenticated, service_role;
grant execute on function private.creative_render_requeue(boolean) to hub_app_server;

-- ---- Ads: which platform refuses the team --------------------------------------------------------------------------------------------

-- Server: the ad platforms' recent refusals of the team (the daily ad review's latest answer by platform, and campaigns a platform refused
-- in the last 30 days: platform, error code and when) and when each was last reconnected (a LinkedIn or Meta connection saved under
-- Settings → Social media, a Google Ads setting changed under Settings → Paid ads). The plan never gives the month's flight to a platform
-- whose sign-in or permission it refused since (server/agents/ads/index.mjs `failingPlatforms`). Codes and times only.
create or replace function private.ads_platform_refusals() returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
  perform private.require_hub_app_server();
  return jsonb_build_object(
    'refusals', coalesce((select jsonb_agg(x.item order by x.item ->> 'at') from (
        select jsonb_build_object('platform', r.key, 'code', r.value #>> '{}', 'at', t.finished_at) as item
          from (select result, finished_at from private.agent_tasks where kind = 'social.ads' and status = 'done' and finished_at >= now() - interval '7 days'
                 order by finished_at desc limit 1) t,
               jsonb_each(case when jsonb_typeof(t.result -> 'refusedBy') = 'object' then t.result -> 'refusedBy' else '{}'::jsonb end) r
         where r.key in ('linkedin', 'meta') and jsonb_typeof(r.value) = 'string'
        union all
        select jsonb_build_object('platform', split_part(a.target_id, ':', 1), 'code', a.result ->> 'error', 'at', a.updated_at)
          from private.agent_actions a
         where a.kind in ('social.campaign_create', 'social.google_campaign') and a.status = 'failed' and a.updated_at >= now() - interval '30 days'
           and a.result ->> 'error' ~ '^[a-z][a-z_]{0,59}$' and split_part(a.target_id, ':', 1) in ('linkedin', 'meta', 'google')) x), '[]'::jsonb),
    'reconnected', jsonb_strip_nulls(jsonb_build_object(
      'linkedin', (select max(e.created_at) from private.audit_events e where e.action = 'hub.social_connection' and e.metadata ->> 'provider' = 'linkedin'),
      'meta', (select max(e.created_at) from private.audit_events e where e.action = 'hub.social_connection' and e.metadata ->> 'provider' = 'meta'),
      'google', (select max(s.changed_at) from private.hub_settings s where s.key like 'ads.google%' and s.changed_by is not null))));
end; $$;
revoke all on function private.ads_platform_refusals() from public, anon, authenticated, service_role;
grant execute on function private.ads_platform_refusals() to hub_app_server;

-- ---- Customer growth: the bounce guard -------------------------------------------------------------------------------------------------

-- The guard trips on two or more hard bounces above the owner's percentage, counted against at least 20 emails (2 of 10 at 5% trips it;
-- 1 of 10 does not). It used to need 20 cold emails inside the seven days that each save of the setting restarts, which ten a day
-- never reached, so 4 bounces in 32 emails (12.5%) never tripped it. The window, the latch and the counts are unchanged.
do $$
declare d text := pg_get_functiondef('private.growth_bounce_guard()'::regprocedure);
begin
  if position($q$ v_now := v_complaints > 0 or (v_bounced >= 2 and v_bounced * 100 > v_pct * greatest(v_sent, 20));$q$ in d) > 0 then return; end if;
  if position($q$ v_now := v_complaints > 0 or (v_sent >= 20 and v_bounced * 100 > v_pct * v_sent);$q$ in d) = 0 then
    raise exception 'The bounce guard changed; update this migration' using errcode = '55000';
  end if;
  execute replace(d, $q$ v_now := v_complaints > 0 or (v_sent >= 20 and v_bounced * 100 > v_pct * v_sent);$q$,
    $q$ v_now := v_complaints > 0 or (v_bounced >= 2 and v_bounced * 100 > v_pct * greatest(v_sent, 20));$q$);
end $$;

-- ---- Customer growth: an address the people finder confirmed -----------------------------------------------------------------------

-- A decision-maker's address the business's own mail server confirmed to the people finder is recorded as confirmed, so the check before
-- the first email does not ask the same server again (and risk an unanswered second check holding the email).
do $$
declare d text := pg_get_functiondef('private.growth_person_address(uuid,text,text,text,text)'::regprocedure);
  anchor constant text := $q$ returning id into v_contact;
 update private.growth_people set contact_id = v_contact$q$;
begin
  if position('mailbox_result = ''verified''' in d) > 0 then return; end if;
  if position(anchor in d) = 0 then raise exception 'The people finder''s address function changed; update this migration' using errcode = '55000'; end if;
  execute replace(d, anchor, $q$ returning id into v_contact;
 -- The mail server's confirmation is the address check's answer too (review 2026-11-17).
 if p_found = 'mail_server' then
  update private.growth_contacts set mailbox_result = 'verified', mailbox_checked_at = now(), mailbox_checks = greatest(mailbox_checks, 1) where id = v_contact;
 end if;
 update private.growth_people set contact_id = v_contact$q$);
end $$;

update private.growth_contacts c set mailbox_result = 'verified', mailbox_checked_at = coalesce(c.mailbox_checked_at, c.verified_at, now()), mailbox_checks = greatest(c.mailbox_checks, 1)
 where c.mailbox_result is null and exists (select 1 from private.growth_people p where p.contact_id = c.id and p.address_found = 'mail_server');

-- ---- Customer growth: interest -------------------------------------------------------------------------------------------------------

-- An opportunity's intent follows what the business did, as each event is recorded (it was set only by the fit assessment, which stops
-- once a business is researched, so every reply and trial left it empty): a trial, a sign-up, first value, a payment or a meeting 100,
-- a positive reply 75, a reply 60, an opened report 50 (at least, as before); "not now" sets it to 25 and "no" to 0, the latest word
-- of the business standing over its earlier interest.
create or replace function private.growth_event_intent() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v integer := case new.kind when 'trial_started' then 100 when 'signup' then 100 when 'first_value' then 100 when 'paid' then 100
  when 'meeting_booked' then 100 when 'positive_reply' then 75 when 'reply' then 60 when 'report_viewed' then 50 when 'not_now' then 25 when 'negative_reply' then 0 end;
begin
  if v is null then return new; end if;
  update private.growth_opportunities o set intent = case when new.kind in ('not_now', 'negative_reply') then v else greatest(coalesce(o.intent, 0), v) end
   where o.organization_id = new.organization_id and o.product = new.product
     and o.intent is distinct from case when new.kind in ('not_now', 'negative_reply') then v else greatest(coalesce(o.intent, 0), v) end;
  return new;
end; $$;
revoke all on function private.growth_event_intent() from public, anon, authenticated, service_role, hub_app_server;
drop trigger if exists growth_event_intent on private.customer_activity_events;
create trigger growth_event_intent after insert on private.customer_activity_events for each row execute function private.growth_event_intent();

-- What the events on record already say, once.
with y as (
  select e.organization_id, e.product,
         max(case e.kind when 'trial_started' then 100 when 'signup' then 100 when 'first_value' then 100 when 'paid' then 100 when 'meeting_booked' then 100
             when 'positive_reply' then 75 when 'reply' then 60 when 'report_viewed' then 50 end) as shown,
         max(e.occurred_at) filter (where e.kind in ('trial_started', 'signup', 'first_value', 'paid', 'meeting_booked', 'positive_reply', 'reply', 'report_viewed')) as shown_at,
         (array_agg(case e.kind when 'not_now' then 25 else 0 end order by e.occurred_at desc) filter (where e.kind in ('not_now', 'negative_reply')))[1] as said,
         max(e.occurred_at) filter (where e.kind in ('not_now', 'negative_reply')) as said_at
    from private.customer_activity_events e
   group by e.organization_id, e.product)
update private.growth_opportunities o
   set intent = case when y.said is not null and (y.shown_at is null or y.said_at >= y.shown_at) then y.said else greatest(y.shown, coalesce(o.intent, 0)) end
  from y
 where o.organization_id = y.organization_id and o.product = y.product and (y.said is not null or y.shown is not null)
   and o.intent is distinct from (case when y.said is not null and (y.shown_at is null or y.said_at >= y.shown_at) then y.said else greatest(y.shown, coalesce(o.intent, 0)) end);

-- ---- Customer growth: our own trials ----------------------------------------------------------------------------------------------

-- Whether an address is the owner's own (Settings → AI team → the owner's email) or on a CareMetric domain. Never a whole personal mail
-- domain: the owner's other addresses there are marked by hand on Growth.
create or replace function private.growth_internal_address(p_email text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(lower(btrim(p_email)) = (select lower(btrim(s.value #>> '{}')) from private.hub_settings s
                                             where s.key = 'agents.owner_email' and jsonb_typeof(s.value) = 'string'), false)
      or split_part(lower(btrim(coalesce(p_email, ''))), '@', 2)
         ~ '(^|\.)(caremetric\.ai|caremetricai\.com|caremetricintel\.com|cmcarebase\.com|caremetricadvisors\.com|caremetrictrain\.com)$';
$$;
revoke all on function private.growth_internal_address(text) from public, anon, authenticated, service_role, hub_app_server;

-- A trial started from such an address is internal: the scorecard does not count it, and no customer email is drafted for it.
do $$
declare d text := pg_get_functiondef('private.growth_ensure_customer(uuid,text)'::regprocedure);
  anchor constant text := $q$ -- A linked customer whose first signal is a heartbeat must never enter the cold-prospect pipeline.$q$;
begin
  if position('private.growth_internal_address' in d) > 0 then return; end if;
  if position(anchor in d) = 0 then raise exception 'The customer link function changed; update this migration' using errcode = '55000'; end if;
  execute replace(d, anchor, $q$ -- Our own trials (review 2026-11-17): a sign-up from the owner's address or a CareMetric address is internal.
 if exists (select 1 from private.billing_customers b where b.tenant_id = p_tenant and b.livemode and not b.deleted and private.growth_internal_address(b.email)) then
  update private.growth_organizations set internal = true where id = org and not internal;
  if found then
   insert into private.audit_events(action, entity_type, entity_id, tenant_id, metadata)
   values ('growth.marked_internal', 'growth_organization', org, p_tenant, jsonb_build_object('product', p_product, 'reason', 'own_address'));
  end if;
 end if;
$q$ || anchor);
end $$;

-- The owner's decision (2026-11-16): the three CareMetric Intel trials started before November 15 are the owner's own or tests. Marked
-- once, and only if exactly those are found: a later or paying customer is never touched.
do $$
declare v_ids uuid[];
begin
  select array_agg(g.id) into v_ids from private.growth_organizations g
   where g.tenant_id is not null and not g.internal
     and exists (select 1 from private.customer_activity_events e where e.organization_id = g.id and e.product = 'caremetric-intel'
                   and e.kind = 'trial_started' and e.occurred_at < timestamptz '2026-11-15 00:00:00-05')
     and not exists (select 1 from private.customer_activity_events e where e.organization_id = g.id and e.kind = 'paid')
     and not exists (select 1 from private.customer_activity_events e where e.organization_id = g.id and e.product = 'carebase');
  if coalesce(array_length(v_ids, 1), 0) between 1 and 3 then
    update private.growth_organizations set internal = true where id = any(v_ids);
    insert into private.audit_events(action, entity_type, entity_id, metadata)
    select 'growth.marked_internal', 'growth_organization', id, jsonb_build_object('reason', 'owner_decision_2026_11_16') from unnest(v_ids) id;
  end if;
end $$;

-- ---- The watchdog: what was lost ---------------------------------------------------------------------------------------------------

-- Server: what the watchdog words (server/agents/tasks/watchdog.mjs). As before (agents, funnel, thin steps), and what the team lost in
-- the last seven days: images made and blocked by the team's own checks, by rule; the latest campaign a platform refused with none
-- created after it; qualified prospects due more than a day with nothing drafted, by why; the bounce guard's counts and the last 30
-- days' cold bounce rate; yesterday's cold emails against the cap and the approved ones waiting; strong fits with no permitted address;
-- and an ad budget with nothing live. Counts, codes and times only.
create or replace function private.agent_watchdog_facts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
  perform private.require_hub_app_server();
  return jsonb_build_object(
    'agents', coalesce((select jsonb_agg(jsonb_build_object('key', g.key, 'name', g.display_name, 'status', g.status,
        'scheduled', exists (select 1 from private.agent_schedules s where s.agent_key = g.key and s.enabled),
        'lastRunAt', (select max(r.started_at) from private.agent_runs r where r.agent_key = g.key),
        'failed7d', (select count(*) from private.agent_tasks t where t.agent_key = g.key and t.status = 'failed' and t.finished_at >= now() - interval '7 days'),
        'oldestOverdueAt', (select min(t.due_at) from private.agent_tasks t where t.agent_key = g.key and t.status = 'queued' and t.due_at < now()))
      order by g.key) from private.agents g), '[]'::jsonb),
    'funnel', jsonb_build_object(
      'found', (select count(*) from private.growth_opportunities where created_at >= now() - interval '7 days'),
      'qualified', (select count(*) from private.growth_opportunities where stage = 'qualified' and updated_at >= now() - interval '7 days'),
      'emailed', (select count(*) from private.growth_messages where purpose = 'marketing' and attempted_at >= now() - interval '7 days'),
      'replied', (select count(*) from private.customer_activity_events where kind in ('reply', 'positive_reply', 'negative_reply', 'not_now') and occurred_at >= now() - interval '7 days')),
    'thinSteps', coalesce((select jsonb_agg(jsonb_build_object('category', s.category, 'label', s.label, 'reviewed', (e ->> 'reviewed')::integer, 'rejected', (e ->> 'rejected')::integer))
      from private.agent_autonomy_steps s cross join lateral (select coalesce(private.agent_autonomy_evidence(s.category), '{"reviewed":0,"rejected":0}'::jsonb) as e) x
      where s.status = 'automatic' and ((e ->> 'reviewed')::integer < s.min_reviewed
        or (e ->> 'rejected')::integer * 100 > s.max_rejected_pct * greatest((e ->> 'reviewed')::integer, 1))), '[]'::jsonb),
    'losses', jsonb_build_object(
      'creativeMade', (select count(*) from private.creative_assets where created_at >= now() - interval '7 days'),
      'creativeBlocked', coalesce((select jsonb_object_agg(b.rule, b.n) from (
          select coalesce((select r ->> 'rule' from jsonb_array_elements(case when jsonb_typeof(a.compliance -> 'reasons') = 'array' then a.compliance -> 'reasons' else '[]'::jsonb end) r
                            where r ->> 'level' = 'block' limit 1), 'unknown') as rule, count(*) as n
            from private.creative_assets a where a.status = 'blocked' and a.created_at >= now() - interval '7 days' group by 1) b), '{}'::jsonb),
      'launchFailed', (select jsonb_build_object('platform', split_part(a.target_id, ':', 1), 'code', a.result ->> 'error', 'at', a.updated_at)
          from private.agent_actions a
         where a.kind in ('social.campaign_create', 'social.google_campaign') and a.status = 'failed' and a.updated_at >= now() - interval '7 days'
           and not exists (select 1 from private.agent_actions b where b.kind in ('social.campaign_create', 'social.google_campaign')
                             and b.status in ('executed', 'executing') and b.created_at > a.created_at)
         order by a.updated_at desc limit 1),
      'held', coalesce((select jsonb_object_agg(h.reason, h.n) from (
          select case when exists (select 1 from private.growth_messages m join private.agent_actions x on x.id = m.action_id
                                    where m.opportunity_id = o.id and m.status = 'proposed' and x.status = 'rejected') then 'rejected'
                      else coalesce(private.growth_hold_for(o.contact_id, 'marketing'), 'other') end as reason, count(*) as n
            from private.growth_opportunities o join private.growth_contacts c on c.id = o.contact_id
            join private.growth_organizations g on g.id = o.organization_id
           where o.owner_agent = 'marketing_manager' and o.stage in ('qualified', 'contacted') and c.eligibility = 'permitted' and not g.internal
             and o.next_at < now() - interval '1 day'
             and not exists (select 1 from private.growth_messages m where m.opportunity_id = o.id and m.created_at >= o.next_at
                               and m.status <> 'cancelled')
           group by 1) h), '{}'::jsonb),
      'bounce', (select jsonb_build_object('guard', private.growth_bounce_guard(),
          'sent30', count(*), 'bounced30', count(*) filter (where x.status = 'bounced'))
          from private.growth_messages x join private.growth_contacts xc on xc.id = x.contact_id
         where x.attempted_at >= now() - interval '30 days' and private.growth_message_class('marketing_manager', x.purpose, xc.source_kind) = 'growth.cold_email'),
      'cap', jsonb_build_object('cap', coalesce(private.growth_cold_email_cap(), 10),
          'yesterday', (select count(*) from private.growth_messages x join private.growth_contacts xc on xc.id = x.contact_id
                         where x.attempted_at >= private.agent_day_start() - interval '1 day' and x.attempted_at < private.agent_day_start()
                           and private.growth_message_class('marketing_manager', x.purpose, xc.source_kind) = 'growth.cold_email'),
          'waiting', (select count(*) from private.agent_actions a where a.kind = 'growth.message' and a.status in ('approved', 'auto_approved'))),
      'reach', (select jsonb_build_object('strongFits', count(*), 'withoutAddress', count(*) filter (where not exists (
              select 1 from private.growth_contacts c where c.organization_id = o.organization_id and c.eligibility = 'permitted')))
          from private.growth_opportunities o join private.growth_organizations g on g.id = o.organization_id
         where o.owner_agent = 'marketing_manager' and o.fit >= 75 and o.stage in ('researched', 'qualified', 'contacted') and not g.internal and g.tenant_id is null),
      'ads', jsonb_build_object(
          'budgetCents', (select case when jsonb_typeof(s.value) = 'number' then (s.value #>> '{}')::numeric end from private.hub_settings s where s.key = 'ads.monthly_budget_cents'),
          'launched', (select count(*) from private.agent_actions a where a.kind in ('social.campaign_create', 'social.google_campaign') and a.status = 'executed'
                        and a.updated_at >= date_trunc('month', now() at time zone 'America/New_York') at time zone 'America/New_York'),
          'live', (select count(*) from private.creative_assets where status = 'live'),
          'approved', (select count(*) from private.creative_assets where status = 'approved'))));
end; $$;
revoke all on function private.agent_watchdog_facts() from public, anon, authenticated, service_role;
grant execute on function private.agent_watchdog_facts() to hub_app_server;
