/**
 * The marketing sections of the three emails CareMetric sends a prospect about CareMetric Intel (email review 2026-11-17, the owner's
 * words on the plain letter: "there's no explanation of what else the software does", "something that I'd throw away without even
 * reading").
 *
 * The writer (draft.mjs) writes a short opening for one organization. Everything after that is written once, here, from the fact
 * sheet: what the software does, the founder's own words, the current offer and the free trial. Code adds it to the email when it is
 * drafted (`withCampaign`), so the words the owner approves are the whole email, and reads it back when the email is sent
 * (`readCampaign`) to lay it out: a report card, numbered points, a row of figures, a quote and a closing panel (worker.mjs
 * `growthEmail`, email-layout.mjs).
 *
 * The sections are written for the reader's own kind of organization (owner direction 2026-11-17: "make the email customized to the
 * recipient's business industry"; a hospice does not care how home health agencies rank). `campaignSettings` names the kinds:
 * a home health agency, a hospice, an organization that is both, an agency whose kind is not known, and a nursing home. Each reads
 * only about its own competitors and its own referral sources, from the fact sheet's row for that industry (facts.mjs
 * `industryUseCases`). A nursing home reads about the nursing homes it competes with, ranked the same way. It has no market report
 * (Intel's free reports cover home health and hospice), so its emails carry none.
 *
 * Every line here keeps the rules a written email keeps (draft.mjs): nothing an organization could read as its own rank, share or
 * rating, no card terms, the data named by its source without the word "public", no data file or year cited, no demo or call offered,
 * no promise of referrals or revenue, and only the numbers the fact sheet and Intel's catalog state. campaign.test.mjs runs each
 * block, for each kind of organization, through those checks.
 *
 * An email whose sections were edited after drafting no longer matches (`readCampaign` answers null) and is sent as a letter with its
 * words as written, so nothing an owner changed is replaced.
 */
import { founder, products as facts } from '../agents/content/facts.mjs';
import { untaggedUrl } from '../agents/links.mjs';
import { linkablePages, playbookFor } from './playbook.mjs';

export const campaignProduct = 'caremetric-intel';

/** The page where any agency gets its own market report (an agency with no roster record has no link of its own). */
export const reviewPage = () => linkablePages(campaignProduct).find(page => /\/market-review\/?$/.test(page.url))?.url ?? null;
const trialPage = () => playbookFor(campaignProduct)?.nextStep?.url ?? null;
const trialDays = () => facts.intel.trialDays;

/**
 * The founder's story as a quote: the fact sheet's story (`founder.story`) in three short sentences, with nothing added to it. "Research my
 * competitors" is the fact sheet's own shorter wording (`founder.storyAbout`).
 */
export const founderQuote = 'I run a home health and hospice agency and a healthcare consulting company. I needed a way to research my competitors and find every potential referral source in my market. So I built CareMetric Intel, and I use it every day.';

/** The figures about its data that Intel's own site publishes (its catalog's "By the numbers"), without the word "public". */
export const dataFigures = Object.freeze([
  ['150+', 'healthcare datasets, linked by provider and county'],
  ['Every NPI', 'in the national provider registry'],
  ['3,200+', 'counties and 33,000+ ZIP areas'],
  ['Daily', 'checks for new CMS releases'],
]);

/**
 * The kinds of organization the sections are written for. `agency` is a home health agency or hospice whose kind is not known, so its
 * words name neither; `both` runs the two under one name.
 */
export const campaignSettings = Object.freeze(['home_health', 'hospice', 'both', 'agency', 'nursing_home']);
const settingOf = setting => (campaignSettings.includes(setting) ? setting : 'agency');
/** Whether this kind of organization has a market report: Intel's reports cover home health and hospice agencies only. */
export const hasReport = setting => settingOf(setting) !== 'nursing_home';

// What changes with the kind of organization: what it is called, who it competes with, who does its field work and where its
// patients come from. Everything else an agency reads is the same.
const agencyWords = {
  home_health: { name: 'home health agency', report: 'Home health market report', rivals: 'home health agency', worker: 'marketer',
    sources: 'The physicians who certify home health in your counties, ranked from Medicare data, plus the hospitals and facilities around them. Save the ones worth a visit.' },
  hospice: { name: 'hospice', report: 'Hospice market report', rivals: 'hospice', worker: 'liaison',
    sources: 'The physicians in your counties, ranked for hospice outreach from Medicare data, plus the hospitals and nursing homes around them. Save the ones worth a visit.' },
  both: { name: 'agency', report: 'Agency market report', rivals: 'home health agency and hospice', worker: 'marketer',
    sources: 'The physicians in your counties, ranked from Medicare data, plus the hospitals and facilities around them. Save the ones worth a visit.' },
  agency: { name: 'agency', report: 'Agency market report', rivals: 'agency like yours', worker: 'marketer',
    sources: 'The physicians in your counties, ranked from Medicare data, plus the hospitals and facilities around them. Save the ones worth a visit.' },
};
const prepCard = 'A daily plan, a suggested route and a prep card before each visit, so every stop has a reason.';
const oneWeek = worker => [
  { tag: 'Every day', title: 'Walk in prepared', text: 'A suggested route for the day, and a prep card before each visit with the account\'s history and what to bring up.' },
  { tag: 'After each visit', title: 'Log it from your phone', text: 'A short note, a next step and a date, saved before you leave the parking lot.' },
  { tag: 'Friday', title: 'See what the week led to', text: `Referrals and admissions by source and by ${worker}, and an alert when a top source starts to slip.` },
];
function agencyCopy(setting) {
  const w = agencyWords[setting];
  return {
    eyebrows: ['Your free market report is ready', 'From your market report to a plan', 'A last note'],
    heading: `What CareMetric Intel does for your ${w.name}, every day`,
    sectionEyebrow: 'The report is just the start',
    reportEyebrow: w.report,
    // What the report card names: what every agency's report holds. The values stay in the report.
    reportTiles: ['Where you stand', 'Who leads the county', 'Top hospitals', 'Top physicians for outreach'],
    featurePoints: [
      ['Finds every referral source', w.sources],
      ['Watches your competition', `Every ${w.rivals} in your territory, ranked by Medicare share. You get an alert when a rating, owner or service area changes.`],
      [`Plans each ${w.worker}'s week`, prepCard],
      ['Keeps every relationship in one place', 'Accounts, contacts, visit notes and follow-ups, logged from a phone before you leave the parking lot.'],
      ['Shows what the work led to', `Referrals and admissions by source and by ${w.worker}, how fast your team answers, and an alert when a top source starts to slip.`],
    ],
    weekSteps: [
      { tag: 'Monday', title: 'Pick who to see', text: 'The highest-ranked physicians and the hospitals in your county, saved to a list, each with its practice location.' },
      ...oneWeek(w.worker),
    ],
    shortPoints: [
      ['Finds every referral source', 'in your counties, ranked from Medicare data.'],
      [`Watches every ${w.rivals}`, 'in your territory, and alerts you when a rating, owner or service area changes.'],
      ['Plans each week and tracks what it led to,', 'from the first visit to the referral.'],
    ],
    closeTitle: 'See every referral source in your county',
  };
}
// A nursing home (facts.mjs `industryUseCases`): hospital-source research, the nursing homes in its territory ranked by Medicare
// share with alerts (Intel ranks nursing homes since 2026-11-17, and the owner asked for the email to say so), its county's use and
// supply of skilled nursing, and the same field work. Intel's free market report covers home health and hospice only, so none is offered.
const nursingHomeCopy = {
  eyebrows: ['For your admissions and marketing team', 'From a list to a week of visits', 'A last note'],
  heading: 'What CareMetric Intel does for your nursing home, every day',
  sectionEyebrow: 'Built for the work of filling beds',
  reportEyebrow: null,
  reportTiles: [],
  featurePoints: [
    ['Finds your hospital sources', 'The hospitals your county\'s residents use, plus the physicians and facilities around you. Save the ones worth a visit.'],
    ['Watches the homes you compete with', 'Every nursing home in your territory, ranked by Medicare share, with its ratings, staffing, inspections and owner. You get an alert when a rating or owner changes.'],
    ['Sizes up your county', 'How much skilled nursing care your county\'s residents use, and how many homes serve them.'],
    ['Plans each week\'s visits', prepCard],
    ['Keeps every relationship in one place', 'Accounts, contacts, visit notes and follow-ups, plus referrals and admissions by source.'],
  ],
  weekSteps: [
    { tag: 'Monday', title: 'Pick who to see', text: 'The hospitals your county\'s residents use and the physicians around you, saved to a list.' },
    ...oneWeek('marketer'),
  ],
  shortPoints: [
    ['Finds your hospital sources', 'and the physicians and facilities around you.'],
    ['Ranks every nursing home in your territory', 'by Medicare share, and alerts you when a rating or owner changes.'],
    ['Plans each week and tracks what it led to,', 'from the first visit to the admission.'],
  ],
  closeTitle: 'See every hospital source in your county',
};
const copies = Object.freeze({ home_health: agencyCopy('home_health'), hospice: agencyCopy('hospice'), both: agencyCopy('both'), agency: agencyCopy('agency'), nursing_home: nursingHomeCopy });
/** The sections' words for one kind of organization: its headings, the five points, the week's four steps and the last email's three lines. */
export const campaignCopy = setting => copies[settingOf(setting)];

// What every kind of organization reads the same.
const shared = {
  figuresLead: 'By the numbers:',
  closeText: () => `Try CareMetric Intel free for ${trialDays()} days on one county, with your own team. No demo to sit through, and the prices are on our website.`,
  closeNote: 'Have a question first? Just reply. I\'ll answer it.',
  weekHeading: 'A week in CareMetric Intel',
  offerEyebrow: 'Founders Sale',
  offerTitle: '50% off your first 12 months',
  // The sale's terms in everyday words (facts.mjs `foundersSaleTerms`): half off the plan's own price for the first paid year, applied
  // by billing with no code. "Your plan's price" leaves out what the terms exclude (setup fees, add-ons, taxes).
  offerText: 'Half off your plan\'s price for your first 12 months as a paying customer. It\'s applied on its own when your paid plan starts. No code needed.',
  weekCloseTitle: () => `Try it on your county, free for ${trialDays()} days`,
  weekCloseText: 'Your own county, your own team. No demo to sit through, and the prices are on our website.',
  reportStill: { own: 'Your market report is still here:', page: 'Your free market report is one step away:' },
  lastHeading: 'What CareMetric Intel does',
  reportLast: { own: 'Your market report:', page: 'Your free market report:' },
  trialLead: () => `Whenever the time is right, start a ${trialDays()}-day free trial on one county:`,
};
export const campaignTouches = Object.freeze([1, 2, 3]);
const touchOf = touch => (campaignTouches.includes(Number(touch)) ? Number(touch) : null);
/** The short line above an email's headline. */
export const campaignEyebrow = (touch, setting = 'agency') => campaignCopy(setting).eyebrows[touchOf(touch) - 1] ?? null;

/**
 * The sections of one email as plain text, which is how they are stored and approved, and what a mail program without HTML shows.
 * `trialUrl` and `reportUrl` are written as given (the trial link already carries its campaign tags). The first email's report link is in
 * the writer's own opening, so its sections carry only the trial. `setting` is the reader's kind of organization (`campaignSettings`);
 * a nursing home's sections never carry a report.
 */
export function campaignBlock(touch, { trialUrl, reportUrl = null, ownReport = false, setting = 'agency' } = {}) {
  const n = touchOf(touch);
  if (!n || !trialUrl) return null;
  const kind = settingOf(setting);
  const copy = copies[kind];
  const reported = hasReport(kind);
  if (n === 1) {
    return [
      copy.heading,
      ...copy.featurePoints.map(([title, text], index) => `${index + 1}. ${title}\n${text}`),
      [shared.figuresLead, ...dataFigures.map(([value, label]) => `- ${value} ${label}`)].join('\n'),
      `"${founderQuote}"`,
      `${copy.closeTitle}\n${shared.closeText()}\n${trialUrl}`,
      shared.closeNote,
    ].join('\n\n');
  }
  if (reported && !reportUrl) return null;
  if (n === 2) {
    return [
      shared.weekHeading,
      ...copy.weekSteps.map(step => `${step.tag}: ${step.title}\n${step.text}`),
      `${shared.offerEyebrow}: ${shared.offerTitle}\n${shared.offerText}`,
      `${shared.weekCloseTitle()}\n${shared.weekCloseText}\n${trialUrl}`,
      ...(reported ? [`${ownReport ? shared.reportStill.own : shared.reportStill.page}\n${reportUrl}`] : []),
    ].join('\n\n');
  }
  return [
    ...(reported ? [`${ownReport ? shared.reportLast.own : shared.reportLast.page}\n${reportUrl}`] : []),
    shared.lastHeading,
    copy.shortPoints.map(([lead, text]) => `- ${lead} ${text}`).join('\n'),
    `${shared.trialLead()}\n${trialUrl}`,
  ].join('\n\n');
}

/** The writer's opening with the email's sections after it, or the opening alone when there is nothing to add or no room for it. */
export function withCampaign(opening, touch, links, { limit = 3900 } = {}) {
  const block = campaignBlock(touch, links);
  const text = String(opening ?? '').trim();
  if (!block || !text) return text;
  const whole = `${text}\n\n${block}`;
  return whole.length <= limit ? whole : text;
}

const linkLine = /^https:\/\/[^\s<>"]+$/;
const linesOf = text => String(text ?? '').split('\n').map(line => line.trim());
/**
 * An email's opening and sections, read back from its words when it is sent: `{ touch, setting, opening, trialUrl, reportUrl,
 * ownReport }`, or null when the words are not a campaign email as `campaignBlock` writes one (another kind of email, an older one, or
 * one whose sections were edited). `reports.accepts(url)` says whether a link is an agency's own report (report-link.mjs). Each touch
 * and kind of organization is tried in turn, and one is accepted only when its sections, written again from what was read, are the
 * email's sections word for word.
 */
export function readCampaign(body, { reports = null } = {}) {
  const text = String(body ?? '').trim();
  const trial = trialPage();
  const page = reviewPage();
  if (!text || !trial) return null;
  const isReport = url => reports?.accepts?.(url) === true;
  const probe = 'https://probe.invalid/';
  for (const touch of campaignTouches) {
    for (const setting of campaignSettings) {
      const reported = hasReport(setting);
      // Where these sections would begin: the first line `campaignBlock` writes for this touch and kind (for a last email with a
      // report, its report line, which differs with whose report it is).
      const starts = new Set([true, false].map(own => campaignBlock(touch, { trialUrl: probe, reportUrl: reported ? probe : null, ownReport: own, setting })?.split('\n')[0]).filter(Boolean));
      const at = [...starts].map(start => text.indexOf(`\n\n${start}\n`)).filter(index => index > 0).sort((a, b) => a - b)[0];
      if (at === undefined) continue;
      const opening = text.slice(0, at).trim();
      const block = text.slice(at + 2);
      const links = linesOf(block).filter(line => linkLine.test(line));
      const trialUrl = links.find(url => (untaggedUrl(url) ?? url) === trial) ?? null;
      if (!trialUrl || !opening) continue;
      // The first email's report link is in the opening; the others' is in their sections. A nursing home's emails have none.
      const from = !reported ? [] : touch === 1 ? linesOf(opening).filter(line => linkLine.test(line)) : links.filter(url => url !== trialUrl);
      const reportUrl = from.find(isReport) ?? from.find(url => (untaggedUrl(url) ?? url) === page) ?? null;
      const ownReport = Boolean(reportUrl && isReport(reportUrl));
      if (campaignBlock(touch, { trialUrl, reportUrl, ownReport, setting }) !== block) continue;
      return { touch, setting, opening, trialUrl, reportUrl, ownReport };
    }
  }
  return null;
}

/**
 * The email's blocks for the layout (email-layout.mjs): the writer's opening as written, the report's card and button, then the
 * sections. `links` are the addresses the opening may link (worker.mjs `messageLinks`); the report link in a first email's opening is
 * shown as the card's button, not as a line of text.
 */
export function campaignBlocks(campaign, { links = [] } = {}) {
  const { touch, opening, trialUrl, reportUrl, ownReport } = campaign;
  const copy = campaignCopy(campaign.setting);
  const openingLines = linesOf(opening).filter(line => line !== reportUrl);
  const message = { type: 'message', text: openingLines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), links };
  const reportAction = reportUrl ? {
    type: 'action', url: reportUrl,
    label: ownReport ? 'Open your market report' : 'Get your free market report',
    note: ownReport ? 'Opens as a PDF. Nothing to sign up for.' : 'Enter your agency\'s Medicare certification number and it is emailed to you as a PDF.',
  } : null;
  const trialButton = { label: 'Start your free trial', url: trialUrl };
  if (touch === 1) {
    return [
      message,
      ...(reportUrl ? [{ type: 'tiles', eyebrow: copy.reportEyebrow.toUpperCase(), title: 'Your market report', subtitle: 'From Medicare and Census data', items: copy.reportTiles.map(tile => tile.toUpperCase()), value: 'in your report' }, reportAction] : []),
      { type: 'features', eyebrow: copy.sectionEyebrow.toUpperCase(), title: copy.heading, items: copy.featurePoints },
      { type: 'stats', items: dataFigures },
      { type: 'quote', text: founderQuote, name: founder.signOff[0], role: founder.signOff[1] },
      // With a report above it, the report's button is the one accent; a nursing home's email has no report, so the trial is.
      { type: 'panel', title: copy.closeTitle, text: shared.closeText(), button: { ...trialButton, quiet: Boolean(reportUrl) }, note: shared.closeNote },
    ];
  }
  if (touch === 2) {
    return [
      message,
      { type: 'cards', title: shared.weekHeading, items: copy.weekSteps },
      { type: 'offer', eyebrow: shared.offerEyebrow.toUpperCase(), title: shared.offerTitle, text: shared.offerText },
      { type: 'panel', title: shared.weekCloseTitle(), text: shared.weekCloseText, button: trialButton,
        // The same words to every agency: an email never says or hints whether its report was opened (opens.mjs).
        ...(reportUrl ? { link: { lead: ownReport ? shared.reportStill.own : shared.reportStill.page, label: ownReport ? 'Open your market report (PDF)' : 'Get your free market report', url: reportUrl } } : {}) },
    ];
  }
  return [
    message,
    reportAction,
    { type: 'points', title: shared.lastHeading, items: copy.shortPoints, link: { lead: 'Whenever the time is right:', label: `start a ${trialDays()}-day free trial on one county`, url: trialUrl } },
  ];
}
