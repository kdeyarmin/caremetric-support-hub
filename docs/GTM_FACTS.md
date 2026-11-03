# CareMetric go-to-market facts

The single source of truth for what CareMetric says about itself in marketing: what each product is and who it is for,
live prices and trials, the founding-partner offer, the claims we may and may not make, and the words we always (and never)
use. Anything written for a prospect, by a person or by the AI team, starts here.

Status: **every fact on this page is "owner to confirm".** Each one was read on 2026-11-03 from the live code of the product it
describes, and the source file is named beside it. None of it is a contract, a quote or a legal statement.

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
  `README.md`, Advisors `site-content.mjs`. Owner to confirm.
- Founder: **Dr. Kevin C. Deyarmin** (ND, MSW, CHPCA, NCG), founder and principal advisor of CareMetric Healthcare Advisors and
  the founder behind CareBase. Source: Advisors `site-content.mjs` (`brand.founder`), CareBase `About.tsx`. Owner to confirm.
- Public addresses: support@caremetric.ai and the central support line (877) 521-2890 (Hub `server/email-layout.mjs`);
  hello@caremetric.ai for founding partners (CareBase `About.tsx`). The help center is **https://help.caremetric.ai**. AI-written
  articles carry no email address or phone number; they link to the product pages below.

## CareMetric CareBase

- **For:** Pennsylvania personal care homes (55 Pa. Code Chapter 2600) and Assisted Living Facilities (55 Pa. Code Chapter
  2800), single or multi-site. Site: https://cmcarebase.com. Owner to confirm.
- **What it does:** staff training, resident records, daily tasks and survey documentation in one place, with optional eMAR,
  Workforce, Survey & Compliance and Resident Billing & Payments modules. Its AI copilot is **text only** (owner decision
  2026-10-30: no voice, no phone calls). Owner to confirm.
- **Trial:** a **30-day** free trial, started online at cmcarebase.com/signup (`MARKETING_TRIAL_DAYS = 30`). Owner to confirm.

Prices (`marketingPricing.ts`; every CareBase price is per active facility, and residents, staff and learners are never counted).
Owner to confirm.

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

**Founding-partner offer** (`About.tsx`, "Founding partners" band). Owner to confirm before an article repeats it.

- Early Pennsylvania personal care home and ALF operators can ask about founding-partner terms by emailing
  hello@caremetric.ai; anyone can still start the standard free trial online.
- They get: help setting up their facilities and staff roster, a direct line to the founder, their workflow prioritized on the
  roadmap, and **founding-partner pricing locked for as long as they subscribe**.
- CareMetric asks them to use at least one real workflow in CareBase, join a short feedback call every few weeks, and let
  CareMetric quote agreed results without identifying residents or staff. (The agent's copy says "give feedback every few
  weeks", so that no AI-written text offers a call.)
- Good fit: a PA personal care home or Assisted Living Facility, single or multi-site, running compliance on spreadsheets,
  binders or a training-only LMS.

## CareMetric Intel

- **For:** home health agencies, hospice agencies, hospitals, nursing homes and personal care homes that want more targeted
  marketing. Site: https://www.caremetricintel.com. Owner to confirm.
- **What it does:** targeted marketing, marketing analysis and territory analysis from public healthcare and demographic data,
  plus a marketing CRM that keeps outreach, follow-up and the referrals the organization records in one place. Its AI features
  (briefs, supported reporting questions, drafted outreach) are text. Owner to confirm.
- **Trial:** a **14-day** free trial with no credit card, covering one county with 3 marketer seats and 1 manager seat
  (`TRIAL_DAYS = 14`, the `trial` plan). It does not turn into a paid subscription by itself. Owner to confirm.

Plans (`planLimits.ts`, `docs/marketing-copy.md`). Annual billing saves about 17%. Owner to confirm.

| Plan | Monthly billing | Annual billing | Includes |
| --- | --- | --- | --- |
| Starter | $349 per month | $290 per month ($3,480 per year) | 3 marketer seats and 1 manager seat, 1 branch, one home health or hospice CRM line, up to 10 counties, extra seats $59 per month, no onboarding fee |
| Growth | $899 per month | $749 per month ($8,988 per year) | 10 seats, up to 3 branches, both CRM lines, 1 full state, campaigns and manager tools, EMR CSV imports and AI briefs, extra seats $49 per month, onboarding $500 (waived with annual billing) |
| Pro | $1,999 per month | $1,665 per month ($19,980 per year) | 25 seats, up to 10 branches, up to 3 states, forecasting and territory tools, white-label reports, extra seats $39 per month, onboarding $1,500 |
| Enterprise | custom | annual only, from about $3,500 per month | larger footprints by agreement |

Extra branches are $99 per month each and extra states $199 per month each.

## CareMetric Healthcare Advisors

- **For:** owners, operators, leadership teams and investors in home health, hospice, skilled nursing, personal care homes and
  assisted living. Site: https://caremetricadvisors.com. Owner to confirm.
- **What it does:** consulting on strategy and operations, clinical quality and compliance, financial performance and
  reimbursement, acquisition advisory and due diligence, education and leadership, technology and workflow, and personal care
  home and ALF operations. Owner to confirm.
- **Prices:** none published; engagements are scoped to the problem. A conversation starts with the consultation request form
  at caremetricadvisors.com/contact, with no obligation to move forward. Business consulting only: never send patient
  information through the site. Owner to confirm.

## Claims

**We may say** (owner to confirm):

- What each product does and who it is for, in the words above.
- The prices, plans, trials and offers above, exactly as written, with the product they belong to.
- That CareBase keeps staff training, resident records, daily tasks and survey documentation in one place for Pennsylvania
  personal care homes and Assisted Living Facilities.
- That a product helps a team stay organized, see what needs attention and keep records ready for a surveyor.
- What a regulation says, from the regulation itself, with its section cited and the "not legal advice" line.

**We may not say** (enforced in code for the AI team by `server/agents/content/validate.mjs`; owner to confirm):

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
- **CareBase never says "prove" or "proof"**: talk about survey readiness, documentation and records (`Landing.copy.test.ts`; the
  landing page also avoids "evidence", owner to confirm whether that extends to articles).
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
  federal sources Intel itself reads: cms.gov and census.gov (owner to confirm the two federal hosts).

## Owner to confirm

- [ ] CareBase prices, add-ons, Complete, Compliance Suite, Small Home and Train prices, and the 30-day trial.
- [ ] Intel plans, annual prices, seats, onboarding fees, add-ons, the Enterprise floor and the 14-day trial.
- [ ] The founding-partner offer may be repeated in articles and pitches as worded above.
- [ ] Advisors has no published prices, and the consultation form is the first step.
- [ ] The claims lists, including that SOC 2 and HIPAA wording stays on CareBase's security page only.
- [ ] cms.gov and census.gov as citation hosts for Intel's topics.
- [ ] Whether CareBase's avoidance of "evidence" applies to articles as well as the landing page.
