-- Google Analytics for the Monday scorecard's website visitors: two owner settings, the GA4 property of each product. The service
-- account key stays the Search Console one in Railway (HUB_SEARCH_CONSOLE_CREDENTIALS). No visitor data is stored in the Hub.
insert into private.hub_settings (key, kind) values
  ('analytics.google_carebase_property', 'text'),
  ('analytics.google_intel_property', 'text')
on conflict (key) do nothing;
