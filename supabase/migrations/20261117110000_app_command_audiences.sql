-- Access changes for Breathe and CareMetric Intel, as for CareBase: each application redeems a one-use capability of its own
-- command audience, never its read audience, so a read capability can never authorize a change.
--   breathe.command: Breathe's organization suspend/restore (tenant.lifecycle.v1) and staff access (staff.access.v1).
--   intel.command:   CareMetric Intel's account disable/enable (users.setActive).
-- Every existing application, command, learning, publication and media audience is kept.
alter table private.app_delegations drop constraint app_delegations_audience_check;
alter table private.app_delegations add constraint app_delegations_audience_check
  check(audience in ('carebase','breathe','caremetric-emr','pennsync','caremetric-go','intel','advisors',
    'carebase.command','breathe.command','intel.command','carebase.learning','publication','media'));
