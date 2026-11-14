# First-party website session measurement

The Monday scorecard can read **anonymous public-site sessions from CareMetric Intel** without a separate analytics subscription.
This measures browser-tab sessions, not unique people, standard 30-minute analytics sessions, customer accounts or a matched visitor-to-trial conversion rate. CareBase has no
native reader in this release and stays “Not connected.”

## Setup

1. Release Intel’s public-site collection and signed aggregate endpoint, including its visitor tables, through its normal reviewed
   deployment process. Collection uses a random browser-session marker only on anonymous public marketing pages. The server stores
   its HMAC and first-seen time; it stores no IP, email, name, page path, query string, referrer or customer record in the visitor tables.
2. Set the same dedicated **`HUB_VISITOR_METRICS_KEY`**, at least 32 characters, on the Hub and Intel services. Keep it server-only.
   This key authorizes only aggregate reporting and is separate from growth events and website lead signing keys.
3. Release the Hub migrations `20261111040000_visitor_metrics.sql` and `20261111040100_visitor_metrics_contract.sql` and the matching
   server. **Settings → Website analytics → Read Intel website sessions** defaults on for this read-only
   connection; an explicitly saved off setting remains off. The feature and dedicated key are still required.
4. Use **AI team → Chief of Staff → Run now → Monday scorecard** to verify the report. The toolkit’s “Configured” badge checks the
   release, switch and key presence only; the scorecard verifies whether the native endpoint can actually answer.

## What a count means

The scorecard asks for its exact Monday-to-Monday Eastern intervals, including daylight-saving changes, and the week before. It does
not approximate a calendar week by subtracting 168 hours. A random marker stays in sessionStorage for the tab’s lifetime, including
reloads; repeated capture is idempotent and the session is counted in the period when it first appeared. A new tab may count separately.

The native store persists when collection began. A requested week before coverage began, outside retained coverage, or otherwise
incomplete returns an unknown count. The Hub never substitutes zero. A new installation therefore cannot produce historical visitor
figures. A complete measured week with no sessions may report zero. Browser storage restrictions, blocked requests and the
anonymous-public-page boundary limit coverage; these figures are not a census of people.

Only available periods are displayed. A failed read says **Could not be read**, missing setup says **Not connected**, and a partial
comparison keeps the available number while marking the other period unavailable. The report labels Intel’s row **Website sessions
(anonymous tabs)**. Trial, first-value and paid events remain separate measurements; dividing these aggregate populations does not prove
matched conversion.

## Server contract

The Hub makes one bounded, read-only `POST` to the fixed address
`https://www.caremetricintel.com/api/hub/visitor-metrics`, with no redirects. The exact JSON body is:

```json
{"before":"2026-10-19T04:00:00.000Z","since":"2026-10-26T04:00:00.000Z","until":"2026-11-02T05:00:00.000Z"}
```

`X-CareMetric-Timestamp` is Unix seconds. `X-CareMetric-Signature` is the hexadecimal HMAC-SHA256 of
`<timestamp>.visitor-metrics.<exact raw body>` using the dedicated key. Intel verifies a five-minute clock window. The response is:

```json
{
  "version": 1,
  "metric": "anonymous_sessions",
  "collectionStartedAt": "2026-10-01T00:00:00.000Z",
  "current": {"count": 100, "complete": true},
  "previous": {"count": 80, "complete": true}
}
```

Before any collection, `collectionStartedAt` is null and both periods have `count: null, complete: false`. An incomplete period
never contributes a count. The Hub validates nonnegative safe integers, coverage dates, response size and timeout. A malformed
response, missing native release, rejected signature or network error leaves counts unavailable; raw responses and credentials are
never logged. This endpoint returns no browser-session identifiers.

## Google Analytics

The scorecard's **Website visitors** row can also come from Google Analytics 4: active users on the product's public site for the same
Monday-to-Sunday Eastern weeks. CareBase is read this way; Intel keeps its own session measurement above and falls back to Google
Analytics only while that is off or not set up. Advisors is not a scorecard product.

1. Each site loads the GA4 tag on its public marketing pages only when its measurement ID is set: `VITE_GA_MEASUREMENT_ID` on Intel
   and CareBase (build-time), `GA_MEASUREMENT_ID` on Advisors.
2. The Hub reads Google Analytics with the Search Console service account (`HUB_SEARCH_CONSOLE_CREDENTIALS`). In its Google Cloud
   project, enable the **Google Analytics Data API**; in Google Analytics, **Admin → Account access management**, add the service
   account's email as a **Viewer**.
3. Enter each property's number (Admin → Property details) in **Settings → Website analytics → CareBase Google Analytics property ID**
   (and **Intel Google Analytics property ID** if Intel's own measurement is not used).

The Hub asks only for the active-user count of each week (no pages, referrers, users or events), signs in with the read-only
Analytics scope, and logs only a fixed failure code. A week Google has no data for (before the tag was installed) shows as unavailable,
never zero, and a property that cannot be read does not hide another product's figures (`server/agents/scorecard/google-analytics.mjs`).
