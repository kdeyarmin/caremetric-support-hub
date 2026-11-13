-- The watchdog and evidence-based hand-over (AI workforce review 2026-11-12, P2: "nobody notices when part of the team stops"; plan
-- 2026-11-13, phase 9):
--
-- - private.agent_watchdog_facts: counts only. Each agent's last run, failed tasks this week, oldest overdue task and whether it has
--   schedules; this week's funnel (prospects found, qualified, emailed, replies); and automatic steps whose owner decisions fall short of
--   today's evidence rule. The morning brief and the Monday scorecard word them (server/agents/tasks/watchdog.mjs).
-- - Hand-over needs evidence, not only a week: a supervised step becomes automatic only when the owner decided at least `min_reviewed`
--   of its actions during supervision and turned down at most `max_rejected_pct` percent of them. Too few decisions: one more supervised
--   week. Too many turned down: the step is held and the owner told. A step already automatic is never undone here, only flagged.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values ('agents.watchdog_idle_days', 'number') on conflict (key) do nothing;

alter table private.agent_autonomy_steps add column if not exists min_reviewed integer not null default 10 check (min_reviewed between 0 and 1000);
alter table private.agent_autonomy_steps add column if not exists max_rejected_pct integer not null default 20 check (max_rejected_pct between 0 and 100);

-- The owner's decisions on a step's own actions since its supervision began: what each change in `changes` lets through (an action kind,
-- a growth message class, an email template).
create function private.agent_autonomy_evidence(p_category text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('reviewed', count(distinct a.id) filter (where a.status in ('approved', 'executing', 'executed', 'failed', 'rejected')),
    'rejected', count(distinct a.id) filter (where a.status = 'rejected'), 'since', s.supervised_since)
  from private.agent_autonomy_steps s
  cross join lateral jsonb_array_elements(s.changes) c
  join private.agent_actions a on a.agent_key = c ->> 'agent' and a.decided_by is not null and a.created_at >= coalesce(s.supervised_since, 'infinity'::timestamptz)
  left join private.growth_messages m on m.action_id = a.id
  left join private.growth_contacts gc on gc.id = m.contact_id
  where s.category = p_category and (
    (c ->> 'config_key' = 'auto_approve_kinds' and (a.kind in (select jsonb_array_elements_text(c -> 'values'))
      or (a.kind = 'growth.message' and private.growth_message_class(a.agent_key, m.purpose, gc.source_kind) in (select jsonb_array_elements_text(c -> 'values')))))
    or (c ->> 'config_key' = 'auto_send_templates' and a.kind = 'email.send' and a.input ->> 'template' in (select jsonb_array_elements_text(c -> 'values'))))
  group by s.supervised_since;
$$;

-- Graduation asks for the evidence first (every earlier check is unchanged).
do $$
declare d text := pg_get_functiondef('private.agent_autonomy_graduate(text)'::regprocedure);
begin
  if position($q$  v_step private.agent_autonomy_steps%rowtype;$q$ in d) = 0
    or position($q$  return jsonb_build_object('graduated', true, 'step', private.agent_autonomy_apply(p_category, 'automatic', null, 'schedule'));$q$ in d) = 0 then
    raise exception 'The graduation function changed; update this migration' using errcode = '55000';
  end if;
  d := replace(d, $q$  v_step private.agent_autonomy_steps%rowtype;$q$, $q$  v_step private.agent_autonomy_steps%rowtype;
  v_evidence jsonb;
  v_reviewed integer;
  v_rejected integer;$q$);
  d := replace(d, $q$  return jsonb_build_object('graduated', true, 'step', private.agent_autonomy_apply(p_category, 'automatic', null, 'schedule'));$q$,
$q$  -- Evidence, not only a week: enough of the owner's decisions, and few enough turned down.
  v_evidence := coalesce(private.agent_autonomy_evidence(p_category), jsonb_build_object('reviewed', 0, 'rejected', 0));
  v_reviewed := (v_evidence ->> 'reviewed')::integer; v_rejected := (v_evidence ->> 'rejected')::integer;
  if v_reviewed > 0 and v_rejected * 100 > v_step.max_rejected_pct * v_reviewed then
    return jsonb_build_object('graduated', false, 'reason', 'too_many_rejections', 'evidence', v_evidence,
      'step', private.agent_autonomy_apply(p_category, 'hold', null, 'schedule'));
  end if;
  if v_reviewed < v_step.min_reviewed then
    update private.agent_autonomy_steps set automatic_at = now() + interval '7 days' where category = p_category returning * into v_step;
    return jsonb_build_object('graduated', false, 'reason', 'not_enough_reviews', 'evidence', v_evidence, 'step', private.agent_autonomy_step_json(v_step));
  end if;
  return jsonb_build_object('graduated', true, 'evidence', v_evidence, 'step', private.agent_autonomy_apply(p_category, 'automatic', null, 'schedule'));$q$);
  execute d;
end $$;

-- Server: what the watchdog words. Counts and names only.
create function private.agent_watchdog_facts() returns jsonb
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
        or (e ->> 'rejected')::integer * 100 > s.max_rejected_pct * greatest((e ->> 'reviewed')::integer, 1))), '[]'::jsonb));
end; $$;

revoke all on function private.agent_autonomy_evidence(text), private.agent_watchdog_facts() from public, anon, authenticated, service_role;
grant execute on function private.agent_watchdog_facts() to hub_app_server;
