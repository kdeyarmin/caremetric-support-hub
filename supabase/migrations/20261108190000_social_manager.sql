-- The Social Media Manager: a new member of the AI team that runs CareMetric's Facebook Page, Instagram account and Meta ad account
-- for engagement. Every week it drafts a content plan and proposes each post; every fifteen minutes it looks for new comments and
-- messages and drafts replies; every day it evaluates the ads and proposes pausing, refreshing or re-budgeting them; and every week it
-- sends the owner a performance report. Nothing here sends, posts or spends anything.
--
-- It starts paused, in Propose, trusted with nothing. Three autonomy steps (all off) let the owner hand over, after a supervised
-- week each: publishing posts, replying to comments and messages (and hiding spam), and tuning ads inside their existing budgets
-- (pausing a losing ad, adding a new variant). Raising an ad budget can never be automatic: the database refuses an automatically
-- approved budget change, and the executor refuses one too.
--
-- The Hub stores no social text from other people: comments and messages are read from Meta when they are handled and never copied
-- into a task, a run or an action. An action holds only CareMetric's own words and Meta's ids.

insert into private.agents (key, display_name, role_summary, status, autonomy, model_tier, daily_budget_cents, tool_allowlist, config)
values ('social_manager', 'Social Media Manager',
  'Plans and drafts posts for Facebook, Instagram and LinkedIn, drafts replies to comments and messages, evaluates the ads every day and proposes changes, and reports weekly. Every post, reply and ad change waits for your approval until you hand it over.',
  'paused', 'propose', 'draft', 400, array['social_post', 'social_reply', 'social_ads', 'social_report'], '{"auto_approve_kinds": [], "effort": "medium"}'::jsonb)
on conflict (key) do nothing;

insert into private.agent_schedules (agent_key, task_kind, cadence, every_seconds, at_local, timezone, requires_session, next_run_at) values
  ('social_manager', 'social.inbox', 'interval', 900, null, 'America/New_York', false, now()),
  ('social_manager', 'social.plan', 'daily', null, '08:15', 'America/New_York', false,
   private.agent_schedule_next('daily', null, '08:15', 'America/New_York', now(), null)),
  ('social_manager', 'social.ads', 'daily', null, '09:10', 'America/New_York', false,
   private.agent_schedule_next('daily', null, '09:10', 'America/New_York', now(), null)),
  ('social_manager', 'social.report', 'daily', null, '08:05', 'America/New_York', false,
   private.agent_schedule_next('daily', null, '08:05', 'America/New_York', now(), null))
on conflict (agent_key, task_kind) do nothing;

-- The action kinds and targets, widened (read from the constraints themselves, as every earlier change did), never narrowed.
do $$
declare
  v_kinds text[];
  v_targets text[];
begin
  select coalesce(array_agg(distinct m[1]), array[]::text[]) into v_kinds
  from pg_constraint c cross join lateral regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''', 'g') m
  where c.conrelid = 'private.agent_actions'::regclass and c.conname = 'agent_actions_kind_check';
  select coalesce(array_agg(distinct m[1]), array[]::text[]) into v_targets
  from pg_constraint c cross join lateral regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''', 'g') m
  where c.conrelid = 'private.agent_actions'::regclass and c.conname = 'agent_actions_target_kind_check';
  if not v_kinds @> array['communication.reply', 'email.send', 'content.publish', 'growth.message', 'growth.content', 'email.external']
    or not v_targets @> array['communication', 'billing_account', 'content_item', 'growth_message', 'growth_content', 'external_email']
    or exists (select 1 from unnest(v_kinds || v_targets) value where value !~ '^[a-z][a-z0-9_.]{1,60}$') then
    raise exception 'The agent action kinds could not be read' using errcode = '55000';
  end if;
  execute format('alter table private.agent_actions drop constraint agent_actions_kind_check, add constraint agent_actions_kind_check check (kind in (%s))',
    (select string_agg(quote_literal(k), ', ' order by k) from (select distinct unnest(v_kinds || array['social.post', 'social.reply', 'social.moderate', 'social.ad_pause', 'social.ad_create', 'social.ad_budget']) as k) x));
  execute format('alter table private.agent_actions drop constraint agent_actions_target_kind_check, add constraint agent_actions_target_kind_check check (target_kind in (%s))',
    (select string_agg(quote_literal(k), ', ' order by k) from (select distinct unnest(v_targets || array['social_post', 'social_item', 'social_ad', 'social_adset']) as k) x));
end $$;

-- Social actions belong to the Social Media Manager and name what they act on. A budget change is never automatic.
alter table private.agent_actions add constraint agent_actions_social_check check (
  kind not like 'social.%' or coalesce(
    agent_key = 'social_manager'
    and target_kind = case kind when 'social.post' then 'social_post' when 'social.ad_pause' then 'social_ad' when 'social.ad_create' then 'social_adset'
                                when 'social.ad_budget' then 'social_adset' else 'social_item' end
    and char_length(target_id) between 1 and 200
    and (kind <> 'social.ad_budget' or status <> 'auto_approved'), false));

-- Server: the targets that already have an open social action, so a daily evaluation never proposes the same change twice while the
-- owner has not decided the first. Targets only, never text.
create function private.social_open_targets() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  return (select coalesce(jsonb_agg(distinct a.kind || ':' || a.target_id), '[]'::jsonb) from private.agent_actions a
          where a.agent_key = 'social_manager' and a.kind like 'social.%' and a.status in ('proposed', 'approved', 'auto_approved', 'executing')
            and a.created_at > now() - interval '14 days');
end;
$$;
revoke all on function private.social_open_targets() from public, anon, authenticated, service_role;
grant execute on function private.social_open_targets() to hub_app_server;

-- Server: hold a post until its time slot. A proposed or approved post (approved by the owner or, once handed over, automatically) is
-- not started before its `scheduledFor` (customer growth's not_before, which the ready list and the execution start respect); a post
-- whose execution began early is handed back to its approved state with the same hold. Only a social.post, only within eight days.
create function private.social_schedule(p_action uuid, p_execution integer) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_action private.agent_actions%rowtype;
  v_at timestamptz;
begin
  perform private.require_hub_app_server();
  select * into v_action from private.agent_actions where id = p_action and kind = 'social.post' and agent_key = 'social_manager' for update;
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

insert into private.agent_autonomy_steps (category, label, requires_feature, changes) values
  ('social_posts', 'Social posts', 'platform.agents.social.v1',
    '[{"agent": "social_manager", "config_key": "auto_approve_kinds", "values": ["social.post"]}]'),
  ('social_replies', 'Social replies', 'platform.agents.social.v1',
    '[{"agent": "social_manager", "config_key": "auto_approve_kinds", "values": ["social.reply", "social.moderate"]}]'),
  ('ad_tuning', 'Ad tuning', 'platform.agents.social.v1',
    '[{"agent": "social_manager", "config_key": "auto_approve_kinds", "values": ["social.ad_pause", "social.ad_create"]}]')
on conflict (category) do nothing;
