-- LinkedIn API tier (owner decision 2026-11-16): Settings → Social media → LinkedIn API tier. LinkedIn approved CareMetric's
-- Community Management app at its Development tier, which allows 100 calls a day for each person's token (500 for the app) and no
-- batch reads (BATCH_GET). The Social Media Manager checked LinkedIn comments every 15 minutes and read post engagement in one batch,
-- which that tier cannot carry. On "Development" (the default) it reads LinkedIn comments at one inbox run every two hours, on the
-- three newest posts, and reads engagement one post at a time for the eight newest (server/agents/social/linkedin.mjs, tasks.mjs);
-- "Standard" is the full workflow, once LinkedIn upgrades the app. A setting from the start, never a Railway variable.
insert into private.hub_settings (key, kind) values ('social.linkedin_api_tier', 'text') on conflict (key) do nothing;
