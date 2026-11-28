import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { campaignName, launchSequences, segments, utmCampaigns } from './copy.mjs';

const fixture = async name => JSON.parse(await readFile(new URL(`./fixtures/pa-${name}.json`, import.meta.url), 'utf8'));
const all = sequences => JSON.stringify(sequences);

describe('the owner\'s cold email copy', () => {
  it('is, for Pennsylvania, word for word the campaigns built by hand on 2026-11-28', async () => {
    const pa = launchSequences('PA');
    expect(pa.agency).toEqual(await fixture('hh'));
    expect(pa.snf).toEqual(await fixture('snf'));
    expect(pa.local).toEqual(await fixture('snf_local'));
    expect(pa.chain).toEqual(await fixture('chain'));
    expect(pa.regional).toEqual(await fixture('regional'));
  });

  it('names the state only in its links', () => {
    const oh = launchSequences('OH'); const pa = launchSequences('PA');
    expect(utmCampaigns('OH')).toEqual({ agency: 'oh-starter', snf: 'oh-snf', local: 'oh-snf-local', chain: 'oh-chain', regional: 'oh-regional' });
    for (const segment of segments) {
      expect(all(oh[segment]).replaceAll(`utm_campaign=${utmCampaigns('OH')[segment]}`, `utm_campaign=${utmCampaigns('PA')[segment]}`)).toBe(all(pa[segment]));
    }
    expect(() => utmCampaigns('Ohio')).toThrow();
  });

  it('keeps the owner\'s rules: no telephone number, no discount as a number, the trial, and "Dr." for everyone but his local nursing homes', () => {
    const oh = launchSequences('OH');
    for (const segment of segments) {
      const text = all(oh[segment]);
      expect(text, segment).not.toMatch(/814|\(\d{3}\)|\d{3}[-.\s]\d{3}[-.\s]\d{4}/);
      expect(text, segment).not.toContain('%');
      expect(text, segment).toContain('free for 30 days');
      expect(text, segment).toContain('no credit card required');
      expect(text, segment).toContain('Founders discounts');
      expect(text, segment).toContain('{{county}}');
      expect(text, segment).toContain('Reply \\"no thanks\\"');
      expect(oh[segment][0].steps.map(step => step.delay)).toEqual([0, 3, 5]);
    }
    expect(all(oh.local)).not.toContain('Dr. Kevin');
    expect(all(oh.local)).toContain('We may already know each other.');
    for (const segment of ['agency', 'snf', 'chain', 'regional']) expect(all(oh[segment]), segment).toContain('Dr. Kevin Deyarmin, ND, MSW, CHPCA, NCG');
  });

  it('names each campaign as Pennsylvania\'s', () => {
    expect(campaignName('OH', 'snf', 'Ohio')).toBe('Ohio – Skilled nursing administrators');
    expect(campaignName('OH', 'chain', 'Ohio')).toBe('Ohio – Chains – corporate');
  });
});
