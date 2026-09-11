-- Intel's verified live Base44 runtime consumes only its own one-use SMS audience.
-- Preserve Go and all governed content/learning/command capabilities.
alter table private.app_delegations drop constraint app_delegations_audience_check;
alter table private.app_delegations add constraint app_delegations_audience_check
  check(audience in ('carebase','breathe','caremetric-emr','pennsync','caremetric-go','intel',
    'carebase.command','carebase.learning','publication','media'));
