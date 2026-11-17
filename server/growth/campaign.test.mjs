import { describe, expect, it } from 'vitest';
import { campaignBlock, campaignBlocks, campaignCopy, campaignEyebrow, campaignSettings, campaignTouches, dataFigures, founderQuote, hasReport, readCampaign, reviewPage, withCampaign } from './campaign.mjs';
import { callsDataPublic, citesDataFile, namesCard, outdatedWords, productNumbers } from './draft.mjs';
import { offersMeeting, playbookFor } from './playbook.mjs';
import { emailStatesStanding } from './standing.mjs';
import { mentionsOpen } from './opens.mjs';
import { founder, products } from '../agents/content/facts.mjs';
import { textProblems, unclearCopy } from '../agents/content/validate.mjs';
import { linkTags, tagLinks } from '../agents/links.mjs';

const product = 'caremetric-intel';
const report = 'https://www.caremetricintel.com/report/eyJ2IjoxfQ.c2lnbmF0dXJlMDEyMzQ1Njc4OQ';
const reports = { accepts: url => url === report };
const trial = touch => tagLinks(playbookFor(product).nextStep.url, linkTags.growthOutreach(product, touch, 'cms-record-plain'));
const openings = {
  1: `CMS counts 48 home health agencies in Erie County. I put together a free market report for Valley Home Health from Medicare data that shows where it stands among them, and who to call on next.\n${report}`,
  2: 'The market report I sent for Valley Home Health shows the hospitals Erie County residents use. Here is what a marketing team does with that.\n\nHow does your team decide who to visit each week?',
  3: 'This is my last note. The market report for Valley Home Health stays where it is.\n\nIf someone else handles marketing there, forward this to them.',
};
const plain = {
  1: 'CareMetric Intel shows an admissions team which hospitals its county\'s residents use.\n\nHow does your team decide which hospitals to visit?',
  2: 'Here\'s what a week of admissions work looks like in CareMetric Intel.\n\nHow does your team decide who to visit each week?',
  3: 'This is my last note. If someone else handles admissions there, forward this to them.',
};
// What a draft passes for one kind of organization: an agency's own report or the market report page; a nursing home has neither.
const links = (touch, setting = 'agency', own = true) => ({ trialUrl: trial(touch), setting,
  ...(hasReport(setting) ? { reportUrl: own ? report : reviewPage(), ownReport: own } : { reportUrl: null, ownReport: false }) });
const openingFor = (touch, setting, own = true) => (!hasReport(setting) ? plain[touch] : touch === 1 && !own ? openings[1].replace(report, reviewPage()) : openings[touch]);
const withoutLinks = text => text.replace(/https?:\/\/\S+/g, ' ');
const cases = campaignSettings.flatMap(setting => (hasReport(setting) ? [true, false] : [true]).map(own => ({ setting, own })));

describe('the marketing sections of an email about CareMetric Intel (email review 2026-11-17)', () => {
  it('says what the software does, in the founder\'s words, and offers the trial, in every email', () => {
    const copy = campaignCopy('home_health');
    const first = campaignBlock(1, links(1, 'home_health'));
    expect(first).toMatch(/^What CareMetric Intel does for your home health agency, every day\n\n1\. Finds every referral source\n/);
    for (const [title, text] of copy.featurePoints) { expect(first).toContain(title); expect(first).toContain(text); }
    expect(copy.featurePoints).toHaveLength(5);
    expect(first).toContain(`"${founderQuote}"`);
    expect(first).toContain(`Try CareMetric Intel free for ${products.intel.trialDays} days on one county, with your own team. No demo to sit through, and the prices are on our website.\n${trial(1)}`);
    expect(first).toMatch(/Have a question first\? Just reply\. I'll answer it\.$/);
    const second = campaignBlock(2, links(2, 'home_health'));
    expect(second).toMatch(/^A week in CareMetric Intel\n\nMonday: Pick who to see\n/);
    expect(copy.weekSteps.map(step => step.tag)).toEqual(['Monday', 'Every day', 'After each visit', 'Friday']);
    expect(second).toContain('Founders Sale: 50% off your first 12 months\nHalf off your plan\'s price for your first 12 months as a paying customer. It\'s applied on its own when your paid plan starts. No code needed.');
    expect(second).toContain(`Try it on your county, free for ${products.intel.trialDays} days\nYour own county, your own team. No demo to sit through, and the prices are on our website.\n${trial(2)}`);
    expect(second).toMatch(new RegExp(`Your market report is still here:\\n${report.replace(/[.]/g, '\\.')}$`));
    const third = campaignBlock(3, links(3, 'home_health'));
    expect(third).toMatch(new RegExp(`^Your market report:\\n${report.replace(/[.]/g, '\\.')}\\n\\nWhat CareMetric Intel does\\n\\n- Finds every referral source in your counties, ranked from Medicare data\\.`));
    expect(third).toMatch(new RegExp(`Whenever the time is right, start a ${products.intel.trialDays}-day free trial on one county:\\n`));
    expect(copy.shortPoints).toHaveLength(3);
    // An agency with no report of its own is sent to the page where it gets one.
    expect(campaignBlock(2, links(2, 'home_health', false))).toContain(`Your free market report is one step away:\n${reviewPage()}`);
    expect(campaignBlock(3, links(3, 'home_health', false))).toMatch(/^Your free market report:\n/);
    // Nothing to add without a trial link, for another touch, or (after an agency's first email) without the report's link.
    expect(campaignBlock(1, {})).toBeNull();
    expect(campaignBlock(4, links(1))).toBeNull();
    expect(campaignBlock(2, { trialUrl: trial(2) })).toBeNull();
  });

  // The owner on a block that told every reader about home health agencies and hospices alike: "Was this for a home health agency? If
  // not, they don't care what the ranking is. Make the email customized to the recipient's business industry."
  it('writes each email for the reader\'s own kind of business, and never about another kind', () => {
    const all = setting => campaignTouches.map(touch => campaignBlock(touch, links(touch, setting))).join('\n\n');
    // A home health agency reads about home health agencies and the physicians who certify home health, never hospices.
    const home = all('home_health');
    expect(home).toContain('Every home health agency in your territory, ranked by Medicare share.');
    expect(home).toContain('The physicians who certify home health in your counties, ranked from Medicare data');
    expect(home).toContain('Plans each marketer\'s week');
    expect(home).toContain('Watches every home health agency in your territory');
    expect(home.replace(founderQuote, '')).not.toMatch(/hospice|nursing home/i);
    // A hospice reads about hospices and hospice outreach, never home health agencies.
    const hospice = all('hospice');
    expect(hospice).toContain('What CareMetric Intel does for your hospice, every day');
    expect(hospice).toContain('Every hospice in your territory, ranked by Medicare share.');
    expect(hospice).toContain('ranked for hospice outreach from Medicare data, plus the hospitals and nursing homes around them');
    expect(hospice).toContain('Plans each liaison\'s week');
    expect(hospice).toContain('by source and by liaison');
    expect(hospice.replace(founderQuote, '')).not.toMatch(/home health/i);
    // One that runs both reads about both, and one whose kind nothing states reads about neither by name.
    expect(all('both')).toContain('Every home health agency and hospice in your territory, ranked by Medicare share.');
    const unknown = all('agency');
    expect(unknown).toContain('Every agency like yours in your territory, ranked by Medicare share.');
    expect(unknown.replace(founderQuote, '')).not.toMatch(/home health|hospice|nursing home/i);
    // A nursing home reads about hospitals, the homes around it and its county: no ranking, no competitor alert and no market report,
    // because Intel's share rankings, alerts and reports cover home health and hospice only.
    const nursing = all('nursing_home');
    expect(nursing).toMatch(/^What CareMetric Intel does for your nursing home, every day\n\n1\. Finds your hospital sources\n/);
    expect(nursing).toContain('Every nursing home near you, with its ratings, staffing, inspections and owner.');
    expect(nursing).toContain('How much skilled nursing care your county\'s residents use, and how many homes serve them.');
    expect(nursing).toContain('from the first visit to the admission.');
    expect(nursing.replace(founderQuote, '')).not.toMatch(/home health|hospice|ranked|Medicare share|alert when a rating|market report/i);
    expect(hasReport('nursing_home')).toBe(false);
    expect(campaignCopy('nursing_home').reportTiles).toEqual([]);
    // The line above the headline fits the reader too, and an unknown kind is read as an agency.
    expect(campaignTouches.map(touch => campaignEyebrow(touch, 'hospice'))).toEqual(['Your free market report is ready', 'From your market report to a plan', 'A last note']);
    expect(campaignTouches.map(touch => campaignEyebrow(touch, 'nursing_home'))).toEqual(['For your admissions and marketing team', 'From a list to a week of visits', 'A last note']);
    expect(campaignEyebrow(4)).toBeNull();
    expect(campaignCopy('dialysis')).toBe(campaignCopy('agency'));
    expect(campaignCopy('hospice').reportEyebrow).toBe('Hospice market report');
    expect(campaignCopy('home_health').reportEyebrow).toBe('Home health market report');
  });

  it('keeps every rule a written email keeps, for every kind of business: the fact sheet\'s numbers, no card, no "public", no rank, no demo and nothing about opens', () => {
    const numbers = productNumbers(product);
    for (const touch of campaignTouches) for (const { setting, own } of cases) {
      const block = campaignBlock(touch, links(touch, setting, own));
      const words = withoutLinks(block);
      const label = `touch ${touch}, ${setting}, ${own ? 'own report' : 'page'}`;
      expect(textProblems(words, { product: 'intel', numbers }), label).toEqual([]);
      expect(unclearCopy(words), label).toEqual([]);
      expect(namesCard(product, words), label).toBe(false);
      expect(callsDataPublic(product, words), label).toBe(false);
      // Easy to read (owner direction 2026-11-17): no data file or year cited, and no sentence over twenty-five words.
      expect(citesDataFile(words), label).toBe(false);
      expect(words, label).not.toMatch(/\b(?:19|20)\d\d\b/);
      for (const sentence of words.split(/(?<=[.?!])\s+|\n+/)) expect(sentence.split(/\s+/).filter(Boolean).length, sentence).toBeLessThanOrEqual(25);
      expect(emailStatesStanding(words), label).toBe(false);
      expect(offersMeeting(words), label).toBe(false);
      expect(mentionsOpen(words), label).toBe(false);
      expect(words, label).not.toMatch(/\bthe book\b|guarantee|risk-free|proprietary|exclusive|more referrals|\bpublic(?:ly)?\b/i);
      // The email as it is stored passes the checks made again when it is sent.
      expect(outdatedWords({ product, subject: 'Your market report', body: withCampaign(openingFor(touch, setting, own), touch, links(touch, setting, own)), purpose: 'marketing' }), label).toBeNull();
    }
    // The founder's words are the fact sheet's story: its own agency and need, built for it and used every day, with nothing added.
    for (const phrase of ['I run a home health and hospice agency and a healthcare consulting company.', 'find every potential referral source in my market', 'So I built CareMetric Intel', 'I use it every day']) expect(founderQuote).toContain(phrase);
    expect(founder.story.join(' ')).toContain('I run a home health and hospice agency and a healthcare consulting company.');
    // The figures are the ones Intel's own site publishes, and the report card names only what every report holds.
    expect(dataFigures.map(([value]) => value)).toEqual(['150+', 'Every NPI', '3,200+', 'Daily']);
    expect(campaignCopy('hospice').reportTiles).toEqual(['Where you stand', 'Who leads the county', 'Top hospitals', 'Top physicians for outreach']);
  });

  it('adds the sections to the writer\'s opening and reads the whole email back when it is sent', () => {
    for (const touch of campaignTouches) for (const { setting, own } of cases) {
      const opening = openingFor(touch, setting, own);
      const given = links(touch, setting, own);
      const body = withCampaign(opening, touch, given);
      const label = `touch ${touch}, ${setting}, ${own ? 'own report' : 'page'}`;
      expect(body.startsWith(`${opening}\n\n`), label).toBe(true);
      expect(body.length, label).toBeLessThan(4000);
      const read = readCampaign(body, { reports });
      expect(read, label).toMatchObject({ touch, opening, trialUrl: given.trialUrl, reportUrl: given.reportUrl, ownReport: given.ownReport });
      // The kind of business is read back wherever the words differ by it; where two kinds read the same (a second email to a home
      // health agency and to an agency of unknown kind), either lays the email out the same.
      expect(campaignBlock(touch, { ...given, setting: read.setting }), label).toBe(campaignBlock(touch, given));
      expect(campaignBlocks(read), label).toEqual(campaignBlocks({ touch, opening, ...given }));
      if (touch === 1) expect(read.setting, label).toBe(setting);
    }
    // An opening with nothing to add, or sections that would not fit, stay the opening alone.
    expect(withCampaign(openings[1], 1, {})).toBe(openings[1]);
    expect(withCampaign(openings[1], 1, links(1), { limit: 500 })).toBe(openings[1]);
    expect(withCampaign('', 1, links(1))).toBe('');
    // Any other email is not a campaign email: a plain letter, an older email, and one whose sections were edited after drafting.
    expect(readCampaign(openings[1], { reports })).toBeNull();
    expect(readCampaign('Would a free trial help?\n\nhttps://www.caremetricintel.com/', { reports })).toBeNull();
    const edited = withCampaign(openings[1], 1, links(1, 'hospice')).replace('Watches your competition', 'Beats your competition');
    expect(readCampaign(edited, { reports })).toBeNull();
    expect(readCampaign(withCampaign(openings[2], 2, links(2)).replace(trial(2), 'https://example.org/'), { reports })).toBeNull();
    expect(readCampaign('', { reports })).toBeNull();
  });

  it('lays each email out: the opening, the report\'s card and button, the sections, and the trial', () => {
    const blocksFor = (touch, setting = 'home_health', own = true) => campaignBlocks(readCampaign(withCampaign(openingFor(touch, setting, own), touch, links(touch, setting, own)), { reports }));
    const first = blocksFor(1);
    expect(first.map(block => block.type)).toEqual(['message', 'tiles', 'action', 'features', 'stats', 'quote', 'panel']);
    // The report's link is the card's button, never a line of the opening.
    expect(first[0].text).not.toContain(report);
    expect(first[0].text).toMatch(/^CMS counts 48 home health agencies in Erie County\./);
    expect(first[1]).toMatchObject({ eyebrow: 'HOME HEALTH MARKET REPORT', title: 'Your market report' });
    expect(blocksFor(1, 'hospice')[1].eyebrow).toBe('HOSPICE MARKET REPORT');
    expect(first[2]).toMatchObject({ label: 'Open your market report', url: report, note: 'Opens as a PDF. Nothing to sign up for.' });
    expect(first[3]).toMatchObject({ title: 'What CareMetric Intel does for your home health agency, every day', items: campaignCopy('home_health').featurePoints });
    expect(first[5]).toMatchObject({ text: founderQuote, name: founder.signOff[0], role: founder.signOff[1] });
    expect(first[6].button).toMatchObject({ label: 'Start your free trial', url: trial(1), quiet: true });
    expect(blocksFor(1, 'home_health', false)[2]).toMatchObject({ label: 'Get your free market report', url: reviewPage(), note: 'Enter your agency\'s Medicare certification number and it is emailed to you as a PDF.' });
    const second = blocksFor(2);
    expect(second.map(block => block.type)).toEqual(['message', 'cards', 'offer', 'panel']);
    expect(second[3]).toMatchObject({ button: { label: 'Start your free trial', url: trial(2) }, link: { lead: 'Your market report is still here:', label: 'Open your market report (PDF)', url: report } });
    const third = blocksFor(3).filter(Boolean);
    expect(third.map(block => block.type)).toEqual(['message', 'action', 'points']);
    expect(third[2].link).toMatchObject({ url: trial(3), label: `start a ${products.intel.trialDays}-day free trial on one county` });
    // A nursing home's emails have no report: no card, no report button, and the trial is the one bright button.
    const nursing = blocksFor(1, 'nursing_home');
    expect(nursing.map(block => block.type)).toEqual(['message', 'features', 'stats', 'quote', 'panel']);
    expect(nursing[1]).toMatchObject({ eyebrow: 'BUILT FOR THE WORK OF FILLING BEDS', title: 'What CareMetric Intel does for your nursing home, every day' });
    expect(nursing[4]).toMatchObject({ title: 'See every hospital source in your county', button: { url: trial(1), quiet: false } });
    expect(blocksFor(2, 'nursing_home')[3].link).toBeUndefined();
    expect(blocksFor(3, 'nursing_home').filter(Boolean).map(block => block.type)).toEqual(['message', 'points']);
  });
});
