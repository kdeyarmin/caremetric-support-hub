# Website leads (lead intake, version 1)

Every public form in CareBase (repository PennTrain), Intel and Healthcare Advisors forwards each lead, server to
server, to the Hub. The Hub records it on the **Leads** screen (`/admin/leads`), opens a conversation in
**Communications** when the person asked to be contacted, and its AI team will alert the owner from the same records.
This is the Hub's canonical copy of the shared contract: all four repositories implement exactly what follows.

## Endpoint

`POST {HUB_LEAD_URL}`; products default `HUB_LEAD_URL` to
`https://support-hub-web-production.up.railway.app/api/leads`. `Content-Type: application/json`, UTF-8, raw body at
most 16384 bytes.

## Authentication: one shared secret per product

Headers on every request:

- `X-CareMetric-Source`: `carebase` | `intel` | `advisors`
- `X-CareMetric-Timestamp`: Unix time in whole seconds
- `X-CareMetric-Signature`: `v1=` + lowercase hex of HMAC-SHA256(secret, `<timestamp>` + `.` + `<raw body bytes>`)

Secrets: the Hub reads `HUB_LEAD_SECRET_CAREBASE`, `HUB_LEAD_SECRET_INTEL`, `HUB_LEAD_SECRET_ADVISORS`; each product
reads its own value as `HUB_LEAD_SECRET`. A secret shorter than 32 characters counts as not configured. The Hub
refuses a timestamp more than 300 seconds from its clock, compares signatures in constant time, and answers 401
`{"error":"unauthorized"}` with no further detail for any authentication failure. A source whose secret is not
configured answers 503 `{"error":"not_configured"}`. The secret never reaches a browser.

The signature over the exact raw body is the only authority. The route is server to server: a request that carries a
browser `Origin` or `Cookie` header, or a query string, is refused as unauthorized like any other authentication
failure (server-side `fetch` in Node and Deno sends none of them).

## Payload

```json
{
  "version": 1,
  "source": "carebase",
  "kind": "demo_request",
  "externalId": "3f1c…",
  "occurredAt": "2026-11-03T12:00:00.000Z",
  "test": false,
  "contact": { "name": "…", "email": "…", "phone": "…", "organization": "…", "role": "…" },
  "details": { "facilityCount": 3, "plan": "complete" },
  "message": "…",
  "attribution": {
    "utmSource": "google", "utmMedium": "cpc", "utmCampaign": "…", "utmTerm": "…", "utmContent": "…",
    "referrerHost": "www.google.com", "landingPath": "/pricing", "firstSeenAt": "2026-11-01T09:00:00.000Z"
  }
}
```

- `version` is the number 1. `source` equals the `X-CareMetric-Source` header.
- `kind` is one of `demo_request`, `consultation`, `contact`, `trial_signup`, `newsletter`, `savings_model`,
  `county_report`.
- `externalId`: the product's own id for this lead, 1 to 100 characters from `[A-Za-z0-9._:-]`. The Hub stores each
  (source, externalId) once; a repeat is answered as a duplicate and changes nothing. Advisors uses its inquiry
  reference `CM-` followed by 12 uppercase hex characters, the same key the Hub's existing Advisors import uses (a
  probe, below, uses `probe-<timestamp>` instead).
- `occurredAt`: ISO 8601, not more than 5 minutes in the future.
- `test`: `true` only for a probe submission (below). Test leads never alert and never count in any report.
- `contact.email` is required and must look like an address; `name`, `phone`, `organization`, `role` are optional
  strings (name and organization at most 200 characters, phone at most 40, role at most 100).
- `details`: optional flat object of at most 12 entries; keys match `^[a-zA-Z][a-zA-Z0-9]{0,39}$`; values are
  strings of at most 200 characters, finite numbers, or booleans. Facts only (facility count, plan, product, state,
  county, service, beds). Never resident, patient or health information.
- `message`: optional free text, at most 4000 characters. Treated as possibly containing PHI: stored only in the
  Hub conversation, never in logs, audit metadata or alerts.
- `attribution`: optional; every field optional; strings at most 200 characters (`landingPath` at most 300);
  `referrerHost` is a host name only and `landingPath` a path only (no query string, no fragment).

How the Hub reads these rules, exactly (any failure is 400 `{"error":"invalid_lead"}`):

- Only the keys above, at the top level and inside `contact` and `attribution`. An optional field may be absent or
  JSON `null`; `test` absent or `null` means `false`.
- Times (`occurredAt`, `attribution.firstSeenAt`) are ISO 8601 instants with their offset, such as
  `2026-11-03T12:00:00.000Z` or `2026-11-03T07:00:00-05:00`, and must be real calendar times.
- An email address has one `@`, no spaces, and a dot in its domain; the Hub stores it trimmed and in lowercase. Other
  single-line fields are trimmed, and control characters in them become spaces.
- `referrerHost` is letters, digits, dots, hyphens and underscores (no scheme, port or path); `landingPath` starts with
  `/` and has no `?`, `#` or whitespace.
- A `CM-` reference is required of Advisors for every lead that is not a test.

What the Hub does by kind:

| kind | source | Hub conversation | owner alert |
| --- | --- | --- | --- |
| `demo_request` | carebase, intel | yes, inquiry type `sales` | at once |
| `consultation` | advisors | yes, inquiry type `advisors` | at once |
| `contact` | any | yes, inquiry type `sales` | at once |
| `trial_signup` | carebase, intel | no | at once |
| `newsletter`, `savings_model`, `county_report` | carebase, intel | no | daily digest |

Owner alerts arrive with the AI team change that builds on this table; until then the Support Concierge already
notices each new web-form conversation like any other.

## Responses

- 202 `{"id":"<lead uuid>","duplicate":false,"conversation":"CM-1234" or null}` for a new lead
- 200 `{"id":"<lead uuid>","duplicate":true,"conversation":…}` for a repeat
- 400 `{"error":"invalid_lead"}`: do not retry
- 401 `{"error":"unauthorized"}`, 413 `{"error":"too_large"}`: do not retry
- 429 `{"error":"rate_limited"}`, 503 `{"error":"not_configured"|"unavailable"}`, network error: retry once

The Hub answers 503 `unavailable` while the database it runs against does not declare `support.leads.v1` (the
migrations below), and when the database cannot be reached. Each product may send 60 signed requests a minute;
unsigned requests never use up that allowance. Anything but `POST` is answered 405 `{"error":"method_not_allowed"}`.

## How products forward

- From server code only, after the product has stored the lead itself (the product keeps its own record, so a Hub
  outage loses nothing).
- Best effort: 5-second timeout, at most one retry after a network error, 429 or 5xx; never fail or noticeably slow
  the visitor's request because of the Hub; never throw out of the forwarder.
- Log only the outcome (status code or error class), never the payload, the contact or the secret.
- When `HUB_LEAD_SECRET` is not set, skip forwarding silently (local development and tests).

## Probe mode: the end-to-end form check

The Hub's Platform Engineer checks each product's main lead endpoint every few hours: CareBase Supabase function
`request-demo`, Intel `POST /api/public/demo-request`, Advisors' consultation inquiry endpoint.

- Probe headers: `X-CareMetric-Probe: v1=` + hex HMAC-SHA256(`HUB_LEAD_SECRET`, `<timestamp>` + `.probe`) and
  `X-CareMetric-Timestamp: <unix seconds>`, same 300-second window. The request body is the endpoint's normal JSON
  body (the Hub sends plausible fake values; the endpoint may ignore them).
- A valid probe skips captcha or Turnstile and any per-visitor rate limit, writes nothing to the product's own
  tables, sends no email, and forwards a lead with `"test": true`, the endpoint's `kind`,
  `"externalId": "probe-<timestamp>"` and `contact.email` `probe@caremetric.invalid`. It answers 200
  `{"probe":true,"forwarded":true|false,"status":<Hub HTTP status, or 0 when unreachable>}`.
- A probe header that does not verify is ignored: the request is treated as an ordinary submission (so it still
  needs the captcha). Never answer differently in a way that reveals whether the secret matched beyond that.
- The Hub then confirms that the test lead arrived (end-to-end proof).

## Source attribution in the browser

- On every public page load, if no attribution is stored, or the URL carries `utm_` parameters, store first-touch
  attribution in `localStorage` key `cm_attribution_v1`: the five UTM values, `referrerHost` (host of
  `document.referrer` when it is not the site's own host), `landingPath` (`location.pathname` only) and
  `firstSeenAt`. Keep the first touch for 90 days; a new set of UTM parameters replaces it. Wrap every storage access
  in try/catch; a page must work without storage.
- Every lead form sends it as `attribution` in its JSON body; the server validates and trims it before forwarding.

## Analytics (owner supplies the account; off until configured)

- Public marketing pages only, never signed-in application pages (those can show resident, patient or customer data).
- Plausible when `PLAUSIBLE_DOMAIN` is set (script `https://plausible.io/js/script.js`, or `PLAUSIBLE_SRC`);
  Google Analytics 4 when `GA_MEASUREMENT_ID` is set; Search Console verification meta tag when
  `GOOGLE_SITE_VERIFICATION` is set. Build-time products use the same names with their framework prefix (for
  example `VITE_PLAUSIBLE_DOMAIN`).
- On a successful lead submission fire one conversion event: Plausible `Lead` with prop `kind`; GA4
  `generate_lead` with `lead_type`.
- Extend the Content-Security-Policy only for the provider that is configured.

## In the Hub

- **Leads.** `private.leads` holds one row per (source, externalId): the kind, the contact's details, the facts, the
  first-touch attribution, the product, the linked conversation and a status (`new`, `contacted`, `qualified`, `won`,
  `lost`, `spam`). The visitor's message is never stored on the lead. The table has row level security and no
  privilege for any browser, service or server role. The Hub server records a lead only through
  `private.lead_intake(source, lead)`, which refuses every session user but `hub_app_server` and does its work in
  `private.lead_record` (executable by no role, so the database tests can exercise it directly).
- **Conversations.** A `demo_request`, `consultation` or `contact` that is not a test opens a `web_form` conversation
  whose source is `carebase.web`, `intel.web` or `advisors.web` ("CareBase website", "Intel website", "Advisors
  website" in Communications), keyed by the externalId. Its subject is "Demo request: …", "Consultation request: …"
  or "Contact request: …" with the organization, else the name, else the address. Its one inbound message is what the
  visitor wrote, followed by the role and the facts as plain `Label: value` lines. An Advisors consultation that the
  owner already imported with **Import Advisors requests** is linked to that conversation, not copied, and a later
  import skips a request a lead already brought in: both use `advisors.web` and the `CM-` reference.
- **Audit.** Each new lead writes one `lead.received` event whose metadata is the source, kind and test flag only;
  each status change writes `lead.status` with the old and new status. Contact details and message text never enter
  audit metadata.
- **Logs.** One line per request: `Lead intake: source=<product or unknown> outcome=<outcome> status=<code>`. Never a
  body, a contact detail, a message or a secret.
- **The Leads screen** (`/admin/leads`, platform administrator only) lists leads newest first with when each arrived,
  the product, the kind and its facts, the contact, where the person came from, its status and a link to its
  conversation. It filters by kind and product, and shows test leads only when asked. Changing a status needs the
  command session (signed in within eight hours); a lead changed elsewhere since the page loaded is refused, and the
  list reloads. The list is the RPC `hub.list_leads(p_kind, p_source, p_include_test, p_offset, p_limit)`; a status
  change is `POST /api/admin/leads/status`, which runs `hub.update_lead_status(p_id, p_status, p_expected_updated_at)`
  in the owner's session.

## Retention

- **Leads** are deleted twelve months after the Hub received them (`received_at`), probes included.
- **Website conversations** (`advisors.web`, `carebase.web` and `intel.web`, including Advisors requests brought in with
  **Import Advisors requests**) are deleted twelve months after their last message (`last_message_at`, which every
  inbound message and every reply moves; an internal note does not), with all their messages. A lead that named a
  deleted conversation keeps no link to it, and deleting a lead never deletes its conversation: each follows its own
  clock.
- Conversations from every other channel (text, email, chat, phone) are never deleted by this; their retention is still
  not automated ([UNIFIED_COMMUNICATIONS.md](UNIFIED_COMMUNICATIONS.md)).
- **How.** `private.lead_retention(p_limit)` deletes, oldest first, at most `p_limit` leads and at most `p_limit`
  conversations that are due (`p_limit` defaults to 500; anything outside 1 to 5000 is refused with 22023), leaves a row
  another transaction holds for a later batch, and answers `{"leads": n, "conversations": n, "more": true|false}`, where
  `more` says whether anything due is left. Only `hub_app_server` may run it, and it refuses every other session user;
  the work is `private.lead_retention_batch`, which no role may run. The `support.leads.v1` gate checks both.
- **When.** The Hub server's fifteen-minute cleanup runs it while the database declares `support.leads.v1`: when the
  server starts, then at most once every six hours per server process, in up to ten batches of 500 while `more` is
  true. What is left waits for the next run, so a row is deleted within about six hours of falling due.
- **Records.** Each batch that deleted something writes one `lead.retention` audit event whose metadata is the two
  counts only, never a name, an address or the id of a deleted row. A run that deleted something logs one line with the
  counts, for example `Lead retention: deleted 3 leads and 2 website conversations.`; a run that fails logs
  `Lead retention could not complete; it will retry.` and is tried again at the next cleanup. The `lead.received` and
  `lead.status` events stay; they hold no contact details.
- This is the Hub's copy only; each product keeps its own record of a lead under its own retention. The Healthcare
  Advisors privacy notice states both periods: a request on its website is deleted twelve months after it is received,
  and the copy in the Hub twelve months after the last message in the conversation about the request.

## Setting it up (owner)

1. Apply `20261103120000_lead_desk.sql` and its gate `20261103120100_lead_desk_contract.sql`, which declares
   `support.leads.v1`. The Hub reads the declaration when it starts, so redeploy (or restart) the Hub if the
   migrations were applied after it last started. Until then `POST /api/leads` answers 503 `unavailable`.
2. Make one secret per product, at least 32 random characters, for example with `openssl rand -hex 32` (64
   characters). Never reuse one secret for two products, and never paste a secret into a browser, chat or ticket.
3. In Railway, open the Hub service and set its variables:
   - `HUB_LEAD_SECRET_CAREBASE`: the CareBase secret
   - `HUB_LEAD_SECRET_INTEL`: the Intel secret
   - `HUB_LEAD_SECRET_ADVISORS`: the Healthcare Advisors secret
4. In each product, set `HUB_LEAD_SECRET` to the same value as its Hub variable, wherever that product's forwarding
   code runs (its lead-forwarding documentation names the place, for example CareBase's Supabase function secrets for
   `request-demo` as well as its server). Leave `HUB_LEAD_URL` unset to use the production Hub.
5. Let the Hub and the products redeploy. The Hub logs one line when it starts, for example
   `Website leads: database ready; secrets set for carebase, intel, advisors.` The control center's **Integration
   setup** panel shows each secret as set or missing (never its value); a value shorter than 32 characters shows as
   set but is refused as not configured, so use the full secret.
6. Submit each product's form once with your own address, then open **Leads**. A demo request, consultation or
   contact request also appears in **Communications**, where you reply.

A product without its secret keeps its leads to itself (it still stores them): the Hub answers 503
`not_configured` and the product logs that outcome. To rotate a secret, set the new value on the Hub and in the
product at the same time; leads sent in between are refused with 401, and each product keeps its own record of them.
