-- Growth reach (AI workforce review 2026-11-17, stage 3; docs/AI_WORKFORCE_REVIEW_2026-11-17.md). The owner's decisions of 2026-11-17:
-- reach agencies under pressure first, use only a website the code confirms, and run a live writing evaluation each Monday.
--
-- 1. Settings (Settings -> Customer growth): "Search the web for roster agencies not found" (growth.roster_site_research, off), "Most
--    agencies to search the web for a day" (growth.roster_site_research_per_day, 10), "Most to spend on one website search"
--    (growth.roster_site_research_cents, 10) and "Run a live writing evaluation each Monday" (growth.live_evaluation, off).
--
-- Nothing is sent by this migration. 20261117200100_growth_reach_contract.sql declares platform.agents.growth-reach.v1.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values
  ('growth.roster_site_research', 'flag'), ('growth.roster_site_research_per_day', 'number'), ('growth.roster_site_research_cents', 'number'),
  ('growth.live_evaluation', 'flag')
on conflict (key) do nothing;
