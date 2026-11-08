# CareMetric go-to-market facts

The single source of truth for what CareMetric says about itself in marketing: what each product is and who it is for,
live prices and trials, the founding-partner offer, the claims we may and may not make, and the words we always (and never)
use. Anything written for a prospect, by a person or by the AI team, starts here.

Status: the owner confirmed every fact, claim and rule on this page on 2026-11-08, from the review copy of this sheet.
They were read on 2026-11-03 from the product code, with sources named below.
The Founders Sale was requested by the owner on 2026-11-08 and its coupon and product scope were verified in the live
CareMetric Stripe account. Current regular prices were also checked against that account.

- The machine-readable copy is [`server/agents/content/facts.mjs`](../server/agents/content/facts.mjs). The Content Marketer (see
  [AI_TEAM.md](AI_TEAM.md#the-content-marketer)) shows the model that copy and checks every draft against it, so a price that is
  not on this page cannot reach a public article or an outreach draft.
- `server/agents/content/facts.test.mjs` fails when the two copies disagree on a price, a percentage or a trial length.
- **To change a fact:** change the product first (its pricing code or copy), then this page and `facts.mjs` in the same pull
  request. A price that changes in the product but not here is simply never repeated by the AI team until it is added.

## Sources read

| Product | Repository and commit | Files |
| --- | --- | --- |
| CareMetric CareBase | `kdeyarmin/PennTrain@b9da4e1` | `artifacts/caremetric-carebase/src/components/marketing/marketingPricing.ts` (prices, trial), `src/pages/marketing/About.tsx` (founding partners), `src/components/marketing/marketingMeta.ts` (public routes), `src/pages/marketing/PaTrainingRequirements.tsx` and `PaDhsCitations.tsx` (official source links), `src/pages/Landing.copy.test.ts` (copy rules), `CLAUDE.md` (vocabulary, text-only AI) |
| CareMetric Intel | `kdeyarmin/intel@4a19909` | `server/lib/planLimits.ts` (plans and prices), `server/lib/orgs.ts` (`TRIAL_DAYS = 14`), `docs/marketing-copy.md` (public copy), `docs/competitive-marketing-review.md` (claims we avoid), `src/App.jsx` (public routes) |
| CareMetric Healthcare Advisors | `kdeyarmin/advisors@fe46d1d` | `site-content.mjs` (services, founder, routes) |
| Support Hub | this repository | `server/email-layout.mjs` (support address and line) |

**Stale source, do not use:** CareBase's `docs/marketing/MARKETING_SITE_REDESIGN_HANDOFF.md` (and `designs/README.md`) still say
CareBase is a flat $499 per organization. That package is retired from sale (`BILLING_MODEL.md`). The live site and code say
**CareBase Core is $199 per facility per month**, and that is what this page uses.

## The company

- **CareMetric** makes software for healthcare and senior-care organizations and offers healthcare consulting. Source: Hub
  `README.md`, Advisors `site-content.mjs`.
- Founder: **Dr. Kevin C. Deyarmin** (ND, MSW, CHPCA, NCG), founder and principal advisor of CareMetric Healthcare Advisors and
  the founder behind CareBase. Source: Advisors `site-content.mjs` (`brand.founder`), CareBase `About.tsx`.
- Public addresses: support@caremetric.ai and the central support line (877) 521-2890 (Hub `server/email-layout.mjs`);
  hello@caremetric.ai for founding partners (CareBase `About.tsx`). The help center is **https://help.caremetric.ai**. AI-written
  articles carry no email address or phone number; they link to the product pages below.

## CareMetric CareBase

- **For:** Pennsylvania personal care homes (55 Pa. Code Chapter 2600) and Assisted Living Facilities (55 Pa. Code Chapter
  2800), single or multi-site. Site: https://cmcarebase.com.
- **What it does:** staff training, resident records, daily tasks and survey documentation in one place, with optional eMAR,
  Workforce, Survey & Compliance and Resident Billing & Payments modules. Its AI copilot is **text only** (owner decision
  2026-10-30: no voice, no phone calls).
- **Trial:** a **30-day** free trial, started online at cmcarebase.com/signup (`MARKETING_TRIAL_DAYS = 30`).

Prices (`marketingPricing.ts`; every CareBase price is per active facility, and residents, staff and learners are never counted).

| Plan | Monthly | Yearly |
| --- | --- | --- |
| CareBase Core (unlimited residents and staff) | $199 per facility | $1,990 per facility |
| eMAR add-on | $149 | $1,490 |
| Staff Training add-on | $99 | $990 |
| Workforce add-on | $99 | $990 |
| Survey & Compliance add-on | $149 | $1,490 |
| Resident Billing & Payments add-on | $99 | $990 |
| CareBase Complete (Core plus every add-on) | $649 | $6,490 |
| Compliance Suite (Training, Workforce, Survey & Compliance; no Core) | $279 | $2,790 |
| Small Home (Core with eMAR; fewer than 20 licensed beds) | $199 | $1,990 |
| Small Home Complete (fewer than 20 licensed beds) | $399 | $3,990 |
| CareMetric Train (training only, per organization, unlimited learners) | $239 | $2,390 |
| Train Single Facility | $119 | $1,190 |

**Legacy founding-partner agreements** (historical program). Preserve previously agreed terms; use the new
Founders Sale below for new offers. Do not advertise lifetime pricing as part of the new sale.

- The older page invited early Pennsylvania personal care home and ALF operators to ask about founding-partner terms by
  emailing hello@caremetric.ai; anyone can still start the standard free trial online.
- They get: help setting up their facilities and staff roster, a direct line to the founder, their workflow prioritized on the
  roadmap, and **founding-partner pricing locked for as long as they subscribe**.
- CareMetric asks them to use at least one real workflow in CareBase, join a short feedback call every few weeks, and let
  CareMetric quote agreed results without identifying residents or staff. (The agent's copy says "give feedback every few
  weeks", so that no AI-written text offers a call.)
- Good fit: a PA personal care home or Assisted Living Facility, single or multi-site, running compliance on spreadsheets,
  binders or a training-only LMS.

## CareMetric Intel

- **For:** home health agencies, hospice agencies, hospitals, nursing homes and personal care homes that want more targeted
  marketing. Site: https://www.caremetricintel.com.
- **What it does:** targeted marketing, marketing analysis and territory analysis from public healthcare and demographic data,
  plus a marketing CRM that keeps outreach, follow-up and the referrals the organization records in one place. Its AI features
  (briefs, supported reporting questions, drafted outreach) are text.
- **Trial:** a **14-day** free trial with no credit card, covering one county with 3 marketer seats and 1 manager seat
  (`TRIAL_DAYS = 14`, the `trial` plan). It does not turn into a paid subscription by itself.

Plans (`planLimits.ts`, `docs/marketing-copy.md`). Annual billing saves about 17%.

| Plan | Monthly billing | Annual billing | Includes |
| --- | --- | --- | --- |
| Starter | $349 per month | $290 per month ($3,480 per year) | 3 marketer seats and 1 manager seat, 1 branch, one home health or hospice CRM line, up to 10 counties, extra seats $59 per month, no onboarding fee |
| Growth | $899 per month | $749 per month ($8,988 per year) | 10 seats, up to 3 branches, both CRM lines, 1 full state, campaigns and manager tools, EMR CSV imports and AI briefs, extra seats $49 per month, onboarding $500 (waived with annual billing) |
| Pro | $1,999 per month | $1,665 per month ($19,980 per year) | 25 seats, up to 10 branches, up to 3 states, forecasting and territory tools, white-label reports, extra seats $39 per month, onboarding $1,500 |
| Enterprise | custom | annual only, from about $3,500 per month | larger footprints by agreement |

Extra branches are $99 per month each and extra states $199 per month each.

## Founders Sale — CareBase, Train and Intel

Owner-requested 2026-11-08. **50% off eligible subscription charges for the first 12 months of paid service.**
The live coupon is `caremetric_founders_sale_50_12m_20261108`, with promotion code **FOUNDERS50** in CareMetric's
`acct_1SinLKB06O2UFlNz` account. [Research, full price table, customer copy and redemption steps](PRICING_RESEARCH_AND_FOUNDERS_SALE.md)
and [the verified live configuration](evidence/founders-sale-20261108.json) are the sources for this offer.

- New paid product subscriptions qualify, including existing free-trial users. The discount is applied automatically
  when paid service starts, after the free trial. No code or activation request is needed.
- Monthly subscriptions receive 50% off the regular monthly rate for the introductory year. Annual subscriptions receive
  50% off the published annual price, paid upfront. Standard pricing resumes after the introductory year.
- Includes current CareBase Core, Complete, Compliance Suite, Small Home, Small Home Complete, Train, Train Single Facility,
  and the eMAR, Staff Training, Workforce, Survey & Compliance and Resident Billing & Payments add-ons; Intel Starter,
  Growth and Pro. Small Home and single-facility eligibility and all capacity limits still apply.
- Core example: **$99.50 per facility per month**, or **$995 for the first annual payment**, then the regular rate.
  Intel Starter example: **$174.50 per organization per month**, or **$1,740 for the first annual payment**, then the regular rate.
- Setup fees, Intel extra seats/branches/states, taxes, legacy plans and custom contracts are excluded. Growth's existing
  annual onboarding waiver remains. Other promotional discounts cannot be combined. One introductory year per organization
  and product; cancellation/restart does not reset it. No enrollment deadline or redemption cap has been set.
- Checkout, paid subscription creation and eligible trial conversions apply the underlying coupon automatically after
  server-side eligibility checks. Quotes show the saving before payment; existing agreements are preserved.
- Existing lifetime founding-partner agreements and Intel's earlier 25%-forever coupon are separate and unchanged.
  The new sale is never advertised as a lifetime rate. Product-site, signup, billing, help and terms propagation is tracked in the pricing report. No customer was enrolled.

## CareMetric Healthcare Advisors

- **For:** owners, operators, leadership teams and investors in home health, hospice, skilled nursing, personal care homes and
  assisted living. Site: https://caremetricadvisors.com.
- **What it does:** consulting on strategy and operations, clinical quality and compliance, financial performance and
  reimbursement, acquisition advisory and due diligence, education and leadership, technology and workflow, and personal care
  home and ALF operations.
- **Prices:** none published; engagements are scoped to the problem. A conversation starts with the consultation request form
  at caremetricadvisors.com/contact, with no obligation to move forward. Business consulting only: never send patient
  information through the site.

## Claims

**We may say** (confirmed 2026-11-08):

- What each product does and who it is for, in the words above.
- The prices, plans, trials and offers above, exactly as written, with the product they belong to.
- That CareBase keeps staff training, resident records, daily tasks and survey documentation in one place for Pennsylvania
  personal care homes and Assisted Living Facilities.
- That a product helps a team stay organized, see what needs attention and keep records ready for a surveyor.
- What a regulation says, from the regulation itself, with its section cited and the "not legal advice" line.

**We may not say** (enforced in code for the AI team by `server/agents/content/validate.mjs`; confirmed 2026-11-08):

- Any price, discount, percentage, count of customers, time saved or other number about CareMetric that is not on this page.
- A guarantee or promise of an outcome: passing a survey or inspection, avoiding citations, fines or deficiencies, more
  referrals, more revenue or a return on investment (Intel's competitive review: no savings percentage, referral increase or
  financial return without evidence).
- A legal or compliance assurance: that a product "ensures compliance", keeps a facility compliant, makes it survey-proof, or is
  approved, endorsed or certified by the Department of Human Services, the state or anyone else.
- Security or privacy certifications or uptime. CareBase's security page states "SOC 2 compliant" and its HIPAA safeguards
  itself; AI-written content does not repeat them until the owner confirms the wording.
- AI that talks on the phone, answers calls or uses voice. CareMetric's AI is text only.
- A phone call, sales call or demo booking as a required step: CareBase and Intel are evaluated with a free trial online, and
  Advisors starts with its consultation request form.
- Named competitors or comparisons with them (Intel's comparison page is dated and sourced; AI-written text makes none).
- Anything about a real resident, patient, employee or facility, or any personal or health information.
- Customer results, testimonials or case studies: none are approved yet (Intel's case studies are labeled illustrative).
- That public data confirms a referral: Medicare and Census figures are research signals; referrals are what the organization
  records (Intel `docs/marketing-copy.md`).

## Vocabulary

- **"Assisted Living Facility" or "ALF", never "Assisted Living Residence" or "ALR"**, in every customer-facing text, even though
  Chapter 2800 itself says "assisted living residence" (PennTrain `CLAUDE.md`). The internal code `ALR` stays in CareBase's
  database; it never appears in copy.
- **The Department of Human Services' inspectors are "surveyors"**, and their visit is a survey or an inspection, **never an
  "auditor" or an "audit"** (PennTrain `CLAUDE.md`; the auditor role is retired).
- **CareBase never says "prove", "proof" or "evidence"**: talk about survey readiness, documentation and records
  (`Landing.copy.test.ts`; the owner confirmed on 2026-11-08 that avoiding "evidence" applies to everything the AI team writes about
  CareBase, articles included).
- **Text-only AI, never phone calls** (owner decision 2026-10-30).
- Product names: CareMetric CareBase (CareBase), CareMetric Intel (Intel), CareMetric Healthcare Advisors.

## Links and sources the AI team may use

- Product pages, by id, in `facts.mjs` (`productPages`): only routes each product's own code defines. The CareBase and Intel
  sites answer 200 for any address, so an invented path such as cmcarebase.com/pricing would look fine and show the home page;
  pricing lives at `/#pricing` on both.
- Official sources, by id, in `facts.mjs` (`officialSources`): the Pennsylvania Code chapters and sections the backlog's topics
  cite (55 Pa. Code Chapters 20, 2600 and 2800 on pacodeandbulletin.gov, in the form cmcarebase.com already cites), the DHS
  personal care home reports page on pa.gov, and CMS and Census data pages for Intel's topics. Each address was opened and
  checked on 2026-11-03.
- Hosts a citation may use: pa.gov (and its subdomains, such as dhs.pa.gov), pacodeandbulletin.gov, palegis.us, the company's
  own sites (cmcarebase.com, caremetricintel.com, caremetricadvisors.com, help.caremetric.ai) and, for Intel's topics, the
  federal sources Intel itself reads: cms.gov and census.gov (confirmed 2026-11-08).

## Owner confirmation

Confirmed by the owner on 2026-11-08 from the review copy of this sheet.

- [x] CareBase prices, add-ons, Complete, Compliance Suite, Small Home and Train prices, and the 30-day trial.
- [x] Intel plans, annual prices, seats, onboarding fees, add-ons, the Enterprise floor and the 14-day trial.
- [x] The one-year Founders Sale was requested by the owner and configured in live billing; use the complete terms above.
- [x] Legacy founding-partner agreements: confirm individual terms before referring to them; do not offer lifetime pricing to new prospects.
- [x] Advisors has no published prices, and the consultation form is the first step.
- [x] The claims lists, including that SOC 2 and HIPAA wording stays on CareBase's security page only.
- [x] cms.gov and census.gov as citation hosts for Intel's topics.
- [x] CareBase's avoidance of "evidence" applies to articles and everything else the AI team writes, as well as the landing page.
