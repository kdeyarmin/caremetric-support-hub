import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  allowedAmounts, allowedHost, allowedPercents, articleUrl, citationHosts, claims, factSheetText, legalDisclaimer, officialSources, productPages, products,
} from './facts.mjs';

const doc = readFileSync(new URL('../../../docs/GTM_FACTS.md', import.meta.url), 'utf8');

describe('the fact sheet', () => {
  it('states every price, percentage and trial length the agent may use in docs/GTM_FACTS.md as well', () => {
    expect(allowedAmounts.length).toBeGreaterThan(25);
    for (const amount of allowedAmounts) expect(doc, amount).toContain(amount);
    for (const percent of allowedPercents) expect(doc, percent).toContain(percent);
    expect(allowedPercents).toEqual(['17%', '50%']);
    expect(products.carebase.trialDays).toBe(30);
    expect(doc).toContain('a **30-day** free trial');
    expect(products.intel.trialDays).toBe(14);
    expect(doc).toContain('a **14-day** free trial');
    expect(products.advisors.trialDays).toBeNull();
  });

  it('uses the live per-facility CareBase price, never the retired flat $499 package', () => {
    expect(allowedAmounts).toContain('$199');
    expect(allowedAmounts).not.toContain('$499');
    expect(factSheetText()).not.toContain('$499');
    expect(products.carebase.pricing[0]).toMatch(/^CareBase Core: \$199 per facility per month/);
    expect(doc).toMatch(/CareBase Core is \$199 per facility per month/);
    expect(doc).toMatch(/MARKETING_SITE_REDESIGN_HANDOFF\.md[\s\S]{0,200}\$499/);
  });

  it('distinguishes base claims from the authorized sale and names each source', () => {
    expect(doc).toContain('base product and claims facts remain "owner to confirm"');
    expect(doc).toContain('Founders Sale was requested by the owner on 2026-11-08');
    for (const product of Object.values(products)) expect(product.source).toMatch(/^kdeyarmin\/[A-Za-z]+@[0-9a-f]{7} /);
    for (const file of ['marketingPricing.ts', 'About.tsx', 'planLimits.ts', 'marketing-copy.md', 'competitive-marketing-review.md', 'site-content.mjs']) expect(doc, file).toContain(file);
  });

  it('preserves legacy founding terms without offering them to new applicants', () => {
    const offer = products.carebase.offers.find(line => line.startsWith('Legacy founding partners'));
    expect(offer).toMatch(/pricing held for as long as they subscribe/);
    expect(offer).toMatch(/do not offer lifetime pricing to new applicants/);
    expect(offer).not.toMatch(/\bcall\b/i);
    expect(doc).toContain('founding-partner pricing locked for as long as they subscribe');
  });

  it('keeps the sale duration, renewal, exclusions and assisted trial redemption with both products', () => {
    for (const product of [products.carebase, products.intel]) {
      const offer = product.offers.find(line => line.startsWith('Founders Sale:'));
      expect(offer).toContain('50% off');
      expect(offer).toContain('first 12 months of paid service');
      expect(offer).toContain('including existing free-trial users');
      expect(offer).toContain('when paid service starts');
      expect(offer).toContain('Standard pricing resumes');
      expect(offer).toContain('custom contracts are excluded');
      expect(offer).toContain('Other promotional discounts cannot be combined');
      expect(offer).toContain('applied automatically');
    }
    expect(products.advisors.offers.join(' ')).not.toContain('FOUNDERS50');
  });

  it('allows a listed host and its subdomains, and nothing that merely contains one', () => {
    for (const host of ['pa.gov', 'www.pa.gov', 'dhs.pa.gov', 'www.pacodeandbulletin.gov', 'palegis.us', 'data.cms.gov', 'www.census.gov', 'cmcarebase.com', 'www.caremetricintel.com', 'help.caremetric.ai']) {
      expect(allowedHost(host), host).toBe(true);
    }
    for (const host of ['evilpa.gov', 'pa.gov.evil.test', 'cmcarebase.com.evil.test', 'caremetric.ai', 'example.com', '', null]) expect(allowedHost(host), String(host)).toBe(false);
    for (const host of citationHosts) expect(doc, host).toContain(host);
  });

  it('lists only https links and sources on allowed hosts, each once', () => {
    const urls = [...Object.values(officialSources).map(source => source.url), ...productPages.map(page => page.url)];
    expect(new Set(urls).size).toBe(urls.length);
    expect(new Set(productPages.map(page => page.id)).size).toBe(productPages.length);
    for (const value of urls) {
      const url = new URL(value);
      expect(url.protocol, value).toBe('https:');
      expect(allowedHost(url.hostname), value).toBe(true);
    }
    // The CareBase and Intel sites answer 200 for any path, so pricing is linked where it lives, on the home page.
    expect(productPages.find(page => page.id === 'carebase-pricing').url).toBe('https://cmcarebase.com/#pricing');
    expect(productPages.find(page => page.id === 'intel-pricing').url).toBe('https://www.caremetricintel.com/#pricing');
    for (const label of [...Object.values(officialSources).map(source => source.label), ...productPages.map(page => page.label)]) {
      expect(label, label).not.toMatch(/assisted living residence|\bALR\b|auditor/i);
    }
  });

  it('shows the model the vocabulary, the claims it may not make and the disclaimer wording', () => {
    const text = factSheetText();
    for (const words of ['Assisted Living Facility', 'surveyors', '"prove" or "proof"', 'text only', 'You may never say:']) expect(text, words).toContain(words);
    expect(claims.mayNot.join(' ')).toMatch(/ensures compliance/);
    expect(legalDisclaimer).toMatch(/not legal advice/);
    expect(articleUrl('pa-fire-drills')).toBe('https://help.caremetric.ai/help/articles/pa-fire-drills');
    expect(factSheetText()).toBe(text);
  });
});
