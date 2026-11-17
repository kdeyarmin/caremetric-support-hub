# CareMetric go-to-market facts

The single source of truth for what CareMetric says about itself in marketing: what each product is and who it is for,
features and functions, reasons to choose it, prices and trials, the founding-partner offer, the claims we may and may not make, and the words we always (and never)
use. Anything written for a prospect, by a person or by the AI team, starts here.

Original review: the owner confirmed every fact, claim and rule on this page on 2026-11-08, from the review copy of this sheet as it stood then.
They were read on 2026-11-03 from the product code, with sources named below.
The Founders Sale was requested by the owner on 2026-11-08 and its coupon and product scope were verified in the live
CareMetric Stripe account. Current regular prices were also checked against that account.
On 2026-11-12 the owner directed how the team presents CareMetric Intel (the bigger picture: a whole marketing workspace, never an email
tool), gave the founder's story for warmer outreach, and asked that everything the team writes be easy to read and make sense
("How everything must read", "The founder's story" and "CareMetric Intel: the bigger picture" below).

**Expanded 2026-11-14:** product capabilities, business reasons, roles, workflow examples and the complete saved feature inventory are
now included in this document. The inventory uses the product-page snapshots reviewed on 2026-11-09. A live refresh was attempted
on 2026-11-14 but blocked by the network proxy; this expansion is not a new verification of production availability or pricing.
New benefit wording describes how the documented tools can help, not measured customer results or a new owner approval of claims.
Buying guidance covers plan selection, rollout, trial evaluation, ongoing costs, exports and support, using the same reviewed sources.

**CareBase reference updated 2026-11-16:** cmcarebase.com/features was redesigned, and the
[CareBase feature and function reference](#carebase-feature-and-function-reference) now follows it: 112 capabilities across 8 areas,
each with the plan or add-on the page names, read from the live public pages on 2026-11-16 (`npm run refresh:features`). The
CareBase summary "Everything it does, by area" (and `capabilities` in `facts.mjs`) follows the same eight areas. Later the same day the
[Intel feature and function reference](#intel-feature-and-function-reference) and Intel's "Everything it does, by area" were refreshed
from caremetricintel.com: 125 features across 12 areas, 8 data families and the site's 10 care settings, with who Intel is for left as
this sheet states. A refresh on 2026-11-17 brought it to 128 features: nursing homes and hospitals joined the competitor rankings
and alerts, and the site added new referral sources for every kind of customer, a reports library and My organization. Reading the public pages is not a new verification of production availability or pricing, and the rewritten
references and summaries await the owner's confirmation below.

## Which offering fits the company

| Company need | Offering | Main reason to consider it |
| --- | --- | --- |
| Run a Pennsylvania personal care home or Assisted Living Facility, including staff requirements, resident records and survey preparation. | **CareMetric CareBase** | Connect daily work, responsibilities and documentation across the facility or organization. Choose the needed modules. |
| Manage staff education without the full resident-operations system. | **CareMetric Train** | Use the separate training plan for courses, live classes and staff training-compliance tools, with unlimited learners. |
| Research a healthcare market and run the team's marketing activity through recorded results. | **CareMetric Intel** | Bring territory research, a healthcare marketing CRM, field work, expenses and referral reporting into one workspace. |
| Get advice on a healthcare business problem, operating change or acquisition. | **CareMetric Healthcare Advisors** | Scope a consulting engagement around the decision or work the organization needs help with. |

CareBase, Intel and Advisors serve different needs. A purchase of one does not imply access to the others.
This sheet covers these commercial offerings; it is not a feature sheet for the internal Support Hub or Breathe.

**Read by need:** [CareBase and Train](#caremetric-carebase) · [Intel](#caremetric-intel) ·
[Advisors](#caremetric-healthcare-advisors) · [Founders Sale](#founders-sale--carebase-train-and-intel) ·
[Choosing a plan](#choosing-a-plan) · [Getting started](#getting-started) ·
[Evaluating the business case](#evaluating-the-business-case) · [Data and exports](#data-ownership-and-exports) ·
[Support and next steps](#support-and-next-steps) ·
[Full feature and function reference](#feature-and-function-reference) · [Claim rules](#claims).

## Keeping the fact sheet current

- The machine-readable copy is [`server/agents/content/facts.mjs`](../server/agents/content/facts.mjs). The Content Marketer (see
  [AI_TEAM.md](AI_TEAM.md#the-content-marketer)) shows the model that copy and checks every draft against it, so a price that is
  not in its approved pricing cannot reach a public article or an outreach draft. Detailed feature prompts also use the product catalogs below.
- `server/agents/content/facts.test.mjs` fails when the two copies disagree on a price, a percentage or a trial length.
- **To change a fact:** change the product first (its pricing code or copy), then this page and `facts.mjs` in the same pull
  request. Intel's live billing catalog is the exception described under Intel pricing: it supplies current values and flags a stale reviewed copy.
- **To update capabilities:** run `npm run refresh:features`, review the changes against the product pages, and update this document's
  feature reference and summaries in the same change. Preserve plan, role and setup conditions. Keep `whyChoose`, `capabilities`
  and `whoUses` in `facts.mjs` aligned with the corresponding sections here. Published feature counts do not override the claim rules.
- Keep Intel's industry table and its access conditions aligned with `industryUseCases` and `industryGuidance` in `facts.mjs`.
  Both are included in `factSheetText()`, so the AI workforce receives the industry guidance alongside the other product facts.

## Sources read

| Product | Repository and commit | Files |
| --- | --- | --- |
| CareMetric CareBase | `kdeyarmin/PennTrain@b9da4e1` | `artifacts/caremetric-carebase/src/components/marketing/marketingPricing.ts` (prices, trial), `src/pages/marketing/About.tsx` (founding partners), `src/components/marketing/marketingMeta.ts` (public routes), `src/pages/marketing/PaTrainingRequirements.tsx` and `PaDhsCitations.tsx` (official source links), `src/pages/Landing.copy.test.ts` (copy rules), `CLAUDE.md` (vocabulary, text-only AI) |
| CareMetric Intel | `kdeyarmin/intel@f50b3eb` | `src/lib/planCatalog.ts` (plans, prices, add-ons and `TRIAL_DAYS`, published at `/api/billing/catalog`, which the Hub reads), `docs/marketing-copy.md` (public copy), `docs/competitive-marketing-review.md` (claims we avoid), `src/App.jsx` (public routes) |
| CareMetric Healthcare Advisors | `kdeyarmin/advisors@fe46d1d` | `site-content.mjs` (services, founder, routes) |
| Support Hub | this repository | `server/email-layout.mjs` (support address and line) |

The [feature and function reference](#feature-and-function-reference) below contains every entry in the reviewed product catalogs:

| Product | Feature sources | Saved source used in the reference |
| --- | --- | --- |
| CareBase | https://cmcarebase.com/features, https://cmcarebase.com/ and https://cmcarebase.com/faq | [carebase-features.json](../server/agents/content/carebase-features.json), reviewed 2026-11-16: 112 capabilities in 8 areas, each with the plan or add-on it needs, plus roles, workflow and operating conditions. |
| Intel | https://www.caremetricintel.com/features and https://www.caremetricintel.com/ | [intel-features.json](../server/agents/content/intel-features.json), reviewed 2026-11-17: 128 features in 12 areas, plus 8 data families and the site's 10 care settings. |

[features.mjs](../server/agents/content/features.mjs) presents these same catalogs to the AI team; refresh them with
`npm run refresh:features` ([AI_TEAM.md](AI_TEAM.md), "What each product does"). Prices and offers remain governed by this sheet
and Intel's billing catalog, not by a feature-page headline. Advisors' service scope comes from `site-content.mjs` above.

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

### CareBase: what the company gets

CareBase connects the records and daily work a care organization needs to manage staff, residents and facilities. Managers see missing requirements, assign follow-up and prepare documentation from the same records staff use. Available modules depend on the subscription; CareMetric Train provides training separately.

**Top reasons a company would choose it:**

- Keep daily work and survey documentation together. Training, credentials, resident records and follow-up tasks give managers a shared view of what needs attention.
- Spend less effort chasing records. Due dates, reminders, assigned owners and overdue alerts make responsibilities visible instead of relying on separate calendars and messages.
- Bring training into the operating workflow. Maintained courses, reviewed policy-based lessons, live attendance, quizzes and certificates keep learning and its records together.
- Manage across facilities without giving everyone the same access. Organization leaders can review the portfolio while managers and employees work within their assigned scope.
- Keep continuity when people change roles. Shared records, retained history and reassigned responsibilities help the next administrator continue the work.
- Choose the modules that match the work. Compare existing training trackers, schedules, incident logs and ledgers with the relevant CareBase modules before retiring a tool. Potential savings depend on actual use.

**Everything it does, by area:**

- Resident care & daily operations [CareBase Core]: inquiries, admissions and move-in checklists; census and room readiness; resident assessments and support plans, with reassessment deadlines and review triggers; agreements signed through guest links; clinical charting of vitals, progress notes and care plans; daily services, care tasks and refusals; change-of-condition follow-up and provider notifications; dietary and food-safety rounds; meal and activity calendars; appointments and transportation; resident documents and history; designated-person and move-in portals; discharge records; maintenance work orders; and emergency plans with resident accountability.
- Staff training & learning [Staff Training add-on or CareMetric Train]: a course catalog the CareMetric team maintains and maps to Pennsylvania requirements; graded quizzes, completion records and certificates; role-based plans and automatic assignments; custom requirements and renewal dates; a training-compliance matrix with export; live classes with digital sign-in, trainer-managed rosters and signed attendance sheets; outside training reviewed by a manager; retraining; an offline-capable training player; certificate verification; and training reports. Required accredited or external training still needs an eligible provider.
- Medication management & eMAR [eMAR add-on · facility activation required]: medication rounds and passes; orders with independent review; scheduled and as-needed (PRN) medications; resident, medication and barcode checks; administration limited to staff whose medication training and insulin qualification are current; refusals, omissions and amendments; PRN follow-up; prescriber holds; controlled-substance counts with a witness; refills and leave packages; printable medication records and downtime packets; and oversight reports. Native eMAR requires facility enrollment, clinical approval and a documented switch to CareBase as the official medication record; until then the facility keeps its existing record, and imported medication events are read-only.
- Survey readiness, safety & quality [Survey & Compliance tools; confidential incidents require Core]: the Today workspace; a readiness score for prioritizing tracked gaps; binder and survey-packet exports; Survey Day Mode with the entrance-conference checklist and an on-shift roster; resident deadlines, including medical evaluations; mock surveys and request tracking; a crosswalk to Pennsylvania's personal care home and ALF rules; time-limited, read-only documentation rooms for surveyors; incidents and reporting deadlines; confidential incidents; complaints and resident rights; violations and plans of correction; fire drills and life-safety records; document templates and DHS forms; quality projects; an assigned work queue with escalation; and policy acknowledgments. The readiness score does not predict survey results, and staff still make and document required reports.
- Workforce, credentials & scheduling [Workforce add-on]: employee records and invitations; clearances; provisional-employment deadlines; licenses, TB and employment-eligibility records; administrator qualifications and continuing education; competency checklists and observed assessments; the medication authorization roster, practicums and annual observations; shift handoffs; shift scheduling with templates and auto-fill; coverage gaps; cross-facility float staff; time-off approvals; and schedules on a phone. Federal exclusion-list checks remain outside CareBase.
- Resident billing & payments [Resident Billing & Payments add-on]: a resident subledger with account history; rate agreements and effective-dated charges; care-level rates; facility billing runs and batch statements; receivables and payment allocation; family payments through the portal; autopay authorization records; personal-funds transactions and statements; independent approval for protected fund actions; move-out closeout; and exports for the accounting workflow. It works alongside the accounting ledger and claims system, not in place of them.
- AI assistance with human review [Staff Training and Survey & Compliance tools]: courses the CareMetric team drafts with AI assistance from policies and source documents, with lesson text, video scripts and graded quiz drafts, optional presenter videos, and a named reviewer's approval before publication. The text copilot answers from facility records and regulatory references, drafts plans of correction and mock-survey preparation, and proposes follow-up that a person must approve.
- Access, integrations & onboarding [Platform tools · access depends on your plan and role]: online signup and guided setup; staff roster imports reviewed before they apply; an import center; FHIR imports of medications, allergies and diagnoses from compatible clinical systems; role-based access by facility; account verification by text message and security policies; private documents with expiring links; a record of actions taken; email, in-app and (when enabled) text alerts with escalation; time-limited guest access; an installable employee app; organization-wide reports; in-app help and product updates; and single sign-on and enterprise provisioning through a managed rollout. Employees see their own records; surveyors receive scoped documentation links without a CareBase sign-in.

**Who uses it, and for what:**

- Owners and organization administrators: review facilities, compare priorities, configure requirements and manage access across the organization.
- Facility managers: resolve overdue work, review staff coverage, validate outside training and prepare requested survey documentation for their assigned sites.
- Trainers: assign courses, schedule classes, record attendance and manage practicum documentation.
- Employees: complete their own training, view published shifts, sign policies and upload records from a browser or phone.
- Surveyors: review only the documentation shared through a scoped, time-limited link, without editing records or receiving a CareBase sign-in.
- Guests, families and designated persons: use time-limited links for shared move-in records, agreements and documentation without a full user account; with Resident Billing & Payments, families can also pay through the portal.

**Example workflow:** import and review a staff roster, configure applicable requirements, and assign courses or a live class.
Record completion or reviewed attendance, resolve missing requirements, and prepare the requested documentation for a surveyor.
Resident workflows run from inquiry and admission through assessments, daily services, reassessment and move-out.
The [full reference](#carebase-feature-and-function-reference) lists every capability and explains these workflows.

**Fit and boundaries:** CareBase is designed primarily for Pennsylvania PCH and ALF operations under Chapters 2600 and 2800.
Its training workflows also support Chapter 6400 homes and federal aide requirements; this does not imply full resident-operations
coverage for every setting. Confirm applicable requirements and retain required signed official forms.
CareMetric Train is the separate training offering, not a bundle of every CareBase module.

CareBase works alongside EHR, payroll, timeclock, HR, general accounting, claims and emergency-call systems.
FHIR is a healthcare data exchange standard; connections require a compatible, configured clinical system.
Native eMAR requires facility enrollment, clinical approval and a documented switch to the official medication record.
Required accredited or external training still needs an eligible provider. Federal exclusion checks remain outside CareBase.
AI drafts and proposed actions need human review; a readiness score helps prioritize gaps and does not predict survey results.

### CareBase and Train pricing

Prices (`marketingPricing.ts`): CareBase plans and add-ons are per active facility; the organization-wide Train plan is the
explicit exception shown below. Residents, staff and learners are not priced per person.

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
  marketing. These five are the primary audience. Site: https://www.caremetricintel.com.
- **Secondary markets** (owner decision 2026-11-16): physician practices, behavioral health, rehabilitation and therapy,
  diagnostics, dialysis and DME suppliers. Intel serves them too, and its site lists them after the primary five, but no outreach,
  content or ads are aimed at them until the primary audience has been thoroughly marketed to.
- **Prospect discovery** (`discoveryGrid` in `server/growth/playbook.mjs`) searches for home health and hospice agencies and, since
  2026-11-16 (owner decision), nursing homes. Intel's free reports (an agency's own market report, the market review and the county
  report) cover home health and hospice agencies only, so a prospect whose own name or research shows it is a nursing home gets emails
  written for a nursing home instead (its hospital sources, the homes around it, its county, the free trial), and is never offered those
  report pages (`intelSetting`, `nursingHomeAngles` and `campaign.mjs`). Hospitals and personal care homes are not searched yet: widening discovery to them
  is a separate owner decision.
- **What it does:** targeted marketing, marketing analysis and territory analysis from public healthcare and demographic data,
  plus a marketing CRM that keeps outreach, follow-up and the referrals the organization records in one place. Its AI features
  (briefs, supported reporting questions, drafted outreach) are text.
- **The bigger picture** (owner direction 2026-11-12; `bigPicture`, `capabilities`, `whoUses` and `present` in `facts.mjs`, written
  from Intel's own /features page and home page with no numbers): see "CareMetric Intel: the bigger picture" below.
- **Trial:** a **30-day** free trial covering 3 marketer seats + 1 manager, 1 location, up to 2 healthcare service lines of your
  choice, 1 county (`TRIAL_DAYS = 30`, the `trial` plan; owner decision 2026-11-12, it was 14 days; the coverage as Intel's billing
  catalog states it since 2026-11-16, where it was 1 branch, home health and hospice). **A credit card is required to start the
  trial**, and the plan chosen at sign-up bills automatically when the trial ends unless it is canceled before then (Hub billing
  since 2026-11-14, [Platform billing](PLATFORM_BILLING.md); Intel's site: "Credit card required · Cancel before trial end to avoid
  charges"). Never write "no credit card" for Intel (`trialCardTerms` in `facts.mjs`).
- **How to offer the trial** (owner direction 2026-11-17; `trialMention` in `facts.mjs`): a card at sign-up is ordinary for a trial,
  so nothing the team writes brings it up unasked.
  - An email, a post, an ad or an article offers the trial in plain words: its length and what it covers.
  - The card and billing terms above are stated, exactly as written, only when a reader asks what the trial needs or what happens
    when it ends.
  - They stay where the card is entered or is the subject: Intel's sign-up, Billing and pricing pages, and the email that asks a
    sign-up to finish adding its card.
  - Nothing may say that no card is needed (refused in code, `trial_terms`), and nothing calls the trial risk-free.
  - A prospect email that names the card is refused when it is written and withdrawn when it would be sent (`card_terms` in
    `server/growth/draft.mjs`).
- **How email names Intel's data** (owner direction 2026-11-17): by its source, without the word "public".
  - A prospect email and a sales reply say "Medicare data" or "CMS and Census data", never "public Medicare data", "publicly
    available data" or "free data". A prospect email that does is refused and, if already queued, withdrawn (`public_data`).
  - This sheet, the catalog, the website, ads, posts and articles still use the word; only email and the reports it delivers changed.
  - Nothing calls the data proprietary, exclusive or licensed. What is CareMetric's own is the analysis: the report, the rankings
    and the plan built from them.
  - When a reader asks whether the data is public or where it comes from, the answer is plain: CMS, NPPES and Census Bureau data
    that CareMetric Intel analyzes.

Plans (Intel's `src/lib/planCatalog.ts`). Annual billing saves about 17%. **Onboarding is free on every plan.**
Intel publishes these figures at `https://www.caremetricintel.com/api/billing/catalog`; once the Hub has read it, the AI team
quotes the catalog (`useAppCatalogFacts` in `server/agents/content/facts.mjs`) and this table is the reviewed copy. When the
catalog moves on, the Hub logs and audits `billing.catalog.facts_stale` until this page and `intelReviewedFacts` are updated.

| Plan | Monthly billing | Annual billing | Includes |
| --- | --- | --- | --- |
| Starter | $349 per month | $290 per month ($3,480 per year) | One office. 3 marketer seats + 1 manager, 1 location, 1 healthcare service line of your choice, up to 10 counties. Extra seats $59 per month ($590 per year on annual billing). Free onboarding. |
| Growth | $899 per month | $749 per month ($8,988 per year) | For growing healthcare teams, with campaigns, manager tools and AI field help. 10 seats included, up to 3 locations, up to 2 healthcare service lines of your choice, 1 full state. Extra seats $49 per month ($490 per year on annual billing). Free onboarding. |
| Pro | $1,999 per month | $1,665 per month ($19,980 per year) | For several territories, with forecasting, territory tools and white-label reports. 25 seats included, up to 10 locations, up to 2 healthcare service lines of your choice, up to 3 states. Extra seats $39 per month ($390 per year on annual billing). Free onboarding. |
| Enterprise | custom | annual only, from about $3,500 per month | larger footprints by agreement |

Extra locations are $99 per month each ($990 per year on annual billing) and extra states $199 per month each
($1,990 per year on annual billing).

### Top reasons a company would choose Intel

- Put the whole marketing program in one workspace. Research, account relationships, visits, follow-ups, expenses and recorded results share the same working context.
- Direct time and budget toward a reasoned target list. Territory demographics, provider profiles, public utilization signals and account coverage help teams decide where to focus.
- Keep relationships from depending on one person. Named account owners, healthcare contacts, stages, shared history and book hand-offs preserve context when responsibilities change.
- Give field work a purpose and a next step. Pre-visit cards, call plans, routes, mobile visit logs and dated follow-ups connect preparation with the work after a visit.
- See what recorded activity led to. Referral funnels, admissions, response times and lost reasons let managers review results alongside visits and outreach without treating public data as confirmed referrals.
- Review marketing spend with the supporting records. Account-linked expenses, receipts, per-person values, policy flags, approvals and reimbursement records help managers examine spending. These tools are not legal advice.
- Bring market changes and team priorities into management reviews. Competitor alerts, goals, coaching, scoped reports and scheduled briefs support decisions across people and locations, subject to plan and role.
- Reduce repeated research and report assembly. Saved lists, account history, supported reporting questions, file imports and reusable reports bring the work together. Any time or cost benefit depends on use.

**Example workflow:** compare counties and providers, save a target list, add relevant accounts to the marketing book, and assign an owner.
Prepare a visit, plan the route, log what happened and set the next step. Attach expenses to the account, then record or import referral
outcomes. Review the results with the team and adjust priorities. This describes a workflow, not a promise of new referrals.

**Fit and boundaries:** research coverage varies by care setting, geography, dataset and plan. Data releases and loading dates are
shown in the product; public signals and opportunity scores do not establish a referral relationship or individual demand.
Company results come from records the team enters or imports. CSV, SFTP and email-delivered reports are file-based imports, not live
EMR connections. Patient-identifying import columns are dropped; keep patient details out of free-text notes and support requests.
Mileage uses straight-line distance between check-ins. Reimbursement tracking records payment status; it does not send payment.
Expense flags support internal review and are not a legal safe harbor. AI assistance depends on the plan, role and configured services,
and generated drafts need review. The [full reference](#intel-feature-and-function-reference) preserves each feature's access conditions.

### CareMetric Intel: the bigger picture

CareMetric Intel runs a healthcare organization's whole marketing program in one workspace, from deciding where to focus to reviewing what came of it. It helps a team understand the market and the territory, build a focused list of referral sources with a clear reason behind each name, keep every relationship moving in a CRM built for healthcare marketing, give every call and visit a purpose, keep marketing spend in view of its policy and the Stark limit, connect the team's effort to the referrals and admissions it records, know the competition, and give managers what they need to set priorities and coach the team. Owners, managers and marketers each work in their own scope of the same shared record.

**Everything it does, by area** (from its own published features page; a plan in brackets is needed for that part):

- Market and territory research: a territory map of providers ranked by lead score; county intelligence on the older-adult population, income and adults living alone, the hospitals residents use and where post-discharge spending goes, the post-acute providers located there and the county's top referral sources; demographics for each county and ZIP area, with the change since the last census; each county's Medicare Advantage plans and ratings, Medicaid managed care where it is published, chronic disease, social vulnerability and shortage areas; county Medicare enrollment and Medicare Advantage share, home health, hospice and skilled nursing use and supply, spending, readmissions and each agency's market share; a Site finder that ranks counties or ZIP areas for a new office or facility by demand, growth, need and the gap in supply; facility profiles with ownership, cost-report figures, star ratings and public quality scores; ready-made market briefs for expansion, acquisition, hospital relationships and referral development; and the data release behind every figure.
- Public data library: public healthcare datasets from CMS, NPPES, the U.S. Census Bureau, HRSA, CDC, AHRQ, BLS, the HHS Office of Inspector General and state licensing agencies, linked by provider, facility, county and ZIP area: every provider in the national NPI registry, with Medicare services, certifications and prescribing; facility quality, inspections, staffing, ownership and cost reports; Medicare use, spending and enrollment; demographics and growth; Medicare Advantage and other payers; community health and need; a provider's standing, such as an exclusion, an opt-out or the next revalidation, and payments from drug and device makers; state-licensed homes where a state's file is loaded; and daily checks for new releases, with outdated data retired rather than shown as current.
- Prospecting and targeting: a directory of providers, practices and facilities by name, NPI, specialty and place; Target Builder and saved lead lists worked by status; referral-source rankings for a county built on public Medicare data; physicians newly listed in the area; referral discovery, which compares public volume with the referrals the team has logged to find under-worked hospitals and physicians and counties with high need and little local supply; physician share; and opportunity scores that show what went into them.
- Healthcare marketing CRM: a marketing book of hospitals, nursing homes, personal care and assisted living homes, physician practices, agencies and other referral sources; separate lines of business, with its own stage and history for an account on each; relationship stages from Target to Active source and Preferred, with the reason when an account is At risk or Lost; contacts by healthcare role, from discharge planner and case manager to director of nursing; each account's full history beside its market position; which members of a physician group certify home health or oversee hospice care, and what the book admitted from them; account tiers with a visit cadence for each, and who is behind on it; calls and texts from an account through the phone's own dialer and messages, logged in a tap, with nothing placed or sent from Intel; a month-end view; duplicate merging and book hygiene; accounts going quiet; side-by-side comparison; handing a whole book to a teammate; and parent organizations.
- Daily field work: a Today page with tasks, progress on goals and the accounts to visit this week, each with a reason; a weekly schedule and call plan; a suggested route built from due follow-ups, slipping sources and key accounts not visited lately; a visit log built for a phone, with check-in, visit templates and a dated next step; a pre-visit card; directions to each account; business card scanning; county call sheets; follow-up emails that book the next visit; calendar sync; and a weekly digest for each marketer.
- Expenses, mileage and reimbursement: spend logged against the referral source it was for, receipt capture, per-person value for shared meals, each physician's running total against the Stark nonmonetary-compensation limit, policy totals for discharge planners and other non-physician sources, policy checks and flags, an approval workflow, reimbursement tracking, budgets, register, compliance and payroll exports, and a mileage log built from visit check-ins. These tools support the organization's compliance program; they are not legal advice. A small part of the workspace, never the point of it.
- Referral and admission tracking: referrals logged on the account they came from, with the service, payer and outcome; response time from arrival to first answer and decision; referral and admission reports imported from EMR exports as CSV files, with patient-identifying columns dropped; a referral funnel by account and marketer; drop-off alerts when a top source slips, and what the book shows about why, with the next step as a task; a quarterly outcomes packet to share with a hospital or facility; a shareable profile page for referral sources with intake details, current availability and public ratings; lost reasons; an admissions forecast [Pro]; and dated confirmations of what new referrals the organization can take.
- Competitor intelligence: the home health agencies, hospices and nursing homes in the territory ranked by Medicare share, with star ratings; a watchlist with alerts when a rating, owner or service area changes or a new provider opens nearby; side-by-side comparison and trends; a county roll-up and a scheduled leadership brief; a plain-language card on how the agency compares with the largest in its county; and a free agency market review anyone can request on Intel's site.
- Manager and team tools: monthly visit and referral goals with a leaderboard [setting targets: Growth and Pro]; a review of each marketer's week; activity reports and a weekly email; ride-along notes and coaching; locations [Growth and Pro]; book balance across marketers [Pro]; account briefs and decision briefs; Ask the book for supported questions about the book; an AI Assistant that answers typed questions about the market, the book and the day and proposes lists, visits, tasks and drafts that are saved only when someone confirms [Growth and Pro]; an AI playbook of pitch pillars, service lines and words to avoid; connecting an AI app that supports MCP to read Intel [Growth and Pro]; friendly activity challenges and a monthly report card, never on referrals or admissions; a calendar of healthcare observances; and a materials library that shows who opened each file.
- Reports and analytics: results reports (performance scorecard, field activity, follow-up, mileage, referrals and admissions, top sources, why referrals were not admitted, payer mix, source pipeline, account coverage and goal attainment), filtered and grouped by person, location, line of business, county, payer or period, each person seeing their own scope, downloaded as PDF, Excel or CSV; source quality after admission, by referral source, marketer or location (how long patients stay, short stays, hospice live discharges and revocations, home health returns to the hospital, and average daily census against each location's budget) [loading reports: owners]; and a custom report builder with scheduled email.
- Email campaigns [Growth and Pro]: campaigns to a lead list or the contacts on the book, with delivery tracking, sender settings and automatic unsubscribe handling. Nurture sequences of calls, visits, emails and tasks on an account, which stop on a referral, a contact leaving or a marked reply, are on every plan. One part of the workspace, never the point of it.
- Administration, security and data: roles and seats, text-message sign-in codes for owners and location managers, a record of sign-ins, changes and exports, billing and territory, guided setup and user guides, a service-line menu and search across the app, a nightly export of the organization's own accounts, referrals and visit counts to its server or a supported CRM [setting it: owners], public data from CMS, NPPES, the U.S. Census Bureau and state licensing files with each release shown, and patient privacy by design: the research uses no patient-level data, and imports, briefs and exports carry no patient names.

**Who uses it, and for what:**

- Owners and administrators: where to focus a small marketing team and its budget, how the market and the competition are moving, and what the team's work led to in recorded referrals and admissions.
- Directors of business development and marketing managers: territory plans, goals, account ownership across locations, a review of each marketer's week, coaching, expense approval and the reports they bring to leadership.
- Marketers and community liaisons: a planned day and route, a focused visit list with a reason for each stop, notes, follow-ups and expenses logged from a phone, and the history of every account they own.

**How to present it.** Owner direction: show the bigger picture. Intel runs the whole marketing program, and sending emails to referral sources is not the point of it. Email campaigns are one feature, on the Growth and Pro plans. Never describe Intel as an email tool, never lead with emailing referral sources, and never make email the whole subject of a message, post, ad, article or answer: when email comes up, show it as one part of the workspace, beside the research, relationships, visits, spend and recorded results it serves. Intel is a marketing workspace, not a compliance product: its expense tools keep marketing spend in view of policy and the Stark limit, and they are a small part of the program. Never describe Intel as a compliance tool, and never lead with compliance, the Stark limit or expense tracking: when spend comes up, show it as part of the field work and relationships it serves (owner direction 2026-11-14). Across your work, cover the whole range above rather than one feature again and again, and pick the part that answers the reader. What a feature needs (a plan in brackets) still applies.

### Intel: top 10 industries and their most useful features

Added at the owner's request on 2026-11-14. This use-case mapping was checked against
`kdeyarmin/intel@393b9b3cd5b19de0ede7f09846313ac11a929f60`: `src/content/featureCatalog.json`,
`src/lib/businessLine.ts`, `src/lib/planCatalog.ts` and `src/content/marketingCopy.json`.
Service-line access was rechecked on 2026-11-16 against `kdeyarmin/intel@8abe4c6` (`src/lib/planCatalog.ts`,
`src/lib/healthcareServiceLines.ts`): standard plans offer CRM workflows for every healthcare service line, within each
plan's count of lines. It does not refresh the saved feature inventory or verify a live deployment. The machine copy is
`industryUseCases` and `industryGuidance` in `server/agents/content/facts.mjs`.

**Industry fit and access conditions:**

- These industries are ordered by fit with the current product. The feature priorities describe likely uses, not measured customer usage or proven demand.
- Home health and hospice have the strongest combination of daily CRM use and market intelligence. Standard plans offer CRM workflows for every healthcare service line, within each plan's allowance of service lines the organization chooses; Enterprise covers every line.
- Every care setting can use market and territory research within the subscribed territory. Public datasets and specialized analyses cover particular settings and geographies, so research depth varies by industry: specialized Medicare share rankings and competitor alerts cover home health agencies, hospices and nursing homes.
- Research coverage varies by dataset, geography and reporting period. State-licensed residential coverage depends on which state files are loaded. Feature access also depends on the plan, role and configured services.
- Public provider and market data supports research and planning; it does not establish confirmed referral relationships. Referral and admission results come from what the organization records or imports.
- For each audience, lead with its relevant features and main purpose below, within these conditions. This guidance does not change prospecting eligibility, campaign audiences or outreach permissions.
- Secondary markets, by owner decision: physician practices, behavioral health, rehabilitation and therapy (inpatient rehabilitation included), diagnostics, dialysis and DME suppliers. Use their rows only to answer a reader from one of those settings, and never aim outreach, content or ads at them until home health agencies, hospice agencies, hospitals, nursing homes and personal care homes have been thoroughly marketed to.

| Industry | Most useful features, in priority order | Main purpose |
| --- | --- | --- |
| **1. Home health agencies** | Referral-source rankings for physicians certifying home health; marketing book and call plans; referral and admission reports and drop-off alerts; competitor rankings. | Focus marketers on promising sources and maintain productive referral relationships. |
| **2. Hospice agencies** | Physician and facility research; relationship history and follow-up tasks; referral and admission tracking; county demand and hospice competitor analysis. | Develop consistent professional relationships and research underserved territories. |
| **3. Skilled nursing facilities and nursing homes** | Hospital-source research; nursing home rankings by Medicare share and competitor alerts; facility profiles covering ratings, staffing, inspections and ownership; county utilization and supply analysis; account and outreach tracking on the nursing home service line. | Prioritize hospital relationships and understand the facility's competitive position. |
| **4. Assisted Living Facilities and memory care communities** | Site finder; county and ZIP-area demographics, especially older residents and people living alone; licensed-home and bed-supply research; nearby provider and facility directories. | Evaluate local demand, competition, expansion locations and community partners. |
| **5. Personal care and residential care homes** | Local demographic research; licensed-home directories and bed counts; hospital and physician searches; territory maps. | Understand the local service area and identify professional relationships worth developing. |
| **6. Hospitals and health systems** | Hospital service-area analysis; post-discharge spending by care setting; physician and practice directories; post-acute facility profiles and quality information. | Plan physician outreach and research potential post-acute partners. |
| **7. Durable medical equipment suppliers** | DME supplier and referring-provider data; clinician searches and lead lists; territory maps; DME report exports. | Find potential ordering clinicians, assess competing suppliers and organize sales territories. |
| **8. Inpatient rehabilitation facilities** | Hospital and physician research; rehabilitation facility profiles and available utilization data; county market analysis; target lists. | Identify hospital relationships and evaluate regional rehabilitation markets. |
| **9. Long-term care hospitals** | Hospital-market research; LTCH facility profiles and available utilization data; provider directories; territory analysis and reports. | Research potential hospital partners and understand regional competition and activity. |
| **10. Physician practices and medical groups** | Provider and specialty searches; territory maps; demographic and community-needs analysis; facility and partner research. | Evaluate practice locations, surrounding specialties and potential professional partners. |

### Intel: what to lead with, why now, and what it is not

Added 2026-11-14 at the owner's request, from the competitor and market research in
[INTEL_MARKETING_PLAYBOOK.md](INTEL_MARKETING_PLAYBOOK.md) (`leadWith`, `whyNow` and `boundaries` in `facts.mjs`). The research found that
the large products in this market lead with the size of their data, customer results, AI for field reps, time saved and EHR
connections, and sell through demo requests with private quotes. Intel answers with what it can honestly show. These lines state no number
and name no company: a number would become one every draft may state, and every EHR vendor is on the competitor list in `validate.mjs`.
The playbook keeps the vendor detail and figures for people, not for prompts.

**What to lead with, one at a time** (rotate them across your work; email and expenses never lead):

- Finding referral sources: which physicians, hospitals and facilities in the territory matter, from public Medicare data, with the release behind every figure.
- Knowing the competition: who serves each county, how they rank on Medicare share and star ratings, and an alert when a competitor's rating, owner or service area changes.
- One workspace for the whole program: research, accounts, visits, follow-ups and recorded results in one shared record.
- Walking into every visit prepared: a pre-visit card before each visit, and on Growth and Pro a written visit debrief, where the AI proposes the visit note and next step for the marketer to check.
- Showing what the work led to: the referral funnel, response time and a quarterly outcomes packet for a hospital, with hospitals in CMS's TEAM model flagged.

**Why now** (market context; check any rule, model or date on cms.gov before you state it):

- CMS froze new home health and hospice Medicare enrollments nationwide in May, so most agencies grow by winning referral sources in the markets they already serve. Check cms.gov or the Federal Register for the freeze's current status before you mention it.
- Hospitals in CMS's TEAM model answer for what happens to patients after discharge, so they look for post-acute partners who answer referrals quickly and can show public quality scores.
- CMS now publishes a Service and Spending Variation Index for each hospice. It is an outlier index, not a quality rating, and is always described that way.
- Field marketers now expect software to help them prepare for visits and write up notes. Say in plain words what Intel's AI does for the marketer, and that a person checks every draft.
- Medicare fee-for-service figures leave out people in Medicare Advantage plans. Say which population a figure covers.

**What it is not, and how to say so:**

- Intel imports referral and admission reports from the EHR as files: an upload, an SFTP folder or email. It is not a live connection to any EHR, and no message names an EHR vendor.
- Intel works in a phone's web browser and can be added to the home screen, where it opens like an app. It is not an app in the app stores.
- Public Medicare data shows which physicians certify home health patients and which agencies serve a county. It does not show who referred which patient to whom.
- Intel has no approved customer results: point to the free county report and the free trial instead. The only figures about its data the team may state are the ones Intel's own site publishes ("By the numbers" in its catalog: its public healthcare datasets, every NPI in the national registry, its ZIP areas and counties, and daily checks for new releases), worded as the site words them (owner approval); state no other count about its data. Name the publishers behind its data (CMS, NPPES, the U.S. Census Bureau and state licensing files).
- Intel is evaluated with a free trial, its prices are on its website, and questions get written answers. Describe what Intel does; never describe or compare what other products do.

The sales playbook gained matching written answers for EHR connection and security questions (`integration` and `security` in
`server/growth/playbook.mjs`), and three outreach angles that follow the lead order: visit preparation, the hospital outcomes packet and
slipping referral sources (`experimentAngles`).

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
- Setup fees, Intel extra seats/locations/states, taxes, legacy plans and custom contracts are excluded. Intel onboarding
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

### Advisors: service scope and reasons to choose it

| Service area | Business need it addresses |
| --- | --- |
| Strategy and operations | Advice on business direction and how the organization operates. |
| Clinical quality and compliance | Advice on quality and compliance work within the agreed engagement. |
| Financial performance and reimbursement | Help examining financial performance and reimbursement questions. |
| Acquisition advisory and due diligence | Advice for evaluating a healthcare acquisition and its due diligence. |
| Education and leadership | Support for leadership and education needs. |
| Technology and workflow | Advice on technology choices and the workflows they support. |
| Personal care home and ALF operations | Consulting focused on the operating needs of these settings. |

**Top reasons a company would choose it:**

- Get advice scoped to a specific healthcare business problem. An engagement can focus on the strategy, operations, quality, financial or workflow question the organization needs to address.
- Bring an advisory perspective to a significant decision. Acquisition advisory and due diligence support owners, operators and investors evaluating an opportunity.
- Support leaders as they change how the organization works. Education, leadership and technology consulting can be scoped alongside operational needs. Deliverables depend on the agreed engagement.

**How to start:** submit the consultation request form with the business problem and organization context, without patient information.
Scope, deliverables and price are agreed for the engagement. Advisors is consulting, not a software plan, free software trial or
guarantee of regulatory, financial or acquisition results.

## Choosing a plan

Choose by the work the company needs to complete, then check the price and capacity for that scope.
This is a guide to the existing packages, not a recommendation to buy features the company will not use.

| Need | Package to evaluate | Important distinction |
| --- | --- | --- |
| Resident records and daily facility operations, with selected additional workflows. | CareBase Core plus the needed add-ons. | General Core does not include eMAR. Staff Training, Workforce, Survey & Compliance and Resident Billing & Payments are also separately priced add-ons. |
| Core and every listed CareBase add-on. | CareBase Complete. | Compare the bundle with the modules actually needed, using the per-facility price. |
| Training, workforce and survey work without resident-operations Core. | Compliance Suite. | Includes Staff Training, Workforce and Survey & Compliance; does not include Core. |
| A facility with fewer than 20 licensed beds. | Small Home or Small Home Complete. | Small Home includes Core and eMAR. Eligibility uses licensed beds, not current occupancy; complete native eMAR enrollment and clinical approval before use. |
| Staff education as a separate purchase. | CareMetric Train or Train Single Facility. | Train is per organization with unlimited learners; Single Facility is for a one-facility organization. It is not the complete resident-operations product. |
| One office working one line of business in a county-based territory. | Intel Starter. | Select one healthcare service line, within the published seat, location and county limits. Campaigns and other labeled Growth/Pro features are not included. |
| Two healthcare service lines, such as home health and hospice, more locations, campaigns and manager tools. | Intel Growth. | Check included seats, locations, state coverage and the access labels on each needed feature. |
| Several territories, admissions forecasting and book balancing. | Intel Pro. | Forecasting and book balance are Pro features. Territory, team capacity and owner/manager permissions still apply. |
| A larger footprint requiring an individually agreed scope. | Intel Enterprise. | Annual custom agreement; confirm included services and requirements in the contract. Custom contracts are excluded from the Founders Sale. |

The Intel trial provides broader feature access within a smaller territory than some paid plans.
Evaluate the intended paid plan before relying on a trial feature for ongoing work.
The [CareBase pricing](#carebase-and-train-pricing), [Intel pricing](#caremetric-intel) and
[feature reference](#feature-and-function-reference) give the actual limits; purchasing extra capacity does not remove role restrictions.

## Getting started

The following is a suggested rollout sequence using documented workflows. It is not a promised implementation timetable or a migration-service commitment.
Name an internal administrator, choose a representative workflow and agree who will keep the records current.

| Offering | What the company should prepare | A useful first workflow |
| --- | --- | --- |
| CareBase | Organization and facility details, facility types, a staff roster, employee duties and the requirements to track. Identify the modules and records needed for the first workflow. | Start online, verify email and set a password. Preview the staff CSV, resolve flagged entries, configure requirements and assign work. Review the resulting status and documentation with the facility manager. |
| CareMetric Train | A roster, relevant roles and training requirements, and a course or live class to assign. Gather supporting records for any outside training to be reviewed. | Assign training, complete a course or finalize reviewed class attendance, and check the resulting hours and certificates. Confirm that required accredited or external training still comes from an eligible provider. |
| Intel | The intended county or territory, team roles, relevant accounts and contacts, and the company's marketing priorities. For referral reporting, prepare a supported export without patient-identifying information. | Create the organization account, select the trial county in Billing, and use the labeled sample book or reviewed account data. Build a focused list, assign an account, log activity and a dated next step, then review a report. |
| Advisors | The business question, desired deliverables, operating context and the people responsible for the work. Keep patient information out of the request. | Submit the consultation request form and agree the engagement scope and deliverables before work begins. |

**Staff and devices:** CareBase works in a supported browser; installing an app is not required. Eligible downloaded employee training can
work offline and synchronize later. Trainers can record class attendance without every employee using a phone.
Intel can be added to a phone's home screen for field work. That does not establish offline availability for Intel or for all CareBase functions.
Check the actual devices and connectivity the team uses during the trial.

**Moving existing information:** CareBase documents a reviewed CSV staff-roster import. Intel documents account/contact CSV import and
supported referral/admission report imports, including column mapping and preview. These capabilities do not establish a full migration
of every record from another system. Identify the fields, historical records and attachments the company needs, and verify what transfers
before retiring the old process. Use only the applicable product's documented imports and configured connections.

## Evaluating the business case

Use the trial to complete real, representative work within the included scope. Record the current process before comparing it with the trial.
The checks below are suggested evaluation criteria, not published customer results or additional product promises.

| Business question | What to check during evaluation | How the company can judge the result |
| --- | --- | --- |
| Can managers find and follow up on missing CareBase requirements? | Review assigned requirements, overdue work, responsible staff and the supporting records. | Compare time spent finding records and assigning follow-up with the current process. Note gaps that still need manual work. |
| Will training records reflect what staff actually completed? | Follow an assigned course or a reviewed live class through to recorded hours and certificates. Check outside-training approval separately. | Reconcile the records with attendance and completion, using the correct facility, role and credit rules. |
| Can staff and managers work within their intended access? | Use the relevant CareBase roles or Intel owner, location-manager and marketer views. Review shared documentation or reports within their scope. | Confirm that each person can complete their job with the records they are meant to see. |
| Does Intel's research cover the territory and accounts that matter? | Search representative providers and facilities, inspect source dates and missing fields, and save a focused list. | Judge the usefulness and coverage for the actual market; public signals are not confirmed referrals. |
| Will Intel help the team follow through on relationships? | Prepare an account, plan a visit, log activity and set a dated next step. Review open tasks and account ownership. | Compare preparation and follow-up work with the current process, including how responsibility transfers between people. |
| Can leadership reconcile recorded marketing results? | Enter or import supported referral facts, review the funnel and lost reasons, and export a scoped report. | Check figures against the input records for the same period. Separate entered outcomes from public market estimates. |
| Does expense administration fit the company's process? | Log an account-linked expense and receipt, review per-person values and flags, and follow the approval and reimbursement records. | Check the information required by the company's policy and payroll process. Mileage uses straight-line distance; reimbursement recording does not send payment. |
| Does the Advisors engagement answer the business question? | Agree the scope, expected deliverables and how leadership will review them. | Evaluate delivery against the agreed work, not a promised financial or regulatory outcome. |

For an internal cost comparison, value only time the team reasonably expects to avoid and subscriptions it can actually retire.
Use the company's own labor costs and observations. Include implementation effort, data preparation, staff training and tools that must remain.
An exported report or completed task demonstrates a workflow; it does not establish a guaranteed financial return, survey result or referral increase.

**Budget for the ongoing scope:** all published prices here are USD, before applicable taxes. Count billed facilities for CareBase,
the applicable organization or single-facility basis for Train, and the plan plus needed extra seats, locations and states for Intel.
Compare the actual annual payment with monthly billing; Intel's displayed annual monthly equivalent is not a monthly payment schedule.
Evaluate the first paid year and the regular renewal price separately. The Founders Sale excludes Intel expansion add-ons and other listed charges.
Intel onboarding is free on every plan; this does not establish free custom migration, integration work or onboarding terms for another product.

## Data ownership and exports

| Offering | Documented capability | What to establish before relying on it |
| --- | --- | --- |
| CareBase | The published FAQ says the organization owns its records and can export them during the wind-down period after cancellation. Reports and documentation exports support ongoing review. | Check current retention and export terms before closing an account. This sheet does not specify the wind-down duration or promise permanent access after cancellation. |
| Intel | Export the marketing book or selected rows as CSV; download supported results reports as PDF, Excel or CSV. Other exports are listed by feature and role. | Verify that the needed fields and history are in the applicable export. The reviewed sources do not establish an export window after cancellation or a complete export of every underlying dataset. |
| Advisors | Deliverables depend on the agreed consulting engagement. | Agree the deliverables, permitted use and handling of company materials in the engagement terms. |

Keep organization contacts, account ownership and permissions current when employees change roles or leave.
CareBase's shared records support an administrator transition; Intel can hand an account book to a teammate while retaining credit for previously logged work.
Export availability does not replace the company's own record-retention process.

**Data boundaries:** CareBase includes resident clinical and operational records within its configured access controls.
Intel uses public provider/facility research and the organization's marketing activity; keep patient names, diagnoses and other patient information out of its notes.
Do not send patient information through support or Advisors' consultation form. These product distinctions matter when deciding where a record belongs.
The [claim rules](#claims) still govern security, privacy and certification statements.

## Support and next steps

| Need | Documented starting point |
| --- | --- |
| Evaluate CareBase. | [Start the free trial](https://cmcarebase.com/signup), review [plans](https://cmcarebase.com/#pricing) or read the [FAQ](https://cmcarebase.com/faq). |
| Evaluate Intel. | Start from the [Intel website](https://www.caremetricintel.com/), review [plans](https://www.caremetricintel.com/#pricing), or explore the [county report](https://www.caremetricintel.com/county-report) and [resource library](https://www.caremetricintel.com/resources/). |
| Explore a consulting engagement. | Use the [Advisors consultation request form](https://caremetricadvisors.com/contact); there is no obligation to move forward. |
| Find product help. | Use the [CareMetric help center](https://help.caremetric.ai), Intel's in-app help and user guides, or the public support contacts listed under [The company](#the-company). |

Start in the product's own signup and billing flow. Intel's free trial does not become a paid subscription by itself.
Automatic application of the Founders Sale means the eligible discount is applied when paid service begins; it does not enroll a trial user automatically.
Do not extend Intel's no-credit-card or trial-expiry terms to CareBase without a product-specific source.

Before purchasing, review the applicable agreement for renewal and cancellation timing, refunds, data retention and deletion, and any required data-processing terms.
Support hours and response commitments are not established by the presence of a support address, telephone number or help center.
Confirm any required service level in the agreement; this sheet does not promise round-the-clock support, a response deadline or an uptime commitment.

Sources for this buying guidance: the reviewed product catalogs' FAQ, role, import and export entries; the plan and trial facts above;
and the currency and tax basis in [the pricing review](PRICING_RESEARCH_AND_FOUNDERS_SALE.md).
Use the current Intel catalog and this sheet's reviewed terms over older onboarding-fee examples in that historical pricing review.
The evaluation and rollout suggestions are planning guidance; they do not add contractual commitments or new approved marketing claims.

## Claims

**We may say** (confirmed 2026-11-08):

- What each product does and who it is for, using the sourced descriptions here and its own feature catalog, with the applicable limits.
- The prices, plans, trials and offers above, exactly as written, with the product they belong to.
- That CareBase keeps staff training, resident records, daily tasks and survey documentation in one place for Pennsylvania
  personal care homes and Assisted Living Facilities.
- That a product helps a team stay organized, see what needs attention and keep records ready for a surveyor.
- What a regulation says, from the regulation itself, with its section cited and the "not legal advice" line.

**We may not say** (enforced in code for the AI team by `server/agents/content/validate.mjs`; confirmed 2026-11-08):

- Any price or offer outside the approved pricing and offer terms; any invented customer count, time saved or other result.
  Product-specific functional counts and limits must come from that product's reviewed catalog, not another product's numbers.
  Functional thresholds in the reference are not savings claims. The AI team's existing percentage allowlist still applies;
  adding a functional threshold to this document does not authorize it in promotional copy.
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
- [x] 2026-11-14: Intel's lead order, market context and boundaries from the competitor research ("Intel: what to lead with, why now,
  and what it is not"), the `integration` and `security` written answers, and the three new outreach angles. Requested by the owner;
  the owner confirmed them on 2026-11-16.
- [x] 2026-11-14: Intel is a marketing workspace, not a compliance product; expense tracking (spend in view of policy and the Stark
  limit) is a small part of it and never leads.
- [x] 2026-11-12: the founder's story wording. The owner confirmed: the founder built Intel, and currently runs a home health and
  hospice agency and a consulting company.
- [x] 2026-11-16: the CareBase feature and function reference, rewritten from the redesigned cmcarebase.com/features (112 capabilities
  across 8 areas, each with the plan or add-on the page names) and its "What the team can do" descriptions; and CareBase's "Everything
  it does, by area" summary in the same eight areas, which the AI team reads (`capabilities` in `facts.mjs`), with families' portal
  payments added to who uses it. The owner confirmed them on 2026-11-16.
- [x] 2026-11-16: the Intel feature and function reference and Intel's "Everything it does, by area", refreshed from caremetricintel.com
  (128 features across 12 areas, including the public data library, 8 data families and the site's 10 care settings). The site’s other
  five care settings are listed as secondary markets; the pre-visit card and spoken debrief pillar never leads; the count of Intel's
  datasets and the AI apps and CRM it connects to are written generically. The owner confirmed them on 2026-11-16.
- [x] 2026-11-16: Intel's trial covers 3 marketer seats + 1 manager, 1 location, up to 2 healthcare service lines of the customer's choice
  and 1 county, as Intel's billing catalog states it (it said 1 branch, home health and hospice); and the plans' descriptions follow
  the catalog too: locations instead of branches, healthcare service lines of the customer's choice instead of home health and hospice,
  and Growth "For growing healthcare teams" instead of "The usual agency plan"; the Founders Sale's excluded add-ons say "Intel extra
  seats/locations/states" to match. Prices and the offer's scope are unchanged. The owner confirmed this wording on 2026-11-16
  (kdeyarmin/caremetric-support-hub#222).
- [x] 2026-11-16: data-scale figures. The team may state the figures about its data that Intel's own site publishes, worded as the site
  words them, and no other count about its data: 150+ public healthcare datasets, every NPI in the national provider registry, 33,000+
  ZIP areas and 3,200+ counties, and daily checks for new CMS releases (the home page's "by the numbers" band, which the features catalog
  carries). Intel still has no approved customer results. Approved by the owner on 2026-11-16. Also confirmed that day: the pre-visit card and spoken
  debrief pillar never leads a brief.
- [ ] 2026-11-16: CareBase's home-page figures (12–16 hrs of annual training tracked per direct care worker, by facility type;
  Ch. 2600 + 2800 linked to supporting records; 60+ survey-ready form templates; 1 record with access by role), read into the CareBase
  catalog the AI team writes from and listed under "CareBase by the numbers". Tick this box when you approve the pull request that adds them.

## Feature and function reference

This is the complete functional inventory from the saved catalogs named under Sources read: 112 CareBase capabilities and 128 Intel features.
It is a reference for explaining what users do, not a statement that every feature is included in every subscription or configured for every customer.
The plan tables, role limits, setup conditions and claim rules apply throughout. No production workflow was newly verified for this expansion.

Terminology follows the approved vocabulary. CareBase's capability names are the page's own: "audit" in them means a medication audit
packet or a log of recorded actions, never the state's survey. Binder and survey-packet exports are described for survey review rather
than as a readiness guarantee.
The Intel source also describes spoken visit entry, a pre-visit card read aloud and spoken questions to its AI Assistant; below, visit
logging, debriefs and directions use the approved written workflow only. As in the catalog, the AI apps and CRM Intel connects to are
not named; the figures about its data are the site's own ("Intel's data, by the numbers" below), approved by the owner on 2026-11-16.
This preserves the owner's text-only AI rule and does not authorize voice or phone claims. Static presenter videos remain course media.

### CareBase feature and function reference

These are the eight areas cmcarebase.com/features publishes (read 2026-11-16: 112 capabilities across 8 areas), in the page's order and
words. Each heading gives the area's count and, in the "Plan or add-on" line, the page's own label for what it needs. The plan tables
above set what a subscription includes; do not infer an entitlement from an area heading or promise every item to every plan.
For example, items under "AI assistance with human review" come with the Staff Training and Survey & Compliance tools, and confidential
incidents under "Survey readiness, safety & quality" require CareBase Core.

#### CareBase by the numbers

The home page's own figures, in the strip under its hero (read 2026-11-16). The AI team reads them worded as the site words them.

| Figure | What it counts |
| --- | --- |
| 12–16 hrs | annual training tracked per direct care worker, by facility type |
| Ch. 2600 + 2800 | PA regulations linked to supporting records |
| 60+ | survey-ready form templates included |
| 1 record | shared documentation, with access based on each person’s role |

#### Resident care & daily operations (17)

Plan or add-on: CareBase Core. Keep the whole resident journey together, from the first inquiry to the last follow-up.

| Capability | What the team can do |
| --- | --- |
| Inquiry tracking, admissions & move-in checklists | Track inquiries and preadmission requirements, and work through move-in checklists to prepare the resident record before move-in. |
| Census, rooms & room-readiness tracking | Track occupancy and rooms, and whether each room is ready. |
| Digital RASP / ASP assessments | Prepare resident assessments and support plans for the facility type; retain the required signed DHS form. |
| Reassessment deadlines & support-plan review triggers | Track reassessment deadlines and the support-plan reviews that time or a change triggers; deadlines differ by facility type and admission circumstances. |
| Resident agreements & guest e-signatures | Prepare resident agreements and have them signed through time-limited guest links. |
| Clinical charting: vitals, progress notes & care plans | Record resident vitals, progress notes, assessments and care plans. |
| Facility-wide vitals rounds | Record vitals across the facility during a round. |
| Resident services, daily care tasks & refusals | Assign services and daily care tasks, and record completion, refusal or needed follow-up. |
| Change-of-condition follow-up & provider notifications | After a fall, hospital return or other change, track provider notifications, reassessment, support-plan review and follow-up. |
| Dietary operations & food-safety rounds | Keep dietary checks and food-safety rounds with daily operations. |
| Meal & activity calendars | Plan meal and activity calendars. |
| Appointments, services calendar & transportation | Organize appointments, services and transportation on a calendar. |
| Resident documents & chronological history | Keep each resident's documents together, with the record's history in date order. |
| Designated-person & move-in portals | Give designated persons and move-in guests time-limited access to the records shared with them, without a full user account. |
| Discharge documentation & retained records | Complete discharge documentation and keep the resident's clinical and operational record after move-out. |
| Maintenance work orders & QR reporting | Track maintenance needs and work orders, with reporting through QR codes. |
| Emergency plans & resident accountability | Keep emergency plans and account for residents during an emergency; CareBase works alongside, not in place of, an emergency-call system. |

#### Staff training & learning (15)

Plan or add-on: Staff Training add-on or CareMetric Train. A maintained course library, clear assignments, and a complete record of learning.

| Capability | What the team can do |
| --- | --- |
| PA-mapped course catalog maintained by the CareMetric team | Assign courses from a catalog the CareMetric team maintains and maps to Pennsylvania requirements. Required accredited or external training still needs an eligible provider. |
| Graded quizzes, completion records & certificates | Record graded quiz results, completions and certificates. |
| Role-based training plans & automatic assignments | Confirm each employee's duties and applicable requirements, and assign training by role automatically. |
| Custom training requirements & renewal dates | Configure the organization's own training requirements and their renewal dates. |
| Interactive training-compliance matrix & CSV export | Review training status across staff and export the matrix as CSV. |
| Live class scheduling & digital sign-in | Schedule instructor-led classes and record attendance digitally, including at a shared kiosk with a name and PIN. |
| Trainer-managed rosters & finalized attendance | Select employees for a class and let the trainer mark attendance; employees do not need a phone or to scan a code. Finalized attendance and confirmed hours create the training records. |
| Printable meeting notices & signed attendance sheets | Print notices and attendance sheets, upload the signed sheet and confirm hours before completing the class. |
| Outside training records & manager review | Submit outside training for a manager to review; only approved records count toward annual totals. |
| Retraining assignments & follow-up | Assign retraining and track its follow-up. |
| Offline-capable employee training player | Complete eligible downloaded training offline and synchronize after reconnecting. |
| Public certificate verification & training passport | Share a public link that verifies a certificate, and keep each employee's training passport. |
| Training reports & employee learning history | Prepare training reports and review each employee's learning history. |
| SCORM / xAPI learning packages managed by the CareMetric team | Use learning packages in the SCORM and xAPI e-learning formats, which the CareMetric team manages. |
| Course versions, review history & source references | See each course's versions, its review history and the sources it is based on. |

#### Medication management & eMAR (13)

Plan or add-on: eMAR add-on · facility activation required. Carry the order, administration record, and follow-up through the medication
workflow. Native eMAR requires facility enrollment, clinical approval before use, and a documented switch to CareBase as the official
medication administration record; until then the facility keeps using its existing record, and imported medication events stay read-only.

| Capability | What the team can do |
| --- | --- |
| Facility medication rounds & pass setup | Set up the facility's medication rounds and passes. |
| Medication orders with independent review | Enter medication orders, each with an independent review. |
| Daily, one-time, interval, variable & PRN schedules | Schedule medications daily, once, at intervals, on a variable schedule or as needed (PRN). |
| Resident, medication & barcode checks | Check the resident, the medication and its barcode during administration. |
| Medication-training & insulin-qualification checks | Limit administration to staff whose medication training is current, and insulin to staff qualified for it. |
| Administrations, refusals, omissions & amendments | Record each administration, refusal or omission, and amend a record when needed. |
| PRN effectiveness follow-up & escalation | Follow up on whether an as-needed (PRN) medication worked, with escalation. |
| Prescriber holds & observation records | Record prescriber holds and observations. |
| Controlled-substance stock, witnesses & discrepancies | Count controlled-substance stock with a witness and record discrepancies. |
| Refill requests & leave medication packages | Request refills and prepare medication packages for a resident's leave. |
| Printable monthly MAR, audit & downtime packets | Print the monthly medication administration record (MAR) and the medication audit and downtime packets. |
| Supervised reconciliation of paper downtime records | Reconcile paper records kept during downtime, under supervision. |
| Medication oversight & quality reports | Review medication oversight and quality reports. |

#### Survey readiness, safety & quality (18)

Plan or add-on: Survey & Compliance tools; confidential incidents require Core. Turn daily documentation into a clearer picture of what
needs attention before a visit.

| Capability | What the team can do |
| --- | --- |
| Today workspace & compliance command center | Review daily priorities, due work and compliance status in one place. |
| Citation-weighted readiness score & gap review | Prioritize tracked gaps by regulatory topic using default planning weights; the score does not predict survey results. |
| Compliance binder PDF & survey-packet exports | Export recorded documentation as a PDF binder or a survey packet for review. |
| Survey Day Mode & entrance-conference checklist | Bring together the entrance-conference checklist, latest binder, on-shift roster and prepared documentation rooms; starting and closing a session is recorded in the audit log. |
| On-shift roster with training & clearance flags | See who is on shift, with training and clearance flags to help staff respond to questions. |
| Resident compliance dashboard & medical-evaluation deadlines | Review resident assessment, support-plan and medical-evaluation deadlines across a facility. |
| Mock-survey rehearsals & request tracking | Rehearse with a mock survey, and track the documents requested and what has been provided. |
| Chapters 2600 / 2800 regulatory crosswalk | Relate records to the requirements of Chapters 2600 and 2800. |
| Time-limited, read-only documentation rooms | Share only the records a surveyor requests through a time-limited, read-only room; surveyors never get a CareBase sign-in or edit access. |
| Incidents & required-reporting deadlines | Track incident reporting tasks and deadlines for the relevant authorities; staff must make and document the required reports. |
| Confidential incidents & public safety reporting | Restrict access to sensitive incidents while supporting required safety reporting work. |
| Complaints, resident rights & follow-up | Track complaints and resident-rights concerns through follow-up. |
| Violations & plans of correction | Track violations and corrective work through due dates, review and verification. |
| Fire drills & life-safety inspection records | Keep fire drill and life-safety inspection records together. |
| 60+ document templates & DHS forms | Prepare records from the published library of document templates and DHS forms. |
| QAPI projects & quality follow-up | Manage Quality Assurance and Performance Improvement (QAPI) projects and their follow-up. |
| Work queue with owners, due dates & escalation | Assign an owner and due date to unresolved work, with escalation. |
| Policy documents, acknowledgments & attestations | Publish policy documents, assign acknowledgments and retain their signature documentation. |

#### Workforce, credentials & scheduling (14)

Plan or add-on: Workforce add-on. See who is qualified, who is available, and which requirements need a follow-up.

| Capability | What the team can do |
| --- | --- |
| Employee records, invitations & lifecycle tracking | Keep employee records, invite staff by email with the appropriate access, and track each employee's status over time. |
| Act 34 / 73 / 33 clearance tracking | Track Act 34, 73 and 33 clearances and their renewals; federal exclusion-list checks (OIG LEIE and SAM.gov) must be completed outside CareBase. |
| OAPSA provisional-employment countdown | Track Older Adults Protective Services Act (OAPSA) provisional-employment deadlines and documented suitability decisions. |
| Professional licenses, TB & I-9 records | Track professional licenses, TB records and I-9 records. |
| Administrator qualifications & continuing education | Keep administrator qualification and continuing-education records together. |
| Competency checklists & observed assessments | Document competencies with checklists and observed assessments. |
| Medication authorization & pass-meds roster | See who may pass medications, with medication-administration qualifications, annual practicums and insulin authorization together and missing or expired records highlighted. |
| Medication practicums & annual observations | Record medication practicums and annual observations. |
| Shift handoffs with assigned follow-up | Record shift handoffs and assign the follow-up they need. |
| Shift scheduling, templates & auto-fill | Set up units, shift types and staffing patterns, generate a draft schedule and review it before publishing. |
| Coverage gaps & staff availability | See coverage gaps and who is available. |
| Cross-facility float staff | Schedule staff across facilities with checks for overlapping assignments. |
| Time-off requests & approval workflows | Submit time-off requests and approve them through an approval workflow. |
| Staff schedule & shift views on mobile | Staff see their published shifts in My Schedule, on a phone or in a browser. |

#### Resident billing & payments (12)

Plan or add-on: Resident Billing & Payments add-on. Bring rates, statements, balances, and family payments into the resident record.
This is a resident subledger: CareBase works alongside the organization's accounting ledger and claims system, not in place of them.

| Capability | What the team can do |
| --- | --- |
| Resident financial subledger & account history | Keep each resident's charges, payments and account history. |
| Rate agreements & effective-dated charges | Record rate agreements and charges that take effect on set dates. |
| Care-level rate schedules & reviews | Set rates by care level and review them. |
| Facility billing runs & batch statements | Run billing for a facility and produce statements in a batch. |
| Receivables, balances & payment allocation | Track receivables and balances, and allocate payments. |
| Family portal payments & payment history | Let families pay through the portal and see their payment history. |
| Facility payment-account onboarding | Set up the facility's account for receiving payments. |
| Autopay policy & authorization records | Set the facility's autopay policy and keep autopay authorization records. |
| Personal-funds transactions & resident statements | Record residents' personal-funds transactions and produce resident statements. |
| Independent approvals for protected fund actions | Require an independent approval for protected fund actions. |
| Move-out financial closeout | Close out a resident's finances at move-out. |
| Financial exports for your accounting workflow | Export financial records for the organization's own accounting workflow. |

#### AI assistance with human review (7)

Plan or add-on: Staff Training and Survey & Compliance tools. Use source documents and facility context to make preparation more useful.
The CareMetric team prepares AI-assisted courses; customers use the reviewed catalog. Copilot actions require human approval, and AI
drafts require review. The copilot is text only.

| Capability | What the team can do |
| --- | --- |
| Team-prepared AI-assisted courses from policies & source documents | The CareMetric team drafts courses with AI assistance from regulations, policies or reference documents. |
| Lesson text, video scripts & graded quiz drafts | Drafts can include lesson text, video scripts and graded quizzes; a reviewer checks the content and source references. |
| Optional AI presenter video lessons | Optional presenter videos accompany lessons; this is course media, not a conversational voice copilot. |
| Named-reviewer approval before course publication | A named reviewer must approve a course before publication; regenerating a section requires a new review. |
| Compliance copilot grounded in facility records & regulatory references | Ask text questions about facility records and regulatory requirements, with references to review; an answer does not itself resolve a compliance gap. |
| Draft plans of correction & mock-survey preparation | Prepare written plan-of-correction and mock-survey drafts for a person to review. |
| Proposed follow-up actions for human approval | Review follow-up work the copilot proposes; a person must approve an action before it is carried out. |

#### Access, integrations & onboarding (16)

Plan or add-on: Platform tools · access depends on your plan and role. Start with your existing records and give each person an
appropriate view.

| Capability | What the team can do |
| --- | --- |
| Online organization signup & guided setup | Begin online, verify email, set a password and configure the organization during the trial, with guided setup. |
| Bulk CSV staff import with review before completion | Upload a CSV staff roster, review the import preview and resolve flagged entries before applying it; employees can also be added one at a time. |
| Data import center & import history | Run imports from one place and review past imports. |
| FHIR imports for medications, allergies & diagnoses | Import medications, allergies and diagnoses through configured FHIR connections to compatible clinical systems. |
| Read-only imported medication events | Review imported medication events without editing them. |
| Role-based access with facility scope | Limit records and actions to each role and assigned facilities: organization administrators see every facility, facility managers their assigned sites. |
| SMS account verification & security policies | Verify accounts by text message and set the organization's security policies. |
| Private documents & time-limited download links | Keep documents private and share them through download links that expire. |
| Audit trail of recorded actions | Review a log of recorded actions. |
| Email, SMS & in-app alerts with escalation | Send configured reminders about upcoming and overdue requirements by email, in the app and, when enabled, by text message; review unresolved alerts, weekly digests and delivery status. |
| Guest access for move-in, agreements & documentation | Use time-limited links for move-in records, agreement signing and documentation review, without a full user account. |
| Installable employee app & mobile-friendly workflows | Use a supported browser with nothing to install, or add the employee training player to a phone's home screen. |
| Organization-wide reports & multi-facility views | Review reports and facilities across the organization; reports follow the same access rules. |
| In-app help, support & product updates | Get help, reach support and read product updates inside CareBase. |
| Enterprise SAML SSO & verified domains (managed rollout) | Sign in through SAML single sign-on with verified email domains; available only through a managed rollout. |
| Enterprise provisioning & access reviews (managed rollout) | Provision enterprise users and review their access; available only through a managed rollout. |

#### Resident workflow from inquiry to move-out

| Stage | How the record is used |
| --- | --- |
| Inquiry & admission | Track inquiries, preadmission requirements, room readiness, and resident agreements. Prepare the resident record before move-in. |
| Initial assessment & support plan | Track initial assessment and support-plan deadlines for the facility type and admission circumstances. Keep orientation documentation with the resident record. |
| Every day | Assign services and record completion, refusal, or follow-up. Keep dietary checks, appointments, transportation, notes, and imported medication events together. |
| When something changes | Record a fall, hospital return, or other change, then track provider notifications, reassessment, support-plan review, and follow-up. |
| Every year | Annual reassessment is scheduled automatically — and completing it triggers the support-plan update Chapter 2600 and 2800 require. |
| Move-out | Discharge documentation, financial closeout, and a retained clinical and operational record that still answers a surveyor's question months later. |

Outside training contributes to annual totals only after approval. Pending or rejected submissions do not receive credit.
For live classes, reviewed attendance and confirmed hours create the training records. Requirements depend on facility type, role and duties.
Chapters 2600 and 2800 have different training and resident-assessment rules; ALF dementia training is tracked separately from the annual minimum.
Use the linked training-requirement guide and official sources for exact deadlines and required hours.

### Intel feature and function reference

“All plans; subject to scope” means the saved source has no additional plan or role label. Territory, purchased capacity, data coverage and organization access rules still apply.
An owner or location-manager label is required authority, not a feature available to every user. Configured-service conditions also apply where described.
The source describes Pro feature access during the trial within its one-county footprint; the reviewed trial seats, location, service lines and duration above remain the limits.

#### Healthcare marketing CRM

The marketing book: the accounts you keep month to month, the people you know there, and everything your team has logged on them.

| Feature | Function | Plan or role condition |
| --- | --- | --- |
| Marketing book of accounts | Keep hospitals, nursing homes, personal care and assisted living homes, physician practices, agencies and other referral sources in one book. Each account holds its type, city, phone, website, NPI, CCN, tags and owner. | All plans; subject to scope |
| Lines of business | Organize relationships by healthcare service line, including practices, hospitals, behavioral health, rehabilitation, diagnostics, senior care, home health, hospice, DME, and other healthcare services. One account can have a separate stage and history on each line. | Starter: one line |
| Relationship stages | Move accounts through Target, Relationship, Active source, Preferred, At risk and Lost. The date of the last change is kept, and At risk or Lost asks why: competitor, service issue, staff turnover, moved or other. | All plans; subject to scope |
| Contacts by healthcare role | Record the administrator, director of nursing, business office, social services, admissions, discharge planner, case manager, physician liaison, physician, intake, MDS coordinator and executive director. Mark someone as left to keep their history and stop email to them. | All plans; subject to scope |
| Account page and full history | Notes, the next visit or call, referrals, expenses and campaigns on one page. Search the account’s whole activity history by note, employee or date. Print a one-page account sheet without notes. | All plans; subject to scope |
| Market position on every account | An account with a CCN or NPI shows its lead score, county and state share and rank, Medicare beneficiaries, star ratings, staffing, cost-report figures and discharge mix beside your own relationship history. | All plans; subject to scope |
| Month end view | Sales calls, referrals, admissions, calls per referral and a six-month trend. See which accounts are referring more or less, which you called with no referral, and which belong on next month’s schedule. | All plans; subject to scope |
| Search, filters and saved views | Search by name, city, tag, NPI or CCN. Filter by type, stage and data-quality flags, save a view as your default, share it by link, and change the stage of many accounts at once. | All plans; subject to scope |
| Spreadsheet import and export | Import up to 2,000 accounts and contacts from a CSV with column mapping and a preview, from a template if you want one. Matches fill blanks instead of creating copies. Export the book or the rows you tick. | All plans; subject to scope |
| Book hygiene | Possible duplicates are listed for a one-step merge. Chips flag accounts with no phone, no contact, no email, an invalid email or no call in 90 days, and engagement reads Healthy, Warm, Cold or No activity. | All plans; subject to scope |
| Going quiet | Accounts whose referrals dropped, or that have gone 45 days without a visit, are listed with the reason and marked on the book and in the Monday digest. | All plans; subject to scope |
| Compare accounts side by side | Compare two to four accounts on stage, contacts, visits, referrals and admissions, star ratings, Medicare share and recent activity. Save the comparison, print it or download a PDF. | All plans; subject to scope |
| Claim, release and hand off | Claim accounts for your own book. When someone leaves or changes territory, move their whole book to a teammate in one step. Visits and referrals already logged stay credited to the person who logged them. | Hand-off: owners & location managers |
| Parent organizations | Group locations that belong to the same organization, from a shared parent name, practice name or people, or name the parent yourself. | All plans; subject to scope |
| Physician group certifications | Open a physician group in the market list to see which members certify home health or oversee hospice care, the patients Medicare published for each, who is on your book, what your book admitted from them in 12 months and an estimated share. Members CMS doesn’t list show as not listed, never zero, and high-volume members not on your book go to a lead list in one step. | All plans; subject to scope |
| Account tiers and visit cadence | Mark accounts tier A, B or C, or let Intel suggest tiers from each account's referrals. The organization sets how often each tier should be visited; Today and Team review show who is behind, the suggested route moves them up, and Monday's email lists them. | All plans; subject to scope |
| Call or text from an account | Call and Text open the phone's dialer or messages app from the account or a person there, then log the call (or a note for a text) in one tap. Nothing is placed or sent from Intel. | All plans; subject to scope |

#### Daily field work

The day on the road: what to do today, where to go, and a fast way to record each visit from a phone.

| Feature | Function | Plan or role condition |
| --- | --- | --- |
| Today | Your workspace when you sign in: tasks with due dates and priorities (overdue ones stay marked), progress on this month’s goals, and up to ten accounts to visit this week, each with one reason. | All plans; subject to scope |
| Tasks and assignments | Create tasks for yourself, linked to an account or not. A manager can assign a task to a named teammate. | All plans; subject to scope |
| Schedule and call plan | Plan visits and calls by day on a weekly agenda. Reschedule or remove a pending activity, or complete it with an outcome so the plan note is kept and the visit is not logged twice. | All plans; subject to scope |
| Suggested route | Builds a day from follow-ups that are due, sources whose referrals fell, and key accounts with no visit in 45 days, then orders the stops as a route on a map. Order this week’s scheduled visits by drive time too. | All plans; subject to scope |
| Visit log built for a phone | Check in with the phone’s location, type or dictate the note, and start from an in-service, lunch or discharge-planner drop-in template. A next step with a date schedules the follow-up. A draft survives a refresh and a save can be retried without duplicates. | All plans; subject to scope |
| Pre-visit card | Before you walk in: the last visit and notes, referrals for 90 days against the 90 before, the oldest open referral, open tasks, the people on the account and what you left last time, with up to four talking points chosen from those figures. On a plan with AI briefs, an AI summary of your last notes. | All plans; subject to scope |
| Spoken visit debrief | Say or type what happened after a visit and the AI proposes the visit note, the next step and its date. Nothing is saved until you check the form and save the visit. Possible patient details are taken out before the AI reads anything. Each debrief, notes summary or paid voice note uses one of your organization’s daily AI requests (500 a day on Growth, 2,000 on Pro), and the Visit log shows how many are left. | Growth & Pro |
| Visit debrief (written workflow) | Type what happened after a visit and review the proposed note, next step and date before saving. Possible patient details are removed before AI processing. Debriefs and notes summaries use the organization’s daily AI allowance; the Visit log shows what remains. | Growth & Pro |
| Business card scan | Photograph a business card on an account and the phone reads the name, role, phone and email for you to check before the contact is saved. On Growth and Pro a paid reader takes over when the phone finds no name, using one AI request. | All plans; subject to scope |
| County call sheets | A working list for a county: hospitals, home health agencies, hospices, nursing homes, clinicians, DME suppliers, personal care and assisted living homes and dialysis facilities. Mark each Call, Visit or Account and it lands on the marketing book. Print the schedule or the chart of accounts. | All plans; subject to scope |
| Follow-up emails | Send one email to a contact and book a dated visit in one step. Members schedule the visit and an owner sends the email; every email carries an unsubscribe link and your postal address. | All plans; subject to scope |
| Calendar sync | Download your scheduled visits and calls, subscribe with a private calendar link, or sync them to Outlook or Google Calendar. Notes are never copied to the calendar. | Outlook and Google sync: where configured |
| Weekly book digest | A Monday email for each marketer: last week’s visits, the coming week’s follow-ups, referral changes on their accounts, accounts going quiet, overdue tasks, new or moved physicians and sources falling off pace. | All plans; subject to scope |
| On your phone’s home screen | Add CareMetric Intel to a phone’s home screen and it opens like an app. | All plans; subject to scope |
| Hands-free on the road | Have the phone read the pre-visit card aloud (never your notes), ask the AI Assistant by voice where it is open, and open directions to the account in Google Maps, Apple Maps or Waze. | All plans; subject to scope |
| Directions to the account | Open directions to the account in Google Maps, Apple Maps or Waze. | All plans; subject to scope |

#### Expenses, mileage and reimbursement

Expense reports built for healthcare marketing: spend is logged against the referral source it was for, valued per person, checked against the Stark limit and your policy, approved, and paid.

| Feature | Function | Plan or role condition |
| --- | --- | --- |
| Expenses logged by account | Record the account, date, amount, business purpose and payment method (corporate card, personal card, out-of-pocket cash, company check). Categories cover meals, gifts, entertainment, education and in-services, promotional items, mileage, per diem and events. Cash and gift cards are deliberately not offered. | All plans; subject to scope |
| Receipt capture | Take a photo or upload an image or PDF and it attaches when you save. Where receipt reading is configured, the amount, date, vendor and a suggested category and account are read from it for you to check. | All plans; subject to scope |
| Per-person value for shared meals | List everyone who partook and the expense is split among them, the valuation rule CMS sets for shared benefits (42 CFR 403.904(g)(1)). Each person’s value builds up across the year. | All plans; subject to scope |
| Stark annual limit tracking | Each physician’s running total is measured against the Stark nonmonetary-compensation limit for the year (42 CFR 411.357(k)), with a warning as it gets close. The limit itself blocks approval unless a manager overrides it with a logged comment. | All plans; subject to scope |
| Non-physician policy totals | Spend on discharge planners, case managers and other referral sources builds up against an internal policy alert you set. It is an alert, not a legal safe harbor: the Anti-Kickback Statute names no dollar threshold. | All plans; subject to scope |
| Policy checks and flags | Per-meal caps by meal (breakfast, in-service lunch, out-of-office lunch, dinner), a per-diem cap, meals per person per month and per 12 months, large single benefits, entertainment, missing receipts, documentation gaps and possible duplicates are all flagged. | All plans; subject to scope |
| Approval workflow | Save a draft, then submit. Clean, fully documented expenses under your approval threshold approve themselves; flagged ones wait in a manager’s queue to be approved or denied with a note. A denied expense can be corrected and resubmitted. | Approving: owners & location managers |
| Reimbursement tracking | Approved and paid are separate facts. A manager records the paid date, method (payroll, direct deposit, check) and batch, one expense or a whole batch at a time. Marketers cannot mark their own expenses reimbursed. | Owners & location managers |
| Budgets and compliance settings | Set a monthly budget per marketer, the approval and receipt-required thresholds, meal and per-diem caps, frequency limits, the warning percentage, the mileage rate and the non-physician policy total. | Owners & location managers |
| Who you’ve spent on | Every marketer sees each person they have spent on this year, their running value against the limit, and their meal counts. The same totals appear on each account’s page. | All plans; subject to scope |
| Expense reports and exports | An itemized register, totals by marketer and by account, a compliance report and a payroll / AP export, for any date range, marketer, category or status. Download CSV or PDF. | Owners & location managers |
| Scheduled expense reports | Email any expense report daily, weekly or monthly to the managers you choose. Send a test, pause or edit a schedule at any time. | Owners & location managers |
| Mileage log | Adds the straight-line miles between each day’s visit check-ins and prices them at your organization’s mileage rate. Turn a day into a mileage expense draft in one step, then submit it like any other expense. Download the log as CSV. | All plans; subject to scope |

#### Referral and admission tracking

Your organization’s own results: the referrals each source sends, what became of them, and which relationships are slipping.

| Feature | Function | Plan or role condition |
| --- | --- | --- |
| Log referrals and outcomes | Record a referral on the account it came from, with the service, payer and a note. Mark it admitted or not admitted, with the reason, when you know. | All plans; subject to scope |
| Response time | Each referral keeps the time it came in, when it was first answered and when it was decided. Results reports median hours to first answer and to decision, the share answered within an hour, after-hours arrivals and the slowest sources. | All plans; subject to scope |
| EMR report imports | Import referrals and admissions from CSV reports with column mapping and a preview. Saved layouts cover common home health and hospice EMR reports. Upload a file, pick one up from an SFTP drop folder, or forward it to an email-in address. Patient-identifying columns are dropped and never stored. | Owners |
| Scheduled EMR report delivery | Some EMR reports can be delivered on a schedule your organization controls, with a delivery health page that shows the interval, observed dates and source totals. A file with rejected rows is held instead of imported. | Owners |
| Referral funnel | Referrals received, admitted and not admitted, and why, by account and by marketer. | All plans; subject to scope |
| Referral drop-off alerts | Flags a top source when its last 30 days fall at least 30% below its average month from the 90 days before. An owner can set the drop anywhere from 10% to 90%. | All plans; subject to scope |
| Outcomes packet | A one-page quarterly PDF for a hospital or facility: the referrals they sent, how many were admitted and how fast they were answered, your organization’s public star rating, readmissions and quality scores, and the availability you confirmed. Hospitals in CMS’s TEAM model are flagged, with a list of TEAM hospitals to target. No patient names, notes or clinical detail. | All plans; subject to scope |
| Lost reasons | Totals the reasons behind every lost and at-risk account, shows how many have no reason recorded, and lists the accounts. | All plans; subject to scope |
| Admissions forecast | Estimates how many open referrals will be admitted, from your last 180 days, as a range that stays wide when the history is short. | Pro |
| Availability | A dated confirmation of what your organization can take: accepting, limited or closed to new referrals, confirmed openings, earliest start, counties, disciplines, payers, languages and weekend coverage. Expired confirmations read as unconfirmed. | Confirming: owners & location managers |
| Why a source is slipping | For a source on the drop-off list, see what the book shows over the same months: a contact who left, referrals not admitted, availability you gave, fewer visits, a service ticket, slower responses, a physician who moved and a watched competitor nearby. Add the next step as a task in one tap. | All plans; subject to scope |
| Shareable profile link | A revocable page for referral sources, by location: intake phone and fax, services, current confirmed availability, public CMS ratings and the median first response to referrals, with a QR code and a view count. No patient information. | All plans; subject to scope |

#### Prospecting and targeting

Find the physicians, practices and facilities worth a relationship, with a reason behind each name on the list.

| Feature | Function | Plan or role condition |
| --- | --- | --- |
| Provider and facility directory | Search providers, organizations, practice locations and facilities by name, NPI, specialty and place. Profiles show locations, taxonomies, affiliations and available Medicare activity. | All plans; subject to scope |
| Target Builder | Filter providers by state, city, ZIP, specialty, score range, Medicare patient volume, Medicare participation and behavioral-health or geriatric focus, then save the matches as a list. | All plans; subject to scope |
| Saved lead lists | Work a list with a status for each provider (New, Contacted, Qualified, Not a fit), add to it from any provider page or search, and export it. | All plans; subject to scope |
| Referral-source rankings | Rank a county’s clinicians by a referral index built on public Medicare data, including the patients they certified for home health, and add the top names to a list in one step. | All plans; subject to scope |
| New physicians | Physicians newly listed in your area in the last 45 days, and people already on your book whose practice address or facility changed. | All plans; subject to scope |
| New referral sources | For a home health agency, a hospice, a nursing home, a personal care home or a hospital: the hospitals, nursing homes, agencies, personal care and assisted living homes and clinicians that refer to an organization like yours, ranked by public volume, with which are already accounts and what each referred. Add a source to accounts in one click. Home health and hospice also get under-worked hospitals and physicians, hospice planning estimates, and counties with high need and little local supply. | All plans; subject to scope |
| Physician share | Your admissions from each physician divided by the home health certifications or hospice care-plan oversight Medicare published for them, banded as mostly yours, split, rarely yours or none yet. A labeled estimate from public counts. | All plans; subject to scope |
| Opportunity scores | Providers in the scored states carry a lead score from CareMetric’s scoring rules, and the provider’s page shows what went into it. A provider without one reads Unscored; a score is never invented. | All plans; subject to scope |

#### Market and territory research

The people, providers and Medicare activity in the places you serve, within your plan’s territory.

| Feature | Function | Plan or role condition |
| --- | --- | --- |
| Territory map | Providers on a map of a state in your territory, highest lead scores first. Filter by specialty group, entity type, score range and patient volume, color by score, or switch on a heat map. A county-density tab ranks counties by practice locations. | All plans; subject to scope |
| County intelligence | A county’s older-adult population, income and adults living alone; the hospitals its residents use and where their post-discharge spending goes; current Medicare facility listings with published-county or labeled ZIP-based membership; historical post-acute providers assigned by their reported ZIP; and top referral sources. | All plans; subject to scope |
| Demographics by county and ZIP area | Residents 65+, 75+ and 85+, median age, household income and home value, poverty, uninsured, disability, Medicare-Medicaid dual coverage and 65+ households living alone, for a county and each of its ZIP areas, with the change in residents since 2020. | All plans; subject to scope |
| Community and payer context | On each county: Medicare Advantage plans, penetration, star ratings and supplemental benefits, Medicaid managed care where CMS publishes it, chronic disease prevalence, social vulnerability, shortage areas, healthcare wages, Part D prescribing and the most common Medicare services. | All plans; subject to scope |
| Site finder | Rank a state’s counties, or the ZIP areas of a state or county, for a new office or facility. Pick a service line and compare demand, growth since 2020, need and the supply gap; the opportunity index averages each area’s percentile among the areas compared. Download it as CSV. | All plans; subject to scope |
| Market data and market share | Each county’s Medicare enrollment and Medicare Advantage share, home health, hospice and skilled nursing use and supply, spending and readmissions, and agency shares using the displayed service-area or provider-ZIP method. Historical post-acute county assignments use the provider ZIP from the utilization year and the Census county containing most of that ZIP area; they can differ from current directory office counties. | All plans; subject to scope |
| Facility directory | Hospitals, home health agencies, hospices, nursing homes, inpatient rehab, long-term care hospitals, DME suppliers, community health centers, dialysis facilities, and state-licensed personal care and assisted living homes where loaded. Export DME suppliers to CSV or Excel from the DME report. | All plans; subject to scope |
| Facility profiles | Ownership, cost-report revenue and expenses, beds and visits, star ratings and quality measures, service areas and rank in the county and state. Print a branded profile. | All plans; subject to scope |
| Public quality scores | A hospice's Hospice Care Index and its Service and Spending Variation Index from CMS's FY2027 hospice rule, a home health agency's value-based purchasing score and payment adjustment, and whether a hospital is in CMS's TEAM model, on each facility page. | All plans; subject to scope |
| Utilization and CMS data | Medicare payments and service volume by specialty, and any clinician’s Medicare service lines by NPI. | All plans; subject to scope |
| Market briefs | Ready-made briefs for expansion (where to grow), acquisition (the largest operators in a state), hospital relationships and referral development. | All plans; subject to scope |
| Data freshness | Every market view shows which release it uses and when it was loaded, so you can judge the figures before using them. | All plans; subject to scope |

#### Public data library

More than 150 public healthcare datasets from CMS, NPPES, the U.S. Census Bureau, HRSA, CDC, AHRQ, BLS, the HHS Office of Inspector General and state licensing agencies, linked by NPI, CCN, county and ZIP.

| Feature | Function | Plan or role condition |
| --- | --- | --- |
| Providers and clinicians | Every individual and organization in the national NPI registry, with practice locations, NUCC specialties and affiliations, kept current from CMS’s weekly files. Add Medicare services and payments by clinician, home health certifications, hospice care-plan oversight, Order & Referring enrollment, Part D prescribing and MIPS scores. | All plans; subject to scope |
| Facilities, quality and ownership | Provider of Services and Care Compare files for hospitals, home health agencies, hospices, nursing homes, inpatient rehab and long-term care hospitals: star ratings, patient surveys, readmissions, inspections, penalties, nurse staffing, ownership and chains, plus cost reports for hospitals, home health agencies, hospices and nursing homes. | All plans; subject to scope |
| Medicare use and market activity | Home health, hospice and skilled nursing use and supply by county, post-acute utilization by provider, spending and readmissions by county, Hospital Service Areas, inpatient diagnosis groups and outpatient services, DME by supplier and referring provider, and monthly Medicare enrollment. | All plans; subject to scope |
| Demographics and growth | American Community Survey 5-year estimates for every county and ZIP area (ages 65+, 75+ and 85+, median age, income, home value, poverty, uninsured, disability, living alone and dual coverage) and Census population estimates of the change since April 2020. | All plans; subject to scope |
| Payers and Medicare Advantage | Medicare Advantage enrollment by organization, contract and county, penetration, plan star ratings and supplemental benefits; Medicaid managed care plans where CMS publishes them; and marketplace insurers by county. | All plans; subject to scope |
| Community health and need | CDC PLACES disease and disability prevalence, the CDC Social Vulnerability Index, AHRQ social determinants of health, HRSA shortage and medically underserved areas, the HRSA Area Health Resources File, Mapping Medicare Disparities, BLS healthcare wages, County Business Patterns and VA facilities. | All plans; subject to scope |
| Provider standing and payments | A provider’s page flags an OIG exclusion, a Medicare opt-out or revocation and the next revalidation date, and shows Open Payments totals from drug and device makers, so you can check standing before you invest in a relationship. | All plans; subject to scope |
| State-licensed homes | Personal care, assisted living, memory care and domiciliary care homes and their beds, imported from each state’s licensing file and counted in county and ZIP area figures. In a state whose file is loaded, an area with none reads 0. | All plans; subject to scope |
| Releases checked daily | The CMS catalogs are checked every day for new releases, and stored rows are refreshed when one arrives. Data years more than ten years old are removed, and a dataset its publisher stopped releasing is retired instead of shown as current. | All plans; subject to scope |

#### Competitor intelligence

Who you compete with for referrals, how they are moving, and what to say about it.

| Feature | Function | Plan or role condition |
| --- | --- | --- |
| Competitor rankings | Home health agencies, hospices and nursing homes in your territory ranked by Medicare share, and hospitals ranked by their share of each county’s residents’ Medicare inpatient cases, with each one’s star rating and change. Yours is marked. Download the rankings as CSV. | All plans; subject to scope |
| Watchlist and alerts | Follow the agencies, nursing homes and hospitals that matter and get alerts when a star rating, owner or service area changes, a change of ownership is filed, or a new agency or nursing home opens nearby. | All plans; subject to scope |
| Compare and trends | Put competitors side by side on market rank, volume, share and its change, star rating, locations and ZIP codes served, and follow their share over time. | All plans; subject to scope |
| County roll-up | Every county in a state with its market leader, number of providers and biggest mover, as CSV or a leadership-brief PDF. | All plans; subject to scope |
| Scheduled leadership brief | Email the county roll-up as a PDF to your managers daily, weekly or monthly. | Owners & location managers |
| What to say | On a home health agency, hospice or nursing home, a card lines your organization up with the three largest in the county on star rating and Medicare patient totals (and patient survey for agencies), in plain sentences. | All plans; subject to scope |
| Personal care and assisted living ranking | For personal care and assisted living organizations: the state-licensed homes in your territory, largest first by licensed beds, with each one’s share of the licensed beds and yours marked. Download it as CSV. | All plans; subject to scope |
| Free agency market review | On the public site, anyone can type a home health or hospice CCN and get a PDF by email: the agency's Medicare patients, share and rank in its county and state, the largest local agencies and its public CMS ratings. | All plans; subject to scope |

#### Manager and team tools

Set expectations, see where the effort goes, and coach the people doing the work.

| Feature | Function | Plan or role condition |
| --- | --- | --- |
| Goals and leaderboard | Monthly visit and referral targets for each marketer, a leaderboard, Met / On pace / Behind for the open month and a six-month trend. Everyone sees their own progress on Today. | Setting targets: Growth & Pro |
| Team review | One marketer’s week in one place: visits and calls with their notes, saved routes, open tasks and assigned accounts. | Owners & location managers |
| Activity report and weekly email | Visits, calls, tasks done and overdue, referrals and admissions by person and source, new and lost sources, stage changes and accounts not visited. Download a spreadsheet or PDF, or turn on a weekly email. | Weekly email: owners & location managers |
| Coaching | Ride-along notes, comments on a visit and 1-on-1s for one marketer. | Owners & location managers |
| Locations | Add locations and assign each person as a marketer or manager. People then see their locations’ accounts, and reports follow the same rule. | Owners · Growth: 3, Pro: 10 |
| Book balance | Proposes a split of accounts across the marketers you choose by referral potential and drive time. Nothing moves until a manager applies it. | Pro · owners & location managers |
| Account briefs and Ask the book | A short factual brief on any account (stage, visits, calls and referral outcomes over 90 days, with notes left out), and answers to supported questions about your book, such as the top ten sources last quarter. | All plans; subject to scope |
| Decision briefs | Prioritized accounts to prepare for, manager exceptions such as overdue tasks and falling referrals, and changes on the accounts you watch. Download a branded PDF or CSV, or have it emailed. | All plans; subject to scope |
| Materials library | Brochures, physician one-pagers, service-line flyers and video links in one searchable place. New versions replace old ones, marketers note what they left on a visit, and managers see who opened each file. | Adding materials: owners & location managers |
| Healthcare observances | A calendar of the days, weeks and months that honor the people marketers call on (Doctors’ Day, Nurse Practitioner Week, Case Management Week, Social Work Month, Nurses Week and more), care settings, health awareness months and Medicare enrollment periods, worked out each year from the sponsor’s rule. Today and the Monday digest show what is coming up; Remind me adds a task two weeks ahead, and the calendar downloads for Outlook, Google Calendar or a phone. | Everyone, every plan |
| AI Assistant | Ask about your market, your book and your day in plain English. It looks answers up in the app’s data inside your plan’s territory, says when a figure is an estimate, and proposes lead lists, visits, tasks, call plans and outreach drafts that are saved only when you confirm. Each question uses one of your organization’s daily AI requests. | Growth & Pro · organization admins, and the team when turned on |
| AI playbook | An organization admin sets the pitch pillars, the service lines to mention and the words to avoid. The pre-visit card adds a pillar when it has room, and the notes summary and spoken debrief follow the playbook and flag an avoided word. | Setting it: owners |
| Use your own AI app with Intel | Make a personal token in Account and connect an AI app that supports MCP to Intel. It reads providers, lead scores, county and market facts, your day, account briefs, lead lists and your book as you, with your role and your plan’s places, and can’t change anything. Each question counts toward your organization’s AI requests. | Growth & Pro · whoever can open the AI Assistant |
| Activity challenges and report card | Set a friendly target for visits, calls, accounts touched or tier A visits for a location or the whole organization, with standings for everyone in it. Never referrals or admissions, with a reminder about contractors paid on a 1099. Each person's report card compares their month's activity with the month before. | All plans; subject to scope |

#### Email campaigns

Reach the contacts on a lead list or your book, with sending rules that protect your reputation.

| Feature | Function | Plan or role condition |
| --- | --- | --- |
| Campaigns to lists and contacts | Email a lead list, the contacts on one line of your book, or both. People marked as left are skipped. | Owners · Growth & Pro |
| Delivery tracking | Track deliveries, opens, clicks and bounces for each campaign, and link campaigns to the accounts they touched. | Owners · Growth & Pro |
| Sender and unsubscribe | Set the name recipients see, where replies go and your postal address. Every email carries an unsubscribe link that is honored automatically. | Owners · Growth & Pro |
| Queue contacts from an account | Any marketer can add a contact to a draft campaign from the account page; an owner prepares and sends it. | Growth & Pro |
| Nurture sequences | Start a sequence of calls, visits, emails and tasks on an account, from four starters (new physician welcome, in-service thank-you, quarterly outcomes packet, re-engage a slipping source) or your own. Email steps carry a draft you send from Follow-up. A sequence stops on its own on a referral, a contact leaving or every contact unsubscribing, or when you mark a reply. | All plans; subject to scope |

#### Reports and analytics

Your book turned into reports that managers, owners and marketers can each trust for their own scope.

| Feature | Function | Plan or role condition |
| --- | --- | --- |
| Reports library | Every report on one page, grouped by the question it answers: your organization, your competitors, new referral sources, your market, and the data builders. The list opens on the reports built for your kind of organization, and search finds a report by what it is about. | All plans; subject to scope |
| My organization | How your own providers stand in public data. A home health agency, hospice, nursing home or hospital shows its CMS star ratings and published measures, how its rating compares with the others in its county, and its share, rank and trend there. A personal care or assisted living home shows its licensed beds and its share of the county’s. Home health agencies and hospices can download their own market report as a PDF. | All plans; subject to scope |
| Results reports | Performance scorecard, field activity, tasks and follow-up, mileage, referrals and admissions, top referral sources, why referrals were not admitted, payer mix, source pipeline, account coverage and goal attainment. | All plans; subject to scope |
| Source quality after admission | Load a stays report (or have a supported EMR deliver it on a schedule) and see, by referral source, marketer or location, how long patients stay, short stays, hospice live discharges and revocations, home health returns to the hospital, and a nursing home's returns to the hospital and discharges home, plus average daily census against each location's budget. A group is rated only with 10 or more endings, a flag means 10 points above your own average, and patient columns are never read or stored. | Loading and organization budgets: owners · by marketer and location: managers |
| Filter and group | Choose dates, then filter and group by person, location, line of business, account type, county, payer, source type, month or week. Members see their own work; managers see their locations; owners see the company. | All plans; subject to scope |
| PDF, Excel and CSV | Every report downloads with the same figures as the screen and the source of the data printed on it. | All plans; subject to scope |
| Custom report builder | Save charts and email them on a schedule to up to 25 people in your organization. | All plans; subject to scope |

#### Administration, security and data

Control who can see what, keep a record of it, and know where every figure comes from.

| Feature | Function | Plan or role condition |
| --- | --- | --- |
| Organization, people and roles | Invite people up to your plan’s seats, make someone an owner or a member, disable accounts, send password reset links and sign someone out everywhere. | Owners |
| Text-message sign-in codes | Owners and location managers can add a six-digit code, sent by text, to their own sign-in. | All plans; subject to scope |
| Security audit | Sign-ins, account changes, exports and other recorded actions for your organization, with filters. | Owners |
| Billing and territory | Choose your plan, counties or states and add-ons (extra seats, locations and states) from Billing. | Owners |
| Guided setup and help | A guided setup for a new organization, an in-app help guide, and illustrated user guides for marketers and administrators as PDFs. | All plans; subject to scope |
| Business menu and search | Pick a healthcare service line to focus your CRM, referral tracking, and available research views. Use Other healthcare services for an unlisted specialty. Public datasets and specialized reports vary by setting. Press Ctrl+K anywhere to search accounts, providers, NPIs, lead lists, pages and individual reports. | All plans; subject to scope |
| Public data, clearly sourced | Provider, facility and market figures come from CMS, NPPES, the U.S. Census Bureau and state licensing files, with each dataset’s release shown. Public research uses no patient-level data. | All plans; subject to scope |
| Patient privacy by design | Patient-identifying columns are dropped from referral imports, briefs and scorecards leave notes out, and exports carry no patient names. | All plans; subject to scope |
| Send data out | An organization admin sends the organization’s own accounts, referrals and visit counts out every night: three CSV files to an SFTP server whose host key you pin, or accounts to a supported CRM as companies. Notes, check-in positions and patient details never leave Intel; passwords and tokens are stored encrypted. | Setting it: owners |

#### Intel's data, by the numbers

The site's own figures about its data (owner approval 2026-11-16): the only figures about its data the team may state, worded as the site words them.

| Figure | What it counts | On the site |
| --- | --- | --- |
| 150+ | public healthcare datasets | From CMS, NPPES, the U.S. Census Bureau, HRSA, CDC, AHRQ, BLS, the HHS Office of Inspector General and state licensing agencies, linked by NPI, CCN, county and ZIP. |
| Every NPI | in the national provider registry | Physicians, practices and organizations with their practice locations and specialties, kept current from CMS’s weekly update files. |
| 33,000+ | ZIP areas and 3,200+ counties | Each with Census age, income, disability, living-alone and growth figures beside the providers and facilities located there. |
| Daily | checks for new CMS releases | Every view names the release it uses and when it was loaded, so your team can judge a figure before acting on it. |

#### Data, sources and what they can tell the company

| Data family | Included information and source | Business use and limit |
| --- | --- | --- |
| Providers | Every individual and organization in the national NPI registry, with practice locations, specialties and affiliations, refreshed from CMS’s weekly files; Medicare services, patients and payments by clinician, home health certifications and hospice care-plan oversight by physician; Order & Referring enrollment, Part D prescribing, MIPS quality scores and Open Payments totals; OIG exclusions, Medicare opt-outs and revocations, flagged on the provider’s page. Source: NPPES, the NUCC taxonomy, CMS Physician & Other Practitioners, Order & Referring, Part D Prescribers, the Quality Payment Program, Open Payments and the OIG exclusion list. | Compare clinicians by specialty, location, and available Medicare activity, see who opened or moved a practice, and review public standing before investing in a relationship. A provider’s presence or activity is a research signal, not a promise of referrals. CMS lists a clinician’s counts only above ten patients. |
| Facilities | Hospitals, home health agencies, hospices, nursing homes, inpatient rehab, long-term care hospitals, DME suppliers and community health centers; Star ratings, patient surveys, readmissions, inspections, penalties and nurse staffing; Ownership, chains, changes of ownership and cost-report revenue, expenses, beds and visits; The Hospice Care Index, home health value-based purchasing scores and CMS TEAM hospitals; State-licensed personal care, assisted living and memory care homes and beds, where loaded. Source: CMS Provider of Services, Care Compare, cost reports (HCRIS), ownership and staffing files, and available state licensing files. | Walk into a hospital or nursing home already knowing its ratings, ownership, size and service area, and print a branded profile for the visit. Licensed-home coverage and available detail vary by state and source. Measures describe the periods CMS publishes. |
| Medicare use & share | Home health, hospice and skilled nursing use and supply by county; Medicare spending per beneficiary and readmissions by county; Where each county’s residents are hospitalized and where post-discharge spending goes; Each agency’s share of the Medicare patients served, from Care Compare ZIP service areas; Inpatient diagnosis groups, outpatient services, and DME by supplier and referring provider. Source: CMS Market Saturation, Geographic Variation, Hospital Service Area, Post-Acute Care utilization, inpatient, outpatient and DME files. | Review the Medicare volume available for your service line alongside local provider supply and hospital activity before assigning outreach resources. Post-discharge spending is a planning indicator, not a count of transfers. Medicare populations and coverage vary by dataset and service line. |
| Demographics | Residents 65+, 75+ and 85+, median age, household income and home value for every county and ZIP area; Poverty, uninsured, disability, Medicare-Medicaid dual coverage and older adults living alone; Population change since the 2020 Census, for all ages and for 65+, 75+ and 85+; A Site finder that ranks counties or ZIP areas by demand, growth, need and supply gap for your service line. Source: U.S. Census Bureau 2020 geography, American Community Survey 5-year estimates and population estimates. | Compare local demand with the providers already there before you hire, open an office or redraw territories. Demographic estimates provide planning context; they do not identify individual prospects. A ZIP area carries its county’s growth. |
| Payers & Medicare Advantage | Medicare enrollment and Medicare Advantage share by county; Medicare Advantage enrollment by organization and plan, plan star ratings and supplemental benefits; Medicaid managed care plans where CMS publishes them, and marketplace insurers by county. Source: CMS Medicare Monthly Enrollment, Medicare Advantage enrollment, star rating and plan benefit files, and marketplace public use files. | Plan payer conversations and outreach with the county’s current Medicare Advantage penetration and the plans that hold the most members. Enrollment is by county of residence, for the period CMS published. |
| Community need | Chronic disease and disability prevalence and Social Vulnerability Index ranks; Health professional shortage areas and medically underserved areas; Social determinants of health, Mapping Medicare Disparities rates and Older Americans Act services by state; Healthcare wages and employers, VA facilities and the home health wage index. Source: CDC PLACES and Social Vulnerability Index, HRSA, AHRQ, the CMS Office of Minority Health, ACL, BLS, Census County Business Patterns and the VA. | Find the communities that most need your services, and see local wage levels for the staff you would hire before you expand. Measures are county-level estimates from each publisher’s latest release. |
| Competitors | Home health agencies and hospices ranked by Medicare share, with star ratings and change from the prior period; Alerts when a competitor’s star rating, owner or service area changes, or a new provider opens nearby; Side-by-side comparisons, share trends and a county roll-up of each market leader and biggest mover; A plain-language card comparing your agency with the three largest in the county. Source: CMS Care Compare, ZIP service areas, Provider of Services and ownership files. | Spot a rival’s weakness or a new entrant early, and give marketers facts to use in the next conversation. Rankings describe the periods CMS publishes, not this week’s referrals. |
| Your results | Accounts, contacts, ownership, calls, visits, and follow-ups; Expenses, receipts, approvals, reimbursements, and mileage; Recorded or CSV-imported referrals and admissions, with response times; Source trends, conversion, lost reasons, team activity, and goals. Source: The information your organization records or imports. | Reduce the time spent reconstructing account history and bring recorded results into the conversation about marketing priorities. Results reflect your records. CSV imports are file-based, not live EMR connections; patient-identifying columns are dropped. |

#### How the focus changes by care setting

The first five are Intel’s primary audience. The other five, which Intel’s site also describes, are secondary markets (“Secondary markets” above, owner decision 2026-11-16): describe them only to answer a reader from one, and aim no outreach, content or ads at them until the primary audience has been thoroughly marketed to.

| Care setting | Relevant use |
| --- | --- |
| Home health agencies | See which physicians certify the most Medicare home health patients, which hospitals your county’s residents use and how much post-discharge spending goes to home health. Rank competing agencies by Medicare share, and track the referrals and admissions each source sends. |
| Hospice agencies | Find physicians by hospice care-plan oversight, hospitals by where residents are admitted, and counties with high need and few hospices. See each hospice’s Hospice Care Index and CMS spending-variation index, and keep every relationship and recorded referral together. |
| Hospitals | Map where your county’s residents are hospitalized and where their post-discharge Medicare spending goes. Research the physician practices, post-acute partners and community organizations around you, see which hospitals are in CMS’s TEAM model, and plan physician outreach by territory. |
| Nursing homes | Analyze the hospitals that serve your area, skilled nursing use and supply, and every competing nursing home’s star ratings, staffing, inspections and ownership. Focus outreach on the hospitals and physicians that matter and keep relationship history and recorded referrals together. |
| Personal care homes | Find the counties and ZIP areas with the most residents 75 and over, older adults living alone and the fewest licensed beds, using the Site finder and state licensing files where loaded. Research nearby hospitals, physicians and senior-care organizations and organize community outreach. |
| Physician practices & clinics (secondary market) | Find referring clinicians and practices by specialty and location. Build an outreach list, assign relationship owners, prepare visits, and track the referrals your team records. |
| Behavioral health (secondary market) | Research primary care practices, hospitals, and community providers. Coordinate relationship development, follow-ups, and referral tracking around your services and territory. |
| Rehabilitation & therapy (secondary market) | Identify physician practices, hospitals, and other potential referral partners. Keep contacts, visits, follow-ups, and recorded referrals together across your locations. |
| Diagnostics, dialysis & DME (secondary market) | Research clinicians and organizations relevant to your specialty. Use available provider activity and directory information to plan outreach and follow the relationships that generate referrals. |
| Other healthcare organizations (secondary market) | Use the same market research, account management, field work, and referral tracking tools for your healthcare services. Choose Other healthcare services when your specialty is not listed. |

Research coverage is not universal: an absent field or an unscored provider is not a negative assessment of that organization.
Results reflect the source reporting period or the organization’s recorded activity, not a real-time census of the whole market.
