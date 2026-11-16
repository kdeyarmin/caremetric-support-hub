import { describe, expect, it } from 'vitest';
import { legalDisclaimer, officialSources } from './facts.mjs';
import { catalogNumbers, featuresText } from './features.mjs';
import { fireDrillDraft, referralDraft } from './fixtures.mjs';
import { topics } from './topics.mjs';
import { allowedNumbers, allowedUrl, checkArticle, checkDraft, limits, markupProblems, normalizeTerms, numbersIn, previewOf, textProblems, unclearCopy } from './validate.mjs';

const topic = key => topics.find(item => item.key === key);
const fire = topic('pa-fire-drill-requirements');
const referral = topic('home-health-referral-marketing');
const check = (over = {}, which = fire) => checkDraft({ ...(which === fire ? fireDrillDraft : referralDraft), ...over }, { topic: which, promptVersion: 'content.1' });
const reasons = (over, which) => check(over, which).reasons ?? [];
// A sentence added to the end of the body, so one rule at a time can be made to fail.
const withSentence = (sentence, which = fire) => ({ body: `${(which === fire ? fireDrillDraft : referralDraft).body}\n\n${sentence}` });

describe('an article that passes', () => {
  it('accepts the authorized temporary sale while still rejecting an unlisted discount', () => {
    const offer = 'Founders Sale applies automatically to eligible subscriptions: 50% off for the first 12 months of paid service, then standard pricing resumes. Other promotions cannot be combined.';
    expect(reasons(withSentence(offer))).toEqual([]);
    expect(reasons(withSentence(offer, referral), referral)).toEqual([]);
    expect(reasons(withSentence(offer.replace('50%', '60%')))).toContain('unlisted_number');
  });

  it('becomes exactly the action input: address, product, topic, kind, title, description and the assembled Markdown', () => {
    const result = check();
    expect(result.ok).toBe(true);
    expect(Object.keys(result.article).sort()).toEqual(['body', 'description', 'kind', 'product', 'promptVersion', 'slug', 'title', 'topic']);
    expect(result.article).toMatchObject({ slug: fireDrillDraft.slug, product: 'carebase', topic: 'pa-fire-drill-requirements', kind: 'regulation', title: fireDrillDraft.title, description: fireDrillDraft.metaDescription, promptVersion: 'content.1' });
    const { body } = result.article;
    expect(body.startsWith(`**In short:** ${fireDrillDraft.summary}\n\n${fireDrillDraft.body.slice(0, 40)}`)).toBe(true);
    expect(body).toContain('## Frequently asked questions\n\n### How often must a Pennsylvania personal care home hold a fire drill?\n\nAt least once a month');
    expect(body).toContain(`## Sources\n\n- [55 Pa. Code § 2600.132, fire drills](${officialSources['pacode-2600-132'].url})`);
    // Product pages carry the Content Marketer's campaign tags; the official sources it cites never do.
    const tags = '?utm_source=help_center&utm_medium=article&utm_campaign=content-carebase';
    expect(body).toContain(`## Learn more\n\n- [CareBase features](https://cmcarebase.com/features${tags})\n- [Free survey readiness guide](https://cmcarebase.com/survey-readiness-guide${tags})`);
    expect(body).not.toMatch(/pacodeandbulletin\.gov[^)\s]*utm_/);
    expect(body.endsWith(`*${legalDisclaimer}*`)).toBe(true);
    expect(checkArticle(result.article)).toEqual([]);
  });

  it('is previewed whole, with the address it will live at, and fits the action', () => {
    const { preview, article } = check();
    expect(preview.split('\n').slice(0, 4)).toEqual([
      'Publish on the public help center: https://help.caremetric.ai/help/articles/pennsylvania-personal-care-home-alf-fire-drill-requirements',
      'Product: CareMetric CareBase', `Title: ${fireDrillDraft.title}`, `Description: ${fireDrillDraft.metaDescription}`,
    ]);
    expect(preview.endsWith(article.body)).toBe(true);
    expect(preview).toBe(previewOf(article));
    expect(preview.length).toBeLessThanOrEqual(limits.preview);
  });

  it('carries the disclaimer only for a regulation, and a marketing article may say "proof" when it is not about CareBase', () => {
    const result = check({}, referral);
    expect(result.ok).toBe(true);
    expect(result.article).toMatchObject({ product: 'caremetric-intel', kind: 'marketing' });
    // An Intel article lives on Intel's website; the preview names that address first, then the help-center copy.
    expect(result.preview.split('\n').slice(0, 3)).toEqual([
      `Publish on CareMetric Intel's website: https://www.caremetricintel.com/resources/${result.article.slug}`,
      `Also readable in the help center (its canonical link points to the address above): https://help.caremetric.ai/help/articles/${result.article.slug}`,
      'Product: CareMetric Intel',
    ]);
    expect(result.preview.length).toBeLessThanOrEqual(limits.preview);
    expect(result.article.body).not.toContain('not legal advice');
    expect(check(withSentence('Recorded referrals are the proof that matters.', referral), referral).ok).toBe(true);
  });

  it('turns a top-level heading into a section heading, one title per page', () => {
    const result = check({ body: fireDrillDraft.body.replace('## How often drills happen', '# How often drills happen') });
    expect(result.ok).toBe(true);
    expect(result.rewrites).toBe(1);
    expect(result.article.body).toContain('\n## How often drills happen\n');
  });
});

describe('the fixed vocabulary', () => {
  it('rewrites Assisted Living Residence, ALR, auditors and a state audit where the meaning is plain', () => {
    expect(normalizeTerms('Assisted Living Residences and ALR staff met the DHS auditor; two ALRs saw the auditors after the state audit. assisted living residence'))
      .toEqual({ text: 'Assisted Living Facilities and ALF staff met the DHS surveyor; two ALFs saw the surveyors after the state inspection. assisted living facility', rewrites: 7, ambiguous: false });
    const result = check({ title: 'Fire drill requirements for Pennsylvania personal care homes and ALRs', body: fireDrillDraft.body.replace('a surveyor can follow', 'an auditor can follow') });
    expect(result.ok).toBe(true);
    expect(result.rewrites).toBe(2);
    expect(result.article.title).toBe('Fire drill requirements for Pennsylvania personal care homes and ALFs');
    expect(result.article.body).toContain('a surveyor can follow');
    expect(result.article.body).not.toMatch(/auditor|\bALR/);
  });

  it('rejects an auditor of another kind, which no rewrite can fix', () => {
    expect(normalizeTerms('Ask your financial auditor.').ambiguous).toBe(true);
    expect(reasons(withSentence('Ask your financial auditor about the records.'))).toContain('ambiguous_term');
    expect(textProblems('The auditor left.')).toContain('vocabulary');
  });
});

describe('each check that rejects a draft', () => {
  it('holds the shape: title, address, description, summary, outline, body and sections', () => {
    expect(reasons({ title: 'Fire drills' })).toEqual(['title_length']);
    expect(reasons({ title: 'Fire drill requirements for **Pennsylvania** homes' })).toEqual(['title_format']);
    expect(reasons({ slug: 'Fire_Drills' })).toEqual(['slug_format']);
    expect(reasons({ slug: 'short' })).toEqual(['slug_format']);
    expect(reasons({ metaDescription: 'Fire drills.' })).toEqual(['description_length']);
    expect(reasons({ summary: 'Too short.' })).toEqual(['summary_length']);
    expect(reasons({ outline: ['One', 'Two'] })).toEqual(['outline']);
    expect(reasons({ body: '## A\n\nB\n\n## C\n\nD\n\n## E\n\nF' })).toEqual(['body_length']);
    expect(reasons({ body: fireDrillDraft.body.replaceAll('\n## ', '\n### ') })).toEqual(['structure']);
    expect(reasons(withSentence('## Sources\n\nSee the regulation.'))).toEqual(['structure']);
  });

  it('holds the questions, the internal links and the citations to their counts', () => {
    expect(reasons({ faq: fireDrillDraft.faq.slice(0, 1) })).toEqual(['faq']);
    expect(reasons({ faq: [{ ...fireDrillDraft.faq[0], question: 'Fire drills are monthly.' }, fireDrillDraft.faq[1]] })).toEqual(['faq']);
    expect(reasons({ internalLinks: [] })).toEqual(['internal_links']);
    expect(reasons({ internalLinks: ['carebase-features', 'somewhere-else'] })).toEqual(['internal_links']);
    expect(reasons({ citations: [] })).toEqual(['citation_count']);
    expect(check({ citations: [] }, referral).ok).toBe(true);
  });

  it('allows citations only to https addresses on the allowed hosts, and only the curated official sources', () => {
    expect(reasons({ citations: ['http://www.pacodeandbulletin.gov/secure/pacode/data/055/chapter2600/s2600.132.html'] })).toEqual(['citation_host']);
    expect(reasons({ citations: ['https://www.example.com/fire-drills'] })).toEqual(['citation_host']);
    expect(reasons({ citations: ['https://pa.gov.example.com/fire'] })).toEqual(['citation_host']);
    expect(reasons({ citations: ['https://user:pass@www.pa.gov/'] })).toEqual(['citation_host']);
    expect(reasons({ citations: ['https://www.pa.gov/an-invented-page'] })).toEqual(['citation_unlisted']);
    expect(allowedUrl('https://dhs.pa.gov/x')?.hostname).toBe('dhs.pa.gov');
    expect(allowedUrl('https://www.pa.gov:8443/x')).toBeNull();
  });

  it('allows links in the body only to curated addresses, and no HTML, images or tables', () => {
    expect(reasons(withSentence('See [the rule](https://www.example.com/rule).'))).toEqual(['link_not_allowed']);
    expect(reasons(withSentence('See [the rule](javascript:alert(1)).'))).toEqual(['link_not_allowed']);
    expect(reasons(withSentence('See https://www.pa.gov/another-page for more.'))).toEqual(['link_unlisted']);
    expect(reasons(withSentence(`See [§ 2600.132](${officialSources['pacode-2600-132'].url}).`))).toEqual([]);
    expect(reasons(withSentence('A <b>bold</b> claim.'))).toEqual(['html']);
    expect(reasons(withSentence('<script>alert(1)</script>'))).toEqual(['html']);
    expect(reasons(withSentence('![A poster](https://cmcarebase.com/poster.png)'))).toContain('unsupported_markup');
    expect(reasons(withSentence('| Drill | Month |\n| --- | --- |\n| Fire | Monthly |'))).toEqual(['unsupported_markup']);
  });

  it('allows only the prices, percentages and numbers the fact sheet and the topic state', () => {
    expect(reasons(withSentence('CareBase Core is $199 per facility per month.'))).toEqual([]);
    expect(reasons(withSentence('CareBase costs $4 per resident.'))).toEqual(['unlisted_price']);
    expect(reasons(withSentence('Teams cut survey preparation by 40%.'))).toEqual(['unlisted_number']);
    expect(reasons(withSentence('Teams save 10 hours a week.'))).toEqual(['unlisted_number']);
    expect(reasons(withSentence('Keep drill records for 3 years.'))).toEqual(['unlisted_number']);
    // The numbers the product's own published catalog states count for an article about that product (tasks/content.mjs passes it).
    const intelArticle = { ...referralDraft, body: `${referralDraft.body}\n\nCareMetric Intel lists accounts that go 45 days without a visit.` };
    expect(checkDraft(intelArticle, { topic: referral, promptVersion: 'content.3' }).reasons).toContain('unlisted_number');
    expect(checkDraft(intelArticle, { topic: referral, promptVersion: 'content.3', features: featuresText(referral.product) }).reasons ?? []).not.toContain('unlisted_number');
    expect(reasons(withSentence('Keep drill records for three years.'))).toEqual(['unlisted_number']);
    // Decimals are part of the number: a listed $199 does not allow $199.99, and the topic's 6 months does not allow 6.5.
    expect(reasons(withSentence('CareBase Core is $199.99 per facility per month.'))).toEqual(['unlisted_price']);
    expect(reasons(withSentence('CareBase Core is $199.00 per facility per month.'))).toEqual([]);
    expect(reasons(withSentence('A yearly plan costs $1,299.50.'))).toEqual(['unlisted_price']);
    expect(reasons(withSentence('Intel Starter is $349.50 per month.', referral), referral)).toEqual(['unlisted_price']);
    expect(reasons(withSentence('Intel Starter is $349 per month.', referral), referral)).toEqual([]);
    expect(reasons(withSentence('A CareBase trial lasts 30.9 days.'))).toEqual(['unlisted_number']);
    expect(reasons(withSentence('A CareBase trial lasts 30 days.'))).toEqual([]);
    expect(reasons(withSentence('A yearly plan costs $1,990.00 per facility.'))).toEqual([]);
    expect(reasons(withSentence('Hold a sleeping-hours drill every 6.5 months.'))).toEqual(['unlisted_number']);
    expect(reasons(withSentence('Hold a sleeping-hours drill every 6.0 months.'))).toEqual([]);
    expect(reasons(withSentence('Annual billing saves about 17.5% on Intel.', referral), referral)).toEqual(['unlisted_number']);
    expect(reasons(withSentence('Annual billing saves about 17.0% on Intel.', referral), referral)).toEqual([]);
    // Section numbers, chapters and the topic's own numbers are not counts.
    expect(reasons(withSentence('Chapter 2600 homes and § 2800.132 residences follow the same 6 months rule, and a CareBase trial lasts 30 days.'))).toEqual([]);
    const allowed = allowedNumbers(['once every 6 months']);
    expect(allowed.has('6:month')).toBe(true);
    expect(allowed.has('30:day')).toBe(true);
    expect(numbersIn('16-hour training, sixteen hours, 40 scheduled working hours, 3 marketer seats, 1,200 residents, 2026 rules, Chapter 2800 homes'))
      .toEqual(['16:hour', '40:hour', '3:staff', '1200:resident']);
    expect(numbersIn('6.5 months, 6.0 months, 1,299.50 residents, § 2600.132(c) and 2800.132 homes, Chapters 2600 and 2800 homes'))
      .toEqual(['6.5:month', '6:month', '1299.5:resident']);
    expect(allowed.has('6.5:month')).toBe(false);
  });

  it('reads "N+" as the number N with its unit, so "3,200+ counties" is checked like "3,200 counties"', () => {
    expect(numbersIn('3,200+ counties')).toEqual(['3200:county']);
    expect(numbersIn('3,200+ counties, 33,000+ ZIP areas, 500 + facilities, 10,000+ staff, 150+ public healthcare datasets, ten+ hours'))
      .toEqual(['3200:county', '33000:zip', '500:facility', '10000:staff', '150:dataset', '10:hour']);
    // An age group, a "+" with no unit after it and a "+" between two counts give no number of their own (Intel's catalog writes the first).
    expect(numbersIn('Residents 65+, 75+ and 85+, and 65+ households living alone; residents aged 65+; 60+ document templates')).toEqual([]);
    expect(numbersIn('3 marketer seats + 1 manager')).toEqual(['3:staff']);
    // Regulation numbers are still names, and prices and percentages keep their own checks.
    expect(numbersIn('Chapter 2600+ homes and § 2800.132 + 2600.132 residences')).toEqual([]);
    expect(reasons(withSentence('CareBase costs $4+ per resident.'))).toEqual(['unlisted_price']);
    expect(reasons(withSentence('Teams cut survey preparation by 40%+.'))).toEqual(['unlisted_number']);
    // A count no source states is refused, for an article, and for outreach, sales and social copy (catalogNumbers).
    for (const sentence of ['CareBase is used in 500+ facilities.', 'CareBase is used in 500 + facilities.', 'Teams of 10,000+ staff use it.'])
      expect(reasons(withSentence(sentence)), sentence).toEqual(['unlisted_number']);
    expect(textProblems('CareMetric Intel covers 4,000+ counties and 40,000+ ZIP areas.', { product: 'intel', numbers: catalogNumbers('intel') })).toEqual(['unlisted_number']);
    // A count the product's catalog states may be written with "+".
    const intelArticle = { ...referralDraft, body: `${referralDraft.body}\n\nCareMetric Intel lists accounts that go 45+ days without a visit.` };
    expect(checkDraft(intelArticle, { topic: referral, promptVersion: 'content.3' }).reasons).toContain('unlisted_number');
    expect(checkDraft(intelArticle, { topic: referral, promptVersion: 'content.3', features: featuresText(referral.product) }).reasons ?? []).not.toContain('unlisted_number');
  });

  it('treats "150+" and "more than 150" as the same count: either one on the fact sheet or a catalog allows both, and no other count', () => {
    for (const source of ['150+ public healthcare datasets', 'More than 150 public healthcare datasets']) {
      const numbers = allowedNumbers([source]);
      for (const sentence of ['Intel draws on 150+ public healthcare datasets.', 'Intel draws on more than 150 public healthcare datasets.', 'Intel draws on 150 + datasets.'])
        expect(textProblems(sentence, { product: 'intel', numbers }), `${source}: ${sentence}`).toEqual([]);
      expect(textProblems('Intel draws on 200+ public healthcare datasets.', { product: 'intel', numbers }), source).toEqual(['unlisted_number']);
    }
    // The owner approved the figures Intel's site publishes about its data on 2026-11-16 ("By the numbers" in its catalog): copy about
    // Intel may state them as the site words them, or as "more than", and no other count.
    const intel = catalogNumbers('intel');
    for (const sentence of ['Intel draws on 150+ public healthcare datasets.', 'Intel draws on more than 150 public healthcare datasets.', 'Intel covers 33,000+ ZIP areas and 3,200+ counties.'])
      expect(textProblems(sentence, { product: 'intel', numbers: intel }), sentence).toEqual([]);
    for (const sentence of ['Intel draws on 200+ public healthcare datasets.', 'Intel covers 40,000+ ZIP areas.', 'Intel covers 3,300+ counties.'])
      expect(textProblems(sentence, { product: 'intel', numbers: intel }), sentence).toEqual(['unlisted_number']);
    // They are Intel's figures: copy about CareBase may state none of them.
    expect(textProblems('CareBase draws on 150+ public healthcare datasets.', { product: 'carebase', numbers: catalogNumbers('carebase') })).toEqual(['unlisted_number']);
  });

  it('reads a number past the country before its unit, so "3,200 U.S. counties" is checked like "3,200 counties"', () => {
    for (const text of ['3,200 U.S. counties', '3,200+ U.S. counties', '3,200 U. S. counties', '3,200 US counties', '3,200 U.S.A. counties', '3,200 American counties'])
      expect(numbersIn(text), text).toEqual(['3200:county']);
    expect(numbersIn('33,000+ U.S. ZIP areas, 50 U.S. states')).toEqual(['33000:zip', '50:state']);
    // "U.S." and "us" with no count after them give no number of their own.
    expect(numbersIn('2020 U.S. Census data; join 3 of us; 3 USB drives; 3,200 counties in the U.S.')).toEqual(['3200:county']);
    // Copy about Intel may state its published figures with the country, and no other figure; copy about CareBase may state none.
    expect(textProblems('CareMetric Intel covers 3,200+ U.S. counties and 33,000+ U.S. ZIP areas.', { product: 'intel', numbers: catalogNumbers('intel') })).toEqual([]);
    expect(textProblems('CareMetric Intel covers 4,000 U.S. counties.', { product: 'intel', numbers: catalogNumbers('intel') })).toEqual(['unlisted_number']);
    expect(reasons(withSentence('CareBase is used in 500 U.S. facilities.'))).toEqual(['unlisted_number']);
  });

  it('reads a number past a describing word before its unit, so "3,200 rural counties" is checked like "3,200 counties"', () => {
    for (const [text, pair] of [['3,200 rural counties', '3200:county'], ['500 Pennsylvania homes', '500:facility'], ['500 Pennsylvania personal care homes', '500:facility'],
      ['500 family-owned homes', '500:facility'], ['500 U.S.-based agencies', '500:facility'], ['10 Medicare-certified agencies', '10:facility'],
      ['14 more trial days', '14:day'], ['2 unanswered leads', '2:referral']]) expect(numbersIn(text), text).toEqual([pair]);
    // The phrase ends first at a function word, at a plural that is its own subject, or at a measure the number belongs to.
    expect(numbersIn('3 questions your staff ask; 2 ways to save hours; 4 things caregivers wish; 5 mistakes nurses make; a 5 star rating; 4 star agencies; a 30 second video; 40 percent of homes'))
      .toEqual([]);
    // A hyphenated number and a year take only the words the reader knows, as before.
    expect(numbersIn('a 30-second video; In 2026 survey deficiencies rose; By 2027 most homes; 24-hour-a-day support')).toEqual(['24:hour']);
    expect(numbersIn('12 month-to-month plans, 65 year-old residents')).toEqual(['12:month', '65:year']);
    // "and" or "or" joins two describing words; a number right after a label names a step, not a count.
    for (const text of ['3,200 rural and urban counties', '3,200 rural or urban counties']) expect(numbersIn(text), text).toEqual(['3200:county']);
    expect(numbersIn('2 new and existing customers; 3 rural and the counties; 5 tips and resident stories')).toEqual(['2:customer']);
    expect(numbersIn('Step 2 Train staff; Steps 2 and 3 cover staff training; Tip 3 staff; Touch 2 leads; No. 1 referral source; #1 referral source')).toEqual([]);
    expect(numbersIn('each year 12 hours of training')).toEqual(['12:hour']);
    // A Markdown heading's marker is not a label: its count is read, so a draft cannot slip one past the check in a section heading.
    for (const text of ['## 500 homes use CareBase', '# 500 homes', '### 500 rural homes', '# 500 + homes']) expect(numbersIn(text), text).toEqual(['500:facility']);
    expect(textProblems('## 500 homes use CareBase', { numbers: allowedNumbers([]) })).toEqual(['unlisted_number']);
    expect(numbersIn('Step #2 staff, ##1 staff')).toEqual(['1:staff']);
    // A count no source states is refused; one the catalog states may be written with a describing word.
    expect(reasons(withSentence('CareBase is used in 500 Pennsylvania homes.'))).toEqual(['unlisted_number']);
    expect(reasons(withSentence('CareBase is used in 500 rural and urban homes.'))).toEqual(['unlisted_number']);
    expect(textProblems('CareMetric Intel covers 3,200+ rural counties.', { product: 'intel', numbers: catalogNumbers('intel') })).toEqual([]);
    expect(textProblems('CareMetric Intel covers 4,000 rural counties.', { product: 'intel', numbers: catalogNumbers('intel') })).toEqual(['unlisted_number']);
  });

  it('rejects guarantees, compliance assurances and certifications', () => {
    expect(reasons(withSentence('We guarantee a clean survey.'))).toContain('guarantee');
    for (const sentence of ['CareBase ensures compliance with Chapter 2600.', 'It keeps your home compliant.', 'Pass your next inspection with CareBase.',
      'Become survey-proof.', 'Avoid all citations.', 'Your home will be fully compliant.', 'Never get cited again.']) {
      expect(reasons(withSentence(sentence)), sentence).toContain('compliance_assurance');
    }
    for (const sentence of ['CareBase is HIPAA-certified.', 'CareBase is approved by the Department.', 'It is endorsed by the state.', '99.9% uptime.']) {
      expect(reasons(withSentence(sentence)), sentence).toContain('certification_claim');
    }
  });

  it('rejects voice or phone AI and a call or a demo as a step, but not a marketer who makes calls', () => {
    expect(reasons(withSentence('Our AI answers your calls after hours.'))).toEqual(['voice_claim']);
    expect(reasons(withSentence('A voice assistant reads the record aloud.'))).toEqual(['voice_claim']);
    expect(reasons(withSentence('Book a demo to see it.'))).toEqual(['call_offer']);
    expect(reasons(withSentence('Call us to get started.'))).toEqual(['call_offer']);
    expect(reasons(withSentence('Liaisons make calls to physician offices and schedule visits.', referral), referral)).toEqual([]);
  });

  it('rejects competitors, testimonials, a claim to be an AI, and "prove", "proof" or "evidence" about CareBase', () => {
    expect(reasons(withSentence('Unlike PointClickCare, it is simple.'))).toEqual(['competitor_named']);
    expect(reasons(withSentence('Our customers love it.'))).toEqual(['testimonial']);
    expect(reasons(withSentence('As an AI, I recommend monthly drills.'))).toEqual(['ai_mention']);
    expect(reasons(withSentence('Records prove the drill happened.'))).toEqual(['prove_word']);
    // The owner confirmed on 2026-11-08 that "evidence" is avoided in everything about CareBase, articles included.
    expect(reasons(withSentence('Keep evidence of each drill for the surveyor.'))).toEqual(['prove_word']);
    expect(reasons(withSentence('Keep proof of every drill.'))).toEqual(['prove_word']);
  });

  it('rejects personal or health information and contact details', () => {
    for (const sentence of ['A resident named Pat fell during the drill.', 'Her SSN is 123-45-6789.', 'Mrs. Example led the drill.', 'Medical record number 12345678 was misplaced.']) {
      expect(reasons(withSentence(sentence)), sentence).toEqual(['personal_information']);
    }
    // The founder named on the fact sheet may be named.
    expect(reasons(withSentence('Dr. Kevin C. Deyarmin founded CareMetric.'))).toEqual([]);
    expect(reasons(withSentence('Email pat@example.com with questions.'))).toEqual(['contact_detail']);
    expect(reasons(withSentence('Call 555-123-4567 for help.'))).toEqual(['contact_detail']);
    expect(reasons(withSentence('Founding partners can email hello@caremetric.ai.'))).toEqual([]);
  });

  it('rejects an article too long to preview whole', () => {
    const long = 'Plan each drill with the shift lead and review it with staff afterwards, writing down what went well and what to change next time. ';
    const result = check({
      body: `${fireDrillDraft.body}\n\n## Reviewing each drill\n\n${long.repeat(19)}`.slice(0, limits.body[1]),
      faq: Array.from({ length: 4 }, (_, index) => ({ question: `What should drill review number ${['one', 'two', 'three', 'four'][index]} cover for staff?`, answer: long.repeat(3).slice(0, 440) })),
    });
    expect(result.reasons).toEqual(['too_long']);
  });
});

describe('the last check before publishing', () => {
  const stored = check().article;
  it('passes the stored article as proposed', () => expect(checkArticle(stored)).toEqual([]));

  it('accepts a product page with well-formed campaign tags and refuses a tag that carries anything else', () => {
    expect(stored.body).toContain('https://cmcarebase.com/features?utm_source=help_center&utm_medium=article&utm_campaign=content-carebase');
    expect(markupProblems('See [features](https://cmcarebase.com/features?utm_source=a&utm_medium=b&utm_campaign=c).')).toEqual([]);
    expect(markupProblems('See https://www.caremetricintel.com/county-report?utm_source=a&utm_medium=b&utm_campaign=c')).toEqual([]);
    for (const url of [
      'https://cmcarebase.com/features?utm_source=a&utm_medium=b&utm_campaign=c&next=https://evil.example',
      'https://cmcarebase.com/features?utm_source=a&utm_medium=b&utm_campaign=evil.example/x',
      'https://cmcarebase.com/not-a-page?utm_source=a&utm_medium=b&utm_campaign=c',
      'https://help.caremetric.ai/help/articles/x?utm_source=a&utm_medium=b&utm_campaign=c',
    ]) expect(markupProblems(`See [it](${url})`), url).toEqual(['link_unlisted']);
    expect(markupProblems('See [it](https://evil.example/?utm_source=a&utm_medium=b&utm_campaign=c)')).toEqual(['link_not_allowed']);
    expect(checkArticle({ ...stored, body: stored.body.replace('utm_campaign=content-carebase', 'utm_campaign=content-carebase&to=evil') })).toEqual(['link_unlisted']);
  });

  it('refuses a stored article that lost its disclaimer, gained markup or a claim, or names an unknown product', () => {
    expect(checkArticle({ ...stored, body: stored.body.replace(legalDisclaimer, 'General information only.') })).toEqual(['missing_disclaimer']);
    expect(checkArticle({ ...stored, body: `${stored.body}\n\n<img src=x onerror=alert(1)>` })).toEqual(['html']);
    expect(checkArticle({ ...stored, body: `${stored.body}\n\nCareBase ensures compliance.` })).toEqual(['compliance_assurance']);
    expect(checkArticle({ ...stored, product: 'pennsync' })).toEqual(['product_unknown']);
    expect(checkArticle({ ...stored, slug: 'Not A Slug' })).toEqual(['slug_format']);
    expect(checkArticle(null)).toEqual(expect.arrayContaining(['slug_format', 'product_unknown', 'title_length', 'body_length']));
  });
});

describe('plain language (owner direction 2026-11-12)', () => {
  it('passes plain, concrete copy, checklists and video beats', () => {
    expect(unclearCopy('Plan the week\'s visits around the accounts that need them. Start a free trial.')).toEqual([]);
    expect(unclearCopy('Territory map\nVisit log\nReferral funnel')).toEqual([]);
    expect(unclearCopy('Free trial. No card.')).toEqual([]);
    expect(unclearCopy('Counties with elevated readmissions are on the map. See https://www.caremetricintel.com/a.b.c')).toEqual([]);
  });

  it('refuses empty buzzwords, strings of fragments and overlong sentences', () => {
    expect(unclearCopy('Unlock smarter referral outreach.')).toEqual(['empty_words']);
    expect(unclearCopy('A seamless solution for your team.')).toEqual(['empty_words']);
    expect(unclearCopy('Territory. Clarity. Growth.')).toEqual(['fragments']);
    expect(unclearCopy(`${Array.from({ length: 31 }, () => 'word').join(' ')}.`)).toEqual(['long_sentence']);
  });
});

describe('Intel trial terms', () => {
  it('refuses copy about Intel that says its trial needs no card, and keeps the true terms', () => {
    for (const text of ['Try it free for 30 days, no credit card.', 'Start a free trial with no card required.', 'The trial needs no payment details.', 'A credit card is not required for the trial.'])
      expect(textProblems(text, { product: 'intel' }), text).toContain('trial_terms');
    expect(textProblems('CareMetric Intel is free for 30 days without a credit card.')).toContain('trial_terms');
    expect(textProblems('A 30-day free trial. A credit card is required to start the trial, and the plan chosen at sign-up bills automatically when the trial ends unless it is canceled before then.', { product: 'intel' })).not.toContain('trial_terms');
    // CareBase trials are unchanged.
    expect(textProblems('Try it free with no credit card.', { product: 'carebase' })).not.toContain('trial_terms');
  });
});
