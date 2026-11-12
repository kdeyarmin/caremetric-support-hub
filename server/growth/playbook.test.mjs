import { describe, expect, it } from 'vitest';
import { productPages } from '../agents/content/facts.mjs';
import { allowedNumbers, textProblems } from '../agents/content/validate.mjs';
import {
  discoveryPages, discoveryQueries, discoveryQueriesPerDay, discoveryQuery, discoveryQueryCount, lifecyclePlay, linkablePages, offersMeeting, operatorHost, playbookText, playbookVersion, salesPlaybook, sequencePlan, touchAngle,
} from './playbook.mjs';

const day = 86_400_000;
const numbers = allowedNumbers([]);

describe('sales playbook', () => {
  it('says nothing about a product that the fact sheet and the claim rules would refuse', () => {
    for (const book of Object.values(salesPlaybook)) {
      for (const line of [...book.valuePoints, ...book.qualifyingQuestions, book.territory, ...book.icp.fits]) {
        expect(textProblems(line, { product: book.factsKey, numbers }), line).toEqual([]);
      }
    }
  });

  it('points every next step and linkable page at the product\'s own pages from the fact sheet', () => {
    for (const [product, book] of Object.entries(salesPlaybook)) {
      expect(productPages.some(page => page.url === book.nextStep.url)).toBe(true);
      const pages = linkablePages(product);
      expect(pages.length).toBe(book.pages.length);
      expect(pages.every(page => page.product === book.factsKey)).toBe(true);
    }
    expect(linkablePages('breathe')).toEqual([]);
  });

  it('keeps CareBase discovery inside Pennsylvania and runs several new searches every day', () => {
    const start = new Date('2026-11-12T13:00:00Z');
    expect(discoveryQueriesPerDay).toBeGreaterThanOrEqual(4);
    // One pass over the whole grid: every search once, none repeated, all on the first page of results.
    const days = count => Array.from({ length: Math.ceil(count / discoveryQueriesPerDay) }, (_, index) => new Date(start.getTime() + index * day));
    const carebase = days(discoveryQueryCount('carebase')).flatMap(instant => discoveryQueries('carebase', instant));
    expect(carebase).toHaveLength(discoveryQueryCount('carebase'));
    expect(carebase.every(search => / PA$/.test(search.query) && search.offset === 0)).toBe(true);
    expect(new Set(carebase.map(search => search.query)).size).toBe(carebase.length);
    const intel = days(discoveryQueryCount('caremetric-intel')).flatMap(instant => discoveryQueries('caremetric-intel', instant));
    expect(new Set(intel.map(search => search.query)).size).toBe(discoveryQueryCount('caremetric-intel'));
    expect(intel.every(search => /home health|hospice/.test(search.query))).toBe(true);
    // Intel is sold nationally: a month of searches must not run out of new markets.
    expect(discoveryQueryCount('caremetric-intel')).toBeGreaterThanOrEqual(discoveryQueriesPerDay * 60);
    // The next pass over the grid asks for the next page of each search, then starts over after the last page.
    const pass = product => Math.ceil(discoveryQueryCount(product) / discoveryQueriesPerDay) * day;
    expect(discoveryQueries('carebase', new Date(start.getTime() + pass('carebase')))[0]).toEqual({ query: carebase[0].query, offset: 1 });
    expect(discoveryQueries('carebase', new Date(start.getTime() + discoveryPages * pass('carebase')))[0]).toEqual(carebase[0]);
    // A day before several searches a day began reads the first page.
    expect(discoveryQueries('carebase', new Date('2026-11-01T13:00:00Z')).every(search => search.offset === 0)).toBe(true);
    // The first search of the day is what one-query callers get, and it changes every day.
    expect(discoveryQuery('carebase', start)).toBe(carebase[0].query);
    expect(discoveryQuery('carebase', start)).not.toBe(discoveryQuery('carebase', new Date(start.getTime() + day)));
    expect(discoveryQueries('carebase', start, 2)).toHaveLength(2);
    expect(discoveryQueries('breathe', start)).toEqual([]);
    expect(discoveryQuery('breathe', start)).toBeNull();
  });

  it('uses the Eastern calendar day, so a late-evening and an early-morning run on the same day search the same thing', () => {
    expect(discoveryQuery('carebase', new Date('2026-11-08T05:30:00Z'))).toBe(discoveryQuery('carebase', new Date('2026-11-09T04:30:00Z')));
    expect(discoveryQuery('carebase', new Date('2026-11-09T04:30:00Z'))).not.toBe(discoveryQuery('carebase', new Date('2026-11-09T05:30:00Z')));
  });

  it('drops directories, social networks, job boards and government sites from discovery', () => {
    for (const host of ['www.aplaceformom.com', 'caring.com', 'pa.gov', 'www.dhs.pa.gov', 'medicare.gov', 'www.indeed.com', 'en.wikipedia.org', 'facebook.com', 'psu.edu', 'county.pa.us'])
      expect(operatorHost(host), host).toBe(false);
    // Directories that reached the pipeline in production, provider-number and company lookups, trade press, and hosts that name
    // themselves a directory, a listing, a review or a jobs site.
    for (const host of ['causeiq.com', 'www.senioradvice.com', 'medicarelist.com', 'homecareatlas.com', 'newlifestyles.com', 'npidb.org', 'www.zoominfo.com',
      'hospicenews.com', 'seniorcaredirectory.com', 'hospice-reviews.org', 'jobs.examplehomehealth.com', 'local.listings.example.com'])
      expect(operatorHost(host), host).toBe(false);
    for (const host of ['maplegrovepch.com', 'www.sunrise-care.org', 'example-hospice.net', 'directcarehospice.com', 'careersourcehomehealth.com'])
      expect(operatorHost(host), host).toBe(true);
  });

  it('gives each outreach touch a different job and caps the touch number', () => {
    expect(new Set(sequencePlan.map(step => step.angle)).size).toBe(sequencePlan.length);
    expect(touchAngle(1)).toBe(sequencePlan[0].angle);
    expect(touchAngle(9)).toBe(sequencePlan.at(-1).angle);
    expect(touchAngle(0)).toBe(sequencePlan[0].angle);
    expect(lifecyclePlay('trial')).toMatch(/Founders Sale .*applies automatically/);
    expect(lifecyclePlay('support')).toMatch(/No sales/);
    expect(lifecyclePlay('unknown')).toBe(lifecyclePlay('outreach'));
  });

  it('renders a constant, versioned text for the model with every product and objection', () => {
    const text = playbookText();
    expect(text).toContain(playbookVersion);
    for (const book of Object.values(salesPlaybook)) {
      expect(text).toContain(book.name);
      for (const objection of book.objections) expect(text).toContain(`- ${objection.key} (`);
    }
    expect(playbookText('carebase')).not.toContain('CareMetric Intel\n');
    expect(playbookText()).toBe(playbookText());
  });

  it('knows an offer to talk, meet or demo from a sentence that declines one or is about the reader\'s own meetings (owner decision 2026-11-09)', () => {
    for (const text of [
      'Would a short conversation about the workflow be useful?', 'Happy to set up a quick call.', 'Would you be open to a call next week?',
      'We can schedule a meeting to go over it.', 'Book a 15-minute call with us.', 'You can speak with our team any time.',
      'Pick a time that suits you: https://cal.example.com', 'Would you like a live demo?', 'Call us to get started.', 'Want a free demo?',
      'Are you available for a quick chat this week?', 'Thanks for your note.\nGrab a quick call with us here.',
    ]) expect(offersMeeting(text), text).toBe(true);
    for (const text of [
      'Hold a meeting with your staff each month.', 'Schedule a meeting with your team to review drills.', 'Reply to this email with any question.',
      'CareMetric does not do live demos or sales calls.', 'We don\'t offer a live demo, but the walkthrough shows every step.',
      'Pick a time each month to review training records.', 'Start a free trial with no credit card.', 'Use the chat on our website.',
      'Meeting the annual training requirement takes planning.', 'Hold a short meeting with your staff each month to review training.', 'A brief note: the trial covers one county.', 'No call needed: start the free trial.', '', null,
    ]) expect(offersMeeting(text), String(text)).toBe(false);
  });
});
