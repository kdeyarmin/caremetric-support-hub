-- Each native administrator adapter receives a different single-use audience.
alter table private.app_delegations drop constraint app_delegations_audience_check;
alter table private.app_delegations add constraint app_delegations_audience_check
  check(audience in ('carebase','breathe','media'));
