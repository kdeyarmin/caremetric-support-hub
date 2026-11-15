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
import { founder, products as facts, productPages } from '../agents/content/facts.mjs';

export const playbookVersion = 'sales-playbook.4';

/**
 * How CareMetric sells (owner decision 2026-11-08): entirely self-serve. Nobody offers a demo, a sales call or a meeting. A prospect gets
 * whatever they need to decide on their own: the walkthrough pages, the guides and manuals in the help center, the free trial, and
 * written answers to every question.
 */
export const sellingPrinciple = 'Selling is self-serve. Never offer or suggest a demo, a sales call or a meeting. Give the prospect what they need to decide on their own: the product\'s walkthrough pages, the most relevant guide or manual, the free trial to try it with their own team, and a written answer to every question.';

// What reads as an offer to talk: a short or personal call, chat, meeting or demo; setting one up; being open to one; speaking or
// meeting with us; picking a time to talk. A sentence that says no ("we do not do live demos") offers nothing, and neither does one
// about the reader's own meetings ("hold a short meeting with your staff").
const offers = [
  /\b(?:short|quick|brief|personal|private|one-on-one|one-to-one|1:1|free|intro(?:ductory)?|\d{1,2}[- ]?min(?:ute)?s?)\s+(?:intro(?:ductory)?\s+)?(?:call|conversation|chat|meeting|demo|demonstration|video\s+call|zoom(?:\s+call)?|screen[- ]?share)\b(?!\s+(?:with|for)\s+(?:your|the|each|every|all)\b)/i,
  /\blive\s+(?:demo|demonstration|walk-?through|session)\b/i,
  /\b(?:set up|schedule|book|arrange|hop on|jump on|grab)\s+(?:a\s+|an\s+)?(?:quick\s+|short\s+|brief\s+)?(?:call|meeting|chat|zoom|video\s+call|demo|demonstration)\b(?!\s+(?:with|for)\s+(?:your|the|each|every|all)\b)/i,
  /\b(?:open to|available for|up for|interested in|time for)\s+(?:a\s+|an\s+)?(?:quick\s+|short\s+|brief\s+)?(?:call|conversation|chat|meeting|demo|demonstration)\b/i,
  /\b(?:speak|meet)\s+(?:with|to)\s+(?:us|me|our team|someone|a member of our team|the (?:caremetric )?team)\b/i,
  /\b(?:pick|find|choose|book)\s+a\s+time\s+(?:that\s+(?:suits|works)|to\s+(?:talk|meet|chat|connect|speak))\b/i,
  /\b(?:call|phone)\s+(?:me|us)\b/i,
];
const saysNo = /\b(?:no|not|never|without|nor)\b|n['’]t\b/i;

/**
 * Whether a message to a prospect or customer offers a demo, a call, a meeting or a conversation with CareMetric, which none may
 * do: CareMetric does no personal demos with anyone (owner decisions 2026-11-08 and 2026-11-09). Read sentence by sentence; a
 * sentence that says no, as in declining a demo, is not an offer. The drafting checks refuse a message for which this is true.
 */
export function offersMeeting(text) {
  return String(text ?? '').split(/(?<=[.?!])\s+|\n+/).some(sentence => !saysNo.test(sentence) && offers.some(pattern => pattern.test(sentence)));
}

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
// Markets for Intel discovery: Pennsylvania and its neighbours first, then home health and hospice markets across the country.
// Intel sells nationally, so the list is long: with several searches a day (discoveryQueriesPerDay) a short list repeats within
// weeks and discovery stops finding anyone new.
const intelMarkets = [
  'Pittsburgh', 'Philadelphia', 'Harrisburg Pennsylvania', 'Allentown Pennsylvania', 'Cleveland Ohio', 'Columbus Ohio', 'Cincinnati Ohio',
  'Baltimore Maryland', 'Newark New Jersey', 'Buffalo New York', 'Richmond Virginia', 'Wilmington Delaware', 'Charlotte North Carolina',
  'Raleigh North Carolina', 'Nashville Tennessee', 'Atlanta Georgia', 'Tampa Florida', 'Orlando Florida', 'Jacksonville Florida',
  'Detroit Michigan', 'Indianapolis Indiana', 'Louisville Kentucky', 'St. Louis Missouri', 'Dallas Texas', 'Houston Texas',
  'San Antonio Texas', 'Phoenix Arizona', 'Birmingham Alabama', 'Oklahoma City Oklahoma', 'Kansas City Missouri',
  'Erie Pennsylvania', 'Scranton Pennsylvania', 'Lancaster Pennsylvania', 'Akron Ohio', 'Toledo Ohio', 'Dayton Ohio', 'Youngstown Ohio',
  'Rochester New York', 'Syracuse New York', 'Albany New York', 'Trenton New Jersey', 'Morgantown West Virginia', 'Charleston West Virginia',
  'Norfolk Virginia', 'Roanoke Virginia', 'Greensboro North Carolina', 'Columbia South Carolina', 'Greenville South Carolina',
  'Charleston South Carolina', 'Savannah Georgia', 'Augusta Georgia', 'Miami Florida', 'Fort Myers Florida', 'Sarasota Florida',
  'Pensacola Florida', 'Mobile Alabama', 'Huntsville Alabama', 'Jackson Mississippi', 'Memphis Tennessee', 'Knoxville Tennessee',
  'Chattanooga Tennessee', 'Lexington Kentucky', 'Grand Rapids Michigan', 'Lansing Michigan', 'Fort Wayne Indiana', 'Chicago Illinois',
  'Springfield Illinois', 'Milwaukee Wisconsin', 'Madison Wisconsin', 'Minneapolis Minnesota', 'Des Moines Iowa', 'Omaha Nebraska',
  'Wichita Kansas', 'Tulsa Oklahoma', 'Little Rock Arkansas', 'New Orleans Louisiana', 'Baton Rouge Louisiana', 'Shreveport Louisiana',
  'Austin Texas', 'Fort Worth Texas', 'El Paso Texas', 'McAllen Texas', 'Lubbock Texas', 'Albuquerque New Mexico', 'Tucson Arizona',
  'Denver Colorado', 'Colorado Springs Colorado', 'Salt Lake City Utah', 'Las Vegas Nevada', 'Boise Idaho', 'Spokane Washington',
  'Seattle Washington', 'Portland Oregon', 'Sacramento California', 'Fresno California', 'San Diego California', 'Riverside California',
  'Los Angeles California', 'Hartford Connecticut', 'Providence Rhode Island', 'Boston Massachusetts', 'Worcester Massachusetts',
  'Manchester New Hampshire', 'Portland Maine',
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
        'A public CMS record shows it was newly certified or changed ownership in the last year: new agencies and new owners build referral sources from scratch.',
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
      'One workspace for the whole marketing job: territory research, focused referral lists, account relationships, planned visits, expenses and recorded results. Email campaigns are one part of it, never the point (fact sheet, "How to present it").',
      'Plans from Starter (3 marketer seats + 1 manager) to Pro, with annual billing saving about 17%.',
      `A ${facts.intel.trialDays}-day free trial (credit card required; canceling before it ends avoids any charge).`,
    ],
    nextStep: { label: 'Start a CareMetric Intel free trial', url: pageUrl('intel-home') },
    pages: ['intel-home', 'intel-how-it-works', 'intel-market-review', 'intel-county-report', 'intel-pricing', 'intel-resources', 'intel-targeted-marketing', 'intel-territory-analysis', 'intel-referral-measurement', 'intel-manager-playbook'],
    qualifyingQuestions: [
      'Which counties or service areas does your team cover today?',
      'How many marketers or liaisons do you have, and how do they track visits and follow-ups?',
      'Home health, hospice or both?',
      'How do you measure which outreach leads to referrals?',
      'Who else would weigh in on choosing a tool?',
    ],
    objections: [
      { key: 'price', when: 'Cost or budget.', answer: 'Quote only the fact sheet: Starter, Growth and Pro with seats and counties, annual billing saving about 17%, and the Founders Sale (50% off eligible subscription charges for the first 12 months of paid service). Never promise more referrals or revenue.' },
      { key: 'timing', when: 'Not now or busy.', answer: `Acknowledge it, mention the ${facts.intel.trialDays}-day free trial (a credit card is required, and canceling before it ends avoids any charge), and ask when to check back. Record a dated follow-up.` },
      { key: 'current_system', when: 'They already use a CRM, a spreadsheet or another data tool.', answer: 'Ask what it leaves out (territory analysis, focused lists, recorded referrals in one place). Never name or criticize another product.' },
      { key: 'data_trust', when: 'They ask whether the data shows real referrals.', answer: 'Be precise: public Medicare and Census figures are research signals; referrals are what the organization records in Intel.' },
      { key: 'authority', when: 'They must ask an owner or a corporate office.', answer: 'Offer a short summary they can forward and ask who else should see it.' },
      { key: 'demo', when: 'They ask for a demo, a call or a meeting.', answer: `CareMetric does not do live demos or sales calls. Offer the written walkthrough instead: the resource or guide that shows what they want to see, the ${facts.intel.trialDays}-day free trial on one county (credit card required; canceling before it ends avoids any charge), and answers to any question by email.` },
      { key: 'results', when: 'They ask for proof of results or case studies.', answer: 'There are no approved customer results to share. Suggest the free trial on one county so they can judge it on their own market.' },
      { key: 'integration', when: 'They ask whether Intel connects to their EHR or another system.', answer: 'Be exact: Intel imports referral and admission reports from the EHR as files (an upload, an SFTP folder or email), with saved layouts for common EHR reports. It is not a live connection. Never name an EHR vendor and never imply a live link.' },
      { key: 'security', when: 'They ask about HIPAA, a BAA, security or a contract.', answer: 'Say only that the research uses no patient-level data, that imports drop patient-identifying columns and that notes should never name a patient. Tell them the owner answers security, BAA and contract questions in writing, and hand the conversation to the owner.' },
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
  { touch: 1, angle: 'Introduce yourself: for CareMetric Intel, the founder\'s story in one or two sentences, as written on the fact sheet. Then one likely problem for this kind of organization, phrased as a question, one sentence on how the product helps, and the free trial as the next step. No price.' },
  { touch: 2, angle: 'Bring a different angle from touch 1: one useful free resource page or one concrete capability, and the current Founders Sale terms if relevant. Do not repeat touch 1\'s opening. Ask one qualifying question.' },
  { touch: 3, angle: 'A short, polite close-the-loop note: ask whether the topic is a priority this year or whether someone else handles it. Make it easy to say "not now". No new pitch.' },
]);
export const touchAngle = touch => sequencePlan[Math.min(Math.max(Number(touch) || 1, 1), sequencePlan.length) - 1].angle;

/**
 * The first email to a CareMetric Intel prospect, built around a market report (owner direction 2026-11-15): make the reader ask
 * themselves how well they know their own market, hand them a report that shows it, and invite them to the trial. `reportTouchAngle`
 * is for an agency whose own report the draft links to; `reviewTouchAngle` for one without a roster record, which gets the page where
 * any agency's report is emailed to it. Questions are for the reader to answer for themselves, never claims about them.
 */
const reportQuestions = 'Then ask two or three short questions the reader can answer for themselves, such as whether the agency is getting its share of the referrals in its county, whether its team knows every referral source in its territory (the hospitals, physicians and facilities), and how much it knows about the competitors it meets at those sources. Questions only: never claim to know the answers.';
const reportClose = `Then ask how much the agency could grow if its owner, managers and marketing team worked from the most current market intelligence, and say in one plain sentence how CareMetric Intel makes targeted marketing sharper (from the fact sheet's "Everything it does"). End with the ${facts.intel.trialDays}-day free trial as the way to see every source in their territory: say in one plain clause that a credit card is required to start the trial and that canceling before it ends means no charge, then the trial link on its own line. Never call it risk-free.`;
export const reportTouchAngle = `First email, built around the agency's own market report. Introduce yourself with the founder's story in one or two sentences. ${reportQuestions} Then say you put together a free market report for the agency from public Medicare data, showing where it stands in its county, who leads the county and the hospitals and physicians who refer the most, and ask them to review it with their managers and marketing team; the report link goes on its own line. ${reportClose} This email may hold up to three questions and two links (the report, then the trial), within one hundred seventy words.`;
export const reviewTouchAngle = `First email, built around a free market report the agency can get for itself. Introduce yourself with the founder's story in one or two sentences. ${reportQuestions} Then say that any agency can get a free market report from public Medicare data, showing where it stands in its county, who leads the county and the hospitals and physicians who refer the most, by entering its CMS certification number on the market report page, and suggest they review it with their managers and marketing team; that page's link goes on its own line. ${reportClose} This email may hold up to three questions and two links (the market report page, then the trial), within one hundred seventy words.`;

/** Follow-ups to a person who asked for something on the website (a county report, a savings model, a newsletter or a contact form). */
export const inboundSequence = deepFreeze([
  { touch: 1, angle: 'They asked for it: thank them in one sentence for requesting what "lead" names, say what one part of it usually means for an organization like theirs, and offer the free trial as the way to see the rest for their own territory. Warm and short. Do not tell the founder\'s story at length: one sentence at most.' },
  { touch: 2, angle: 'A week later: one concrete thing they could do with the product that follows from what they asked for, and one useful page from "links". Ask one simple question about what they are working on.' },
  { touch: 3, angle: 'A short, polite last note: ask whether this is a priority this year or whether someone else handles it. Make it easy to say "not now". No new pitch.' },
]);
export const inboundAngle = touch => inboundSequence[Math.min(Math.max(Number(touch) || 1, 1), inboundSequence.length) - 1].angle;
/** The one re-ask (private.growth_reengage), months after "not now" or a silent sequence, or soon after an ownership change. */
export const reaskAngle = 'One brief, friendly check-in, months after the last message. Acknowledge the time that has passed in a few words, mention one thing that is new or relevant (a change the sources show, or the free trial still being there), and ask whether now is a better time. Three or four sentences. Easy to ignore, no pressure, and never a reproach for not answering.';
/** What a message may lead with when the product policy runs experiments (draft.mjs arms): one part of the product, chosen per organization. */
export const experimentAngles = deepFreeze({
  // The last three come from the Intel marketing playbook (docs/INTEL_MARKETING_PLAYBOOK.md, owner request 2026-11-14): visit
  // preparation, the hospital outcomes packet and catching a slipping referral source. Expenses never lead (owner direction 2026-11-14).
  'caremetric-intel': ['referral_sources', 'territory', 'competitors', 'visit_prep', 'hospital_outcomes', 'slipping_sources'],
  carebase: ['staff_training', 'survey_ready', 'daily_records'],
});

/** How the Account Manager and the Sales Executive handle each customer-success moment. */
export const lifecyclePlays = deepFreeze({
  onboarding: 'Welcome them, ask what outcome would make the product worth keeping, and point to the guide for the single first setup step that leads to it.',
  activation: 'They have not reached first value yet. Name the one setup step that is usually missing, point to its guide, and ask what is in the way.',
  trial: 'Before the trial ends: recap the goal they named, ask what is left to decide, and say what happens when it ends exactly as the fact sheet states for this product (for CareMetric Intel, the plan chosen at sign-up bills automatically unless they cancel before then); the Founders Sale (its terms on the fact sheet) applies automatically when paid service starts, with no code needed. Never pressure and never invent an extension.',
  adoption: 'Use has stalled. Ask whether the workflow still fits and what is in the way, and point to the guide for one specific step.',
  renewal: 'Ahead of renewal, recap the goals they set, ask what is working and what is not, and invite open questions.',
  support: 'An open support issue comes first: acknowledge it and say the team is working with them on it. No sales or upgrade talk.',
  recovery: 'They asked to cancel. Ask what led to it and whether anything would change their mind. No pressure and no invented offers.',
  expansion: 'They mentioned an additional need. Ask about it and connect it to one relevant module or plan from the fact sheet.',
  outreach: 'Introduce the product to a prospect who has not replied yet, following the touch plan.',
});
export const lifecyclePlay = kind => lifecyclePlays[kind] ?? lifecyclePlays.outreach;

/**
 * Who a message about `product` comes from: the product team's sign-off and the product's website. Prospect outreach (`purpose`
 * 'marketing') is the founder's own letter (owner direction 2026-11-12), so it is signed with the founder's name and title instead.
 */
export function senderFor(product, purpose = null) {
  const book = salesPlaybook[product];
  const fact = book ? facts[book.factsKey] : null;
  const signer = purpose === 'marketing' ? founder.signOff : null;
  if (!fact) return { team: 'The CareMetric team', ...(signer ? { signer } : {}), site: null };
  return { team: `The ${fact.name} team`, ...(signer ? { signer } : {}), site: { label: fact.site.replace(/^https:\/\/(?:www\.)?/, '').replace(/\/$/, ''), url: fact.site } };
}

/** The pages a message about `product` may link to (that product's own pages from the fact sheet), plus nothing else. */
export function linkablePages(product) {
  const book = salesPlaybook[product];
  if (!book) return [];
  return book.pages.map(id => productPages.find(page => page.id === id)).filter(Boolean);
}

/**
 * The search queries for a product's discovery on a given day. Each day takes the next `discoveryQueriesPerDay` steps of the product's
 * segment-by-place grid, so discovery keeps finding new organizations instead of rereading the same results, and no query is repeated
 * until the whole grid has been searched. Each time the grid has been walked once, the next pass reads the next page of every search
 * (`offset`), so a second pass still finds organizations the first did not. CareBase stays inside Pennsylvania.
 */
const discoveryGrid = deepFreeze({
  carebase: { segments: ['"personal care home"', '"assisted living facility"', '"personal care home" administrator', '"assisted living" personal care home'], places: pennsylvania },
  'caremetric-intel': {
    segments: ['"home health agency"', '"hospice agency"', '"home health and hospice"', 'hospice "community liaison"', '"home health" "service area" Medicare certified', 'hospice "serving" counties referrals'],
    places: intelMarkets,
  },
});
/** The places a product's discovery searches ("Cleveland Ohio"), in grid order: where a web-found prospect was most likely found. */
export const discoveryPlaces = product => [...(discoveryGrid[product]?.places ?? [])];
/** Searches per product per day. Each is one call to the search provider; the daily discovery run paces them a second apart. */
export const discoveryQueriesPerDay = 6;
/** Result pages a search provider serves for one query (the first and the four after it). */
export const discoveryPages = 5;
const discoveryStartDay = Math.floor(Date.parse('2026-11-12') / 86_400_000);
const dayNumber = instant => Math.floor(Date.parse(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(instant)) / 86_400_000);
export const discoveryQueryCount = product => (discoveryGrid[product] ? discoveryGrid[product].segments.length * discoveryGrid[product].places.length : 0);
/** The day's searches for `product`: `{ query, offset }` each, `count` of them (never more than the grid holds). */
export function discoveryQueries(product, instant = new Date(), count = discoveryQueriesPerDay) {
  const grid = discoveryGrid[product];
  if (!grid) return [];
  const size = grid.segments.length * grid.places.length;
  const each = Math.min(Math.max(Math.trunc(count) || 1, 1), size);
  // Counted from the day several searches a day began, so the first pass over the grid reads the first page of results.
  const first = (dayNumber(instant) - discoveryStartDay) * each;
  return Array.from({ length: each }, (_, index) => {
    const position = first + index;
    const step = ((position % size) + size) % size;
    const pass = Math.floor(position / size);
    // Places change with every search; the segment moves on once every place has been searched with the current one.
    return { query: `${grid.segments[Math.floor(step / grid.places.length)]} ${grid.places[step % grid.places.length]}`, offset: pass < 0 ? 0 : pass % discoveryPages };
  });
}
/** The first search of the day (the guardrail check and older callers read one query a day). */
export function discoveryQuery(product, instant = new Date()) {
  return discoveryQueries(product, instant)[0]?.query ?? null;
}

/**
 * Hosts that are never an operator to sell to: directories, review and listing sites, provider-number and company-data lookups, social
 * networks, job boards, encyclopedias and government or school sites. Discovery drops them, so the contact finder never emails a
 * directory's info@ address. A host whose own name says it is a directory or a listing is dropped as well.
 */
const notOperators = [
  'aplaceformom.com', 'caring.com', 'seniorly.com', 'seniorliving.org', 'seniorhousingnet.com', 'senioradvisor.com', 'assistedliving.org',
  'assistedlivingfacilities.org', 'payingforseniorcare.com', 'carelistings.com', 'careforth.com', 'agingcare.com', 'medicare.gov', 'yelp.com',
  'yellowpages.com', 'facebook.com', 'linkedin.com', 'instagram.com', 'twitter.com', 'x.com', 'youtube.com', 'indeed.com', 'glassdoor.com',
  'ziprecruiter.com', 'monster.com', 'simplyhired.com', 'wikipedia.org', 'mapquest.com', 'bbb.org', 'healthgrades.com', 'usnews.com',
  'homehealthcareagencies.com', 'hospicedirectory.org', 'carecompare.com', 'nursinghomesite.com', 'zillow.com', 'reddit.com', 'quora.com',
  // Seen in production discovery (2026-11-08 to 2026-11-11): each was recorded as a prospect and scored as a directory.
  'causeiq.com', 'senioradvice.com', 'medicarelist.com', 'homecareatlas.com', 'newlifestyles.com',
  // Senior-care and home-care marketplaces and listing sites.
  'care.com', 'seniorcare.com', 'retirementliving.com', 'seniorguidance.org', 'seniorhomes.com', 'seniorlivingguide.com', 'seniorcareauthority.com',
  'assistedlivingmagazine.com', 'assistedlivingnearme.net', 'homecare.com', 'homecarepulse.com', 'bestcompany.com', 'consumeraffairs.com',
  'trustpilot.com', 'birdeye.com', 'angi.com', 'thumbtack.com', 'nextdoor.com', 'hospiceanalytics.com', 'nationalhospicelocator.com',
  'homehealthcompare.com', 'medicare.org', 'medicareadvantage.com', 'healthcarecomps.com', 'definitivehc.com', 'hospicecompare.com',
  // Provider-number (NPI) lookups and health-provider directories.
  'npidb.org', 'npino.com', 'npiprofile.com', 'opennpi.com', 'npi.io', 'hipaaspace.com', 'healthcare4ppl.com', 'healthcare6.com', 'providerwire.com',
  'doximity.com', 'vitals.com', 'webmd.com', 'zocdoc.com', 'sharecare.com', 'ratemds.com', 'wellness.com', 'findatopdoc.com', 'carepathways.com',
  // Company-data, contact-data and nonprofit lookups.
  'dnb.com', 'zoominfo.com', 'crunchbase.com', 'bloomberg.com', 'manta.com', 'chamberofcommerce.com', 'opencorporates.com', 'bizapedia.com',
  'buzzfile.com', 'rocketreach.co', 'apollo.io', 'signalhire.com', 'lusha.com', 'leadiq.com', 'datanyze.com', 'owler.com', 'pitchbook.com',
  'propublica.org', 'guidestar.org', 'candid.org', 'charitynavigator.org', 'greatnonprofits.org', 'cylex.us.com', 'hotfrog.com', 'superpages.com',
  'whitepages.com', 'local.com', 'foursquare.com', 'tripadvisor.com',
  // Trade associations and trade press: about providers, never one.
  'nahc.org', 'nhpco.org', 'allianceforcareathome.org', 'leadingage.org', 'ahcancal.org', 'argentum.org', 'homehealthcarenews.com',
  'hospicenews.com', 'mcknights.com', 'mcknightshomecare.com', 'mcknightsseniorliving.com', 'seniorhousingnews.com', 'skillednursingnews.com',
  'beckershospitalreview.com', 'fiercehealthcare.com', 'modernhealthcare.com', 'kff.org', 'aarp.org',
  // Social, search, app-store, recruiting and publishing platforms.
  'tiktok.com', 'pinterest.com', 'threads.net', 'google.com', 'bing.com', 'apple.com', 'amazon.com', 'medium.com', 'substack.com', 'wordpress.com',
  'blogspot.com', 'wixsite.com', 'careerbuilder.com', 'salary.com', 'snagajob.com', 'jooble.org', 'talent.com', 'lensa.com', 'vivian.com',
  'myworkdayjobs.com', 'icims.com', 'greenhouse.io', 'lever.co', 'paylocity.com', 'adp.com', 'prnewswire.com', 'businesswire.com', 'globenewswire.com',
  'issuu.com', 'scribd.com', 'slideshare.net', 'eventbrite.com', 'gofundme.com', 'legacy.com', 'dignitymemorial.com',
];
// A host that names itself a directory, a listing, a review or a jobs site (seniorcaredirectory.example, hospicereviews.example).
const directoryName = /(?:^|[.-])(?:directory|directories|listings?|reviews?|ratings|jobs|careers)(?:[.-]|$)|(?:directory|listings|reviews)\.[a-z]{2,}$/;
export function operatorHost(host) {
  const value = String(host ?? '').toLowerCase().replace(/^www\./, '');
  if (!value || /\.(?:gov|edu|mil)$/.test(value) || /\.(?:gov|edu)\.[a-z]{2}$/.test(value) || /(?:^|\.)(?:pa\.us|state\.[a-z]{2}\.us)$/.test(value)) return false;
  if (directoryName.test(value)) return false;
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
