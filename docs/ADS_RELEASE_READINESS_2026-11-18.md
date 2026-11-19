# Advertising release readiness — November 18, 2026

This follows the earlier [creative review](ADS_CREATIVE_REVIEW_2026-11-18.md), which preceded PRs [275](https://github.com/kdeyarmin/caremetric-support-hub/pull/275) and [276](https://github.com/kdeyarmin/caremetric-support-hub/pull/276). Observations below are read-only snapshots, not a statement that campaigns are currently delivering.

## Confirmed release evidence

- Both fixes are on main. The initially inspected head was `264f3173b39090da02eaa912ee5c9d5db6efb608`; this repair also incorporates subsequent main `a7ca45e3dc136c3d9108a35e8b76ef9f6f78367b` (Creative page approval UI).
- [Main CI run 44366334340](https://github.com/kdeyarmin/caremetric-support-hub/actions/runs/44366334340) passed verification, runtime-image and database jobs for `264f3173`.
- Railway production deployment `a9a882bc-8f3b-42b5-acaa-be36c5818b5f` successfully deployed `264f3173` at 18:08 UTC. This observation does not identify later deployments.
- The production ledger contains `creative_brief_queue_atomic` under version `20261118010712` and `campaign_creative_validation` under `20261118012536`. Those differ from repository filenames `20261118005317_creative_brief_queue_atomic.sql` and `20261118010000_campaign_creative_validation.sql`.
- Installed function definitions include the full approved/live creative snapshot and atomic brief enqueue. The application role can execute them; browser roles cannot. The new read-only prerequisite evaluator accepts those retrieved production definitions and privileges.
- The creative-validation ledger version corresponds to 01:25:36 UTC; the PR #276 server startup log is 01:26:50 UTC. That supports migration-before-server ordering. The ledger has no independent `applied_at` evidence, so it does not prove the exact application time.

## Follow-up code corrections

- Ad refreshes search the full approved creative snapshot and require the same destination as the existing ad. UTM differences and trailing slashes are allowed; different offers, query parameters and fragments are not.
- Generated refresh copy also preserves its destination. Unsupported destinations stop the proposal instead of falling back to a default product page.
- Immediately before creating an ad from approved creative, the executor rechecks status, product, platform, placement, copy, CTA, destination and public image identity. A changed or unavailable snapshot fails before a provider write.
- Missing ad destinations are reported as `no_ad_link` (the reason main already uses for the daily review), separately from readable external destinations. An ad set whose active ads include an unread destination cannot receive a budget-increase proposal; paused ads, whose LinkedIn links are never read, do not block it.
- Connection checks test Page reads and advertising data reads independently. Success explicitly does not certify campaign writes, conversion submission or delivery.
- Railway pre-deploy and server startup check installed database prerequisites before the new server's workers start. The check never applies migrations or contacts ad providers. CI exercises it through the application role on its disposable database.

## Campaign and attribution evidence

- LinkedIn attempts on November 16 and 17 failed with `linkedin_permission` and `linkedin_invalid_request`. They predate these corrections and do not demonstrate the present permissions of the ad account.
- Google action `966e6738-1fce-4bda-9d61-d2ed1ad8886f` has a creation receipt for `customers/3021386768/campaigns/24493303819`, dated November 18 at 14:21:10 UTC. It records $5/day through November 27 and the Intel `/market-review` destination. A receipt is not proof of approval, impressions or delivery.
- At inspection, that flight reserved the entire $50 November allocation. No increase or retry is authorized by this document. Hub reservations do not establish total provider-side account spending.
- No attributed paid leads were found in the inspected November records. Meta and LinkedIn conversion rows were skipped for `no_click`; no successful submission was observed. The Hub conversion sender currently supports Meta and LinkedIn, not Google. Google's native tag/import configuration remains unverified.
- Recent Meta permission and LinkedIn founder-token errors concern distinct workflows; they do not by themselves establish that the separate advertising token is invalid. A working company Page connection also does not prove paid-ad access.

## Required production follow-through

1. Enable **Wait for CI** for Railway project `3f687ca2-36a8-427e-b7e9-bbe8132dd44b`, production environment `88191d70-eed1-4949-9727-9fc635097c77`, service `support-hub-web` (`17392a89-0ee0-4af1-99ee-2f8c2dbf3308`). Its inspected source setting was `checkSuites: false`; the required setting is `true`.
2. After this repair's CI is green and the owner approves release, merge the repair PR. Railway's normal main-branch deployment should run `node server/release-check.mjs` first. No additional migration is introduced by this repair. Do not rerun historical migrations just to make their ledger version numbers match filenames.
3. Recheck Page and advertising access separately with the actual connected accounts. LinkedIn needs Advertising API access, any Development-tier account assignment, account roles and the documented ad scopes; conversions additionally need Conversions API approval and `rw_conversions`. Meta needs the correct system-user/ad-account assignment and Marketing API permissions. Make credential or assignment changes only after showing the exact proposed change and obtaining approval.
4. Reconcile the Google receipt and any LinkedIn/Meta campaign IDs with provider approval status, destination, targeting, budget, end date, impressions and actual spend. Verify conversion actions and actual attribution separately. Google Ads browser access rejected AI-agent access during this review; do not bypass that restriction. An authorized API connection or owner review is needed.
5. Review and explicitly approve suitable Meta report creative if none is approved. Do not approve warnings in bulk as a substitute for asset review. No provider launch, retry or budget change is part of this code release approval.

The readiness decision remains conditional until the release and live-account checks are complete. No campaigns were launched or retried, budgets increased, credentials changed, or production settings modified during this repair.
