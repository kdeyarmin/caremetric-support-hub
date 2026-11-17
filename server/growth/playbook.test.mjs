import { describe, expect, it } from 'vitest';
import { products, productPages, trialCardTerms, trialMention } from '../agents/content/facts.mjs';
import { allowedNumbers, textProblems } from '../agents/content/validate.mjs';
import {
  discoveryPages, discoveryQueries, discoveryQueriesPerDay, discoveryQuery, discoveryQueryCount, inboundSequence, intelSetting, lifecyclePlay, linkablePages, offersMeeting, operatorHost, playbookText, playbookVersion, quietPlays, reaskAngle,
  reportCloseAngle, reportTouchAngle, reviewFollowupAngle, reviewTouchAngle, salesPlaybook, sequencePlan, shortFormLimits, touchAngle, unviewedTouchAngle, viewedTouchAngle,
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
    expect(intel.every(search => /home health|hospice|skilled nursing facility|nursing and rehabilitation/.test(search.query))).toBe(true);
    // Nursing homes are a primary audience (owner decision 2026-11-16): searched in every pass, the first of them before the hospice agencies.
    const firstOf = pattern => intel.findIndex(search => pattern.test(search.query));
    expect(firstOf(/skilled nursing facility/)).toBeGreaterThan(-1);
    expect(firstOf(/nursing and rehabilitation center/)).toBeGreaterThan(-1);
    expect(firstOf(/skilled nursing facility/)).toBeLessThan(firstOf(/"hospice agency"/));
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

  it('tells a nursing home from a home health or hospice agency by its name, then by its research, and doubts toward the agency', () => {
    const said = (...claims) => claims.map((claim, index) => ({ id: `e${index}`, claim }));
    expect(intelSetting({ name: 'Sunrise Nursing & Rehabilitation Center' })).toBe('nursing_home');
    expect(intelSetting({ name: 'Maple Grove Skilled Nursing Facility' })).toBe('nursing_home');
    expect(intelSetting({ name: 'Oak Ridge', evidence: said('Oak Ridge is a 120-bed nursing home with short-term rehabilitation.') })).toBe('nursing_home');
    // An agency's name decides, whatever its pages mention; "skilled nursing" alone is a home health service.
    expect(intelSetting({ name: 'Valley Home Health', evidence: said('We work with every nursing home in the county.') })).toBeNull();
    expect(intelSetting({ name: 'Riverbend', evidence: said('Skilled nursing, physical therapy and aides in your home.') })).toBeNull();
    // A nursing home's research that also speaks of hospice or home health stays with the agency's email.
    expect(intelSetting({ name: 'Oak Ridge', evidence: said('A nursing home that also runs a hospice program.') })).toBeNull();
    expect(intelSetting({ name: 'Oak Ridge', evidence: said('Nursing home care for seniors.') })).toBe('nursing_home');
    expect(intelSetting({ name: 'Acme Health' })).toBeNull();
    expect(intelSetting()).toBeNull();
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

  it('gives a CareMetric Intel agency three emails around its market report: the report alone, then the trial, then a short close (owner decision 2026-11-17)', () => {
    expect(playbookVersion).toBe('sales-playbook.6');
    expect(shortFormLimits).toEqual({ words: 120, questions: 1 });
    // Six plans, each its own job.
    const plans = [reportTouchAngle, reviewTouchAngle, viewedTouchAngle, unviewedTouchAngle, reviewFollowupAngle, reportCloseAngle];
    expect(new Set(plans).size).toBe(6);
    // The first: the report offered in the first sentence, one link, one question, no trial.
    for (const first of [reportTouchAngle, reviewTouchAngle]) {
      expect(first).toMatch(/^First email, built around /);
      expect(first).toMatch(/That sentence is what the reader sees in their inbox beside the subject, so it holds the offer and nothing else\./);
      expect(first).toMatch(/Never state or hint at the agency's own figure, rank or rating: the reader opens the report to see them\./);
      expect(first).toMatch(/you run a home health and hospice agency, and you built CareMetric Intel to see your own market this way/);
      expect(first).toMatch(/No other link, no free trial and no price: those come in the next email\./);
      expect(first).not.toMatch(/Founders Sale|risk-free|three questions|two links/);
    }
    // The second offers the trial; the third does not, and leaves the report with the reader.
    for (const second of [viewedTouchAngle, unviewedTouchAngle, reviewFollowupAngle]) expect(second).toMatch(/free trial on one county they serve/);
    expect(reportCloseAngle).toMatch(/^Third and last email: a short close of about fifty words\./);
    expect(reportCloseAngle).toMatch(/No new pitch, no free trial/);
    // None tells the writer to call or meet, and the words each uses for the report's physicians pass the standing check (standing.mjs).
    for (const plan of plans) {
      expect(offersMeeting(plan)).toBe(false);
      expect(plan).not.toMatch(/ranks? highest|ranked highest/);
    }
  });

  it('never tells a writer to volunteer the card a CareMetric Intel trial needs, and answers plainly when a reader asks (owner direction 2026-11-17)', () => {
    const book = salesPlaybook['caremetric-intel'];
    // What a writer may say about the trial, and the answers that mention it, no longer carry the card.
    expect(book.valuePoints).toContain(`A ${products.intel.trialDays}-day free trial on one county, started online.`);
    for (const line of [...book.valuePoints, ...book.qualifyingQuestions, ...book.pains, ...book.triggers]) expect(line, line).not.toMatch(/credit card|\bcard\b|canceling before/i);
    for (const key of ['timing', 'demo', 'price', 'results']) expect(book.objections.find(objection => objection.key === key).answer, key).not.toMatch(/credit card|canceling before/i);
    expect(book.objections.find(objection => objection.key === 'timing').answer).toMatch(/30-day free trial can start whenever suits them/);
    expect(book.objections.find(objection => objection.key === 'demo').answer).toMatch(/the 30-day free trial on one county, and answers to any question by email\.$/);
    // One answer holds the terms, as the fact sheet words them, for a reader who asks; it never denies the card.
    const asked = book.objections.find(objection => objection.key === 'trial_terms');
    expect(asked.when).toBe('They ask what the trial needs, whether it needs a card, or what happens when it ends.');
    expect(asked.answer.toLowerCase()).toContain(trialCardTerms.toLowerCase().replace(/\.$/, ''));
    expect(asked.answer).toMatch(/Say this only when they ask\. Never bring it up unasked, and never say a card is not needed\.$/);
    expect(book.objections.filter(objection => /credit card/i.test(objection.answer)).map(objection => objection.key)).toEqual(['trial_terms']);
    expect(playbookText()).toContain('- trial_terms (They ask what the trial needs, whether it needs a card, or what happens when it ends.)');
    // No outreach plan of any kind asks for the terms: the first three emails, a website lead's, a re-ask and the quiet follow-ups.
    const plans = [reportTouchAngle, reviewTouchAngle, viewedTouchAngle, unviewedTouchAngle, reviewFollowupAngle, reportCloseAngle, ...sequencePlan.map(step => step.angle),
      ...inboundSequence.map(step => step.angle), reaskAngle, ...Object.values(quietPlays)];
    for (const plan of plans) expect(plan, plan.slice(0, 40)).not.toMatch(/credit card is required|canceling before it ends|card terms|say (?:in one plain clause )?that a credit card/i);
    // The fact sheet carries the rule for every writer, beside the terms it still states.
    expect(trialMention).toBe('Offer the free trial in plain words: its length and what it covers. Do not bring up the credit card or how billing starts. State those terms, exactly as written above, only when the reader asks what the trial needs or what happens when it ends. Never say that no card is needed, and never call the trial risk-free.');
    expect(products.intel.trialMention).toBe(trialMention);
    expect(products.carebase.trialMention).toBeUndefined();
    // CareBase's trial needs no card, and its playbook never spoke of one.
    expect(JSON.stringify(salesPlaybook.carebase)).not.toMatch(/credit card/i);
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
      'Pick a time each month to review training records.', 'Start a free trial; a credit card is required.', 'Use the chat on our website.',
      'Meeting the annual training requirement takes planning.', 'Hold a short meeting with your staff each month to review training.', 'A brief note: the trial covers one county.', 'No call needed: start the free trial.', '', null,
    ]) expect(offersMeeting(text), String(text)).toBe(false);
  });
});
