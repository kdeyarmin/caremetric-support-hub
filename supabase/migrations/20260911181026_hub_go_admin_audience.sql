-- Go shares EMR's native data authority but must never consume its capability.
-- Preserve existing readers, command, learning and media audiences.
alter table private.app_delegations drop constraint app_delegations_audience_check;
alter table private.app_delegations add constraint app_delegations_audience_check
  check(audience in ('carebase','breathe','caremetric-emr','pennsync','caremetric-go',
    'carebase.command','carebase.learning','media'));
