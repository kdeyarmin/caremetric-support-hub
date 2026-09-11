# CareBase invoice and provider reads

The Hub uses its existing administrator transport and fixed CareBase registry endpoint for these operations. Both the legacy JWT proxy and the app-owned SMS session path use the same request and response parsers. Requests cannot select provider URLs, provider credentials, arbitrary provider IDs, organization filters, or payment actions.

| Operation | Request fields | Data source |
| --- | --- | --- |
| `billing.invoices.list` | `limit` (1–50, default 25), `offset` (0–10000), optional literal `search` (at most 100 characters) | Native `billing_invoices` records |
| `billing.invoices.get` | Native invoice UUID `id` | Native record plus a bounded Stripe verification |
| `billing.subscriptions.verify` | Native subscription UUID `id` | Native subscription and application access plus a bounded Stripe verification |

Search is trimmed, and empty search is omitted before the exact operation is bound into an SMS delegation. Other fields are rejected. These three reads are currently CareBase-only. The UI displays each action only when the native capabilities advertise it, and it requests provider details only after an administrator selects a record.

The invoice list explicitly identifies `application_database` as its source. Each detail contains the stored record and a distinct Stripe result with `checkedAt`, pinned API version `2026-02-25.clover`, and one of `available`, `unconfigured`, `unavailable`, `notfound`, or `identity_mismatch`. Unavailable results must contain no provider data. Native/provider identity mismatch never produces a verified provider panel. The Hub validates native IDs against the requested record, validates available provider IDs, and recomputes the documented comparison fields. Additional billing data fields, missing required fields, duplicate invoice IDs, contradictory page counts, or forged comparison assertions fail closed.

Invoice comparisons cover status, currency, amount due, amount paid, and amount remaining. Subscription comparisons cover the stored provider status. Account access state, manual overrides, complimentary access, and grace periods remain separate from Stripe subscription status. A matching comparison does not assert that every provider field matches or that the provider controls effective application access.

No invoice payment links, PDF URLs, customer addresses or emails, card details, patient records, provider writes, event processing, or entitlement mutations are added by these reads. Existing separately authorized application access commands retain their own preview/apply flow.

## Amounts

Every monetary amount is a canonical unsigned decimal integer string in Stripe minor units, bounded by PostgreSQL signed bigint maximum `9223372036854775807`. The Hub never converts an amount to a JavaScript Number. Provider and stored amounts retain their own currencies in the comparison table; currencies are never summed or converted.

The formatter uses string arithmetic and an explicit currency list based on [Stripe's supported currencies and minor-unit rules](https://docs.stripe.com/currencies), reviewed September 11, 2026. Stripe's ISK and UGX compatibility representation uses two decimal places even though the currencies have no fractional charge unit. HUF and TWD invoice amounts also use two places; their special payout restrictions do not apply to this invoice display. Stripe's documented zero-decimal charge currencies use zero places. Currency rules not explicitly verified by this formatter, including regional currencies absent from the reviewed list, are displayed as exact raw minor units. `Intl.NumberFormat` currency defaults do not decide the Stripe amount exponent.

## Verification

Protocol tests cover closed requests and responses, product and record binding, nullable legacy invoice links, all unavailable provider states, exact high-value amounts, and contradictory comparison results. DOM tests exercise capability gating, searching and pagination, explicit selection, loading, cancellation of late results, safe authorization errors, stored/provider separation, and rechecking a subscription. Tests inject synthetic data clients and do not grant a production administrator session or contact a payment provider.
