/**
 * The machine-readable copy of docs/GTM_FACTS.md: the only facts about CareMetric's products the Content Marketer may state,
 * the pages it may link to, the official sources it may cite and the vocabulary it must use. The model is shown this file's
 * fact sheet (`factSheetText`) and the code checks every draft against the same values (validate.mjs), so a price that is not
 * here cannot reach a public article or an outreach draft.
 *
 * Every value was read from the live code of the product it describes (the source is named beside it). A change to a price
 * or a trial is made in the product first, then here and in docs/GTM_FACTS.md; facts.test.mjs keeps the two copies together.
 * The owner confirmed every fact and claim here on 2026-11-08, and on 2026-11-12 directed how Intel is presented (`present`: a whole
 * marketing workspace, never an email tool). The owner requested the Founders Sale on 2026-11-08;
 * its coupon, duration and product scope were verified in the live CareMetric billing account.
 * The 2026-11-14 expansion adds CareBase's functional overview and each product's reasons to choose it, from the reviewed
 * feature catalogs and Advisors' service scope. It does not re-verify prices, certify outcomes or extend the approved claims.
 */

export const factsVersion = '2026-11-14';

/**
 * Where public help articles live. An article's help-center address is `${helpCenterOrigin}/help/articles/<slug>`; that is its
 * canonical address unless its product's own website serves it (CareMetric Intel's: intelArticleUrl, articleHomeUrl).
 */
export const helpCenterOrigin = 'https://help.caremetric.ai';
export const articleUrl = slug => `${helpCenterOrigin}/help/articles/${slug}`;

const deepFreeze = value => {
  if (value && typeof value === 'object') for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};

// Redeemed through assisted billing activation, not an automatic checkout promotion. Keep the complete terms together.
const foundersSaleTerms = 'Founders Sale: 50% off eligible subscription charges for the first 12 months of paid service on new paid product subscriptions, including existing free-trial users. The discount is applied automatically to eligible subscriptions after the trial, when paid service starts. No code or activation request is needed. Monthly billing receives 50% off the regular monthly rate; annual billing receives 50% off the published annual price paid upfront. Standard pricing resumes after the introductory year. Setup fees, Intel extra seats/branches/states, taxes, legacy plans and custom contracts are excluded. Other promotional discounts cannot be combined. One introductory year per organization and product; plan eligibility and capacity limits still apply. No enrollment deadline or cap has been set. Source: live Stripe offer verified 2026-11-08; docs/PRICING_RESEARCH_AND_FOUNDERS_SALE.md.';

const usd = cents => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const listNames = names => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? '');

/**
 * Intel's pricing and offer lines, written from the catalog Intel publishes
 * (parsed by server/app-catalog-sync.mjs) in the sheet's own wording. The
 * reviewed lines below are exactly what this writes from Intel's catalog when
 * they were reviewed (facts.test.mjs holds them together).
 */
export function intelFactsFromCatalog(catalog) {
  const product = key => catalog.products.find(item => item.entitlement_key === key);
  const amount = (item, interval, plan) => item?.prices.find(price => price.interval === interval && (plan ? price.plan === plan : !price.plan))?.unit_amount;
  const perYear = (month, year, suffix = 'on annual billing') => (year ? ` (${usd(year)} per year ${suffix})` : '');
  const plans = catalog.products.filter(item => item.kind === 'plan' && item.self_serve && amount(item, 'month'));
  const seats = product('extra_seat');
  const pricing = plans.map(item => {
    const month = amount(item, 'month');
    const year = amount(item, 'year');
    const seat = amount(seats, 'month', item.entitlement_key);
    return [
      `${item.name}: ${usd(month)} per month${year ? `, or ${usd(Math.round(year / 12))} per month billed annually (${usd(year)} per year)` : ''}.`,
      item.description,
      seat ? `Extra seats ${usd(seat)} per month${perYear(seat, amount(seats, 'year', item.entitlement_key))}.` : '',
      catalog.free_onboarding ? 'Free onboarding.' : '',
    ].filter(Boolean).join(' ');
  });
  const quoted = catalog.products.find(item => item.kind === 'plan' && !item.self_serve && item.from_unit_amount);
  if (quoted) pricing.push(`${quoted.name}: a custom annual agreement starting at about ${usd(quoted.from_unit_amount)} per month.`);
  const branch = product('extra_branch');
  const state = product('extra_state');
  const extras = [
    branch && amount(branch, 'month') ? `Extra branches are ${usd(amount(branch, 'month'))} per month each${perYear(0, amount(branch, 'year'))}` : '',
    state && amount(state, 'month') ? `extra states ${usd(amount(state, 'month'))} per month each${perYear(0, amount(state, 'year'))}` : '',
  ].filter(Boolean);
  const saving = catalog.annual_saving_percent ? ` Annual billing saves about ${catalog.annual_saving_percent}%.` : '';
  if (extras.length) pricing.push(`${extras.join(' and ')}.${saving}`);
  const first = plans[0];
  const offers = [
    `A ${catalog.trial_days}-day free trial with no credit card${catalog.trial_includes ? `, covering ${catalog.trial_includes}` : ''}, then request paid plan activation from CareMetric.`,
    foundersSaleTerms,
    `Eligible Intel products: ${listNames(plans.map(item => item.name))}. Intel ${first.name} is ${usd(Math.round(amount(first, 'month') / 2))} per organization per month during the introductory year`
      + `${amount(first, 'year') ? `, or ${usd(Math.round(amount(first, 'year') / 2))} for the first annual payment` : ''}, then the regular rate.${catalog.free_onboarding ? ' Onboarding is free on every plan.' : ''}`,
  ];
  return { trialDays: catalog.trial_days, pricing, offers };
}

/**
 * The reviewed copy of Intel's facts (docs/GTM_FACTS.md), quoted until the Hub
 * reads Intel's catalog (server/billing.mjs, syncAppCatalog), and the yardstick
 * for flagging docs/GTM_FACTS.md when the catalog moves on.
 */
export const intelReviewedFacts = deepFreeze({
  trialDays: 30,
  pricing: [
    'Starter: $349 per month, or $290 per month billed annually ($3,480 per year). One office. 3 marketer seats + 1 manager, 1 branch, home health or hospice, up to 10 counties. Extra seats $59 per month ($590 per year on annual billing). Free onboarding.',
    'Growth: $899 per month, or $749 per month billed annually ($8,988 per year). The usual agency plan, with campaigns, manager tools and AI field help. 10 seats included, up to 3 branches, home health and hospice, 1 full state. Extra seats $49 per month ($490 per year on annual billing). Free onboarding.',
    'Pro: $1,999 per month, or $1,665 per month billed annually ($19,980 per year). For several territories, with forecasting, territory tools and white-label reports. 25 seats included, up to 10 branches, home health and hospice, up to 3 states. Extra seats $39 per month ($390 per year on annual billing). Free onboarding.',
    'Enterprise: a custom annual agreement starting at about $3,500 per month.',
    'Extra branches are $99 per month each ($990 per year on annual billing) and extra states $199 per month each ($1,990 per year on annual billing). Annual billing saves about 17%.',
  ],
  offers: [
    'A 30-day free trial with no credit card, covering 3 marketer seats + 1 manager, 1 branch, home health and hospice, 1 county, then request paid plan activation from CareMetric.',
    foundersSaleTerms,
    'Eligible Intel products: Starter, Growth and Pro. Intel Starter is $174.50 per organization per month during the introductory year, or $1,740 for the first annual payment, then the regular rate. Onboarding is free on every plan.',
  ],
});

// Intel's facts as last read from its catalog; null until the first read.
let intelLive = null;
let intelLiveVersion = null;
const intelFacts = () => intelLive ?? intelReviewedFacts;

/** The three things CareMetric sells. `slug` is the Hub's product slug, which is where an article about the product is published. */
export const products = deepFreeze({
  carebase: {
    slug: 'carebase', name: 'CareMetric CareBase', site: 'https://cmcarebase.com',
    source: 'kdeyarmin/PennTrain@b9da4e1 artifacts/caremetric-carebase/src/components/marketing/marketingPricing.ts',
    forWhom: 'Pennsylvania personal care homes (55 Pa. Code Chapter 2600) and Assisted Living Facilities (55 Pa. Code Chapter 2800), single or multi-site.',
    does: 'Staff training, resident records, daily tasks and survey documentation in one place, with optional eMAR, workforce, survey and compliance, and resident billing modules. Its AI copilot is text only.',
    bigPicture: 'CareBase connects the records and daily work a care organization needs to manage staff, residents and facilities. Managers see missing requirements, assign follow-up and prepare documentation from the same records staff use. Available modules depend on the subscription; CareMetric Train provides training separately.',
    capabilities: [
      'Training and requirements: maintained courses, graded quizzes, competency checklists, role-based assignments, custom requirements, reminders, a compliance matrix, reports, document storage and eligible offline training.',
      'Reviewed AI assistance and live classes: the CareMetric team prepares courses from source documents for human review, with optional presenter videos. The text copilot answers from facility records and regulatory references and drafts follow-up for approval. Trainers schedule classes, manage rosters, record attendance and retain signed attendance sheets.',
      'Resident care and operations: inquiries, admissions, census, room readiness, agreements, assessments, support plans, clinical notes and vitals, change-of-condition follow-up, daily services, dietary checks, transportation and resident financial records. Compatible clinical systems can supply records through configured FHIR connections. Imported medication events are read-only; native eMAR requires enrollment, clinical approval and a documented switch.',
      'Credentials and workforce: clearances, qualifications, licenses, provisional-employment deadlines, continuing education, medication authorization, policy acknowledgments, shift scheduling, cross-facility staff and time-off coverage.',
      'Survey, safety and facilities: binder exports, a readiness score for prioritizing recorded gaps, Survey Day Mode, documentation rooms, incidents, complaints, reporting deadlines, corrective work, fire drills, emergency operations, maintenance, quality projects and assigned work queues. The readiness score does not predict survey results.',
      'Access and onboarding: organization and facility roles, scoped guest links, certificate verification, staff roster imports, invitations, online signup, configured reminders and an installable employee training player. Employees see their own records; surveyors receive scoped documentation links without a CareBase sign-in.',
    ],
    whyChoose: [
      'Keep daily work and survey documentation together. Training, credentials, resident records and follow-up tasks give managers a shared view of what needs attention.',
      'Spend less effort chasing records. Due dates, reminders, assigned owners and overdue alerts make responsibilities visible instead of relying on separate calendars and messages.',
      'Bring training into the operating workflow. Maintained courses, reviewed policy-based lessons, live attendance, quizzes and certificates keep learning and its records together.',
      'Manage across facilities without giving everyone the same access. Organization leaders can review the portfolio while managers and employees work within their assigned scope.',
      'Keep continuity when people change roles. Shared records, retained history and reassigned responsibilities help the next administrator continue the work.',
      'Choose the modules that match the work. Compare existing training trackers, schedules, incident logs and ledgers with the relevant CareBase modules before retiring a tool. Potential savings depend on actual use.',
    ],
    whoUses: [
      'Owners and organization administrators: review facilities, compare priorities, configure requirements and manage access across the organization.',
      'Facility managers: resolve overdue work, review staff coverage, validate outside training and prepare requested survey documentation for their assigned sites.',
      'Trainers: assign courses, schedule classes, record attendance and manage practicum documentation.',
      'Employees: complete their own training, view published shifts, sign policies and upload records from a browser or phone.',
      'Surveyors: review only the documentation shared through a scoped, time-limited link, without editing records or receiving a CareBase sign-in.',
      'Guests and designated persons: use time-limited links for shared move-in records, agreements and documentation without a full user account.',
    ],
    trialDays: 30,
    pricing: [
      'CareBase Core: $199 per facility per month, or $1,990 per facility per year. Unlimited residents and staff; nobody is counted per person.',
      'Add-ons, each per facility per month (per year): eMAR $149 ($1,490), Staff Training $99 ($990), Workforce $99 ($990), Survey & Compliance $149 ($1,490), Resident Billing & Payments $99 ($990).',
      'CareBase Complete (Core plus every add-on): $649 per facility per month, or $6,490 per year.',
      'Compliance Suite (Staff Training, Workforce and Survey & Compliance without Core): $279 per facility per month, or $2,790 per year.',
      'Small Home (Core with eMAR included, for facilities with fewer than 20 licensed beds): $199 per facility per month, or $1,990 per year. Small Home Complete: $399, or $3,990 per year.',
      'CareMetric Train (training only, unlimited learners): $239 per organization per month, or $2,390 per year. Train Single Facility: $119 per month, or $1,190 per year.',
    ],
    offers: [
      'A 30-day free trial, started online at cmcarebase.com/signup.',
      foundersSaleTerms,
      'Eligible CareBase/Train products: Core, Complete, Compliance Suite, Small Home, Small Home Complete, Train, Train Single Facility, and the eMAR, Staff Training, Workforce, Survey & Compliance and Resident Billing & Payments add-ons. CareBase Core is $99.50 per facility per month during the introductory year, or $995 for the first annual payment, then the regular rate.',
      'Legacy founding partners: preserve previously agreed founding-partner pricing held for as long as they subscribe. Previously agreed lifetime terms are separate from the current Founders Sale; do not offer lifetime pricing to new applicants or describe the new sale as a lifetime rate.',
    ],
  },
  intel: {
    slug: 'caremetric-intel', name: 'CareMetric Intel', site: 'https://www.caremetricintel.com',
    source: 'kdeyarmin/intel@f50b3eb src/lib/planCatalog.ts, read live from https://www.caremetricintel.com/api/billing/catalog (reviewed copy: intelReviewedFacts)',
    forWhom: 'Home health agencies, hospice agencies, hospitals, nursing homes and personal care homes that want more targeted marketing.',
    does: 'Targeted marketing, marketing analysis and territory analysis from public healthcare and demographic data, plus a marketing CRM that keeps outreach, follow-up and the referrals the organization records in one place.',
    // Owner direction 2026-11-12 (docs/GTM_FACTS.md, "CareMetric Intel: the bigger picture"): every agent sees the whole product, and
    // email is never the point of it. Written from Intel's own published /features page and home page (intel-features.json), in words
    // only: a number here would become one every draft may state (validate.mjs allowedNumbers).
    bigPicture: 'CareMetric Intel runs a healthcare organization\'s whole marketing program in one workspace, from deciding where to focus to reviewing what came of it. It helps a team understand the market and the territory, build a focused list of referral sources with a clear reason behind each name, keep every relationship moving in a CRM built for healthcare marketing, give every call and visit a purpose, keep marketing spend in view of its policy and the Stark limit, connect the team\'s effort to the referrals and admissions it records, know the competition, and give managers what they need to set priorities and coach the team. Owners, managers and marketers each work in their own scope of the same shared record.',
    capabilities: [
      'Market and territory research: a territory map of providers ranked by lead score; county intelligence on the older-adult population, income and adults living alone, the hospitals residents use and where post-discharge spending goes, the post-acute providers located there and the county\'s top referral sources; county Medicare enrollment and Medicare Advantage share, home health, hospice and skilled nursing use and supply, spending, readmissions and each agency\'s market share; facility profiles with ownership, cost-report figures, star ratings and public quality scores; ready-made market briefs for expansion, acquisition, hospital relationships and referral development; and the data release behind every figure.',
      'Prospecting and targeting: a directory of providers, practices and facilities by name, NPI, specialty and place; Target Builder and saved lead lists worked by status; referral-source rankings for a county built on public Medicare data; physicians newly listed in the area; referral discovery, which compares public volume with the referrals the team has logged to find under-worked hospitals and physicians and counties with high need and little local supply; physician share; and opportunity scores that show what went into them.',
      'Healthcare marketing CRM: a marketing book of hospitals, nursing homes, personal care and assisted living homes, physician practices, agencies and other referral sources; home health and hospice worked as separate lines of business; relationship stages from Target to Active source and Preferred, with the reason when an account is At risk or Lost; contacts by healthcare role, from discharge planner and case manager to director of nursing; each account\'s full history beside its market position; a month-end view; duplicate merging and book hygiene; accounts going quiet; side-by-side comparison; handing a whole book to a teammate; and parent organizations.',
      'Daily field work: a Today page with tasks, progress on goals and the accounts to visit this week, each with a reason; a weekly schedule and call plan; a suggested route built from due follow-ups, slipping sources and key accounts not visited lately; a visit log built for a phone, with check-in, visit templates and a dated next step; a pre-visit card; business card scanning; county call sheets; follow-up emails that book the next visit; calendar sync; and a weekly digest for each marketer.',
      'Expenses, mileage and reimbursement: spend logged against the referral source it was for, receipt capture, per-person value for shared meals, each physician\'s running total against the Stark nonmonetary-compensation limit, policy totals for discharge planners and other non-physician sources, policy checks and flags, an approval workflow, reimbursement tracking, budgets, register, compliance and payroll exports, and a mileage log built from visit check-ins. These tools support the organization\'s compliance program; they are not legal advice.',
      'Referral and admission tracking: referrals logged on the account they came from, with the service, payer and outcome; response time from arrival to first answer and decision; referral and admission reports imported from EMR exports as CSV files, with patient-identifying columns dropped; a referral funnel by account and marketer; drop-off alerts when a top source slips; a quarterly outcomes packet to share with a hospital or facility; lost reasons; an admissions forecast [Pro]; and dated confirmations of what new referrals the agency can take.',
      'Competitor intelligence: the home health agencies and hospices in the territory ranked by Medicare share, with star ratings; a watchlist with alerts when a rating, owner or service area changes or a new provider opens nearby; side-by-side comparison and trends; a county roll-up and a scheduled leadership brief; and a plain-language card on how the agency compares with the largest in its county.',
      'Manager and team tools: monthly visit and referral goals with a leaderboard [setting targets: Growth and Pro]; a review of each marketer\'s week; activity reports and a weekly email; ride-along notes and coaching; branches [Growth and Pro]; book balance across marketers [Pro]; account briefs and decision briefs; Ask the book for supported questions about the book; and a materials library that shows who opened each file.',
      'Reports and analytics: results reports (performance scorecard, field activity, follow-up, mileage, referrals and admissions, top sources, why referrals were not admitted, payer mix, source pipeline, account coverage and goal attainment), filtered and grouped by person, location, line of business, county, payer or period, each person seeing their own scope, downloaded as PDF, Excel or CSV, and a custom report builder with scheduled email.',
      'Email campaigns [Growth and Pro]: campaigns to a lead list or the contacts on the book, with delivery tracking, sender settings and automatic unsubscribe handling. One part of the workspace, never the point of it.',
      'Administration, security and data: roles and seats, text-message sign-in codes for managers, a record of sign-ins, changes and exports, billing and territory, guided setup and user guides, public data from CMS, NPPES, the U.S. Census Bureau and state licensing files with each release shown, and patient privacy by design: the research uses no patient-level data, and imports, briefs and exports carry no patient names.',
    ],
    whoUses: [
      'Owners and administrators: where to focus a small marketing team and its budget, how the market and the competition are moving, and what the team\'s work led to in recorded referrals and admissions.',
      'Directors of business development and marketing managers: territory plans, goals, account ownership across branches, a review of each marketer\'s week, coaching, expense approval and the reports they bring to leadership.',
      'Marketers and community liaisons: a planned day and route, a focused visit list with a reason for each stop, notes, follow-ups and expenses logged from a phone, and the history of every account they own.',
    ],
    present: 'Owner direction: show the bigger picture. Intel runs the whole marketing program, and sending emails to referral sources is not the point of it. Email campaigns are one feature, on the Growth and Pro plans. Never describe Intel as an email tool, never lead with emailing referral sources, and never make email the whole subject of a message, post, ad, article or answer: when email comes up, show it as one part of the workspace, beside the research, relationships, visits, spend and recorded results it serves. Across your work, cover the whole range above rather than one feature again and again, and pick the part that answers the reader. What a feature needs (a plan in brackets) still applies.',
    whyChoose: [
      'Put the whole marketing program in one workspace. Research, account relationships, visits, follow-ups, expenses and recorded results share the same working context.',
      'Direct time and budget toward a reasoned target list. Territory demographics, provider profiles, public utilization signals and account coverage help teams decide where to focus.',
      'Keep relationships from depending on one person. Named account owners, healthcare contacts, stages, shared history and book hand-offs preserve context when responsibilities change.',
      'Give field work a purpose and a next step. Pre-visit cards, call plans, routes, mobile visit logs and dated follow-ups connect preparation with the work after a visit.',
      'See what recorded activity led to. Referral funnels, admissions, response times and lost reasons let managers review results alongside visits and outreach without treating public data as confirmed referrals.',
      'Review marketing spend with the supporting records. Account-linked expenses, receipts, per-person values, policy flags, approvals and reimbursement records help managers examine spending. These tools are not legal advice.',
      'Bring market changes and team priorities into management reviews. Competitor alerts, goals, coaching, scoped reports and scheduled briefs support decisions across people and branches, subject to plan and role.',
      'Reduce repeated research and report assembly. Saved lists, account history, supported reporting questions, file imports and reusable reports bring the work together. Any time or cost benefit depends on use.',
    ],
    // Prices, the trial and Intel's offers come from Intel's own catalog once the Hub has read it.
    get trialDays() { return intelFacts().trialDays; },
    get pricing() { return intelFacts().pricing; },
    get offers() { return intelFacts().offers; },
  },
  advisors: {
    slug: 'advisors', name: 'CareMetric Healthcare Advisors', site: 'https://caremetricadvisors.com',
    source: 'kdeyarmin/advisors@fe46d1d site-content.mjs',
    forWhom: 'Owners, operators, leadership teams and investors in home health, hospice, skilled nursing, personal care homes and assisted living.',
    does: 'Consulting on strategy and operations, clinical quality and compliance, financial performance and reimbursement, acquisition advisory and due diligence, education and leadership, technology and workflow, and personal care home and ALF operations. Led by founder and principal advisor Dr. Kevin C. Deyarmin.',
    whyChoose: [
      'Get advice scoped to a specific healthcare business problem. An engagement can focus on the strategy, operations, quality, financial or workflow question the organization needs to address.',
      'Bring an advisory perspective to a significant decision. Acquisition advisory and due diligence support owners, operators and investors evaluating an opportunity.',
      'Support leaders as they change how the organization works. Education, leadership and technology consulting can be scoped alongside operational needs. Deliverables depend on the agreed engagement.',
    ],
    trialDays: null,
    pricing: ['No published prices: engagements are scoped to the problem. A conversation starts with the consultation request form at caremetricadvisors.com/contact.'],
    offers: ['A consultation request through caremetricadvisors.com/contact, with no obligation to move forward. Business consulting only: never send patient information through the site.'],
  },
});

/** The product a topic, an article or a draft is about. */
export const productKeys = Object.freeze(Object.keys(products));
export const productSlugs = Object.freeze(productKeys.map(key => products[key].slug));
export const productBySlug = slug => Object.values(products).find(product => product.slug === slug) ?? null;

/**
 * The public pages an article may link to, by id. These are routes each product's own code defines (a path such as
 * cmcarebase.com/pricing answers 200 for anything, so only real routes are listed). The model names ids, never addresses.
 */
export const productPages = deepFreeze([
  { id: 'carebase-home', product: 'carebase', label: 'CareMetric CareBase', url: 'https://cmcarebase.com/' },
  { id: 'carebase-pricing', product: 'carebase', label: 'CareBase plans and pricing', url: 'https://cmcarebase.com/#pricing' },
  { id: 'carebase-features', product: 'carebase', label: 'CareBase features', url: 'https://cmcarebase.com/features' },
  { id: 'carebase-how-it-works', product: 'carebase', label: 'How CareBase works', url: 'https://cmcarebase.com/how-it-works' },
  { id: 'carebase-training-requirements', product: 'carebase', label: 'PA annual training requirements by facility type', url: 'https://cmcarebase.com/pa-training-requirements' },
  { id: 'carebase-dhs-citations', product: 'carebase', label: 'Common PA DHS citations for personal care homes and ALFs', url: 'https://cmcarebase.com/pa-dhs-citations' },
  { id: 'carebase-survey-guide', product: 'carebase', label: 'Free survey readiness guide', url: 'https://cmcarebase.com/survey-readiness-guide' },
  { id: 'carebase-regulatory-updates', product: 'carebase', label: 'PA regulatory updates for personal care homes and ALFs', url: 'https://cmcarebase.com/regulatory-updates' },
  { id: 'carebase-faq', product: 'carebase', label: 'CareBase questions and answers', url: 'https://cmcarebase.com/faq' },
  { id: 'carebase-about', product: 'carebase', label: 'About CareBase and the Founders Sale', url: 'https://cmcarebase.com/about' },
  { id: 'carebase-signup', product: 'carebase', label: 'Start a CareBase free trial', url: 'https://cmcarebase.com/signup' },
  { id: 'intel-home', product: 'intel', label: 'CareMetric Intel', url: 'https://www.caremetricintel.com/' },
  { id: 'intel-pricing', product: 'intel', label: 'CareMetric Intel plans and pricing', url: 'https://www.caremetricintel.com/#pricing' },
  { id: 'intel-how-it-works', product: 'intel', label: 'How CareMetric Intel works', url: 'https://www.caremetricintel.com/#how-it-works' },
  { id: 'intel-county-report', product: 'intel', label: 'Free county report from CareMetric Intel', url: 'https://www.caremetricintel.com/county-report' },
  { id: 'intel-resources', product: 'intel', label: 'CareMetric Intel resource library', url: 'https://www.caremetricintel.com/resources/' },
  { id: 'intel-targeted-marketing', product: 'intel', label: 'A practical framework for targeted healthcare marketing', url: 'https://www.caremetricintel.com/resources/targeted-healthcare-marketing-framework' },
  { id: 'intel-territory-analysis', product: 'intel', label: 'Territory analysis with public healthcare and demographic data', url: 'https://www.caremetricintel.com/resources/public-data-territory-analysis' },
  { id: 'intel-referral-measurement', product: 'intel', label: 'Measure marketing activity and recorded referrals', url: 'https://www.caremetricintel.com/resources/marketing-activity-referral-measurement' },
  { id: 'intel-manager-playbook', product: 'intel', label: 'A manager’s playbook for focused healthcare outreach', url: 'https://www.caremetricintel.com/resources/healthcare-marketing-manager-playbook' },
  { id: 'advisors-home', product: 'advisors', label: 'CareMetric Healthcare Advisors', url: 'https://caremetricadvisors.com/' },
  { id: 'advisors-services', product: 'advisors', label: 'Healthcare consulting services', url: 'https://caremetricadvisors.com/services' },
  { id: 'advisors-senior-living', product: 'advisors', label: 'Personal care home and ALF consulting', url: 'https://caremetricadvisors.com/senior-living' },
  { id: 'advisors-acquisitions', product: 'advisors', label: 'Acquisition advisory and due diligence', url: 'https://caremetricadvisors.com/acquisitions' },
  { id: 'advisors-resources', product: 'advisors', label: 'Checklists and guides for healthcare leaders', url: 'https://caremetricadvisors.com/resources' },
  { id: 'advisors-survey-checklist', product: 'advisors', label: 'Survey and compliance readiness checklist', url: 'https://caremetricadvisors.com/resources/survey-readiness' },
  { id: 'advisors-acquisition-checklist', product: 'advisors', label: 'Pre-acquisition readiness checklist', url: 'https://caremetricadvisors.com/resources/acquisition-readiness' },
  { id: 'advisors-contact', product: 'advisors', label: 'Request a consultation', url: 'https://caremetricadvisors.com/contact' },
]);
/**
 * Intel's website serves the help center's CareMetric Intel articles itself, at `${intelArticleOrigin}/resources/<content key>`,
 * from the Hub's public feed (GET /api/public/articles?product=caremetric-intel, server/public-articles.mjs). That address is an
 * Intel article's canonical one: the help center still shows the article, points its canonical link there and leaves it out of
 * its own sitemap, so the search credit goes to the site that sells Intel.
 */
export const intelArticleOrigin = 'https://www.caremetricintel.com';
export const intelArticleUrl = slug => `${intelArticleOrigin}/resources/${slug}`;
/** The product whose own website serves its articles, by product slug, and the address it serves one at. */
const articleHomes = Object.freeze({ [products.intel.slug]: intelArticleUrl });
/** True when the product's articles live on its own website (only CareMetric Intel's do). */
export const servedElsewhere = productSlug => Object.hasOwn(articleHomes, productSlug);
/** The canonical address of the product's article: on the product's own website when it serves it, else in the help center. */
export const articleHomeUrl = (productSlug, slug) => (servedElsewhere(productSlug) ? articleHomes[productSlug](slug) : articleUrl(slug));

export const productPageIds = Object.freeze(productPages.map(page => page.id));
export const productPage = id => productPages.find(page => page.id === id) ?? null;

/**
 * The official sources an article may cite, by id. Every address was opened and checked on 2026-11-03 (the Pennsylvania Code
 * section pages use the same form as the citations on cmcarebase.com). A topic names the ones that support it.
 */
const paCode = (chapter, section) => `https://www.pacodeandbulletin.gov/secure/pacode/data/055/chapter${chapter}/s${chapter}.${section}.html`;
export const officialSources = deepFreeze({
  'pacode-2600': { label: '55 Pa. Code Chapter 2600 (personal care homes)', url: 'https://www.pacodeandbulletin.gov/Display/pacode?file=/secure/pacode/data/055/chapter2600/chap2600toc.html' },
  'pacode-2800': { label: '55 Pa. Code Chapter 2800 (assisted living facilities)', url: 'https://www.pacodeandbulletin.gov/Display/pacode?file=/secure/pacode/data/055/chapter2800/chap2800toc.html' },
  'pacode-2600-11': { label: '55 Pa. Code § 2600.11, licensure of personal care homes', url: paCode(2600, 11) },
  'pacode-2800-11': { label: '55 Pa. Code § 2800.11, licensure of assisted living facilities', url: paCode(2800, 11) },
  'pacode-20-31': { label: '55 Pa. Code § 20.31, annual inspection', url: paCode(20, 31) },
  'pacode-20-33': { label: '55 Pa. Code § 20.33, other inspections', url: paCode(20, 33) },
  'pacode-20-34': { label: '55 Pa. Code § 20.34, access during inspections', url: paCode(20, 34) },
  'pacode-20-52': { label: '55 Pa. Code § 20.52, plan of correction', url: paCode(20, 52) },
  'pacode-2600-16': { label: '55 Pa. Code § 2600.16, reportable incidents and conditions', url: paCode(2600, 16) },
  'pacode-2800-16': { label: '55 Pa. Code § 2800.16, reportable incidents and conditions', url: paCode(2800, 16) },
  'pacode-2600-41': { label: '55 Pa. Code § 2600.41, notification of rights and complaint procedures', url: paCode(2600, 41) },
  'pacode-2800-41': { label: '55 Pa. Code § 2800.41, notification of rights and complaint procedures', url: paCode(2800, 41) },
  'pacode-2600-42': { label: '55 Pa. Code § 2600.42, specific rights', url: paCode(2600, 42) },
  'pacode-2800-42': { label: '55 Pa. Code § 2800.42, specific rights', url: paCode(2800, 42) },
  'pacode-2600-65': { label: '55 Pa. Code § 2600.65, direct care staff training and orientation', url: paCode(2600, 65) },
  'pacode-2800-65': { label: '55 Pa. Code § 2800.65, staff orientation and direct care staff training', url: paCode(2800, 65) },
  'pacode-2800-69': { label: '55 Pa. Code § 2800.69, additional dementia-specific training', url: paCode(2800, 69) },
  'pacode-2600-107': { label: '55 Pa. Code § 2600.107, emergency preparedness', url: paCode(2600, 107) },
  'pacode-2800-107': { label: '55 Pa. Code § 2800.107, emergency preparedness', url: paCode(2800, 107) },
  'pacode-2600-132': { label: '55 Pa. Code § 2600.132, fire drills', url: paCode(2600, 132) },
  'pacode-2800-132': { label: '55 Pa. Code § 2800.132, fire drills', url: paCode(2800, 132) },
  'pacode-2600-190': { label: '55 Pa. Code § 2600.190, medication administration training', url: paCode(2600, 190) },
  'pacode-2800-190': { label: '55 Pa. Code § 2800.190, medication administration training', url: paCode(2800, 190) },
  'dhs-pch-reports': { label: 'Pennsylvania DHS personal care home reports', url: 'https://www.pa.gov/agencies/dhs/resources/for-providers/ltc-providers/personal-care-home-reports' },
  'cms-data': { label: 'CMS data catalog (data.cms.gov)', url: 'https://data.cms.gov/' },
  'cms-home-health': { label: 'CMS provider data: home health services', url: 'https://data.cms.gov/provider-data/topics/home-health-services' },
  'cms-hospice': { label: 'CMS provider data: hospice care', url: 'https://data.cms.gov/provider-data/topics/hospice-care' },
  'census-acs': { label: 'U.S. Census Bureau American Community Survey', url: 'https://www.census.gov/programs-surveys/acs' },
});

/**
 * Hosts a citation or a link in an article may point to: the state's official sources the owner named (pa.gov and its
 * subdomains such as dhs.pa.gov, pacodeandbulletin.gov, palegis.us), the federal data sources Intel itself reads (cms.gov,
 * census.gov; confirmed 2026-11-08), and the company's own sites. A subdomain of a listed host counts; nothing else does.
 */
export const citationHosts = Object.freeze([
  'pa.gov', 'pacodeandbulletin.gov', 'palegis.us', 'cms.gov', 'census.gov',
  'cmcarebase.com', 'caremetricintel.com', 'caremetricadvisors.com', 'help.caremetric.ai',
]);

/** True when `host` is a listed host or a subdomain of one. */
export const allowedHost = host => {
  const value = String(host ?? '').toLowerCase();
  return citationHosts.some(allowed => value === allowed || value.endsWith(`.${allowed}`));
};

/**
 * CareMetric's founder, and why Intel exists, in the owner's own words (owner direction 2026-11-12: make cold outreach warmer with the
 * owner's name and story). Prospect outreach is written in the founder's first person and signed `signOff` (growth/worker.mjs). The story
 * carries no result, no agency or company name and no number, and nothing may be added to it. The owner confirmed the wording on
 * 2026-11-12: the founder built Intel and currently runs the agency and the consulting company.
 */
export const founder = deepFreeze({
  name: 'Dr. Kevin C. Deyarmin',
  credentials: 'ND, MSW, CHPCA, NCG',
  signOff: ['Dr. Kevin C. Deyarmin', 'Founder, CareMetric'],
  story: [
    'I run a home health and hospice agency and a healthcare consulting company.',
    'I needed a way to do business intelligence research on my competitors and to find every potential referral source in my market.',
    'So I built CareMetric Intel. It was custom built by someone who uses it every day, and I still do.',
  ],
  storyAbout: 'CareMetric Intel was custom built by someone who uses it every day: its founder, who runs a home health and hospice agency and a healthcare consulting company, and needed a way to research competitors and find every potential referral source in the market.',
  rules: 'Tell the story only as written: the founder\'s own agency, competitor research and finding referral sources, built for that need and used every day. Add nothing to it: no results from the founder\'s agency (referrals, admissions, census, revenue or growth), no agency or company name, no number, no years and no superlative. It is about Intel, so tell it only in text about Intel.',
});

/** The fixed line every article about a regulation ends with. */
export const legalDisclaimer = 'This article is general information about Pennsylvania regulations, not legal advice. Read the current regulation and check with your regional licensing office or an attorney before you rely on it.';

/** What may be said, and what may not. Shown to the model; the code enforces the second list (validate.mjs). */
export const claims = deepFreeze({
  may: [
    'What each product does and who it is for, in the words above.',
    'The prices, plans, trials and offers above, exactly as written, with the product they belong to.',
    'That CareBase is built for Pennsylvania personal care homes and Assisted Living Facilities and keeps staff training, resident records, daily tasks and survey documentation in one place.',
    'That a product can help a team stay organized, see what needs attention and keep records ready for a surveyor.',
    'What a regulation says, only from the regulation facts given with the topic, with the section cited.',
  ],
  mayNot: [
    'Any price, discount, percentage, count of customers, time saved or other number about CareMetric that is not on this sheet.',
    'A guarantee or promise of any outcome: passing a survey or inspection, avoiding citations, fines or deficiencies, more referrals, more revenue or a return on investment.',
    'A legal or compliance assurance: that a product "ensures compliance", keeps a facility compliant, makes it survey-proof or is approved, endorsed or certified by the Department of Human Services, the state or anyone else.',
    'Security or privacy certifications (SOC 2, HIPAA certified or compliant) or uptime figures. The CareBase security page states its own; AI-written content does not repeat them.',
    'AI that talks on the phone, answers calls or uses voice. CareMetric\'s AI is text only.',
    'A phone call, sales call or demo booking as a required step. CareBase and Intel are evaluated with a free trial online.',
    'Named competitors or comparisons with them.',
    'Anything about a real resident, patient, employee or facility, or any personal or health information.',
    'Customer results, testimonials or case studies (none are approved yet).',
    'That public data confirms a referral: Medicare and Census figures are research signals; referrals are what the organization records.',
  ],
});

/** Words that are fixed across every customer-facing text. `rewrite` pairs are applied by validate.mjs where they are unambiguous. */
export const vocabulary = deepFreeze({
  rules: [
    'Write "Assisted Living Facility" or "ALF", never "Assisted Living Residence" or "ALR", even though Chapter 2800 itself says "assisted living residence".',
    'Call the Department of Human Services inspectors "surveyors" and their visit a survey or an inspection, never "auditors" or an audit.',
    'In anything about CareBase, never use the words "prove", "proof" or "evidence": talk about survey readiness, documentation and records.',
    'Name the products CareMetric CareBase (or CareBase), CareMetric Intel (or Intel) and CareMetric Healthcare Advisors.',
  ],
});

/**
 * How every word the AI team writes must read (owner direction 2026-11-12: some ad copy was hard to understand or did not make sense).
 * Shown first on the fact sheet, so every writer reads it; the Creative Director's and the Social Media Manager's checks refuse the
 * worst of it in code (creative/compliance.mjs and social/content.mjs, `unclearCopy`).
 */
export const writing = deepFreeze([
  'Plain, everyday words that a busy owner or administrator understands on the first read, with no other context. Write the way you would say it out loud to them.',
  'Say something concrete: who it is for, what they can do, see or stop doing. "Plan the week\'s visits around the accounts that need them" beats "Unlock smarter outreach".',
  'Complete, short sentences, one idea each. No strings of one-word fragments ("Territory. Clarity. Growth."), no stacked nouns ("referral intelligence workflow platform") and no clever wordplay or puns that need explaining.',
  'No buzzwords or empty words: unlock, empower, leverage, synergy, seamless, robust, revolutionize, supercharge, game-changer, next-level, cutting-edge, elevate, transform, solution, journey.',
  'A headline must make sense on its own, and every line must make sense to someone who has never heard of CareMetric.',
  'Before you answer, reread each line as that reader would. If it could confuse them, or it would sound odd said out loud, rewrite it in plainer words.',
]);

const sheetLines = () => Object.values(products).flatMap(product => [...product.pricing, ...product.offers]);
const amountsIn = lines => [...new Set(lines.flatMap(line => line.match(/\$\d{1,3}(?:,\d{3})*(?:\.\d+)?(?!\d)/g) ?? []))].sort();
const percentsIn = lines => [...new Set(lines.flatMap(line => line.match(/\d+(?:\.\d+)?%/g) ?? []))].sort();

/**
 * Every dollar amount on the sheet, decimals included, as "$1,990"; an article may state these and no other (compared as numbers).
 * A live binding: it follows Intel's catalog once the Hub has read it (useAppCatalogFacts).
 */
export let allowedAmounts = Object.freeze(amountsIn(sheetLines()));

/** Every percentage on the sheet (a live binding, like allowedAmounts). */
export let allowedPercents = Object.freeze(percentsIn(sheetLines()));

/** Counts the changes of the facts, so a checker that derives something from the sheet knows to derive it again. */
export let factsRevision = 0;

const refreshAllowed = () => {
  allowedAmounts = Object.freeze(amountsIn(sheetLines()));
  allowedPercents = Object.freeze(percentsIn(sheetLines()));
  factsRevision++;
};

/**
 * The facts an application publishes with its prices (server/app-catalog-sync.mjs) become what the AI team
 * quotes and what drafts are checked against. Only Intel publishes them. Returns the amounts the reviewed copy
 * (docs/GTM_FACTS.md) does not state yet, which the sync flags for that document's update.
 */
export function useAppCatalogFacts(app, catalog) {
  if (app !== products.intel.slug) return [];
  const facts = intelFactsFromCatalog(catalog);
  if (!facts.pricing.length || !facts.trialDays) return [];
  if (intelLiveVersion !== catalog.version || JSON.stringify(facts) !== JSON.stringify(intelLive)) {
    intelLive = deepFreeze(facts);
    intelLiveVersion = catalog.version;
    refreshAllowed();
  }
  const reviewed = new Set(amountsIn([...intelReviewedFacts.pricing, ...intelReviewedFacts.offers]));
  return amountsIn([...facts.pricing, ...facts.offers]).filter(amount => !reviewed.has(amount));
}

/** Back to the reviewed copy (tests). */
export function resetAppCatalogFacts() {
  intelLive = null;
  intelLiveVersion = null;
  refreshAllowed();
}

/** The fact sheet as the model reads it. A constant: it is cached with the system prompt and never carries anything per request. */
export function factSheetText() {
  const version = intelLiveVersion ? `${factsVersion}, Intel catalog ${intelLiveVersion}` : factsVersion;
  const lines = [`CareMetric fact sheet (version ${version}). These are the only facts about CareMetric you may state.`];
  lines.push('', 'How everything must read:', ...writing.map(line => `- ${line}`));
  lines.push('', `CareMetric's founder: ${founder.name} (${founder.credentials}).`,
    'The founder\'s story, in the founder\'s own words (when you write as the founder, tell it in the first person like this):',
    ...founder.story.map(line => `- ${line}`), `Told about the founder (an ad, a post or an article): ${founder.storyAbout}`, `Rules for the story: ${founder.rules}`);
  for (const product of Object.values(products)) {
    lines.push('', `${product.name} (${product.site})`, `Who it is for: ${product.forWhom}`, `What it does: ${product.does}`);
    if (product.bigPicture) lines.push(`The bigger picture: ${product.bigPicture}`);
    if (product.whyChoose?.length) lines.push('Top reasons a company would choose it:', ...product.whyChoose.map(line => `- ${line}`));
    if (product.capabilities?.length) lines.push('Everything it does, by area (from its own published features page; a plan in brackets is needed for that part):', ...product.capabilities.map(line => `- ${line}`));
    if (product.whoUses?.length) lines.push('Who uses it, and for what:', ...product.whoUses.map(line => `- ${line}`));
    if (product.present) lines.push(`How to present it: ${product.present}`);
    if (product.trialDays) lines.push(`Free trial: ${product.trialDays} days.`);
    lines.push('Pricing:', ...product.pricing.map(line => `- ${line}`), 'Offers:', ...product.offers.map(line => `- ${line}`));
  }
  lines.push('', 'You may say:', ...claims.may.map(line => `- ${line}`));
  lines.push('', 'You may never say:', ...claims.mayNot.map(line => `- ${line}`));
  lines.push('', 'Vocabulary:', ...vocabulary.rules.map(line => `- ${line}`));
  lines.push('', 'Pages you may link to (use the id in internalLinks):', ...productPages.map(page => `- ${page.id}: ${page.label} (${page.url})`));
  return lines.join('\n');
}
