-- Autonomy steps: how a kind of work moves from "the owner approves each one" to "the agent does it on its own".
--
-- Each step is one kind of work the owner chose to hand over (account emails, support answers, article publishing, offers). A step
-- starts with a supervised week: the agents involved are set to propose (nothing goes out unless the owner approves it), and the step
-- records when the week ends. When it ends, the Chief of Staff's hourly task switches the step to automatic: each agent involved is set
-- to act and the step's action kinds (or email templates) are added to its auto-approval list, in one transaction, with an audit row.
-- The owner can keep approving at any time ("hold"), which takes those kinds back off the list, or make a step automatic early.
--
-- A step whose code is not on the Hub yet (its feature is not declared) stays supervised past its date and switches as soon as the
-- code arrives. What a step changes is data written here by migrations; no role can read or write the table, and every change goes
-- through the operations below.
create table private.agent_autonomy_steps (
  category text primary key check (category ~ '^[a-z][a-z_]{2,39}$'),
  label text not null check (char_length(label) between 3 and 80),
  requires_feature text not null check (requires_feature ~ '^[a-z0-9.-]{3,80}$'),
  -- [{"agent": key, "config_key": "auto_approve_kinds" | "auto_send_templates", "values": [...]}]
  changes jsonb not null check (jsonb_typeof(changes) = 'array' and jsonb_array_length(changes) between 1 and 4),
  status text not null default 'off' check (status in ('off', 'supervised', 'automatic', 'held')),
  supervised_since timestamptz,
  automatic_at timestamptz,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  check (status <> 'supervised' or (supervised_since is not null and automatic_at is not null and automatic_at > supervised_since)),
  check (status <> 'automatic' or automatic_at is not null)
);
alter table private.agent_autonomy_steps enable row level security;
revoke all on private.agent_autonomy_steps from public, anon, authenticated, service_role, hub_app_server;

insert into private.agent_autonomy_steps (category, label, requires_feature, changes) values
  ('account_emails', 'Account emails', 'platform.agents.lifecycle.v1',
    '[{"agent": "account_manager", "config_key": "auto_send_templates", "values": ["welcome", "setup_nudge", "trial_checkin", "testimonial_ask"]}]'),
  ('support_answers', 'Support answers', 'platform.agents.concierge-autosend.v1',
    '[{"agent": "support_concierge", "config_key": "auto_approve_kinds", "values": ["communication.answer"]}]'),
  ('articles', 'Article publishing', 'platform.agents.content-autopublish.v1',
    '[{"agent": "content_marketer", "config_key": "auto_approve_kinds", "values": ["content.publish"]}]'),
  ('offers', 'Offers', 'platform.agents.offers.v1',
    '[{"agent": "account_manager", "config_key": "auto_approve_kinds", "values": ["offer.apply"]}]')
on conflict (category) do nothing;

-- The Chief of Staff checks every hour whether a supervised week has ended. It changes nothing of its own: the switch is the owner's
-- choice, made when the week started.
insert into private.agent_schedules (agent_key, task_kind, cadence, every_seconds, at_local, timezone, requires_session, next_run_at)
values ('chief_of_staff', 'autonomy.graduate', 'interval', 3600, null, 'America/New_York', false, now())
on conflict (agent_key, task_kind) do nothing;

-- One step as the owner's screen and the server see it. Whether its code is on the Hub is read from the declared features.
create function private.agent_autonomy_step_json(p_step private.agent_autonomy_steps) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'category', p_step.category, 'label', p_step.label, 'status', p_step.status,
    'supervisedSince', p_step.supervised_since, 'automaticAt', p_step.automatic_at,
    'changedAt', p_step.changed_at,
    'ready', coalesce((hub.get_backend_contract() -> 'features') ? p_step.requires_feature, false),
    'agents', (select coalesce(jsonb_agg(distinct c ->> 'agent'), '[]'::jsonb) from jsonb_array_elements(p_step.changes) c));
$$;

-- Adds (p_add) or takes back (not p_add) one step's values on one agent's list. A value another automatic step also adds stays.
create function private.agent_autonomy_change(p_category text, p_change jsonb, p_add boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_agent text := p_change ->> 'agent';
  v_key text := p_change ->> 'config_key';
  v_values text[];
  v_current text[];
  v_kept text[];
begin
  if v_key is null or v_key not in ('auto_approve_kinds', 'auto_send_templates') or jsonb_typeof(p_change -> 'values') is distinct from 'array' then
    raise exception 'An autonomy step names an unknown setting.' using errcode = '22023';
  end if;
  select coalesce(array_agg(value order by value), array[]::text[]) into v_values from jsonb_array_elements_text(p_change -> 'values');
  if exists (select 1 from unnest(v_values) value where value !~ '^[a-z][a-z0-9_.]{1,60}$') then
    raise exception 'An autonomy step names an invalid value.' using errcode = '22023';
  end if;
  select coalesce(array_agg(value order by value), array[]::text[]) into v_current
  from private.agents a cross join lateral jsonb_array_elements_text(
    case when jsonb_typeof(a.config -> v_key) = 'array' then a.config -> v_key else '[]'::jsonb end) value
  where a.key = v_agent;
  if not exists (select 1 from private.agents where key = v_agent) then
    raise exception 'An autonomy step names an unknown agent.' using errcode = 'P0002';
  end if;
  if p_add then
    v_kept := array(select distinct value from unnest(v_current || v_values) value order by value);
  else
    -- Keep what this step did not add, and what another automatic step adds to the same agent's same list.
    v_kept := array(select kept.item from unnest(v_current) as kept(item)
      where kept.item <> all (v_values)
         or exists (select 1 from private.agent_autonomy_steps other cross join lateral jsonb_array_elements(other.changes) as c(change)
                    where other.category <> p_category and other.status = 'automatic'
                      and c.change ->> 'agent' = v_agent and c.change ->> 'config_key' = v_key and (c.change -> 'values') ? kept.item)
      order by kept.item);
  end if;
  update private.agents
  set config = jsonb_set(config, array[v_key], to_jsonb(v_kept)),
      autonomy = case when p_add then 'act' else autonomy end,
      updated_at = now()
  where key = v_agent;
end;
$$;

-- The one place a step changes. 'supervise' starts a supervised week from now; 'hold' keeps the owner approving everything;
-- 'automatic' hands the work over now (the code must be on the Hub). Every change is audited.
create function private.agent_autonomy_apply(p_category text, p_action text, p_actor uuid, p_source text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_step private.agent_autonomy_steps%rowtype;
  v_change jsonb;
  v_from text;
begin
  if p_action is null or p_action not in ('supervise', 'hold', 'automatic') then
    raise exception 'Choose supervise, hold or automatic.' using errcode = '22023';
  end if;
  select * into v_step from private.agent_autonomy_steps where category = p_category for update;
  if not found then
    raise exception 'Unknown autonomy step.' using errcode = 'P0002';
  end if;
  v_from := v_step.status;

  if p_action = 'automatic' then
    if v_step.status = 'automatic' then
      return private.agent_autonomy_step_json(v_step);
    end if;
    if not coalesce((hub.get_backend_contract() -> 'features') ? v_step.requires_feature, false) then
      raise exception 'The code for this step is not on the Hub yet, so it cannot run on its own.' using errcode = '55000';
    end if;
    -- Agents are changed in key order, so two steps switching at once cannot deadlock.
    for v_change in select c from jsonb_array_elements(v_step.changes) c order by c ->> 'agent' loop
      perform 1 from private.agents where key = v_change ->> 'agent' for update;
    end loop;
    update private.agent_autonomy_steps
    set status = 'automatic', automatic_at = now(), changed_at = now(), changed_by = p_actor
    where category = p_category;
    for v_change in select c from jsonb_array_elements(v_step.changes) c order by c ->> 'agent' loop
      perform private.agent_autonomy_change(p_category, v_change, true);
    end loop;
  else
    for v_change in select c from jsonb_array_elements(v_step.changes) c order by c ->> 'agent' loop
      perform 1 from private.agents where key = v_change ->> 'agent' for update;
    end loop;
    -- Leaving automatic: the step is no longer automatic before its values are taken back, so they are not kept on its account.
    update private.agent_autonomy_steps
    set status = case p_action when 'supervise' then 'supervised' else 'held' end,
        supervised_since = case p_action when 'supervise' then now() else supervised_since end,
        automatic_at = case p_action when 'supervise' then now() + interval '7 days' else null end,
        changed_at = now(), changed_by = p_actor
    where category = p_category;
    if v_step.status = 'automatic' then
      for v_change in select c from jsonb_array_elements(v_step.changes) c order by c ->> 'agent' loop
        perform private.agent_autonomy_change(p_category, v_change, false);
      end loop;
    end if;
    -- Supervision needs proposals: an agent that can only observe is moved up to propose. One already acting stays, with this
    -- step's values off its list, so it proposes this work and keeps doing anything else it was trusted with.
    update private.agents set autonomy = 'propose', updated_at = now()
    where autonomy = 'observe' and key in (select c ->> 'agent' from jsonb_array_elements(v_step.changes) c);
  end if;

  insert into private.audit_events (actor_id, action, entity_type, metadata)
  values (p_actor, 'agent.autonomy_step', 'agent', jsonb_build_object('category', p_category, 'from', v_from,
    'to', (select status from private.agent_autonomy_steps where category = p_category), 'source', p_source));
  return (select private.agent_autonomy_step_json(s) from private.agent_autonomy_steps s where s.category = p_category);
end;
$$;

-- Server: the supervised steps whose week has ended, and those ending within a day (for the owner's reminder).
create function private.agent_autonomy_due() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  return jsonb_build_object(
    'due', (select coalesce(jsonb_agg(private.agent_autonomy_step_json(s) order by s.automatic_at, s.category), '[]'::jsonb)
            from private.agent_autonomy_steps s where s.status = 'supervised' and s.automatic_at <= now()),
    'soon', (select coalesce(jsonb_agg(private.agent_autonomy_step_json(s) order by s.automatic_at, s.category), '[]'::jsonb)
             from private.agent_autonomy_steps s where s.status = 'supervised' and s.automatic_at > now() and s.automatic_at <= now() + interval '1 day'));
end;
$$;

-- Server: switch one step whose supervised week has ended. A step that is no longer due (the owner held it, or it changed) or whose
-- code is missing is left as it is and says why.
create function private.agent_autonomy_graduate(p_category text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_step private.agent_autonomy_steps%rowtype;
begin
  perform private.require_hub_app_server();
  select * into v_step from private.agent_autonomy_steps where category = p_category for update;
  if not found then
    raise exception 'Unknown autonomy step.' using errcode = 'P0002';
  end if;
  if v_step.status <> 'supervised' or v_step.automatic_at > now() then
    return jsonb_build_object('graduated', false, 'reason', 'not_due', 'step', private.agent_autonomy_step_json(v_step));
  end if;
  if not coalesce((hub.get_backend_contract() -> 'features') ? v_step.requires_feature, false) then
    return jsonb_build_object('graduated', false, 'reason', 'code_missing', 'step', private.agent_autonomy_step_json(v_step));
  end if;
  return jsonb_build_object('graduated', true, 'step', private.agent_autonomy_apply(p_category, 'automatic', null, 'schedule'));
end;
$$;

-- Owner: every step, for the AI team page.
create function hub.get_agent_autonomy() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform hub.authorize_app_admin();
  return (select coalesce(jsonb_agg(private.agent_autonomy_step_json(s) order by s.category), '[]'::jsonb) from private.agent_autonomy_steps s);
end;
$$;

-- Owner: start a supervised week, keep approving, or hand the work over now. A stale screen is refused.
create function hub.set_agent_autonomy_step(p_category text, p_action text, p_expected_changed_at timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor jsonb;
  v_changed timestamptz;
begin
  v_actor := hub.authorize_app_command();
  select changed_at into v_changed from private.agent_autonomy_steps where category = p_category;
  if not found then
    raise exception 'Unknown autonomy step.' using errcode = 'P0002';
  end if;
  if v_changed is distinct from p_expected_changed_at then
    raise exception 'This step changed. Refresh and review again.' using errcode = '40001';
  end if;
  return private.agent_autonomy_apply(p_category, p_action, (v_actor ->> 'user_id')::uuid, 'owner');
end;
$$;

revoke all on function
  private.agent_autonomy_step_json(private.agent_autonomy_steps),
  private.agent_autonomy_change(text, jsonb, boolean),
  private.agent_autonomy_apply(text, text, uuid, text),
  private.agent_autonomy_due(),
  private.agent_autonomy_graduate(text)
from public, anon, authenticated, service_role, hub_app_server;
grant execute on function private.agent_autonomy_due(), private.agent_autonomy_graduate(text) to hub_app_server;

revoke all on function hub.get_agent_autonomy(), hub.set_agent_autonomy_step(text, text, timestamptz) from public, anon, service_role;
grant execute on function hub.get_agent_autonomy(), hub.set_agent_autonomy_step(text, text, timestamptz) to authenticated;
