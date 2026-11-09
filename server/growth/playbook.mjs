/**
 * The sales and customer-success playbook: the skills the revenue agents share. The Marketing Manager uses it to find, judge and
 * write to prospects; the Sales Executive uses it to answer prospects and move them to a trial and a paid plan; the Account
 * Manager uses it to onboard customers and keep them.
 *
 * It holds method, not new facts. Every price, trial, offer and claim a message may state comes from the fact sheet
 * (../agents/content/facts.mjs, the machine copy of docs/GTM_FACTS.md), and the code checks drafts against that sheet. Pains and
 * buying triggers here are hypotheses to ask about, never statements about a particular prospect. Changing anything a model reads
 * here means changing `playbookVersion`.
 */
import { products as facts, productPages } from '../agents/content/facts.mjs';

export const playbookVersion = 'sales-playbook.3';

/**
 * How CareMetric sells (owner decision 2026-11-08): entirely self-serve. Nobody offers a demo, a sales call or a meeting. A prospect gets
 * whatever they need to decide on their own: the walkthrough pages, the guides and manuals in the help center, the free trial, and
 * written answers to every question.
 */
export const sellingPrinciple = 'Selling is self-serve. Never offer or suggest a demo, a sales call or a meeting. Give the prospect what they need to decide on their own: the product\'s walkthrough pages, the most relevant guide or manual, the free trial to try it with their own team, and a written answer to every question.';

const deepFreeze = value => {
  if (value && typeof value === 'object') for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};

// Pennsylvania places, for CareBase discovery (CareBase is built for Pennsylvania Chapter 2600 and 2800 homes only).
const pennsylvania = [
  'Pittsburgh PA', 'Philadelphia PA', 'Harrisburg PA', 'Allentown PA', 'Erie PA', 'Lancaster PA', 'Scranton PA', 'Reading PA', 'York PA',
  'State College PA', 'Altoona PA', 'Johnstown PA', 'Wilkes-Barre PA', 'Williamsport PA', 'Chambersburg PA', 'Greensburg PA', 'Butler PA',
  'Washington PA', 'Bucks County PA', 'Montgomery County PA', 'Chester County PA', 'Delaware County PA', 'Westmoreland County PA',
  'Lehigh Valley PA', 'Cumberland County PA', 'Berks County PA', 'Luzerne County PA', 'Lackawanna County PA', 'Beaver County PA',
  'Centre County PA', 'Lebanon PA', 'Hazleton PA', 'Pottsville PA', 'New Castle PA', 'Indiana PA', 'Somerset PA',
];
// Markets for Intel discovery: Pennsylvania and its neighbours first, then large home health and hospice markets.
const intelMarkets = [
  'Pittsburgh', 'Philadelphia', 'Harrisburg Pennsylvania', 'Allentown Pennsylvania', 'Cleveland Ohio', 'Columbus Ohio', 'Cincinnati Ohio',
  'Baltimore Maryland', 'Newark New Jersey', 'Buffalo New York', 'Richmond Virginia', 'Wilmington Delaware', 'Charlotte North Carolina',
  'Raleigh North Carolina', 'Nashville Tennessee', 'Atlanta Georgia', 'Tampa Florida', 'Orlando Florida', 'Jacksonville Florida',
  'Detroit Michigan', 'Indianapolis Indiana', 'Louisville Kentucky', 'St. Louis Missouri', 'Dallas Texas', 'Houston Texas',
  'San Antonio Texas', 'Phoenix Arizona', 'Birmingham Alabama', 'Oklahoma City Oklahoma', 'Kansas City Missouri',
];

const pageUrl = id => productPages.find(page => page.id === id)?.url ?? null;

/**
 * Per product: who to look for and who to leave alone, the people involved, what they may be struggling with (to ask about),
 * what may make them look now, what we may say, the next step, the questions that qualify, and how to meet common objections.
 */
export const salesPlaybook = deepFreeze({
  carebase: {
    product: 'carebase', factsKey: 'carebase', name: facts.carebase.name, shortName: 'CareBase',
    territory: 'Pennsylvania only: licensed personal care homes (55 Pa. Code Chapter 2600) and Assisted Living Facilities (Chapter 2800).',
    icp: {
      fits: [
        'A licensed Pennsylvania personal care home (55 Pa. Code Chapter 2600).',
        'A licensed Pennsylvania Assisted Living Facility (55 Pa. Code Chapter 2800).',
        'A single-site operator or a multi-site group with Pennsylvania homes.',
      ],
      strongSignals: [
        'Its own website shows it operates the home or homes (not a listing about it).',
        'It mentions staff training, orientation, annual training hours, medication administration training, or survey readiness.',
        'It is hiring direct care staff, opening, expanding, or has recently changed ownership or administrator.',
        'It runs records on paper, binders, spreadsheets or a training-only system.',
      ],
      disqualifiers: [
        'Not located in Pennsylvania.',
        'Not a personal care home or Assisted Living Facility (for example a skilled nursing facility only, a home health agency, a hospital, a pharmacy or a software vendor).',
        'A directory, listing or referral site, an association, a news article, a government page or a job board, rather than the operator itself.',
        'An existing CareMetric customer or an internal organization.',
      ],
    },
    personas: [
      { role: 'Owner or executive director', cares: 'Survey readiness across every home, staff turnover, time lost to paperwork and a predictable cost per facility.' },
      { role: 'Administrator', cares: 'Staff training kept current, resident records and daily tasks organized, and records ready when a surveyor arrives.' },
      { role: 'Training or compliance lead', cares: 'Assigning required annual training, seeing who is overdue and keeping completion records in one place.' },
    ],
    pains: [
      'Tracking each staff member\'s annual training hours and orientation across binders or spreadsheets.',
      'Pulling records together when a surveyor arrives, or after a plan of correction.',
      'New hires who need orientation and training quickly because of turnover.',
      'Resident records, daily tasks and medication records kept in different places.',
    ],
    triggers: ['An upcoming or recent DHS inspection', 'A plan of correction', 'Hiring or turnover of direct care staff', 'A new administrator', 'Opening or acquiring a home', 'A renewal of a current software contract'],
    valuePoints: [
      'One place for staff training, resident records, daily tasks and survey documentation, built for Pennsylvania personal care homes and Assisted Living Facilities.',
      'Priced per facility with unlimited residents and staff; nobody is counted per person.',
      'Optional eMAR, Workforce, Survey & Compliance and Resident Billing & Payments modules, or training only with CareMetric Train.',
      'Helps a team stay organized, see what needs attention and keep records ready for a surveyor.',
      'A 30-day free trial started online.',
    ],
    nextStep: { label: 'Start a CareBase free trial', url: pageUrl('carebase-signup') },
    pages: ['carebase-signup', 'carebase-pricing', 'carebase-features', 'carebase-how-it-works', 'carebase-training-requirements', 'carebase-survey-guide', 'carebase-faq', 'carebase-about', 'carebase-home'],
    qualifyingQuestions: [
      'How many Pennsylvania homes do you operate, and are they personal care homes, Assisted Living Facilities or both?',
      'How do you track staff training and annual hours today?',
      'Is a DHS inspection or a plan of correction coming up?',
      'Who else would weigh in on choosing a system?',
      'Would you start with training only, or with records and daily tasks as well?',
    ],
    objections: [
      { key: 'price', when: 'Cost or budget.', answer: 'Pricing is per facility with unlimited residents and staff. Quote only the fact sheet: Core, Small Home for fewer than 20 licensed beds, Train for training only, and the Founders Sale (50% off eligible subscription charges for the first 12 months of paid service, after the free trial). Never invent a discount.' },
      { key: 'timing', when: 'Not now, too busy, after the holidays or after an inspection.', answer: 'Acknowledge it, note that the free trial can start whenever suits them, and ask when to check back. Record a dated follow-up instead of pushing.' },
      { key: 'current_system', when: 'They already use another system or a training-only tool.', answer: 'Ask what it leaves out or makes hard (training, records, daily tasks, survey documentation). Never name or criticize another product.' },
      { key: 'switching', when: 'Switching is hard, or staff will not adopt it.', answer: 'Suggest starting with one workflow, such as staff training, during the free trial, and offer help setting up facilities and the staff roster.' },
      { key: 'authority', when: 'They must ask an owner, a partner or a corporate office.', answer: 'Offer a short summary they can forward (who it is for, what it does, the price for their homes, the trial) and ask who else should see it.' },
      { key: 'security', when: 'Security, privacy or HIPAA questions.', answer: 'Do not state certifications. Say the owner will answer security questions personally and set needsOwner.' },
      { key: 'demo', when: 'They ask for a demo, a call or a meeting.', answer: 'CareMetric does not do live demos or sales calls. Offer the written walkthrough instead: the how-it-works page or the guide that shows what they want to see, the 30-day free trial to try it with their own staff and records, and answers to any question by email.' },
      { key: 'fit', when: 'They are not a Pennsylvania personal care home or ALF.', answer: 'Be honest that CareBase is built for Pennsylvania Chapter 2600 and 2800 homes. If they are a home health, hospice or other agency that markets to referral sources, CareMetric Intel may fit instead.' },
    ],
  },
  'caremetric-intel': {
    product: 'caremetric-intel', factsKey: 'intel', name: facts.intel.name, shortName: 'Intel',
    territory: 'United States: home health and hospice agencies first; also hospitals, nursing homes and personal care homes that market to referral sources.',
    icp: {
      fits: [
        'A home health agency or a hospice agency with a marketing, business development or community liaison role.',
        'A hospital, nursing home or personal care home that does targeted marketing to referral sources.',
        'An organization with one or more branches that plans territories by county.',
      ],
      strongSignals: [
        'Its own website shows it is a home health or hospice provider (a Medicare-certified agency, service areas or branches).',
        'It is hiring marketers, community liaisons or business development staff.',
        'It is opening a branch, entering a new county or expanding service lines.',
        'It mentions referral partners such as physicians, hospitals or facilities.',
      ],
      disqualifiers: [
        'A directory, listing or referral site, an association, a news article, a government page or a job board, rather than the provider itself.',
        'A software vendor, a staffing agency, a franchise sales page or a consultant rather than a care provider.',
        'An existing CareMetric customer or an internal organization.',
      ],
    },
    personas: [
      { role: 'Owner or administrator', cares: 'Census growth, where to focus a small marketing team, and spend that can be measured.' },
      { role: 'Director of business development or marketing', cares: 'Territory plans, which referral sources to visit, follow-up discipline and recorded referrals.' },
      { role: 'Marketer or community liaison', cares: 'A focused visit list, notes and follow-ups in one place, and less time building lists by hand.' },
    ],
    pains: [
      'Deciding which counties and referral sources deserve a small team\'s time.',
      'Outreach, follow-up and recorded referrals kept in spreadsheets or several tools.',
      'Little visibility for a manager into what marketers did and what came of it.',
      'Building target lists by hand from public data.',
    ],
    triggers: ['Hiring a marketer or liaison', 'Opening a branch or entering a county', 'A census goal or a slow quarter', 'A new director of business development', 'Annual planning'],
    valuePoints: [
      'Targeted marketing, marketing analysis and territory analysis from public healthcare and demographic data.',
      'A marketing CRM that keeps outreach, follow-up and the referrals the organization records in one place.',
      'Plans from Starter (3 marketer seats + 1 manager) to Pro, with annual billing saving about 17%.',
      'A 14-day free trial with no credit card.',
    ],
    nextStep: { label: 'Start a CareMetric Intel free trial', url: pageUrl('intel-home') },
    pages: ['intel-home', 'intel-pricing', 'intel-walkthrough', 'intel-county-report', 'intel-resources', 'intel-targeted-marketing', 'intel-territory-analysis', 'intel-referral-measurement', 'intel-manager-playbook'],
    qualifyingQuestions: [
      'Which counties or service areas does your team cover today?',
      'How many marketers or liaisons do you have, and how do they track visits and follow-ups?',
      'Home health, hospice or both?',
      'How do you measure which outreach leads to referrals?',
      'Who else would weigh in on choosing a tool?',
    ],
    objections: [
      { key: 'price', when: 'Cost or budget.', answer: 'Quote only the fact sheet: Starter, Growth and Pro with seats and counties, annual billing saving about 17%, and the Founders Sale (50% off eligible subscription charges for the first 12 months of paid service). Never promise more referrals or revenue.' },
      { key: 'timing', when: 'Not now or busy.', answer: 'Acknowledge it, mention the 14-day free trial needs no credit card, and ask when to check back. Record a dated follow-up.' },
      { key: 'current_system', when: 'They already use a CRM, a spreadsheet or another data tool.', answer: 'Ask what it leaves out (territory analysis, focused lists, recorded referrals in one place). Never name or criticize another product.' },
      { key: 'data_trust', when: 'They ask whether the data shows real referrals.', answer: 'Be precise: public Medicare and Census figures are research signals; referrals are what the organization records in Intel.' },
      { key: 'authority', when: 'They must ask an owner or a corporate office.', answer: 'Offer a short summary they can forward and ask who else should see it.' },
      { key: 'demo', when: 'They ask for a demo, a call or a meeting.', answer: 'CareMetric does not do live demos or sales calls. Offer the written walkthrough instead: the walkthrough page (how CareMetric Intel works) or the resource or guide that shows what they want to see, the free county report for their own county, the 14-day free trial (no credit card) on one county, and answers to any question by email.' },
      { key: 'results', when: 'They ask for proof of results or case studies.', answer: 'There are no approved customer results to share. Suggest the free trial on one county so they can judge it on their own market.' },
    ],
  },
});

export const playbookProducts = Object.freeze(Object.keys(salesPlaybook));
export const playbookFor = product => salesPlaybook[product] ?? null;

/**
 * What each outreach touch is for. Every touch offers one easy next step; none repeats an earlier one.
 * Touch 1 opens on a likely problem; touch 2 brings a new angle (a useful resource or the current offer); touch 3 closes the loop.
 */
export const sequencePlan = deepFreeze([
  { touch: 1, angle: 'Open with one likely problem for this kind of organization, phrased as a question, then one sentence on how the product helps, and the free trial as the next step. No price.' },
  { touch: 2, angle: 'Bring a different angle from touch 1: one useful free resource page or one concrete capability, and the current Founders Sale terms if relevant. Do not repeat touch 1\'s opening. Ask one qualifying question.' },
  { touch: 3, angle: 'A short, polite close-the-loop note: ask whether the topic is a priority this year or whether someone else handles it. Make it easy to say "not now". No new pitch.' },
]);
export const touchAngle = touch => sequencePlan[Math.min(Math.max(Number(touch) || 1, 1), sequencePlan.length) - 1].angle;

/** How the Account Manager and the Sales Executive handle each customer-success moment. */
export const lifecyclePlays = deepFreeze({
  onboarding: 'Welcome them, ask what outcome would make the product worth keeping, and point to the guide for the single first setup step that leads to it.',
  activation: 'They have not reached first value yet. Name the one setup step that is usually missing, point to its guide, and ask what is in the way.',
  trial: 'Before the trial ends: recap the goal they named, ask what is left to decide, and explain how to activate a paid plan; the Founders Sale (its terms on the fact sheet) applies automatically when paid service starts, with no code needed. Never pressure and never invent an extension.',
  adoption: 'Use has stalled. Ask whether the workflow still fits and what is in the way, and point to the guide for one specific step.',
  renewal: 'Ahead of renewal, recap the goals they set, ask what is working and what is not, and invite open questions.',
  support: 'An open support issue comes first: acknowledge it and say the team is working with them on it. No sales or upgrade talk.',
  recovery: 'They asked to cancel. Ask what led to it and whether anything would change their mind. No pressure and no invented offers.',
  expansion: 'They mentioned an additional need. Ask about it and connect it to one relevant module or plan from the fact sheet.',
  outreach: 'Introduce the product to a prospect who has not replied yet, following the touch plan.',
});
export const lifecyclePlay = kind => lifecyclePlays[kind] ?? lifecyclePlays.outreach;

/** Who a message about `product` comes from: the product team's sign-off and the product's website. */
export function senderFor(product) {
  const book = salesPlaybook[product];
  const fact = book ? facts[book.factsKey] : null;
  if (!fact) return { team: 'The CareMetric team', site: null };
  return { team: `The ${fact.name} team`, site: { label: fact.site.replace(/^https:\/\/(?:www\.)?/, '').replace(/\/$/, ''), url: fact.site } };
}

/** The pages a message about `product` may link to (that product's own pages from the fact sheet), plus nothing else. */
export function linkablePages(product) {
  const book = salesPlaybook[product];
  if (!book) return [];
  return book.pages.map(id => productPages.find(page => page.id === id)).filter(Boolean);
}

/**
 * The search query for a product's discovery on a given day. It walks a product's segment-by-place grid one step a day, so daily
 * discovery keeps finding new organizations instead of rereading the same ten results. CareBase stays inside Pennsylvania.
 */
const discoveryGrid = deepFreeze({
  carebase: { segments: ['"personal care home"', '"assisted living facility"', '"personal care home" administrator', '"assisted living" personal care home'], places: pennsylvania },
  'caremetric-intel': { segments: ['"home health agency"', '"hospice agency"', '"home health and hospice"', 'hospice "community liaison"'], places: intelMarkets },
});
const dayNumber = instant => Math.floor(Date.parse(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(instant)) / 86_400_000);
export function discoveryQuery(product, instant = new Date()) {
  const grid = discoveryGrid[product];
  if (!grid) return null;
  const size = grid.segments.length * grid.places.length;
  const step = ((dayNumber(instant) % size) + size) % size;
  // Places change every day; the segment moves on once every place has been searched with the current one.
  return `${grid.segments[Math.floor(step / grid.places.length)]} ${grid.places[step % grid.places.length]}`;
}
export const discoveryQueryCount = product => (discoveryGrid[product] ? discoveryGrid[product].segments.length * discoveryGrid[product].places.length : 0);

/**
 * Hosts that are never an operator to sell to: directories, review and listing sites, social networks, job boards, encyclopedias and
 * government or school sites. Discovery drops them, so the contact finder never emails a directory's info@ address.
 */
const notOperators = [
  'aplaceformom.com', 'caring.com', 'seniorly.com', 'seniorliving.org', 'seniorhousingnet.com', 'senioradvisor.com', 'assistedliving.org',
  'assistedlivingfacilities.org', 'payingforseniorcare.com', 'carelistings.com', 'careforth.com', 'agingcare.com', 'medicare.gov', 'yelp.com',
  'yellowpages.com', 'facebook.com', 'linkedin.com', 'instagram.com', 'twitter.com', 'x.com', 'youtube.com', 'indeed.com', 'glassdoor.com',
  'ziprecruiter.com', 'monster.com', 'simplyhired.com', 'wikipedia.org', 'mapquest.com', 'bbb.org', 'healthgrades.com', 'usnews.com',
  'homehealthcareagencies.com', 'hospicedirectory.org', 'carecompare.com', 'nursinghomesite.com', 'zillow.com', 'reddit.com', 'quora.com',
];
export function operatorHost(host) {
  const value = String(host ?? '').toLowerCase().replace(/^www\./, '');
  if (!value || /\.(?:gov|edu|mil)$/.test(value) || /\.(?:gov|edu)\.[a-z]{2}$/.test(value) || /(?:^|\.)(?:pa\.us|state\.[a-z]{2}\.us)$/.test(value)) return false;
  return !notOperators.some(blocked => value === blocked || value.endsWith(`.${blocked}`));
}

/** The playbook as the model reads it: constant text, cached with the system prompt. */
export function playbookText(only = null) {
  const lines = [`CareMetric sales playbook (version ${playbookVersion}). Method only: every fact you state still comes from the fact sheet.`, sellingPrinciple];
  for (const book of Object.values(salesPlaybook)) {
    if (only && book.product !== only) continue;
    lines.push('', `${book.name}`, `Territory: ${book.territory}`,
      'Good fit:', ...book.icp.fits.map(line => `- ${line}`),
      'Strong signals:', ...book.icp.strongSignals.map(line => `- ${line}`),
      'Not a fit:', ...book.icp.disqualifiers.map(line => `- ${line}`),
      'People involved:', ...book.personas.map(persona => `- ${persona.role}: ${persona.cares}`),
      'Likely problems (ask, never assert):', ...book.pains.map(line => `- ${line}`),
      'Buying triggers (ask, never assert):', ...book.triggers.map(line => `- ${line}`),
      'What we may say:', ...book.valuePoints.map(line => `- ${line}`),
      `Next step: ${book.nextStep.label} (${book.nextStep.url}).`,
      'Qualifying questions (ask at most one per message):', ...book.qualifyingQuestions.map(line => `- ${line}`),
      'Objections:', ...book.objections.map(item => `- ${item.key} (${item.when}) ${item.answer}`));
  }
  lines.push('', 'Outreach touches:', ...sequencePlan.map(step => `- Touch ${step.touch}: ${step.angle}`));
  lines.push('', 'Customer moments:', ...Object.entries(lifecyclePlays).map(([kind, play]) => `- ${kind}: ${play}`));
  return lines.join('\n');
}
