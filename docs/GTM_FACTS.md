# CareMetric go-to-market facts

The single source of truth for what CareMetric says about itself in marketing: what each product is and who it is for,
live prices and trials, the founding-partner offer, the claims we may and may not make, and the words we always (and never)
use. Anything written for a prospect, by a person or by the AI team, starts here.

Status: the owner confirmed every fact, claim and rule on this page on 2026-11-08, from the review copy of this sheet.
They were read on 2026-11-03 from the product code, with sources named below.
The Founders Sale was requested by the owner on 2026-11-08 and its coupon and product scope were verified in the live
CareMetric Stripe account. Current regular prices were also checked against that account.
On 2026-11-12 the owner directed how the team presents CareMetric Intel (the bigger picture: a whole marketing workspace, never an email
tool), gave the founder's story for warmer outreach, and asked that everything the team writes be easy to read and make sense
("How everything must read", "The founder's story" and "CareMetric Intel: the bigger picture" below).

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
| CareMetric Intel | `kdeyarmin/intel@f50b3eb` | `src/lib/planCatalog.ts` (plans, prices, add-ons and `TRIAL_DAYS`, published at `/api/billing/catalog`, which the Hub reads), `docs/marketing-copy.md` (public copy), `docs/competitive-marketing-review.md` (claims we avoid), `src/App.jsx` (public routes) |
| CareMetric Healthcare Advisors | `kdeyarmin/advisors@fe46d1d` | `site-content.mjs` (services, founder, routes) |
| Support Hub | this repository | `server/email-layout.mjs` (support address and line) |

What each product **does**, feature by feature, is read from the products' own published pages rather than kept here:
`server/agents/content/features.mjs` (Intel's /features and home page; CareBase's /features, home page and /faq), refreshed with
`npm run refresh:features` (docs/AI_TEAM.md, "What each product does"). Prices and offers stay on this page.

**Stale source, do not use:** CareBase's `docs/marketing/MARKETING_SITE_REDESIGN_HANDOFF.md` (and `designs/README.md`) still say
CareBase is a flat $499 per organization. That package is retired from sale (`BILLING_MODEL.md`). The live site and code say
**CareBase Core is $199 per facility per month**, and that is what this page uses.

## How everything must read

Owner direction 2026-11-12: some ad copy was hard to understand or did not make sense. These rules open the fact sheet every writer on
the AI team reads (`writing` in `facts.mjs`), and the Creative Director's, Social Media Manager's and growth writer's checks refuse an
empty buzzword, a string of one- or two-word fragments or a sentence over 30 words (`unclearCopy` in `validate.mjs`).

- Plain, everyday words that a busy owner or administrator understands on the first read, with no other context. Write the way you would
  say it out loud to them.
- Say something concrete: who it is for, what they can do, see or stop doing. "Plan the week's visits around the accounts that need them"
  beats "Unlock smarter outreach".
- Complete, short sentences, one idea each. No strings of one-word fragments ("Territory. Clarity. Growth."), no stacked nouns and no
  clever wordplay or puns that need explaining.
- No buzzwords or empty words: unlock, empower, leverage, synergy, seamless, robust, revolutionize, supercharge, game-changer, next-level,
  cutting-edge, elevate, transform, solution, journey.
- A headline must make sense on its own, and every line must make sense to someone who has never heard of CareMetric.
- Reread each line as that reader would; if it could confuse them, or would sound odd said out loud, rewrite it in plainer words.

## The company

- **CareMetric** makes software for healthcare and senior-care organizations and offers healthcare consulting. Source: Hub
  `README.md`, Advisors `site-content.mjs`.
- Founder: **Dr. Kevin C. Deyarmin** (ND, MSW, CHPCA, NCG), founder and principal advisor of CareMetric Healthcare Advisors and
  the founder behind CareBase. Source: Advisors `site-content.mjs` (`brand.founder`), CareBase `About.tsx`.
- **The founder's story** (owner's own words, 2026-11-12; `founder` in `facts.mjs`). Prospect outreach and the founder's partnership
  pitches are written in the founder's first person and told like this:
  - "I run a home health and hospice agency and a healthcare consulting company."
  - "I needed a way to do business intelligence research on my competitors and to find every potential referral source in my market."
  - "So I built CareMetric Intel. It was custom built by someone who uses it every day, and I still do."

  Told about the founder (an ad, a post or an article): CareMetric Intel was custom built by someone who uses it every day: its founder,
  who runs a home health and hospice agency and a healthcare consulting company, and needed a way to research competitors and find every
  potential referral source in the market. Rules: tell it only as written and only about Intel; no results from the founder's agency (referrals, admissions, census,
  revenue or growth), no agency or company name, no number or years, no superlative. Prospect outreach is signed "Dr. Kevin C. Deyarmin, Founder,
  CareMetric".
- Public addresses: support@caremetric.ai and the central support line (877) 521-2890 (Hub `server/email-layout.mjs`);
  hello@caremetric.ai for founding partners (CareBase `About.tsx`). The help center is **https://help.caremetric.ai**; articles about
  CareMetric Intel live at **https://www.caremetricintel.com/resources/<address>** (`intelArticleOrigin`). AI-written articles carry no email address or phone number; they link to the product pages below.

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
- **The bigger picture** (owner direction 2026-11-12; `bigPicture`, `capabilities`, `whoUses` and `present` in `facts.mjs`, written
  from Intel's own /features page and home page with no numbers): see "CareMetric Intel: the bigger picture" below.
- **Trial:** a **30-day** free trial with no credit card, covering 3 marketer seats + 1 manager, 1 branch, home health and
  hospice, 1 county (`TRIAL_DAYS = 30`, the `trial` plan; owner decision 2026-11-12, it was 14 days). It does not turn into a paid subscription by itself.

Plans (Intel's `src/lib/planCatalog.ts`). Annual billing saves about 17%. **Onboarding is free on every plan.**
Intel publishes these figures at `https://www.caremetricintel.com/api/billing/catalog`; once the Hub has read it, the AI team
quotes the catalog (`useAppCatalogFacts` in `server/agents/content/facts.mjs`) and this table is the reviewed copy. When the
catalog moves on, the Hub logs and audits `billing.catalog.facts_stale` until this page and `intelReviewedFacts` are updated.

| Plan | Monthly billing | Annual billing | Includes |
| --- | --- | --- | --- |
| Starter | $349 per month | $290 per month ($3,480 per year) | One office. 3 marketer seats + 1 manager, 1 branch, home health or hospice, up to 10 counties. Extra seats $59 per month ($590 per year on annual billing). Free onboarding. |
| Growth | $899 per month | $749 per month ($8,988 per year) | The usual agency plan, with campaigns, manager tools and AI field help. 10 seats included, up to 3 branches, home health and hospice, 1 full state. Extra seats $49 per month ($490 per year on annual billing). Free onboarding. |
| Pro | $1,999 per month | $1,665 per month ($19,980 per year) | For several territories, with forecasting, territory tools and white-label reports. 25 seats included, up to 10 branches, home health and hospice, up to 3 states. Extra seats $39 per month ($390 per year on annual billing). Free onboarding. |
| Enterprise | custom | annual only, from about $3,500 per month | larger footprints by agreement |

Extra branches are $99 per month each ($990 per year on annual billing) and extra states $199 per month each
($1,990 per year on annual billing).

### CareMetric Intel: the bigger picture

CareMetric Intel runs a healthcare organization's whole marketing program in one workspace, from deciding where to focus to reviewing what came of it. It helps a team understand the market and the territory, build a focused list of referral sources with a clear reason behind each name, keep every relationship moving in a CRM built for healthcare marketing, give every call and visit a purpose, keep marketing spend in view of its policy and the Stark limit, connect the team's effort to the referrals and admissions it records, know the competition, and give managers what they need to set priorities and coach the team. Owners, managers and marketers each work in their own scope of the same shared record.

**Everything it does, by area** (from its own published features page; a plan in brackets is needed for that part):

- Market and territory research: a territory map of providers ranked by lead score; county intelligence on the older-adult population, income and adults living alone, the hospitals residents use and where post-discharge spending goes, the post-acute providers located there and the county's top referral sources; county Medicare enrollment and Medicare Advantage share, home health, hospice and skilled nursing use and supply, spending, readmissions and each agency's market share; facility profiles with ownership, cost-report figures, star ratings and public quality scores; ready-made market briefs for expansion, acquisition, hospital relationships and referral development; and the data release behind every figure.
- Prospecting and targeting: a directory of providers, practices and facilities by name, NPI, specialty and place; Target Builder and saved lead lists worked by status; referral-source rankings for a county built on public Medicare data; physicians newly listed in the area; referral discovery, which compares public volume with the referrals the team has logged to find under-worked hospitals and physicians and counties with high need and little local supply; physician share; and opportunity scores that show what went into them.
- Healthcare marketing CRM: a marketing book of hospitals, nursing homes, personal care and assisted living homes, physician practices, agencies and other referral sources; home health and hospice worked as separate lines of business; relationship stages from Target to Active source and Preferred, with the reason when an account is At risk or Lost; contacts by healthcare role, from discharge planner and case manager to director of nursing; each account's full history beside its market position; a month-end view; duplicate merging and book hygiene; accounts going quiet; side-by-side comparison; handing a whole book to a teammate; and parent organizations.
- Daily field work: a Today page with tasks, progress on goals and the accounts to visit this week, each with a reason; a weekly schedule and call plan; a suggested route built from due follow-ups, slipping sources and key accounts not visited lately; a visit log built for a phone, with check-in, visit templates and a dated next step; a pre-visit card; business card scanning; county call sheets; follow-up emails that book the next visit; calendar sync; and a weekly digest for each marketer.
- Expenses, mileage and reimbursement: spend logged against the referral source it was for, receipt capture, per-person value for shared meals, each physician's running total against the Stark nonmonetary-compensation limit, policy totals for discharge planners and other non-physician sources, policy checks and flags, an approval workflow, reimbursement tracking, budgets, register, compliance and payroll exports, and a mileage log built from visit check-ins. These tools support the organization's compliance program; they are not legal advice.
- Referral and admission tracking: referrals logged on the account they came from, with the service, payer and outcome; response time from arrival to first answer and decision; referral and admission reports imported from EMR exports as CSV files, with patient-identifying columns dropped; a referral funnel by account and marketer; drop-off alerts when a top source slips; a quarterly outcomes packet to share with a hospital or facility; lost reasons; an admissions forecast [Pro]; and dated confirmations of what new referrals the agency can take.
- Competitor intelligence: the home health agencies and hospices in the territory ranked by Medicare share, with star ratings; a watchlist with alerts when a rating, owner or service area changes or a new provider opens nearby; side-by-side comparison and trends; a county roll-up and a scheduled leadership brief; and a plain-language card on how the agency compares with the largest in its county.
- Manager and team tools: monthly visit and referral goals with a leaderboard [setting targets: Growth and Pro]; a review of each marketer's week; activity reports and a weekly email; ride-along notes and coaching; branches [Growth and Pro]; book balance across marketers [Pro]; account briefs and decision briefs; Ask the book for supported questions about the book; and a materials library that shows who opened each file.
- Reports and analytics: results reports (performance scorecard, field activity, follow-up, mileage, referrals and admissions, top sources, why referrals were not admitted, payer mix, source pipeline, account coverage and goal attainment), filtered and grouped by person, location, line of business, county, payer or period, each person seeing their own scope, downloaded as PDF, Excel or CSV, and a custom report builder with scheduled email.
- Email campaigns [Growth and Pro]: campaigns to a lead list or the contacts on the book, with delivery tracking, sender settings and automatic unsubscribe handling. One part of the workspace, never the point of it.
- Administration, security and data: roles and seats, text-message sign-in codes for managers, a record of sign-ins, changes and exports, billing and territory, guided setup and user guides, public data from CMS, NPPES, the U.S. Census Bureau and state licensing files with each release shown, and patient privacy by design: the research uses no patient-level data, and imports, briefs and exports carry no patient names.

**Who uses it, and for what:**

- Owners and administrators: where to focus a small marketing team and its budget, how the market and the competition are moving, and what the team's work led to in recorded referrals and admissions.
- Directors of business development and marketing managers: territory plans, goals, account ownership across branches, a review of each marketer's week, coaching, expense approval and the reports they bring to leadership.
- Marketers and community liaisons: a planned day and route, a focused visit list with a reason for each stop, notes, follow-ups and expenses logged from a phone, and the history of every account they own.

**How to present it.** Owner direction: show the bigger picture. Intel runs the whole marketing program, and sending emails to referral sources is not the point of it. Email campaigns are one feature, on the Growth and Pro plans. Never describe Intel as an email tool, never lead with emailing referral sources, and never make email the whole subject of a message, post, ad, article or answer: when email comes up, show it as one part of the workspace, beside the research, relationships, visits, spend and recorded results it serves. Across your work, cover the whole range above rather than one feature again and again, and pick the part that answers the reader. What a feature needs (a plan in brackets) still applies.

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
- Setup fees, Intel extra seats/branches/states, taxes, legacy plans and custom contracts are excluded. Intel onboarding
  is free on every plan. Other promotional discounts cannot be combined. One introductory year per organization
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
  pricing lives at `/#pricing` on both. Intel's walkthrough is `/#how-it-works` and its free county report `/county-report`
  (both checked on the live site on 2026-11-09: the home page carries `id="how-it-works"` and links `/county-report`).
- Campaign tags: every product page an agent puts in front of a person carries utm_source, utm_medium and utm_campaign
  (`server/agents/links.mjs`; the values are listed in docs/AI_TEAM.md). Citations, help-center links and unsubscribe links are
  never tagged, and no message carries a booking link.
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
- [x] Intel plans, annual prices, seats, free onboarding, monthly and annual add-on prices, the Enterprise floor and the
  trial (read from Intel's catalog; reviewed 2026-11-09). The trial became 30 days on 2026-11-12 (owner decision; Intel's `TRIAL_DAYS`).
- [x] The one-year Founders Sale was requested by the owner and configured in live billing; use the complete terms above.
- [x] Legacy founding-partner agreements: confirm individual terms before referring to them; do not offer lifetime pricing to new prospects.
- [x] Advisors has no published prices, and the consultation form is the first step.
- [x] The claims lists, including that SOC 2 and HIPAA wording stays on CareBase's security page only.
- [x] cms.gov and census.gov as citation hosts for Intel's topics.
- [x] CareBase's avoidance of "evidence" applies to articles and everything else the AI team writes, as well as the landing page.
- [x] 2026-11-12: Intel's bigger picture and "How to present it" (sending emails to referral sources is never the point), the plain-language
  rules, and outreach written and signed as the founder.
- [x] 2026-11-12: the founder's story wording. The owner confirmed: the founder built Intel, and currently runs a home health and
  hospice agency and a consulting company.
