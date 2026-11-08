import { describe, expect, it } from 'vitest';
import { productPages } from '../agents/content/facts.mjs';
import { allowedNumbers, textProblems } from '../agents/content/validate.mjs';
import {
  discoveryQuery, discoveryQueryCount, lifecyclePlay, linkablePages, operatorHost, playbookText, playbookVersion, salesPlaybook, sequencePlan, touchAngle,
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

  it('keeps CareBase discovery inside Pennsylvania and finds a new search every day', () => {
    const start = new Date('2026-11-08T13:00:00Z');
    const carebase = Array.from({ length: discoveryQueryCount('carebase') }, (_, index) => discoveryQuery('carebase', new Date(start.getTime() + index * day)));
    expect(carebase.every(query => / PA$/.test(query))).toBe(true);
    expect(new Set(carebase).size).toBe(carebase.length);
    const intel = Array.from({ length: 30 }, (_, index) => discoveryQuery('caremetric-intel', new Date(start.getTime() + index * day)));
    expect(new Set(intel).size).toBe(30);
    expect(intel.every(query => /home health|hospice/.test(query))).toBe(true);
    expect(discoveryQuery('breathe', start)).toBeNull();
  });

  it('uses the Eastern calendar day, so a late-evening and an early-morning run on the same day search the same thing', () => {
    expect(discoveryQuery('carebase', new Date('2026-11-08T05:30:00Z'))).toBe(discoveryQuery('carebase', new Date('2026-11-09T04:30:00Z')));
    expect(discoveryQuery('carebase', new Date('2026-11-09T04:30:00Z'))).not.toBe(discoveryQuery('carebase', new Date('2026-11-09T05:30:00Z')));
  });

  it('drops directories, social networks, job boards and government sites from discovery', () => {
    for (const host of ['www.aplaceformom.com', 'caring.com', 'pa.gov', 'www.dhs.pa.gov', 'medicare.gov', 'www.indeed.com', 'en.wikipedia.org', 'facebook.com', 'psu.edu', 'county.pa.us'])
      expect(operatorHost(host), host).toBe(false);
    for (const host of ['maplegrovepch.com', 'www.sunrise-care.org', 'example-hospice.net']) expect(operatorHost(host), host).toBe(true);
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
});
