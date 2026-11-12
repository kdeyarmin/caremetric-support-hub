-- Amazon SES as the Hub's email service (docs/AMAZON_SES.md).
--
-- Four Hub settings under Settings -> Email. None is a secret (the SES access key stays in Railway):
-- - email.provider: which service sends the Hub's email, 'sendgrid' (the default, so nothing changes until the owner switches) or 'ses';
-- - email.ses_region: the AWS region the SES domains are verified in (default us-east-2);
-- - email.ses_configuration_set: the configuration set that publishes delivery, bounce and complaint events;
-- - email.ses_events_topic: the SNS topic ARN those events come from; the Hub accepts SES events from no other topic.
--
-- Additive: no function, grant or existing row changes. A server deployed before this runs uses each setting's default.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values
  ('email.provider', 'text'),
  ('email.ses_region', 'text'),
  ('email.ses_configuration_set', 'text'),
  ('email.ses_events_topic', 'text')
on conflict (key) do nothing;
