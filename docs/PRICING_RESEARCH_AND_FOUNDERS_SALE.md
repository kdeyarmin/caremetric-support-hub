# CareMetric pricing review and Founders Sale

Researched and verified November 8, 2026. All prices are USD, before applicable taxes. PennTrain is the repository name for CareBase and CareMetric Train; Intel means CareMetric Intel.

## Recommendation

Keep the current regular prices for this launch. Use **per-facility subscription pricing for CareBase**, **flat organization pricing for Train**, and **organization tiers with included seats, branches and territories for Intel**. Preserve monthly and annual options, and introduce the Founders Sale — **50% off the first 12 months of paid service** at launch on 2026-11-08, raised by the owner to **75% off** on 2026-11-24.

These are the best-supported launch models from the available evidence, not a measured profit-maximizing price. Customer willingness to pay, acquisition cost, churn and delivery costs were not available. Validate those before making a permanent price cut or increasing the upper tiers.

The sale is configured in the live CareMetric Stripe account as **FOUNDERS75** (75% coupon; the original 50% configuration is recorded in docs/evidence/founders-sale-20261108.json). The regular catalog prices were read from Stripe and agree with the existing product fact sheet. The live public sites corroborate CareBase's monthly prices and Intel's displayed annual prices. No existing customer subscription was changed.

## Competitors and current public pricing

The comparison uses vendors' own pages, accessed on the research date. “Quote required” means no dollar price appeared on the reviewed official page, not that a product is necessarily more expensive. No sales forms were submitted or vendors contacted.

| Product | Closest comparison | Public pricing or buying model | What the comparison means |
| --- | --- | --- | --- |
| [Trella Health CRM / market intelligence](https://www.trellahealth.com/solutions/customer-relationship-management-crm/) | Intel: post-acute marketing, accounts, referral relationships and field activity | Demo-led; no dollar price on the reviewed CRM page. Request a scoped quote. | Direct workflow competitor. Trella advertises connected clinical workflows and 30+ EHR integrations. Intel's public research and supported CSV imports should not be marketed as equivalent claims coverage or live integrations. |
| [Definitive Healthcare](https://www.definitivehc.com/pricing) | Intel: healthcare market and territory intelligence | Custom quote based on products, licenses and add-ons; individual products and bundles available. | Supports packaging by data scope and team access. No defensible percentage-savings claim can be calculated without an actual like-for-like quote. |
| [Alpha Sophia](https://www.alphasophia.com/pricing) | Intel: provider targeting and market research, adjacent audience | Max plan: price on request, platform fee includes 5 users; Custom plan also on request. | Supports a platform fee with included seats. Its claims-data offering differs from Intel's public-data approach; do not use stale third-party dollar prices. |
| [ECP](https://www.ecp123.com/) | CareBase: assisted living EHR, eMAR, admissions, CRM and billing | Sales-led; no dollar price on the reviewed official page. | Compare the modules and implementation quote actually needed. Pharmacy integration coverage and clinical workflow depth are material differences. |
| [eResidentCare pricing](https://eresidentcare.com/pricing/) | CareBase: residential care records, eMAR, care plans and daily charting | Pricing page: starts at $89/month, $249/quarter, $899/year; unlimited users, support and training, no setup fee. Medication inventory $15/month; data import assistance from $150. | Its [home page](https://eresidentcare.com/) instead says starts at $99/month. Treat this as a vendor pricing inconsistency and confirm facility/census scope before quoting a total. CareBase Core at $199 is above either entry rate, and general Core + eMAR is $348/month. CareBase must compete on PA workflows and its broader modules, not a claim to be the cheapest. |
| [CareAcademy](https://careacademy.com/pricing/) | Train / Staff Training: caregiver LMS and compliance training | Displayed starting/default selection: Essentials $239/month; Advanced $383/month; Complete $419/month. Pricing has a seat selector. FAQ requires a 1-year contract; Advanced/Complete explicitly show annual commitment. | Train organization at $239/month matches the displayed Essentials price; Train Single Facility at $119/month is a lower entry price. CareAcademy's extracted page does not establish the selected seat count, so this is not an equal-seat total-cost comparison. Library scope, accredited CE, languages and integrations differ. |
| [Relias](https://www.relias.com/official-information) | Train / Compliance Suite: organizational learning and compliance | No organizational subscription price on the reviewed official page; obtain a scoped organizational quote. | A broader workforce learning/compliance competitor. Individual Relias Academy CE course prices are not a valid substitute for organizational LMS pricing. |

## Recommended packaging

### CareBase: retain per-facility pricing

Keep Core at **$199/month per active facility**, Small Home at **$199** including eMAR for facilities with **fewer than 20 licensed beds**, Compliance Suite at **$279**, Small Home Complete at **$399**, and Complete at **$649**. Residents and staff stay unlimited. Do not convert to per-resident pricing: facility pricing is understandable, predictable, and avoids charging customers more for entering complete records.

Lead the buying page with three choices: **Core**, **Complete**, and **Training only**. Put Small Home eligibility and Compliance Suite alongside the relevant use cases rather than presenting every SKU as a competing primary plan. Keep modules available for customers who already have an EHR or eMAR.

At current monthly prices, Core plus all five add-ons totals **$794**; Complete at **$649** saves **$145/month** (about **18.3%**) against buying those same CareBase items separately. Compliance Suite at **$279** saves **$68/month** against Training + Workforce + Survey & Compliance at **$347**. These are internal bundle comparisons, not competitor savings claims.

General Core does not include eMAR: Core + eMAR is **$348/month**, or **$174/month** in the sale. The under-20-bed Small Home plan includes eMAR for **$199/month**, or **$99.50/month** in the sale. Keep that distinction prominent.

### Train: flat pricing with a low-cost single-facility entry

Keep **$119/month for one facility** and **$239/month per organization**, with unlimited learners. This provides an affordable entry for small homes and avoids a per-learner penalty for training every employee.

Do not imply an identical curriculum or accreditation to CareAcademy or Relias. For very large rollouts, measure support, content-production and video costs; negotiate implementation services separately rather than silently narrowing existing unlimited-learner promises.

### Intel: platform tiers with included capacity

Keep **Starter $349**, **Growth $899**, **Pro $1,999 per organization per month**, with Enterprise quoted separately. Retain the actual limits:

| Plan | Included team | Branches | Territory |
| --- | --- | --- | --- |
| Starter | 3 marketers + 1 manager | 1 | Up to 10 counties |
| Growth | 10 seats | Up to 3 | 1 full state |
| Pro | 25 seats | Up to 10 | Up to 3 states |

Starter's four included seats work out to **$87.25/seat/month** at full utilization; Growth is **$89.90** and Pro **$79.96**. These are explanatory equivalents, not a per-seat billing model or proof of competitor savings.

Sell the predictable starting total and included coverage. Expansion seats, branches and states should be explicit; avoid charging per referral, because referrals are customer-recorded outcomes, not a stable software consumption unit. Avoid pure usage pricing for basic research: customers need predictable budgets and confidence to explore.

Keep existing annual prices (**$3,480 / $8,988 / $19,980**). Keep the existing Growth onboarding waiver for annual billing. Evaluate whether Pro's mandatory **$1,500** onboarding is justified by delivered services, but do not silently waive it or discount it as part of this subscription sale. Growth monthly onboarding remains **$500**. Existing extra-seat prices (**$59 / $49 / $39**), branch (**$99**) and state (**$199**) prices remain unchanged and are excluded from this sale: no active, separately priced Intel expansion products appeared in the inspected catalog. *Update, November 9, 2026:* the owner made Intel onboarding free on every plan, and the extra seat, branch and state gained annual prices at ten times the monthly price (**$590 / $490 / $390** a seat, **$990** a branch, **$1,990** a state). The Hub now creates their Stripe products and prices from Intel's catalog (`docs/PLATFORM_BILLING.md`); they remain excluded from the sale.

Do not raise Intel prices merely because enterprise data vendors use quote-based sales. Intel should position its transparent pricing, focused territories and usable CRM workflows without implying it supplies the same proprietary claims data.

## Founders Sale prices

Monthly and annual billing are alternative choices. The annual sale is **75% off the published annual price**, paid upfront, not 75% of twelve monthly payments. Thus the built-in annual savings remain; other coupons do not stack.

| Plan / billing unit | Regular monthly | Monthly during first year | Regular annual | First annual payment |
| --- | ---: | ---: | ---: | ---: |
| Train Single Facility | $119 | $29.75 | $1,190 | $297.50 |
| Train — organization | $239 | $59.75 | $2,390 | $597.50 |
| CareBase Core — facility | $199 | $49.75 | $1,990 | $497.50 |
| Small Home — eligible facility | $199 | $49.75 | $1,990 | $497.50 |
| Compliance Suite — facility | $279 | $69.75 | $2,790 | $697.50 |
| Small Home Complete — eligible facility | $399 | $99.75 | $3,990 | $997.50 |
| CareBase Complete — facility | $649 | $162.25 | $6,490 | $1,622.50 |
| Intel Starter — organization | $349 | $87.25 | $3,480 | $870 |
| Intel Growth — organization | $899 | $224.75 | $8,988 | $2,247 |
| Intel Pro — organization | $1,999 | $499.75 | $19,980 | $4,995 |
| CareBase eMAR add-on — facility | $149 | $37.25 | $1,490 | $372.50 |
| CareBase Staff Training add-on — facility | $99 | $24.75 | $990 | $247.50 |
| CareBase Workforce add-on — facility | $99 | $24.75 | $990 | $247.50 |
| CareBase Survey & Compliance add-on — facility | $149 | $37.25 | $1,490 | $372.50 |
| CareBase Resident Billing & Payments add-on — facility | $99 | $24.75 | $990 | $247.50 |

Small Home plans require fewer than 20 licensed beds; Train Single Facility requires a one-facility organization. Per-facility amounts multiply by the number of active billed facilities. Included features and capacity do not change during the sale.

Examples: Core monthly costs **$597** over the first twelve months versus **$2,388** at the regular monthly rate. Core annual costs **$497.50 upfront**, then the regular annual rate (currently **$1,990**) at renewal. Intel Growth monthly costs **$2,697** in first-year subscription charges, before tax; annual costs **$2,247 upfront**. Intel Pro annual is **$4,995 before tax**. Intel onboarding has been free on every plan since November 9, 2026, so no onboarding fee is added.

## Customer-facing offer copy

> **Founders Sale — 75% off your first year**
>
> Start with CareMetric CareBase, CareMetric Train, or CareMetric Intel and save 75% on eligible subscription charges for your first 12 months of paid service.
>
> CareBase Core starts at **$49.75/month per facility** during the offer, and Intel Starter starts at **$87.25/month per organization** on monthly billing. Annual plans are also 75% off their published annual subscription price.
>
> Start your free trial. **Your 75% discount is applied automatically to eligible subscriptions — no code needed.**
>
> For new paid subscriptions to eligible plans; existing free-trial users qualify. Standard subscription pricing resumes after the introductory year. Setup fees, Intel extra seats/locations/states, taxes and custom contracts are excluded. Other promotional discounts cannot be combined. Plan eligibility, capacity limits and regular cancellation terms apply.

CTA destinations: [CareBase / Train trial](https://cmcarebase.com/signup), [Train-only trial](https://cmcarebase.com/signup?product=train), and [Intel plans and trial](https://www.caremetricintel.com/#pricing).

No enrollment deadline or redemption cap was supplied, so none was invented. The one-year limit applies to each redeemed discount, not to a global countdown. This copy is implemented across the product sites, signup, billing, help, terms, and Hub sales guidance. Release and production verification are recorded below.

## Automatic application

The live coupon is now `caremetric_founders_sale_75_12m_20261124` — 75%, repeating for 12 months, restricted to the same 15 products (owner change 2026-11-24). The earlier coupon `caremetric_founders_sale_50_12m_20261108` remains in place for subscriptions already on it. Customers do not enter FOUNDERS75 or request assisted activation. The billing service applies the underlying coupon after server-side paid-history checks, including eligible trial conversions.

- Checkout previews and sessions use the same coupon, with the exact saving persisted in the quote and checked against the paid receipt. Customers see standard price, saving, discounted recurring subtotal, and amount due before payment.
- New paid subscriptions created in Hub administration automatically receive the offer unless an explicit agreement/discount was selected. Published price IDs are allowlisted; private contract prices and retired plans are excluded. Setup, onboarding and Intel expansions remain full price.
- Existing free trials qualify. On the first paid `invoice.created` event, the billing service checks complete subscription and paid-invoice history and applies the coupon to both the subscription and draft invoice. The trial itself does not consume the discount. The year is anchored to trial end, even if delivery is delayed.
- Automatic subscriptions restore standard pricing at the first renewal outside the introductory year, including the edge case where the coupon was attached slightly after the paid-service boundary. Duplicate events and partial provider failures use stable idempotency keys.
- Prior paid service or prior redemption prevents a new introductory year. Other coupons are not stacked. Existing customer agreements remain unchanged. History that cannot be fully read fails closed.
- Keep the billing cadence and renewal anchor during the introductory year. An unusual invoice spanning the end of the year is held for billing reconciliation rather than applying a discount to a second annual period.

`server/founders-sale.mjs` owns these decisions; `server/founders-catalog.mjs` records the verified public price allowlist. Update that list deliberately when publishing new eligible prices. For Intel, whose prices the Hub changes from Intel's own catalog (`docs/PLATFORM_BILLING.md`, "Prices an application sets itself"), a price that replaces an allowlisted price on the same product (its `hub_replaces`, directly or through earlier changes) keeps the offer at its own amount (`followFoundersReplacements`); customers' contract prices never do, and the coupon's product scope is unchanged because the products are the same. CareBase and Train follow their changed prices the same way (`FOUNDERS_FOLLOW_APPS`), so a CareBase or Train price an administrator changes in the Hub keeps the offer; the Hub re-reads the Founders products' prices after every such change and every 15 minutes (`refreshFounders`). Coupon scope and terms are re-read from Stripe before application; unexpected terms stop the purchase. The signed invoice webhook must remain enabled and monitored. A missed or finalized invoice requiring reconciliation returns an error and must be investigated; do not blindly retry a customer charge.

## Validation and follow-up

Read-after-write verification on November 8 confirmed the original coupon's exact product allowlist, 50% discount, 12-month duration and active code. The 75% coupon that replaced it on November 24 has the same 15-product allowlist and 12-month duration, with promotion code FOUNDERS75 active (read from the Hub's Stripe mirror on November 27, 2026). No customer was charged or enrolled. Automated provider fixtures cover checkout discounts and receipt validation, trial conversion, monthly and annual first-year service, standard renewal, duplicate events, interrupted writes, prior paid service, and exclusions. No real customer was charged for testing; these tests do not constitute a live payment or a Stripe test-clock simulation.

Track trial-to-paid conversion, activation by workflow, support hours, AI/video costs, collected recurring revenue net of discounts, retention and discount-expiry renewals separately by product and billing cadence. Review after the initial cohorts activate and again before year-two renewals. A practical planning target is at least **70% contribution margin after direct service costs**; it is a proposed internal target, not measured performance. At 75% off (25% of list price), that leaves a cost budget of 7.5% of regular revenue: about **$15/month per Core facility** or about **$67/month per Intel Growth organization** on monthly billing. Annual sale plans have a lower monthly revenue equivalent and need a tighter budget.

The evidence supports the current pricing structure and a temporary acquisition offer. It does not establish price elasticity or justify claims of guaranteed customer savings, referrals, revenue, or survey outcomes.


## Cross-product rollout

- Intel: public announcement, monthly/annual plan cards, signup, billing offer and plan requests, Help inventory, owner manual/PDF, terms and crawler-readable plans.
- CareBase/Train: all marketing routes, complete plan and add-on pricing, About/How it works, signup, billing, FAQ/guide bot, terms and savings explanation.
- Support Hub: admin billing, customer billing and self-service, generated-content facts, pricing report and activation runbook.
- Regular catalog prices and existing customer contracts are retained. Automatic sale quotes and receipts validate the discounted totals. Public cards lead with the sale price and clearly show standard renewal pricing.
- Release tracking: [Intel #394](https://github.com/kdeyarmin/intel/pull/394), [CareBase/Train #866](https://github.com/kdeyarmin/PennTrain/pull/866), and [Support Hub #151](https://github.com/kdeyarmin/caremetric-support-hub/pull/151). These pull requests contain validation results and merge status; Railway deploys their main-branch commits.

Legacy-code review: `INTELFOUNDING` (`promo_1UV1uvB06O2UFlNz4wIpiWU7`) remains active in Stripe with zero redemptions at the November 8 read-back. All new-offer app copy now uses FOUNDERS75. The connected Stripe API does not expose promotion-code updates, so the older code has not been deactivated. As of November 27, 2026 the Hub's Stripe mirror shows `INTELFOUNDING` (25% off Intel plans, forever) and `FOUNDERS50` (the 50% coupon) both still active with zero redemptions; Hub checkout never accepts a typed code, but both should be turned off in Hub billing (promotion codes, **Deactivate**) so no administrator applies them by mistake. New eligible subscriptions use the automatic Founders Sale; existing agreed lifetime terms are preserved.
