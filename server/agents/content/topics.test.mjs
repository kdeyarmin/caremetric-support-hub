import { describe, expect, it } from 'vitest';
import { allowedHost, officialSources, products } from './facts.mjs';
import { backlogProblems, chooseTopic, countyTopic, queryMatches, quarterTag, rewriteAfterDays, topics } from './topics.mjs';
import { numbersIn } from './validate.mjs';

const now = new Date('2026-11-03T13:00:00Z');
const daysAgo = days => new Date(now.getTime() - days * 86_400_000).toISOString();
const byKey = key => topics.find(topic => topic.key === key);
// Shaped as private.agent_content_state returns it: the product is the Hub's slug (caremetric-intel), never the backlog's key (intel).
const article = (key, status, at = daysAgo(1)) => ({ topic: key, slug: byKey(key)?.slug ?? `${key}-slug`, product: products[byKey(key)?.product ?? 'carebase'].slug, status, at });

describe('the topic backlog', () => {
  it('is well formed: unique keys and slugs, known products, sources and pages', () => {
    expect(backlogProblems()).toEqual([]);
    expect(topics.length).toBeGreaterThanOrEqual(12);
    // Intel is the one product the team markets: its backlog must last months at two articles a week, not three weeks.
    expect(topics.filter(topic => topic.product === 'intel').length).toBeGreaterThanOrEqual(12);
    expect(new Set(topics.map(topic => topic.product))).toEqual(new Set(['carebase', 'intel', 'advisors']));
    expect(backlogProblems([...topics, { ...topics[0] }])).toEqual(expect.arrayContaining([`${topics[0].key}: duplicate key`, `${topics[0].key}: duplicate slug`]));
    expect(backlogProblems([{ ...topics[0], key: 'x-y', slug: 'x-y', sources: ['nowhere'], links: ['nowhere'] }])).toEqual(['x-y: unknown source nowhere', 'x-y: unknown page nowhere']);
  });

  it('covers the regulations, surveyor readiness and the other products the owner named', () => {
    const keys = topics.map(topic => topic.key);
    for (const key of ['pa-surveyor-visit-readiness', 'pa-annual-inspection-records', 'pa-staff-training-hours', 'pa-fire-drill-requirements', 'pa-reportable-incidents',
      'pa-medication-administration-training', 'pa-resident-rights-notices', 'home-health-referral-marketing', 'county-market-data-outreach', 'pch-alf-acquisition-review']) {
      expect(keys, key).toContain(key);
    }
  });

  it('cites a section for every regulation fact, from official sources only, in the fixed vocabulary', () => {
    for (const topic of topics) {
      for (const source of topic.sources) expect(allowedHost(new URL(officialSources[source].url).hostname), source).toBe(true);
      const text = [topic.title, topic.angle, topic.audience, ...topic.facts].join(' ');
      expect(text, topic.key).not.toMatch(/assisted living residence|\bALR\b|auditor|\bprove|\bproof\b/i);
      if (topic.kind === 'regulation') for (const fact of topic.facts) expect(fact, `${topic.key}: ${fact}`).toMatch(/§|Chapter|pa\.gov/);
    }
    // The numbers the regulation facts state are the ones an article may repeat.
    expect(numbersIn(byKey('pa-staff-training-hours').facts.join(' '))).toEqual(expect.arrayContaining(['12:hour', '16:hour', '4:hour', '30:day', '2:hour', '40:hour']));
    expect(numbersIn(byKey('pa-reportable-incidents').facts.join(' '))).toContain('24:hour');
  });
});

describe('choosing the next topic', () => {
  it('starts with the highest priority, in backlog order, so the choice is deterministic', () => {
    expect(chooseTopic({ now }).key).toBe('pa-chapter-2600-vs-2800');
    expect(chooseTopic({ now })).toBe(chooseTopic({ now }));
  });

  it('skips a topic that is published or still waiting for the owner, whatever its address', () => {
    // (The next CareBase topic would follow, but the last article was about CareBase, so another product's turn comes first.)
    for (const status of ['executed', 'proposed', 'approved', 'auto_approved', 'executing']) {
      expect(chooseTopic({ articles: [article('pa-chapter-2600-vs-2800', status)], now }).key, status).toBe('home-health-referral-marketing');
      expect(chooseTopic({ articles: [article('pa-chapter-2600-vs-2800', status), article('home-health-referral-marketing', status, daysAgo(0))], now }).key, status)
        .toBe('pa-surveyor-visit-readiness');
    }
  });

  it('leaves a rejected topic alone for 90 days and tries an expired or failed one again at once', () => {
    expect(chooseTopic({ articles: [article('pa-chapter-2600-vs-2800', 'rejected', daysAgo(30))], now }).key).toBe('pa-surveyor-visit-readiness');
    expect(chooseTopic({ articles: [article('pa-chapter-2600-vs-2800', 'rejected', daysAgo(91))], now }).key).toBe('pa-chapter-2600-vs-2800');
    for (const status of ['expired', 'failed']) expect(chooseTopic({ articles: [article('pa-chapter-2600-vs-2800', status)], now }).key, status).toBe('pa-chapter-2600-vs-2800');
  });

  it('skips a topic whose suggested address another article already uses', () => {
    expect(chooseTopic({ takenSlugs: [byKey('pa-chapter-2600-vs-2800').slug], now }).key).toBe('pa-surveyor-visit-readiness');
    // The address a live article holds is taken too, even when it was published for another topic.
    expect(chooseTopic({ articles: [{ topic: 'retired-topic', slug: byKey('pa-chapter-2600-vs-2800').slug, product: 'caremetric-intel', status: 'executed', at: daysAgo(3) }], now }).key)
      .toBe('pa-surveyor-visit-readiness');
  });

  it('turns towards the product whose inbox questions have been busiest, by counts alone', () => {
    const questions = [{ product: 'caremetric-intel', inquiryType: 'sales', conversations: 12 }, { product: 'carebase', inquiryType: 'technical_support', conversations: 1 }];
    expect(chooseTopic({ questions, now }).key).toBe('home-health-referral-marketing');
    expect(chooseTopic({ questions: [{ product: 'advisors', inquiryType: 'advisors', conversations: 40 }], now }).product).toBe('advisors');
    expect(chooseTopic({ questions: [{ product: 'none', inquiryType: 'unclassified', conversations: 50 }], now }).key).toBe('pa-chapter-2600-vs-2800');
  });

  it('steps away from Intel too, whose articles the database names caremetric-intel', () => {
    expect(article('home-health-referral-marketing', 'executed').product).toBe('caremetric-intel');
    // A few Intel sales questions lift the next Intel topic just above the next CareBase one...
    const questions = [{ product: 'caremetric-intel', inquiryType: 'sales', conversations: 2 }];
    const intelFirst = [article('home-health-referral-marketing', 'executed', daysAgo(10)), article('pa-chapter-2600-vs-2800', 'executed', daysAgo(1))];
    expect(chooseTopic({ articles: intelFirst, questions, now }).key).toBe('county-market-data-outreach');
    // ...unless the last article was about Intel, which then steps back.
    const intelLast = [article('pa-chapter-2600-vs-2800', 'executed', daysAgo(10)), article('home-health-referral-marketing', 'executed', daysAgo(1))];
    expect(chooseTopic({ articles: intelLast, questions, now }).key).toBe('pa-surveyor-visit-readiness');
  });

  it('steps away from the product the last article was about', () => {
    const articles = [article('pa-chapter-2600-vs-2800', 'executed', daysAgo(7))];
    expect(chooseTopic({ articles, now }).product).not.toBe('carebase');
    expect(chooseTopic({ articles, now }).key).toBe('home-health-referral-marketing');
  });

  it('answers null when every topic is taken', () => {
    expect(chooseTopic({ articles: topics.map(topic => article(topic.key, 'executed')), now })).toBeNull();
    expect(chooseTopic({ backlog: [], now })).toBeNull();
  });
});

describe('reach outside cold email (team review 2026-11-17, stage 6)', () => {
  it('puts Intel\'s free market report first in every Intel article\'s suggested pages', () => {
    for (const item of topics.filter(entry => entry.product === 'intel')) expect(item.links[0], item.key).toBe('intel-market-review');
    for (const item of topics.filter(entry => entry.product !== 'intel')) expect(item.links, item.key).not.toContain('intel-market-review');
  });

  it('makes a county topic from a roster county, with no figure, pointing to the county and market reports', () => {
    const lancaster = countyTopic({ countyFips: '42071', state: 'PA', name: 'Lancaster County' });
    expect(lancaster).toMatchObject({ key: 'county-42071', product: 'intel', slug: 'home-health-hospice-lancaster-county-pa',
      title: 'Home health and hospice in Lancaster County, PA: what to look at in the market', links: ['intel-county-report', 'intel-market-review', 'intel-home'] });
    expect(backlogProblems([lancaster])).toEqual([]);
    expect(lancaster.facts.flatMap(numbersIn)).toEqual([]);
    expect(countyTopic({ countyFips: '22071', state: 'LA', name: 'Orleans Parish' })).toMatchObject({ slug: 'home-health-hospice-orleans-parish-la', title: 'Home health and hospice in Orleans Parish, LA: what to look at in the market' });
    expect(countyTopic({ countyFips: '02290', state: 'AK', name: 'Yukon-Koyukuk census area' }).title).toContain('Yukon-Koyukuk Census Area, AK');
    // Every other kind of name Intel sends: an independent city is not the county of the same name, accents stay in the title and are folded in the slug.
    const city = countyTopic({ countyFips: '51760', state: 'VA', name: 'Richmond city' });
    const county = countyTopic({ countyFips: '51159', state: 'VA', name: 'Richmond County' });
    expect(city).toMatchObject({ slug: 'home-health-hospice-richmond-city-va', title: 'Home health and hospice in Richmond City, VA: what to look at in the market' });
    expect(county.slug).toBe('home-health-hospice-richmond-county-va');
    expect(city.angle).toContain('State no figure about the city');
    expect(countyTopic({ countyFips: '35013', state: 'NM', name: 'Doña Ana County' })).toMatchObject({ slug: 'home-health-hospice-dona-ana-county-nm', title: expect.stringContaining('in Doña Ana County, NM:') });
    expect(countyTopic({ countyFips: '11001', state: 'DC', name: 'District of Columbia' })).toMatchObject({ slug: 'home-health-hospice-washington-dc', title: expect.stringContaining('in Washington, DC:') });
    expect(countyTopic({ countyFips: '09110', state: 'CT', name: 'Capitol Planning Region' }).angle).toContain('about the planning region');
    expect(countyTopic({ countyFips: '72001', state: 'PR', name: 'Adjuntas Municipio' }).slug).toBe('home-health-hospice-adjuntas-municipio-pr');
    expect(backlogProblems([city, county, countyTopic({ countyFips: '11001', state: 'DC', name: 'District of Columbia' })])).toEqual([]);
    for (const bad of [{ countyFips: '4207', state: 'PA', name: 'Lancaster' }, { countyFips: '42071', state: 'pa', name: 'Lancaster' }, { countyFips: '42071', state: 'PA', name: '' }]) {
      expect(countyTopic(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('nudges a topic up when people search for its keywords, by at most one', () => {
    const intel = topics.filter(entry => entry.product === 'intel');
    const target = intel.find(entry => entry.keywords.length > 0 && entry.priority === Math.min(...intel.map(item => item.priority)));
    const queries = target.keywords.map(keyword => `best ${keyword.toLowerCase()} near me`);
    expect(queryMatches(target, queries)).toBe(target.keywords.filter(keyword => keyword.split(/\s+/).some(word => word.length > 3)).length);
    expect(queryMatches(target, ['nothing to see'])).toBe(0);
    const plain = chooseTopic({ backlog: [topics[0], target], now });
    const searched = chooseTopic({ backlog: [{ ...topics[0], priority: target.priority + 0.5 }, target], queries, now });
    expect(plain.key).toBe(topics[0].key);
    expect(searched.key).toBe(target.key);
  });

  it('writes a topic again a quarter after it was published, under the quarter\'s own address, and only when asked', () => {
    const item = topics[0];
    const old = [article(item.key, 'executed', daysAgo(rewriteAfterDays + 1))];
    expect(chooseTopic({ backlog: [item], articles: old, now })).toBeNull();
    const again = chooseTopic({ backlog: [item], articles: old, now, rewrite: true });
    expect(again).toMatchObject({ key: item.key, rewrite: true, slug: `${item.slug.slice(0, 72)}-2026-q4` });
    expect(again.angle).toContain('write it afresh');
    expect(quarterTag(new Date('2027-02-01T00:00:00Z'))).toBe('2027-q1');
    // Published within the quarter, or the quarter's article already written or waiting: not again.
    expect(chooseTopic({ backlog: [item], articles: [article(item.key, 'executed', daysAgo(30))], now, rewrite: true })).toBeNull();
    expect(chooseTopic({ backlog: [item], articles: old, takenSlugs: [`${item.slug.slice(0, 72)}-2026-q4`], now, rewrite: true })).toBeNull();
  });
});
