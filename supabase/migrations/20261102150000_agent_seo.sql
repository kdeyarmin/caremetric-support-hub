-- The SEO Analyst: the AI team's fourth agent. Every Monday morning it checks each public CareMetric website
-- from the outside, without running scripts, and emails the owner what to fix. It uses no model and reads only
-- the company's own public pages, so it is seeded observe-only. Like every agent it starts paused: nothing runs
-- until the owner resumes it on the AI team page.
--
-- The schedule fires every morning at 06:30 Eastern; the server's handler does the week's work only on Monday
-- (an interval schedule is limited to a day), and a check the owner starts with "Run now" runs on any day.
-- Seeding is idempotent, and a row the owner already changed is left as it is.
insert into private.agents (key, display_name, role_summary, status, autonomy, model_tier, daily_budget_cents, tool_allowlist, config)
values ('seo_analyst', 'SEO Analyst',
  'Checks each public website every Monday for what search engines and AI assistants read: robots and sitemaps, titles, descriptions, canonical links, headings, structured data and broken links. Emails what to fix.',
  'paused', 'observe', 'fast', 50, array[]::text[], '{"effort": "low", "auto_approve_kinds": []}'::jsonb)
on conflict (key) do nothing;

insert into private.agent_schedules (agent_key, task_kind, cadence, every_seconds, at_local, timezone, requires_session, next_run_at)
values ('seo_analyst', 'seo.weekly', 'daily', null, '06:30', 'America/New_York', false,
  private.agent_schedule_next('daily', null, '06:30', 'America/New_York', now(), null))
on conflict (agent_key, task_kind) do nothing;
