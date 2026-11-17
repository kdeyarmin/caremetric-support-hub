/**
 * The marketing sections of the three emails CareMetric sends a home health agency or hospice about CareMetric Intel (email review
 * 2026-11-17, the owner's words on the plain letter: "there's no explanation of what else the software does", "something that I'd
 * throw away without even reading").
 *
 * The writer (draft.mjs) writes a short opening for one agency: what CareMetric made for it and why it matters there. Everything
 * after that is the same for every agency and is written once, here, from the fact sheet: what the software does, the founder's own
 * words, the current offer and the free trial. Code adds it to the email when it is drafted (`withCampaign`), so the words the owner
 * approves are the whole email, and reads it back when the email is sent (`readCampaign`) to lay it out: a report card, numbered
 * points, a row of figures, a quote and a closing panel (worker.mjs `growthEmail`, email-layout.mjs).
 *
 * Every line here keeps the rules a written email keeps (draft.mjs): nothing an agency could read as its own rank, share or rating,
 * no card terms, the data named by its source without the word "public", no demo or call offered, no promise of referrals or revenue,
 * and only the numbers the fact sheet and Intel's catalog state. campaign.test.mjs runs each block through those checks.
 *
 * An email whose sections were edited after drafting no longer matches (`readCampaign` answers null) and is sent in the same look with
 * its words as written, so nothing an owner changed is replaced.
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

/** What Intel does, as the first email lists it: the fact sheet's five things to lead with, in a reader's words. */
export const featurePoints = Object.freeze([
  ['Finds every referral source', 'The physicians in your counties, ranked from Medicare data, plus the hospitals and facilities around them. Save the ones worth a visit.'],
  ['Watches your competition', 'Every home health agency and hospice in your territory, ranked by Medicare share. You get an alert when a rating, owner or service area changes.'],
  ['Plans each marketer\'s week', 'A daily plan, a suggested route and a prep card before each visit, so every stop has a reason.'],
  ['Keeps every relationship in one place', 'Accounts, contacts, visit notes and follow-ups, logged from a phone before you leave the parking lot.'],
  ['Shows what the work led to', 'Referrals and admissions by source and by marketer, how fast your team answers, and an alert when a top source starts to slip.'],
]);
/** The figures about its data that Intel's own site publishes (its catalog's "By the numbers"), without the word "public". */
export const dataFigures = Object.freeze([
  ['150+', 'healthcare datasets, linked by provider and county'],
  ['Every NPI', 'in the national provider registry'],
  ['3,200+', 'counties and 33,000+ ZIP areas'],
  ['Daily', 'checks for new CMS releases'],
]);
/** A week of the work, as the second email shows it. */
export const weekSteps = Object.freeze([
  { tag: 'Monday', title: 'Pick who to see', text: 'The highest-ranked physicians and the hospitals in your county, saved to a list, each with its practice location.' },
  { tag: 'Every day', title: 'Walk in prepared', text: 'A suggested route for the day, and a prep card before each visit with the account\'s history and what to bring up.' },
  { tag: 'After each visit', title: 'Log it from your phone', text: 'A short note, a next step and a date, saved before you leave the parking lot.' },
  { tag: 'Friday', title: 'See what the week led to', text: 'Referrals and admissions by source and by marketer, and an alert when a top source starts to slip.' },
]);
/** The same five things in three lines, for the last email. */
export const shortPoints = Object.freeze([
  ['Finds every referral source', 'in your counties, ranked from Medicare data.'],
  ['Watches your competition', 'and alerts you when a rating, owner or service area changes.'],
  ['Plans each week and tracks what it led to,', 'from the first visit to the referral.'],
]);
/** What the report card names: what every agency's report holds. The values stay in the report. */
export const reportTiles = Object.freeze(['Where you stand', 'Who leads the county', 'Top hospitals', 'Top physicians for outreach']);

const words = {
  1: {
    eyebrow: 'Your free market report is ready',
    heading: 'What CareMetric Intel does for your agency, every day',
    sectionEyebrow: 'The report is just the start',
    figures: () => ['By the numbers:', ...dataFigures.map(([value, label]) => `- ${value} ${label}`)].join('\n'),
    closeTitle: 'See every referral source in your county',
    closeText: () => `Try CareMetric Intel free for ${trialDays()} days on one county, with your own team. No demo to sit through, and the prices are on our website.`,
    closeNote: 'Have a question first? Just reply. I\'ll answer it.',
  },
  2: {
    eyebrow: 'From your market report to a plan',
    heading: 'A week in CareMetric Intel',
    offerEyebrow: 'Founders Sale',
    offerTitle: '50% off your first 12 months',
    // The sale's terms in everyday words (facts.mjs `foundersSaleTerms`): half off the plan's own price for the first paid year, applied
    // by billing with no code. "Your plan's price" leaves out what the terms exclude (setup fees, add-ons, taxes).
    offerText: 'Half off your plan\'s price for your first 12 months as a paying customer. It\'s applied on its own when your paid plan starts. No code needed.',
    closeTitle: () => `Try it on your county, free for ${trialDays()} days`,
    closeText: 'Your own county, your own team. No demo to sit through, and the prices are on our website.',
    reportLead: { own: 'Your market report is still here:', page: 'Your free market report is one step away:' },
  },
  3: {
    eyebrow: 'A last note',
    heading: 'What CareMetric Intel does',
    reportLead: { own: 'Your market report:', page: 'Your free market report:' },
    trialLead: () => `Whenever the time is right, start a ${trialDays()}-day free trial on one county:`,
  },
};
export const campaignTouches = Object.freeze([1, 2, 3]);
const touchOf = touch => (campaignTouches.includes(Number(touch)) ? Number(touch) : null);
export const campaignEyebrow = touch => words[touchOf(touch)]?.eyebrow ?? null;

/**
 * The sections of one email as plain text, which is how they are stored and approved, and what a mail program without HTML shows.
 * `trialUrl` and `reportUrl` are written as given (the trial link already carries its campaign tags). The first email's report link is in
 * the writer's own opening, so its sections carry only the trial.
 */
export function campaignBlock(touch, { trialUrl, reportUrl = null, ownReport = false } = {}) {
  const n = touchOf(touch);
  if (!n || !trialUrl) return null;
  if (n === 1) {
    const w = words[1];
    return [
      w.heading,
      ...featurePoints.map(([title, text], index) => `${index + 1}. ${title}\n${text}`),
      w.figures(),
      `"${founderQuote}"`,
      `${w.closeTitle}\n${w.closeText()}\n${trialUrl}`,
      w.closeNote,
    ].join('\n\n');
  }
  if (!reportUrl) return null;
  if (n === 2) {
    const w = words[2];
    return [
      w.heading,
      ...weekSteps.map(step => `${step.tag}: ${step.title}\n${step.text}`),
      `${w.offerEyebrow}: ${w.offerTitle}\n${w.offerText}`,
      `${w.closeTitle()}\n${w.closeText}\n${trialUrl}`,
      `${ownReport ? w.reportLead.own : w.reportLead.page}\n${reportUrl}`,
    ].join('\n\n');
  }
  const w = words[3];
  return [
    `${ownReport ? w.reportLead.own : w.reportLead.page}\n${reportUrl}`,
    w.heading,
    shortPoints.map(([lead, text]) => `- ${lead} ${text}`).join('\n'),
    `${w.trialLead()}\n${trialUrl}`,
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
 * An email's opening and sections, read back from its words when it is sent: `{ touch, opening, trialUrl, reportUrl, ownReport }`, or
 * null when the words are not a campaign email as `campaignBlock` writes one (another kind of email, an older one, or one whose
 * sections were edited). `reports.accepts(url)` says whether a link is an agency's own report (report-link.mjs).
 */
export function readCampaign(body, { reports = null } = {}) {
  const text = String(body ?? '').trim();
  const trial = trialPage();
  const page = reviewPage();
  if (!text || !trial) return null;
  const isReport = url => reports?.accepts?.(url) === true;
  for (const touch of campaignTouches) {
    // The first and second emails' sections begin at their heading; the third's begin at its report line.
    const starts = touch === 3 ? [words[3].reportLead.own, words[3].reportLead.page] : [words[touch].heading];
    const at = starts.map(start => text.indexOf(`\n\n${start}\n`)).filter(index => index > 0).sort((a, b) => a - b)[0];
    if (at === undefined) continue;
    const opening = text.slice(0, at).trim();
    const block = text.slice(at + 2);
    const links = linesOf(block).filter(line => linkLine.test(line));
    const trialUrl = links.find(url => (untaggedUrl(url) ?? url) === trial) ?? null;
    if (!trialUrl || !opening) continue;
    // The first email's report link is in the opening; the others' is in their sections.
    const from = touch === 1 ? linesOf(opening).filter(line => linkLine.test(line)) : links.filter(url => url !== trialUrl);
    const reportUrl = from.find(isReport) ?? from.find(url => (untaggedUrl(url) ?? url) === page) ?? null;
    const ownReport = Boolean(reportUrl && isReport(reportUrl));
    if (touch !== 1 && !reportUrl) continue;
    if (campaignBlock(touch, { trialUrl, reportUrl, ownReport }) !== block) continue;
    return { touch, opening, trialUrl, reportUrl, ownReport };
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
  const w = words[touch];
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
      ...(reportUrl ? [{ type: 'tiles', eyebrow: 'AGENCY MARKET REPORT', title: 'Your market report', subtitle: 'From Medicare and Census data', items: reportTiles.map(tile => tile.toUpperCase()), value: 'in your report' }, reportAction] : []),
      { type: 'features', eyebrow: w.sectionEyebrow.toUpperCase(), title: w.heading, items: featurePoints },
      { type: 'stats', items: dataFigures },
      { type: 'quote', text: founderQuote, name: founder.signOff[0], role: founder.signOff[1] },
      { type: 'panel', title: w.closeTitle, text: w.closeText(), button: { ...trialButton, quiet: true }, note: w.closeNote },
    ];
  }
  if (touch === 2) {
    return [
      message,
      { type: 'cards', title: w.heading, items: weekSteps },
      { type: 'offer', eyebrow: w.offerEyebrow.toUpperCase(), title: w.offerTitle, text: w.offerText },
      { type: 'panel', title: w.closeTitle(), text: w.closeText, button: trialButton,
        // The same words to every agency: an email never says or hints whether its report was opened (opens.mjs).
        link: { lead: ownReport ? w.reportLead.own : w.reportLead.page, label: ownReport ? 'Open your market report (PDF)' : 'Get your free market report', url: reportUrl } },
    ];
  }
  return [
    message,
    reportAction,
    { type: 'points', title: w.heading, items: shortPoints, link: { lead: 'Whenever the time is right:', label: `start a ${trialDays()}-day free trial on one county`, url: trialUrl } },
  ];
}
