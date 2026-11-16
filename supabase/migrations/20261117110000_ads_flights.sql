-- Ad budget flights (owner decision 2026-11-16): Settings → Paid ads → "Run each month's campaign as a short flight" spends the monthly
-- number in one campaign over a few days, at no less than the platform's least daily budget, ending on its own
-- (server/agents/ads/index.mjs `flightBudget`). A small monthly number spread a thirtieth a day is below every platform's least, so no
-- campaign could run. A launch handed over reserves the flight's own days (private.ads_launch_reserve already takes them), so the
-- month's number still bounds what it spends. One setting; no function changes.
insert into private.hub_settings (key, kind) values ('ads.flight_days', 'number') on conflict (key) do nothing;
