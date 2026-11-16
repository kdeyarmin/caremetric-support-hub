-- Two addresses that were Railway variables become Hub settings (CLAUDE.md: only secrets and the service's wiring stay in Railway):
--
-- - billing.intel_catalog_url (Settings -> Billing -> Intel price catalog address), was INTEL_CATALOG_URL: where the Hub reads
--   Intel's plan prices to keep Stripe in step. Empty is Intel's live catalog; another address is for a staging Hub only;
-- - learning.media_import_hosts (Settings -> Course distribution -> Lesson video import hosts), was HUB_MEDIA_IMPORT_HOSTS: the
--   exact hosts bulk lesson-video import may download MP4s from. Empty is HeyGen's asset hosts.
--
-- On its next start the Hub copies a value still set in either variable into its setting, once, and says the variable can be deleted
-- (server/hub-settings.mjs). Nothing else changes.
insert into private.hub_settings (key, kind) values
  ('billing.intel_catalog_url', 'text'),
  ('learning.media_import_hosts', 'list')
on conflict (key) do nothing;
