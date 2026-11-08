/**
 * The machine-readable copy of docs/GTM_FACTS.md: the only facts about CareMetric's products the Content Marketer may state,
 * the pages it may link to, the official sources it may cite and the vocabulary it must use. The model is shown this file's
 * fact sheet (`factSheetText`) and the code checks every draft against the same values (validate.mjs), so a price that is not
 * here cannot reach a public article or an outreach draft.
 *
 * Every value was read from the live code of the product it describes (the source is named beside it). A change to a price
 * or a trial is made in the product first, then here and in docs/GTM_FACTS.md; facts.test.mjs keeps the two copies together.
 * Base product claims remain "owner to confirm". The owner requested the Founders Sale on 2026-11-08;
 * its coupon, duration and product scope were verified in the live CareMetric billing account.
 */

export const factsVersion = '2026-11-08';

/** Where public help articles live. The canonical address of an article is `${helpCenterOrigin}/help/articles/<slug>`. */
export const helpCenterOrigin = 'https://help.caremetric.ai';
export const articleUrl = slug => `${helpCenterOrigin}/help/articles/${slug}`;

const deepFreeze = value => {
  if (value && typeof value === 'object') for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};

// Redeemed through assisted billing activation, not an automatic checkout promotion. Keep the complete terms together.
const foundersSaleTerms = 'Founders Sale: 50% off eligible subscription charges for the first 12 months of paid service on new paid product subscriptions, including existing free-trial users. Ask CareMetric for FOUNDERS50 when activating a paid plan; CareMetric applies the discount after the trial, when paid service starts. Monthly billing receives 50% off the regular monthly rate; annual billing receives 50% off the published annual price paid upfront. Standard pricing resumes after the introductory year. Setup fees, Intel extra seats/branches/states, taxes, legacy plans and custom contracts are excluded. Other promotional discounts cannot be combined. One introductory year per organization and product; plan eligibility and capacity limits still apply. No enrollment deadline or cap has been set. Source: live Stripe offer verified 2026-11-08; docs/PRICING_RESEARCH_AND_FOUNDERS_SALE.md.';

/** The three things CareMetric sells. `slug` is the Hub's product slug, which is where an article about the product is published. */
export const products = deepFreeze({
  carebase: {
    slug: 'carebase', name: 'CareMetric CareBase', site: 'https://cmcarebase.com',
    source: 'kdeyarmin/PennTrain@b9da4e1 artifacts/caremetric-carebase/src/components/marketing/marketingPricing.ts',
    forWhom: 'Pennsylvania personal care homes (55 Pa. Code Chapter 2600) and Assisted Living Facilities (55 Pa. Code Chapter 2800), single or multi-site.',
    does: 'Staff training, resident records, daily tasks and survey documentation in one place, with optional eMAR, workforce, survey and compliance, and resident billing modules. Its AI copilot is text only.',
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
    source: 'kdeyarmin/intel@4a19909 server/lib/planLimits.ts, server/lib/orgs.ts, docs/marketing-copy.md, docs/competitive-marketing-review.md',
    forWhom: 'Home health agencies, hospice agencies, hospitals, nursing homes and personal care homes that want more targeted marketing.',
    does: 'Targeted marketing, marketing analysis and territory analysis from public healthcare and demographic data, plus a marketing CRM that keeps outreach, follow-up and the referrals the organization records in one place.',
    trialDays: 14,
    pricing: [
      'Starter: $349 per month, or $290 per month billed annually ($3,480 per year). 3 marketer seats and 1 manager seat, 1 branch, one home health or hospice CRM line, up to 10 counties, extra seats $59 per month, no onboarding fee.',
      'Growth: $899 per month, or $749 per month billed annually ($8,988 per year). 10 seats, up to 3 branches, both CRM lines, 1 full state, campaigns and manager tools, EMR CSV imports and AI briefs, extra seats $49 per month, onboarding $500 (waived with annual billing).',
      'Pro: $1,999 per month, or $1,665 per month billed annually ($19,980 per year). 25 seats, up to 10 branches, up to 3 states, forecasting and territory tools, white-label reports, extra seats $39 per month, onboarding $1,500.',
      'Enterprise: a custom annual agreement starting at about $3,500 per month.',
      'Extra branches are $99 per month each and extra states $199 per month each. Annual billing saves about 17%.',
    ],
    offers: [
      'A 14-day free trial with no credit card, covering one county with 3 marketer seats and 1 manager seat, then request paid plan activation from CareMetric.',
      foundersSaleTerms,
      'Eligible Intel products: Starter, Growth and Pro. Intel Starter is $174.50 per organization per month during the introductory year, or $1,740 for the first annual payment, then the regular rate. Existing onboarding fees and the Growth annual onboarding waiver remain unchanged.',
    ],
  },
  advisors: {
    slug: 'advisors', name: 'CareMetric Healthcare Advisors', site: 'https://caremetricadvisors.com',
    source: 'kdeyarmin/advisors@fe46d1d site-content.mjs',
    forWhom: 'Owners, operators, leadership teams and investors in home health, hospice, skilled nursing, personal care homes and assisted living.',
    does: 'Consulting on strategy and operations, clinical quality and compliance, financial performance and reimbursement, acquisition advisory and due diligence, education and leadership, technology and workflow, and personal care home and ALF operations. Led by founder and principal advisor Dr. Kevin C. Deyarmin.',
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
 * census.gov; owner to confirm), and the company's own sites. A subdomain of a listed host counts; nothing else does.
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
    'In anything about CareBase, never use the words "prove" or "proof": talk about survey readiness, documentation and records.',
    'Name the products CareMetric CareBase (or CareBase), CareMetric Intel (or Intel) and CareMetric Healthcare Advisors.',
  ],
});

/** Every dollar amount on the sheet, decimals included, as "$1,990"; an article may state these and no other (compared as numbers). */
export const allowedAmounts = Object.freeze([...new Set(Object.values(products).flatMap(product => [...product.pricing, ...product.offers])
  .flatMap(line => line.match(/\$\d{1,3}(?:,\d{3})*(?:\.\d+)?(?!\d)/g) ?? []))].sort());

/** Every percentage on the sheet. */
export const allowedPercents = Object.freeze([...new Set(Object.values(products).flatMap(product => [...product.pricing, ...product.offers])
  .flatMap(line => (line.match(/\d+(?:\.\d+)?%/g) ?? [])))].sort());

/** The fact sheet as the model reads it. A constant: it is cached with the system prompt and never carries anything per request. */
export function factSheetText() {
  const lines = [`CareMetric fact sheet (version ${factsVersion}). These are the only facts about CareMetric you may state.`];
  for (const product of Object.values(products)) {
    lines.push('', `${product.name} (${product.site})`, `Who it is for: ${product.forWhom}`, `What it does: ${product.does}`);
    if (product.trialDays) lines.push(`Free trial: ${product.trialDays} days.`);
    lines.push('Pricing:', ...product.pricing.map(line => `- ${line}`), 'Offers:', ...product.offers.map(line => `- ${line}`));
  }
  lines.push('', 'You may say:', ...claims.may.map(line => `- ${line}`));
  lines.push('', 'You may never say:', ...claims.mayNot.map(line => `- ${line}`));
  lines.push('', 'Vocabulary:', ...vocabulary.rules.map(line => `- ${line}`));
  lines.push('', 'Pages you may link to (use the id in internalLinks):', ...productPages.map(page => `- ${page.id}: ${page.label} (${page.url})`));
  return lines.join('\n');
}
