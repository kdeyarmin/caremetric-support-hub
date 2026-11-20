-- Leads from Google ads are sent to Google again (review 2026-11-20). Since June 15, 2026 the Google Ads API refuses offline click
-- conversions from a developer that had not imported them before, and it refused the Hub's first lead from a Google ad on November 19
-- with CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE. The Hub now sends them through Google's Data Manager API. A lead is a candidate only
-- while it has no ads_conversions row for the platform, so the refusals the old path recorded are removed and those leads are sent again
-- (if they are within a week of the lead). Nothing else is touched.
--
-- Apply this after the release that sends through the Data Manager API is live: the release before it would only be refused again and
-- record the same row.
set local lock_timeout = '10s';

delete from private.ads_conversions
 where platform = 'google' and status = 'failed' and code = 'google_customer_not_allowlisted_for_this_feature';
