-- First-party website measurement: this only enables the owner setting; it captures no visitor data in the Hub.
insert into private.hub_settings (key, kind) values
  ('analytics.intel_visitors', 'flag')
on conflict (key) do nothing;
