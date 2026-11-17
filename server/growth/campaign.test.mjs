import { describe, expect, it } from 'vitest';
import { campaignBlock, campaignBlocks, campaignEyebrow, campaignTouches, dataFigures, featurePoints, founderQuote, readCampaign, reportTiles, reviewPage, shortPoints, weekSteps, withCampaign } from './campaign.mjs';
import { callsDataPublic, namesCard, outdatedWords, productNumbers } from './draft.mjs';
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
const links = (touch, own = true) => ({ trialUrl: trial(touch), reportUrl: own ? report : reviewPage(), ownReport: own });
const withoutLinks = text => text.replace(/https?:\/\/\S+/g, ' ');

describe('the marketing sections of an email to a CareMetric Intel agency (email review 2026-11-17)', () => {
  it('says what the software does, in the founder\'s words, and offers the trial, in every email', () => {
    const first = campaignBlock(1, links(1));
    expect(first).toMatch(/^What CareMetric Intel does for your agency, every day\n\n1\. Finds every referral source\n/);
    for (const [title, text] of featurePoints) { expect(first).toContain(title); expect(first).toContain(text); }
    expect(featurePoints).toHaveLength(5);
    expect(first).toContain(`"${founderQuote}"`);
    expect(first).toContain(`Try CareMetric Intel free for ${products.intel.trialDays} days on one county, with your own team. No demo to sit through, and the prices are on our website.\n${trial(1)}`);
    expect(first).toMatch(/A question first\? Reply to this email and I will answer it\.$/);
    const second = campaignBlock(2, links(2));
    expect(second).toMatch(/^A week in CareMetric Intel\n\nMonday: Pick who to see\n/);
    expect(weekSteps.map(step => step.tag)).toEqual(['Monday', 'Every day', 'After each visit', 'Friday']);
    expect(second).toContain('Founders Sale: 50% off your first 12 months\n50% off eligible subscription charges for the first 12 months of paid service. It is applied automatically when your paid plan starts, with no code needed.');
    expect(second).toContain(`Try it on your county, free for ${products.intel.trialDays} days\nYour own county, your own team. No demo to sit through, and the prices are on our website.\n${trial(2)}`);
    expect(second).toMatch(new RegExp(`Your market report is still here:\\n${report.replace(/[.]/g, '\\.')}$`));
    const third = campaignBlock(3, links(3));
    expect(third).toMatch(new RegExp(`^Your market report:\\n${report.replace(/[.]/g, '\\.')}\\n\\nWhat CareMetric Intel does\\n\\n- Finds every referral source in your counties, ranked from Medicare data\\.`));
    expect(third).toMatch(new RegExp(`Whenever the time is right, start a ${products.intel.trialDays}-day free trial on one county:\\n`));
    expect(shortPoints).toHaveLength(3);
    // An agency with no report of its own is sent to the page where it gets one.
    expect(campaignBlock(2, links(2, false))).toContain(`Your free market report is one step away:\n${reviewPage()}`);
    expect(campaignBlock(3, links(3, false))).toMatch(/^Your free market report:\n/);
    // Nothing to add without a trial link, for another touch, or (after the first email) without the report's link.
    expect(campaignBlock(1, {})).toBeNull();
    expect(campaignBlock(4, links(1))).toBeNull();
    expect(campaignBlock(2, { trialUrl: trial(2) })).toBeNull();
  });

  it('keeps every rule a written email keeps: the fact sheet\'s numbers, no card, no "public", no rank, no demo and nothing about opens', () => {
    const numbers = productNumbers(product);
    for (const touch of campaignTouches) for (const own of [true, false]) {
      const block = campaignBlock(touch, links(touch, own));
      const words = withoutLinks(block);
      const label = `touch ${touch}, ${own ? 'own report' : 'page'}`;
      expect(textProblems(words, { product: 'intel', numbers }), label).toEqual([]);
      expect(unclearCopy(words), label).toEqual([]);
      expect(namesCard(product, words), label).toBe(false);
      expect(callsDataPublic(product, words), label).toBe(false);
      expect(emailStatesStanding(words), label).toBe(false);
      expect(offersMeeting(words), label).toBe(false);
      expect(mentionsOpen(words), label).toBe(false);
      expect(words, label).not.toMatch(/\bthe book\b|guarantee|risk-free|proprietary|exclusive|more referrals|\bpublic(?:ly)?\b/i);
      // The email as it is stored passes the checks made again when it is sent.
      expect(outdatedWords({ product, subject: 'Your market report', body: withCampaign(openings[touch], touch, links(touch, own)), purpose: 'marketing' }), label).toBeNull();
    }
    // The founder's words are the fact sheet's story: its own agency and need, built for it and used every day, with nothing added.
    for (const phrase of ['I run a home health and hospice agency and a healthcare consulting company.', 'find every potential referral source in my market', 'so I built CareMetric Intel', 'I use it every day']) expect(founderQuote).toContain(phrase);
    expect(founder.story.join(' ')).toContain('I run a home health and hospice agency and a healthcare consulting company.');
    // The figures are the ones Intel's own site publishes, and the report card names only what every report holds.
    expect(dataFigures.map(([value]) => value)).toEqual(['150+', 'Every NPI', '3,200+', 'Daily']);
    expect(reportTiles).toEqual(['Where you stand', 'Who leads the county', 'Top hospitals', 'Top physicians for outreach']);
  });

  it('adds the sections to the writer\'s opening and reads the whole email back when it is sent', () => {
    for (const touch of campaignTouches) for (const own of [true, false]) {
      const opening = touch === 1 && !own ? openings[1].replace(report, reviewPage()) : openings[touch];
      const body = withCampaign(opening, touch, links(touch, own));
      expect(body.startsWith(`${opening}\n\n`)).toBe(true);
      expect(body.length).toBeLessThan(4000);
      expect(readCampaign(body, { reports })).toEqual({ touch, opening, trialUrl: trial(touch), reportUrl: own ? report : reviewPage(), ownReport: own });
    }
    // An opening with nothing to add, or sections that would not fit, stay the opening alone.
    expect(withCampaign(openings[1], 1, {})).toBe(openings[1]);
    expect(withCampaign(openings[1], 1, links(1), { limit: 500 })).toBe(openings[1]);
    expect(withCampaign('', 1, links(1))).toBe('');
    // Any other email is not a campaign email: a plain letter, an older email, and one whose sections were edited after drafting.
    expect(readCampaign(openings[1], { reports })).toBeNull();
    expect(readCampaign('Would a free trial help?\n\nhttps://www.caremetricintel.com/', { reports })).toBeNull();
    const edited = withCampaign(openings[1], 1, links(1)).replace('Watches your competition', 'Beats your competition');
    expect(readCampaign(edited, { reports })).toBeNull();
    expect(readCampaign(withCampaign(openings[2], 2, links(2)).replace(trial(2), 'https://example.org/'), { reports })).toBeNull();
    expect(readCampaign('', { reports })).toBeNull();
  });

  it('lays each email out: the opening, the report\'s card and button, the sections, and the trial', () => {
    const blocksFor = (touch, own = true) => campaignBlocks(readCampaign(withCampaign(touch === 1 && !own ? openings[1].replace(report, reviewPage()) : openings[touch], touch, links(touch, own)), { reports }));
    const first = blocksFor(1);
    expect(first.map(block => block.type)).toEqual(['message', 'tiles', 'action', 'features', 'stats', 'quote', 'panel']);
    // The report's link is the card's button, never a line of the opening.
    expect(first[0].text).not.toContain(report);
    expect(first[0].text).toMatch(/^CMS counts 48 home health agencies in Erie County\./);
    expect(first[2]).toMatchObject({ label: 'Open your market report', url: report, note: 'Opens as a PDF. Nothing to sign up for.' });
    expect(first[5]).toMatchObject({ text: founderQuote, name: founder.signOff[0], role: founder.signOff[1] });
    expect(first[6].button).toMatchObject({ label: 'Start your free trial', url: trial(1) });
    expect(blocksFor(1, false)[2]).toMatchObject({ label: 'Get your free market report', url: reviewPage(), note: 'Enter your agency\'s Medicare certification number and it is emailed to you as a PDF.' });
    const second = blocksFor(2);
    expect(second.map(block => block.type)).toEqual(['message', 'cards', 'offer', 'panel']);
    expect(second[3]).toMatchObject({ button: { label: 'Start your free trial', url: trial(2) }, link: { lead: 'Your market report is still here:', label: 'Open your market report (PDF)', url: report } });
    const third = blocksFor(3);
    expect(third.map(block => block.type)).toEqual(['message', 'action', 'points']);
    expect(third[2].link).toMatchObject({ url: trial(3), label: `start a ${products.intel.trialDays}-day free trial on one county` });
    expect(campaignTouches.map(campaignEyebrow)).toEqual(['Your free market report is ready', 'From your market report to a plan', 'A last note']);
    expect(campaignEyebrow(4)).toBeNull();
  });
});
