import { founder, products } from '../agents/content/facts.mjs';
import { untaggedUrl } from '../agents/links.mjs';

const intelHome = 'https://www.caremetricintel.com/';
const signup = new URL('/login?signup=true', intelHome).href;

export function agencyTrialUrl(taggedHome) {
  return untaggedUrl(taggedHome) === intelHome ? `${signup}&${new URL(taggedHome).search.slice(1)}` : signup;
}

export function isAgencyTrialUrl(url) {
  return url === signup || (url.startsWith(`${signup}&`) && untaggedUrl(`${intelHome}?${url.slice(signup.length + 1)}`) === intelHome);
}

const copy = {
  home_health: {
    title: 'For home health teams',
    market: 'Compare home health agencies based in your market and research clinicians who certify home health.',
    field: 'Give marketers a reason for each visit and a place to log the follow-up.',
    results: 'Review recorded referrals and admissions by account and marketer.',
  },
  hospice: {
    title: 'For hospice teams',
    market: 'Compare local hospices and research hospitals, nursing homes, and clinicians for hospice outreach.',
    field: 'Help liaisons prepare visits and keep track of who needs a follow-up.',
    results: 'Review recorded referrals and admissions by account and liaison.',
  },
  both: {
    title: 'For home health and hospice teams',
    market: 'Research home health and hospice markets separately, then find accounts worth getting to know.',
    field: 'Give marketers and liaisons a single place to plan visits and follow up.',
    results: 'Review recorded referrals and admissions by service line, account, and teammate.',
  },
  agency: {
    title: 'For your marketing team',
    market: 'Compare agencies based in your market and research potential referral partners.',
    field: 'Plan and prepare visits, then save the notes and next steps together.',
    results: 'Review recorded referrals and admissions by account and teammate.',
  },
};

export const agencyFounderQuote = 'I run a home health and hospice agency. I built CareMetric Intel to research my competitors and find potential referral sources for my own team.';

/** The account brief's lead angles (playbook.mjs). Email 1's fixed blocks follow the one the draft used. Any other value keeps the general blocks. */
export const emailAngles = Object.freeze(['referral_sources', 'territory', 'competitors', 'visit_prep', 'hospital_outcomes', 'slipping_sources']);

const angleBlocks = Object.freeze({
  referral_sources: {
    heading: 'Who to call on in your county',
    points: [
      ['The physicians who certify the most', 'Ranked from Medicare data, with the hospitals residents use.'],
      ['A list your team can work', 'Save the ones worth a visit and keep the follow-up in one place.'],
      ['What the visits led to', 'Referrals and admissions by source, from what your team records.'],
    ],
  },
  territory: {
    heading: 'A week planned around your counties',
    points: [
      ['Where a small team should spend its time', 'Counties, referral sources and a visit rhythm, from Medicare data.'],
      ['One list for the week', 'The accounts worth a stop, saved before anyone leaves the office.'],
      ['What the week led to', 'Referrals and admissions by source, from what your team records.'],
    ],
  },
  competitors: {
    heading: 'Who else is working your county',
    points: [
      ['The agencies in your territory', 'Each one located there, with an alert when an owner, rating or service area changes.'],
      ['Where the referrals come from', 'The physicians and hospitals residents use, ranked from Medicare data.'],
      ['A plan for your own team', 'Who to visit, and a place to keep what the visit led to.'],
    ],
  },
  visit_prep: {
    heading: 'Walk in knowing why you are there',
    points: [
      ['A reason for each stop', 'The account\'s history and what to bring up, before the visit.'],
      ['A note before you leave', 'A short follow-up and a date, saved from a phone.'],
      ['Friday\'s picture', 'Referrals and admissions by source, from what your team recorded.'],
    ],
  },
  hospital_outcomes: {
    heading: 'What you can show a hospital',
    points: [
      ['The hospitals your county uses', 'Where residents go, from Medicare data, so the list is not a guess.'],
      ['A reason for the meeting', 'Response time and quality scores your team can put in front of a discharge planner.'],
      ['The follow-up in one place', 'Who you saw, what you promised and whether a referral came back.'],
    ],
  },
  slipping_sources: {
    heading: 'Catch a source before it goes quiet',
    points: [
      ['The sources that used to send patients', 'Ranked from Medicare data, so a slow one shows up early.'],
      ['A visit while it still matters', 'A reason for the stop and a date for the next one.'],
      ['What changed', 'Referrals by source, from what your team records, with an alert when a top source slips.'],
    ],
  },
});

export function agencyReportSubject(value) {
  const name = String(value ?? '').replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[, ]+(?:LLC|Inc\.?|Corp\.?)$/i, '');
  if (!name) return 'Your agency market report';
  const full = `Your ${name} market report`;
  if (full.length <= 60) return full;
  const shortName = name.match(/^(.{1,41})(?=\s)/)?.[1].replace(/[,.]$/, '');
  return shortName ? `Your ${shortName} market report` : 'Your agency market report';
}

const offerDetail = 'The discount applies automatically to eligible new subscriptions when paid service starts.';
const trialDetail = 'Try it with your team in one county.';

function content(touch, { setting, trialUrl, reportUrl, ownReport, angle = null }) {
  const words = copy[setting];
  const trialDays = products.intel.trialDays;
  const offer = products.intel.offers.find((item) => item.startsWith('Founders Sale: '));
  const offerTitle = offer?.match(/^Founders Sale: (\d+% off) eligible subscription charges for the first (\d+ months)/);
  const trial = { label: `Start your ${trialDays}-day free trial`, url: trialUrl };
  // Without a report of its own, the agency is offered Intel's free county report (2026-11-19): a state, a county and an email address.
  const report = { label: ownReport ? 'Open your market report' : 'Get your free county report', url: reportUrl };
  const note = ownReport
    ? (reportUrl.endsWith('/view') ? 'Read online or download a PDF.' : 'Opens as a printable PDF.')
    : 'Choose your state and county. We’ll email the report as a PDF.';
  // Email 1 follows the brief's angle. Email 2 and 3 stay the general blocks, so the sequence still says what the product does.
  const angled = touch === 1 ? angleBlocks[angle] : null;
  if (touch === 1) return {
    heading: angled?.heading ?? words.title,
    points: angled?.points ?? [['Know your market', words.market], ['Plan your outreach', words.field], ['Review the results', words.results]],
    trial, report, note,
  };
  if (touch === 2) return {
    heading: 'A week of outreach',
    points: [['Start of week', words.market], ['After each visit', words.field], ['Weekly review', words.results]],
    offerTitle: offerTitle ? `Founders Sale: ${offerTitle[1]} the first ${offerTitle[2]}` : undefined, trial, report, note,
  };
  return { points: [], trial, report, note };
}

/**
 * Version 3 (the Nov 24 measurement, docs/AI_WORKFORCE_REVIEW_2026-11-17_TEAM.md): the first email asks for one thing, its report, so its
 * sections no longer close on the free trial; the second email offers the trial, as it did. Version 2's first email (with the trial) is
 * still read back and laid out as written, so an email drafted before the change goes out as it was approved.
 */
export const firstWithoutTrial = (touch, version) => Number(touch) === 1 && Number(version) >= 3;

export function agencyCampaignText(touch, links) {
  const noTrial = firstWithoutTrial(touch, links.version);
  if (!copy[links.setting] || (!links.trialUrl && !noTrial) || !links.reportUrl) return null;
  const { heading, points, offerTitle, trial, report, note } = content(touch, links);
  const trialLine = `${trialDetail}\n${trial.label}\n${trial.url}`;
  const reportCaption = `${report.label}\n${note}`;
  const reportLine = `${reportCaption}\n${report.url}`;
  if (touch === 1) return [
    reportCaption, heading, ...points.map(([label, detail]) => `${label}\n${detail}`),
    `"${agencyFounderQuote}"`, ...(noTrial ? [] : [trialLine]),
  ].join('\n\n');
  if (touch === 2) return [
    heading, ...points.map(([label, detail]) => `${label}\n${detail}`), offerTitle ? `${offerTitle}\n${offerDetail}` : null, trialLine, reportLine,
  ].filter(Boolean).join('\n\n');
  return [reportLine, trialLine].join('\n\n');
}

export function agencyCampaignBlocks(campaign, links) {
  const { touch, opening, reportUrl } = campaign;
  const { heading, points, offerTitle, trial, report, note } = content(touch, campaign);
  const message = { type: 'message', text: opening.split('\n').filter((line) => line.trim() !== reportUrl).join('\n').trim(), links };
  const reportAction = { type: 'action', ...report, note };
  const trialLink = { ...trial, lead: trialDetail };
  if (touch === 1) return [
    message, reportAction,
    { type: 'points', title: heading, items: points },
    { type: 'quote', text: agencyFounderQuote, name: founder.signOff[0], role: founder.signOff[1] },
    ...(firstWithoutTrial(touch, campaign.version) ? [] : [{ type: 'points', items: [], link: trialLink }]),
  ];
  if (touch === 2) return [
    message, { type: 'points', title: heading, items: points },
    ...(offerTitle ? [{ type: 'offer', title: offerTitle, text: offerDetail }] : []),
    { type: 'action', ...trial, note: trialDetail },
    { type: 'points', items: [], link: { ...report, lead: note } },
  ];
  return [message, reportAction, { type: 'points', items: [], link: trialLink }];
}
