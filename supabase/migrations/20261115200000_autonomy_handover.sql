-- Four more kinds of work the owner hands over (owner decision 2026-11-15: the owner is the only person at CareMetric, so the AI team
-- stops waiting for his approval on these). Each is an autonomy step (20261104220000_agent_autonomy.sql) that ships HELD: nothing changes
-- until the owner, or the engineer deploying this for him, switches it to automatic:
--
--   select private.agent_autonomy_apply('<category>', 'automatic', null, 'owner_decision_2026_11_15');
--
-- The step adds its values to the agent's auto_approve_kinds and sets the agent to Act, in one transaction, with an audit row; "Keep
-- approving" on the AI team page takes them back off. The four steps:
--
-- 1. named_contacts ("Named people's email addresses"): the trust value growth.named_contact on the Marketing Manager. A decision-maker's
--    work address that the agency publishes on its own site, or that the agency's mail server confirmed, is permitted for outreach on its
--    own instead of waiting on the Growth screen (private.growth_person_address below). A guess nobody confirmed is never recorded at all,
--    an imported list still waits, a suppressed address is still refused, and a business where a contact opted out or that said "not
--    interested" or "not now" still waits for the owner. Sending to the person is still cold email under its own step and caps.
-- 2. learning_memo ("Learning memo"): the trust value growth.learning_memo on the Marketing Manager. The Monday memo is used at once, as
--    if the owner had chosen "Use this memo", with the same audit row (private.growth_learning_propose below).
-- 3. ad_campaigns ("Ad campaign launch"): social.campaign_create and social.google_campaign on the Social Media Manager. The monthly
--    campaign is approved on its own and launched live by the server with its first ad from creative the owner already approved, within
--    the owner's caps: each live launch reserves its daily budget for the rest of its month here first (private.ads_launch_reserve), so
--    all of a month's automatic launches together never pass Settings -> Paid ads -> "Most to spend on new campaigns a month", no daily
--    budget passes Settings -> Social media -> "Most any ad may spend per day", and a live campaign ends with its month.
-- 4. founder_posts ("Founder posts"): social.founder_post on the Social Media Manager. Posts for the founder's own LinkedIn profile publish
--    at their time slot through the existing executor; without his personal token they are still emailed to copy.
--
-- The database used to refuse an automatic approval of a campaign or a founder post outright (agent_actions_campaign_check,
-- agent_actions_founder_post_check). Those checks keep everything else they checked; the refusal becomes a trigger that admits an
-- automatic approval only while the matching step is automatic. Approved automatically, a campaign or founder post is also re-checked
-- when it is carried out (private.agent_action_trusted): a pause, a level change or "Keep approving" stops it.
--
-- The steps ask for no minimum of the owner's decisions (min_reviewed 0): the two growth steps create no actions the evidence could count,
-- and the owner chose to hand all four over without a supervised week's evidence, so the watchdog does not flag them every morning. A
-- supervised week, if the owner starts one, still holds a step whose decisions were turned down too often.
--
-- 20261115200100_autonomy_handover_contract.sql declares platform.agents.autonomy-handover.v1, which the steps require and the server reads.
set local lock_timeout = '10s';

-- ---------------------------------------------------------------------------------------
-- 1. The four steps, held.
-- ---------------------------------------------------------------------------------------
insert into private.agent_autonomy_steps (category, label, requires_feature, changes, status, min_reviewed) values
  ('named_contacts', 'Named people''s email addresses', 'platform.agents.autonomy-handover.v1',
    '[{"agent": "marketing_manager", "config_key": "auto_approve_kinds", "values": ["growth.named_contact"]}]', 'held', 0),
  ('learning_memo', 'Learning memo', 'platform.agents.autonomy-handover.v1',
    '[{"agent": "marketing_manager", "config_key": "auto_approve_kinds", "values": ["growth.learning_memo"]}]', 'held', 0),
  ('ad_campaigns', 'Ad campaign launch', 'platform.agents.autonomy-handover.v1',
    '[{"agent": "social_manager", "config_key": "auto_approve_kinds", "values": ["social.campaign_create", "social.google_campaign"]}]', 'held', 0),
  ('founder_posts', 'Founder posts', 'platform.agents.autonomy-handover.v1',
    '[{"agent": "social_manager", "config_key": "auto_approve_kinds", "values": ["social.founder_post"]}]', 'held', 0)
on conflict (category) do nothing;

-- ---------------------------------------------------------------------------------------
-- 2. Campaigns and founder posts: approved automatically only while their step is automatic.
-- ---------------------------------------------------------------------------------------
alter table private.agent_actions drop constraint if exists agent_actions_campaign_check;
alter table private.agent_actions add constraint agent_actions_campaign_check check (
  kind not in ('social.campaign_create', 'social.google_campaign') or coalesce(agent_key = 'social_manager' and target_kind = 'social_item'
    and target_id ~ '^(meta|linkedin|google):(carebase|caremetric-intel):[0-9]{4}-[0-9]{2}$', false)) not valid;
alter table private.agent_actions validate constraint agent_actions_campaign_check;

alter table private.agent_actions drop constraint if exists agent_actions_founder_post_check;
alter table private.agent_actions add constraint agent_actions_founder_post_check check (
  kind <> 'social.founder_post' or coalesce(agent_key = 'social_manager' and target_kind = 'social_item'
    and target_id ~ '^founder:[0-9]{4}-[0-9]{2}-[0-9]{2}:[1-5]$', false)) not valid;
alter table private.agent_actions validate constraint agent_actions_founder_post_check;

-- An action of these kinds becomes automatically approved (proposed so, or moved there from a state the owner decides) only while the
-- owner's step for it is automatic. A hand-back from an execution that had started (a post waiting for its slot, a restart) keeps the
-- approval it already had. The error is a check violation, as the constraints' refusal was.
create or replace function private.agent_actions_handover_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_category text := case when new.kind = 'social.founder_post' then 'founder_posts' else 'ad_campaigns' end;
begin
  if tg_op = 'UPDATE' and old.status in ('auto_approved', 'executing') then
    return new;
  end if;
  if not exists (select 1 from private.agent_autonomy_steps where category = v_category and status = 'automatic') then
    raise exception 'This kind of action is approved automatically only while the owner has handed it over.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.agent_actions_handover_guard() from public, anon, authenticated, service_role, hub_app_server;
drop trigger if exists agent_actions_handover_guard on private.agent_actions;
create trigger agent_actions_handover_guard before insert or update of status on private.agent_actions
  for each row when (new.status = 'auto_approved' and new.kind in ('social.founder_post', 'social.campaign_create', 'social.google_campaign'))
  execute function private.agent_actions_handover_guard();

-- Server: whether an action being carried out may still go ahead. One the owner approved may; one approved automatically only while its
-- agent is active, on Act and trusted with its kind (and, for a campaign or founder post, its step is automatic), checked now.
create or replace function private.agent_action_trusted(p_action uuid, p_execution integer) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_action private.agent_actions%rowtype;
  v_agent private.agents%rowtype;
begin
  perform private.require_hub_app_server();
  select * into v_action from private.agent_actions where id = p_action;
  if not found or v_action.status <> 'executing' or p_execution is null or v_action.executions <> p_execution then
    return false;
  end if;
  if v_action.decided_by is not null and v_action.decided_at is not null then
    return true;
  end if;
  select * into v_agent from private.agents where key = v_action.agent_key;
  return found and v_agent.status = 'active' and v_agent.autonomy = 'act'
    and jsonb_typeof(v_agent.config -> 'auto_approve_kinds') = 'array' and (v_agent.config -> 'auto_approve_kinds') ? v_action.kind
    and (v_action.kind not in ('social.founder_post', 'social.campaign_create', 'social.google_campaign')
      or exists (select 1 from private.agent_autonomy_steps s where s.status = 'automatic'
                   and s.category = case when v_action.kind = 'social.founder_post' then 'founder_posts' else 'ad_campaigns' end));
end;
$$;
revoke all on function private.agent_action_trusted(uuid, integer) from public, anon, authenticated, service_role;
grant execute on function private.agent_action_trusted(uuid, integer) to hub_app_server;

-- A founder post approved automatically and handed back to wait for its slot stays automatically approved (it went back to approved
-- before, since nothing but the owner could approve one). Every other rule is unchanged (20261113260000_founder_post_schedule.sql).
create or replace function private.social_schedule(p_action uuid, p_execution integer) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_action private.agent_actions%rowtype;
  v_at timestamptz;
begin
  perform private.require_hub_app_server();
  select * into v_action from private.agent_actions
   where id = p_action and (kind = 'social.post' or kind = 'social.founder_post') and agent_key = 'social_manager' for update;
  if not found then return false; end if;
  begin
    v_at := (v_action.input ->> 'scheduledFor')::timestamptz;
  exception when others then
    return false;
  end;
  if v_at is null or v_at > now() + interval '8 days' then return false; end if;
  if v_action.status in ('proposed', 'approved', 'auto_approved') then
    update private.agent_actions set not_before = greatest(v_at, now()), updated_at = now() where id = v_action.id;
    return true;
  end if;
  if v_action.status = 'executing' and v_action.executions = p_execution then
    update private.agent_actions set status = case when decided_by is null then 'auto_approved' else 'approved' end,
      executing_at = null, not_before = greatest(v_at, now() + interval '1 minute'), updated_at = now()
    where id = v_action.id;
    return true;
  end if;
  return false;
end;
$$;
revoke all on function private.social_schedule(uuid, integer) from public, anon, authenticated, service_role;
grant execute on function private.social_schedule(uuid, integer) to hub_app_server;

-- ---------------------------------------------------------------------------------------
-- 3. Live campaigns stay within the owner's monthly number.
-- ---------------------------------------------------------------------------------------
-- One row per campaign launched live on its own: its daily budget for the days left in its month. Closed to every role.
create table if not exists private.ads_launch_reservations (
  action_id uuid primary key references private.agent_actions(id) on delete cascade,
  month text not null check (month ~ '^[0-9]{4}-[0-9]{2}$'),
  platform text not null check (platform in ('meta', 'linkedin', 'google')),
  daily_cents integer not null check (daily_cents > 0),
  days integer not null check (days between 1 and 31),
  committed_cents integer not null check (committed_cents > 0 and committed_cents = daily_cents * days),
  created_at timestamptz not null default now()
);
create index if not exists ads_launch_reservations_month on private.ads_launch_reservations (month);
alter table private.ads_launch_reservations enable row level security;
revoke all on private.ads_launch_reservations from public, anon, authenticated, service_role, hub_app_server;

-- A whole-number setting in cents, or null when it is not set (or not a whole number).
create or replace function private.ads_setting_cents(p_key text) returns integer
language sql stable set search_path = '' as $$
  select case when jsonb_typeof(s.value) = 'number' and (s.value #>> '{}') ~ '^[0-9]{1,9}$' then (s.value #>> '{}')::integer end
  from private.hub_settings s where s.key = p_key;
$$;
revoke all on function private.ads_setting_cents(text) from public, anon, authenticated, service_role, hub_app_server;

-- Server: reserve a campaign's share of this month before it is launched live. Only for a campaign approved automatically under the
-- owner's hand-over, checked now with the agent row held, while it is being carried out and in its own month (Eastern). The daily budget
-- is the one asked for, lowered to what the month's number has left for the days remaining and to the daily ad-set limit; below the
-- platform's least daily budget (p_min) nothing is reserved and the campaign is created paused, as an owner-approved one is. Asking again
-- for the same action returns its reservation.
create or replace function private.ads_launch_reserve(p_action uuid, p_execution integer, p_daily integer, p_min integer, p_days integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_action private.agent_actions%rowtype;
  v_agent private.agents%rowtype;
  v_row private.ads_launch_reservations%rowtype;
  v_month text;
  v_platform text;
  v_cap integer;
  v_daily_cap integer;
  v_used bigint;
  v_daily bigint;
begin
  perform private.require_hub_app_server();
  if p_daily is null or p_daily < 1 or p_min is null or p_min < 1 or p_days is null or p_days < 1 or p_days > 31 then
    raise exception 'Invalid reservation' using errcode = '22023';
  end if;
  -- One reservation at a time, so two servers cannot both find the same money left.
  perform pg_advisory_xact_lock(hashtextextended('ads.launch', 0));
  select * into v_action from private.agent_actions where id = p_action for update;
  if not found or v_action.kind not in ('social.campaign_create', 'social.google_campaign') or v_action.status <> 'executing'
    or p_execution is null or v_action.executions <> p_execution then
    return jsonb_build_object('reserved', false, 'reason', 'not_executing');
  end if;
  if v_action.decided_by is not null then
    -- The owner's own approval creates the campaign paused, exactly as before; it is never launched live here.
    return jsonb_build_object('reserved', false, 'reason', 'owner_approved');
  end if;
  select * into v_agent from private.agents where key = v_action.agent_key for share;
  if not found or v_agent.status <> 'active' or v_agent.autonomy <> 'act' or jsonb_typeof(v_agent.config -> 'auto_approve_kinds') <> 'array'
    or not ((v_agent.config -> 'auto_approve_kinds') ? v_action.kind)
    or not exists (select 1 from private.agent_autonomy_steps where category = 'ad_campaigns' and status = 'automatic') then
    return jsonb_build_object('reserved', false, 'reason', 'approval_required');
  end if;
  select * into v_row from private.ads_launch_reservations where action_id = p_action;
  if found then
    return jsonb_build_object('reserved', true, 'already', true, 'dailyBudgetCents', v_row.daily_cents, 'days', v_row.days, 'committedCents', v_row.committed_cents);
  end if;
  v_platform := split_part(v_action.target_id, ':', 1);
  v_month := split_part(v_action.target_id, ':', 3);
  if v_month <> to_char(now() at time zone 'America/New_York', 'YYYY-MM') then
    return jsonb_build_object('reserved', false, 'reason', 'month_over');
  end if;
  v_cap := private.ads_setting_cents('ads.monthly_budget_cents');
  if v_cap is null or v_cap <= 0 then
    return jsonb_build_object('reserved', false, 'reason', 'no_monthly_budget');
  end if;
  v_daily_cap := private.ads_setting_cents('social.max_daily_budget_cents');
  select coalesce(sum(committed_cents), 0) into v_used from private.ads_launch_reservations where month = v_month;
  v_daily := least(p_daily::bigint, greatest(v_cap - v_used, 0) / p_days);
  if v_daily_cap is not null and v_daily_cap > 0 then
    v_daily := least(v_daily, v_daily_cap);
  end if;
  if v_daily < p_min then
    return jsonb_build_object('reserved', false, 'reason', 'monthly_budget_used', 'remainingCents', greatest(v_cap - v_used, 0), 'monthlyCapCents', v_cap);
  end if;
  insert into private.ads_launch_reservations (action_id, month, platform, daily_cents, days, committed_cents)
  values (p_action, v_month, v_platform, v_daily, p_days, v_daily * p_days);
  insert into private.audit_events (actor_id, action, entity_type, entity_id, metadata)
  values (null, 'ads.launch_reserved', 'agent_action', p_action, jsonb_build_object('platform', v_platform, 'month', v_month,
    'dailyBudgetCents', v_daily, 'days', p_days, 'committedCents', v_daily * p_days, 'monthlyCapCents', v_cap, 'usedCents', v_used + v_daily * p_days));
  return jsonb_build_object('reserved', true, 'dailyBudgetCents', v_daily, 'days', p_days, 'committedCents', v_daily * p_days,
    'monthlyCapCents', v_cap, 'usedCents', v_used + v_daily * p_days);
end;
$$;

-- Server: give a reservation back when the campaign was not launched (it stays paused), while the same execution is still running.
create or replace function private.ads_launch_release(p_action uuid, p_execution integer) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  perform pg_advisory_xact_lock(hashtextextended('ads.launch', 0));
  delete from private.ads_launch_reservations r
  where r.action_id = p_action
    and exists (select 1 from private.agent_actions a where a.id = p_action and a.status = 'executing' and p_execution is not null and a.executions = p_execution);
  if found then
    insert into private.audit_events (actor_id, action, entity_type, entity_id, metadata)
    values (null, 'ads.launch_released', 'agent_action', p_action, '{}'::jsonb);
  end if;
  return found;
end;
$$;
revoke all on function private.ads_launch_reserve(uuid, integer, integer, integer, integer), private.ads_launch_release(uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function private.ads_launch_reserve(uuid, integer, integer, integer, integer), private.ads_launch_release(uuid, integer) to hub_app_server;

-- ---------------------------------------------------------------------------------------
-- 4. Named people's addresses: permitted on their own while handed over.
-- ---------------------------------------------------------------------------------------
-- Server: the work address found for one person, and how ('published' with its page on the business's own site, or 'mail_server'). Every
-- earlier rule is unchanged (20261113290000_growth_people_finder.sql): the business's own domain, never suppressed or taken. While the
-- owner has handed named people's addresses over (the Marketing Manager active, on Act and trusted with growth.named_contact, read with
-- its row held), the address is permitted on its own and becomes the contact of the business's opportunities that were never emailed,
-- exactly as the owner's "Permit" does, with the same audit row (no actor: the owner's standing hand-over). It still waits for the owner
-- when a contact at the business opted out or the business said "not interested" or "not now".
create or replace function private.growth_person_address(p_person uuid, p_email text, p_name text, p_found text, p_source_url text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p private.growth_people%rowtype; g private.growth_organizations%rowtype; v_email text := lower(btrim(p_email)); v_contact uuid; v_host text; v_page text;
  v_agent private.agents%rowtype; v_auto boolean := false;
begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
 select * into p from private.growth_people where id = p_person for update;
 if not found then raise exception 'Unknown person' using errcode = '22023'; end if;
 select * into g from private.growth_organizations where id = p.organization_id;
 v_host := split_part(coalesce(v_email, ''), '@', 2);
 if v_email !~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$' or char_length(v_email) > 320 or (v_host <> g.domain and v_host not like '%.' || g.domain) then
  raise exception 'A found address must be a work address on the business''s own domain' using errcode = '22023';
 end if;
 v_page := lower(split_part(split_part(coalesce(p_source_url, ''), '://', 2), '/', 1));
 if p_found is null or p_found not in ('published', 'mail_server')
   or (p_found = 'published' and (p_source_url is null or p_source_url !~ '^https://' or char_length(p_source_url) > 2000 or v_page not in (g.domain, 'www.' || g.domain)))
   or (p_found = 'mail_server' and p_source_url is not null) then
  raise exception 'A published address needs its page on the business''s own site; a confirmed one has none' using errcode = '22023';
 end if;
 if exists (select 1 from private.email_suppressions where email_hash = encode(extensions.digest(v_email, 'sha256'), 'hex')) then
  return jsonb_build_object('found', false, 'reason', 'suppressed');
 end if;
 if exists (select 1 from private.growth_contacts where email = v_email) then return jsonb_build_object('found', false, 'reason', 'taken'); end if;
 -- The owner's hand-over, checked now. An address the business published or its mail server confirmed is all that reaches here.
 select * into v_agent from private.agents where key = 'marketing_manager' for share;
 v_auto := found and v_agent.status = 'active' and v_agent.autonomy = 'act'
   and jsonb_typeof(v_agent.config -> 'auto_approve_kinds') = 'array' and (v_agent.config -> 'auto_approve_kinds') ? 'growth.named_contact'
   and not g.internal and g.tenant_id is null
   and not exists (select 1 from private.growth_contacts c where c.organization_id = g.id and c.eligibility = 'opted_out')
   and not exists (select 1 from private.customer_activity_events e where e.organization_id = g.id and e.kind in ('negative_reply', 'not_now'));
 -- Recorded for review first, exactly as before; the hand-over then permits it below, as the owner's "Permit" does.
 insert into private.growth_contacts(organization_id, email, name, role, eligibility, verified_at, source_url, source_kind)
 values (g.id, v_email, left(coalesce(nullif(btrim(p_name), ''), p.name), 200), p.title, 'review', now(), p_source_url, 'enriched')
 returning id into v_contact;
 update private.growth_people set contact_id = v_contact, address_found = p_found, name = left(coalesce(nullif(btrim(p_name), ''), name), 200), observed_at = now()
  where id = p.id;
 insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
 values (null, 'growth.person_found', 'growth', g.id, jsonb_build_object('contact', v_contact, 'source', p.source, 'found', p_found));
 if v_auto then
  -- As hub.growth_people_decide's "permit": the contact permitted, the opportunity's contact where the business was never emailed, and
  -- unsent drafts to another contact of those opportunities cancelled.
  update private.growth_contacts set eligibility = 'permitted', verified_at = coalesce(verified_at, now()), version = version + 1 where id = v_contact;
  update private.growth_opportunities o set contact_id = v_contact, version = o.version + 1, updated_at = now()
   where o.organization_id = g.id and o.owner_agent = 'marketing_manager'
     and not exists (select 1 from private.growth_messages m where m.opportunity_id = o.id and m.purpose = 'marketing' and m.attempted_at is not null);
  update private.growth_messages set status = 'cancelled' where status in ('draft', 'proposed') and purpose = 'marketing'
    and opportunity_id in (select id from private.growth_opportunities where organization_id = g.id and contact_id = v_contact)
    and contact_id <> v_contact;
  insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
  values (null, 'growth.person_permitted', 'growth', g.id, jsonb_build_object('contact', v_contact, 'approval', 'automatic', 'found', p_found));
 end if;
 return jsonb_build_object('found', true, 'contactId', v_contact, 'eligibility', case when v_auto then 'permitted' else 'review' end);
end; $$;
revoke all on function private.growth_person_address(uuid, text, text, text, text) from public, anon, authenticated, service_role;
grant execute on function private.growth_person_address(uuid, text, text, text, text) to hub_app_server;

-- ---------------------------------------------------------------------------------------
-- 5. The learning memo: used on its own while handed over.
-- ---------------------------------------------------------------------------------------
-- Server: a new memo. While the owner has handed the learning memo over (the Marketing Manager active, on Act and trusted with
-- growth.learning_memo), it is used at once: the product's active memo retires and this one is active, with the audit row the owner's
-- "Use this memo" writes (no actor: the owner's standing hand-over). Otherwise it is proposed for the owner, as before, replacing an
-- undecided proposal. The same text as the waiting proposal is not proposed again; while handed over, that proposal is used.
create or replace function private.growth_learning_propose(p_product text, p_memo text, p_stats jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_version integer; v_id uuid; v_existing private.growth_learning_memos%rowtype; v_agent private.agents%rowtype; v_auto boolean := false; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
 if p_product not in ('carebase', 'caremetric-intel') or char_length(coalesce(p_memo, '')) not between 1 and 2000 or jsonb_typeof(p_stats) <> 'object' then
  raise exception 'Invalid memo' using errcode = '22023';
 end if;
 select * into v_agent from private.agents where key = 'marketing_manager' for share;
 v_auto := found and v_agent.status = 'active' and v_agent.autonomy = 'act'
   and jsonb_typeof(v_agent.config -> 'auto_approve_kinds') = 'array' and (v_agent.config -> 'auto_approve_kinds') ? 'growth.learning_memo';
 select * into v_existing from private.growth_learning_memos where product = p_product and memo = p_memo and status in ('proposed', 'active')
  order by created_at desc limit 1;
 if found then
  if v_existing.status = 'proposed' and v_auto then
   update private.growth_learning_memos set status = 'retired', decided_at = now() where product = p_product and status = 'active';
   update private.growth_learning_memos set status = 'active', decided_at = now() where id = v_existing.id;
   insert into private.audit_events(actor_id, action, entity_type, metadata)
   values (null, 'growth.memo_activated', 'growth', jsonb_build_object('product', p_product, 'version', v_existing.version, 'approval', 'automatic'));
   return jsonb_build_object('proposed', false, 'reason', 'unchanged', 'activated', true, 'version', v_existing.version);
  end if;
  return jsonb_build_object('proposed', false, 'reason', 'unchanged');
 end if;
 update private.growth_learning_memos set status = 'rejected', decided_at = now() where product = p_product and status = 'proposed';
 select coalesce(max(version), 0) + 1 into v_version from private.growth_learning_memos where product = p_product;
 insert into private.growth_learning_memos(product, version, memo, stats) values (p_product, v_version, p_memo, p_stats) returning id into v_id;
 if v_auto then
  update private.growth_learning_memos set status = 'retired', decided_at = now() where product = p_product and status = 'active';
  update private.growth_learning_memos set status = 'active', decided_at = now() where id = v_id;
  insert into private.audit_events(actor_id, action, entity_type, metadata)
  values (null, 'growth.memo_activated', 'growth', jsonb_build_object('product', p_product, 'version', v_version, 'approval', 'automatic'));
 end if;
 return jsonb_build_object('proposed', true, 'id', v_id, 'version', v_version, 'activated', v_auto);
end; $$;
revoke all on function private.growth_learning_propose(text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function private.growth_learning_propose(text, text, jsonb) to hub_app_server;
