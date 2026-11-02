-- Facts for the Chief of Staff's morning brief.
--
-- The brief is written at 07:00 Eastern with nobody signed in, so it cannot use the owner's
-- session. This is the one read it needs: a single JSON document of counts and times that the
-- Hub server turns into an email. It carries no names, no message text, no addresses and no
-- amounts: how many approvals wait and how long the oldest has waited, which products are down,
-- what failed, what the team did yesterday (the previous Eastern day, midnight to midnight) and
-- what it cost, which agents are paused or ran out of budget, and how many subscriptions are
-- past due or have a trial ending within a week. Only live-mode subscriptions are counted.
--
-- Like the rest of the control plane it is callable by the Hub server role alone.

create function private.agent_brief_facts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_today timestamptz := private.agent_day_start();
  v_yesterday timestamptz := (date_trunc('day', now() at time zone 'America/New_York') - interval '1 day') at time zone 'America/New_York';
begin
  perform private.require_hub_app_server();
  return jsonb_build_object(
    'generatedAt', now(),
    'yesterdayStart', v_yesterday,
    'todayStart', v_today,
    'approvals', (select jsonb_build_object('count', count(*), 'oldestAt', min(created_at))
                  from private.agent_actions where status = 'proposed'),
    'awaitingSession', (select count(*) from private.agent_tasks where status = 'awaiting_session'),
    'incidents', (select coalesce(jsonb_agg(jsonb_build_object('target', target_key, 'since', failing_since, 'failures', consecutive_failures)
                                            order by failing_since, target_key), '[]'::jsonb)
                  from private.agent_probe_state where state = 'down'),
    'failedTasks', (select count(*) from private.agent_tasks where status = 'failed' and finished_at >= now() - interval '24 hours'),
    -- An urgent alert "did not reach the owner" when no channel of it was sent.
    'undeliveredAlerts', (select count(*) from (
                            select 1 from private.owner_notifications
                            where severity = 'urgent' and created_at >= now() - interval '24 hours'
                            group by dedupe_key having bool_and(status <> 'sent')) unsent),
    'yesterday', jsonb_build_object(
      'runs', (select count(*) from private.agent_runs where started_at >= v_yesterday and started_at < v_today),
      'tasksDone', (select count(*) from private.agent_tasks where status = 'done' and finished_at >= v_yesterday and finished_at < v_today),
      'tasksFailed', (select count(*) from private.agent_tasks where status = 'failed' and finished_at >= v_yesterday and finished_at < v_today),
      'actionsExecuted', (select count(*) from private.agent_actions where status = 'executed' and executed_at >= v_yesterday and executed_at < v_today),
      'incidentsOpened', (select count(*) from private.agent_actions
                          where kind = 'incident.open' and status = 'executed' and executed_at >= v_yesterday and executed_at < v_today),
      'incidentsClosed', (select count(*) from private.agent_actions
                          where kind = 'incident.resolve' and status = 'executed' and executed_at >= v_yesterday and executed_at < v_today),
      'spendCents', (select coalesce(sum(cost_cents), 0) from private.agent_runs where started_at >= v_yesterday and started_at < v_today)),
    'agents', (select coalesce(jsonb_agg(jsonb_build_object(
                         'key', a.key, 'name', a.display_name, 'status', a.status, 'budgetCents', a.daily_budget_cents,
                         'spentCents', coalesce(s.spent, 0), 'hitBudget', coalesce(s.hit, false)) order by a.key), '[]'::jsonb)
               from private.agents a
               left join lateral (
                 select sum(r.cost_cents) as spent, bool_or(r.outcome = 'budget_exhausted') as hit
                 from private.agent_runs r
                 where r.agent_key = a.key and r.started_at >= v_yesterday and r.started_at < v_today) s on true),
    'billing', jsonb_build_object(
      'pastDue', (select count(*) from private.billing_subscriptions where livemode and status in ('past_due', 'unpaid')),
      'trialsEnding', (select count(*) from private.billing_subscriptions
                       where livemode and status = 'trialing' and trial_end >= now() and trial_end < now() + interval '7 days'))
  );
end;
$$;

revoke all on function private.agent_brief_facts() from public, anon, authenticated, service_role, hub_app_server;
grant execute on function private.agent_brief_facts() to hub_app_server;
