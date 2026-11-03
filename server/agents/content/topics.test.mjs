import { describe, expect, it } from 'vitest';
import { allowedHost, officialSources, products } from './facts.mjs';
import { backlogProblems, chooseTopic, topics } from './topics.mjs';
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
