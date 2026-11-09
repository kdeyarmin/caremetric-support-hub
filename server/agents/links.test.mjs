import { describe, expect, it } from 'vitest';
import { articleUrl, officialSources, productPages } from './content/facts.mjs';
import {
  addressesIn, campaignTags, linkAllowed, productCode, productHosts, productSiteUrl, tagKeys, tagLinks, taggedUrl, tagsOf, tagValue, untaggedUrl,
} from './links.mjs';

const tags = { source: 'caremetric', medium: 'email', campaign: 'growth-intel-touch1', content: 'control' };
const query = 'utm_source=caremetric&utm_medium=email&utm_campaign=growth-intel-touch1&utm_content=control';
const valid = value => typeof value === 'string' && value.length >= 1 && value.length <= 80 && /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(value);

describe('what may be tagged', () => {
  it('is an https address on a product site (the hosts of the product pages), nothing else', () => {
    expect(productHosts).toEqual(['cmcarebase.com', 'www.caremetricintel.com', 'caremetricadvisors.com']);
    for (const page of productPages) expect(productSiteUrl(page.url), page.url).toBe(true);
    for (const value of [
      'http://cmcarebase.com/signup', 'https://help.caremetric.ai/help/articles/x', 'https://www.cms.gov/', 'https://calendly.com/caremetric',
      'https://cmcarebase.com.evil.test/', 'https://evil.test/?u=https://cmcarebase.com/', 'https://user:pw@cmcarebase.com/', 'https://cmcarebase.com:8443/',
      'https://caremetricintel.com/', 'not a url', '', null,
    ]) expect(productSiteUrl(value), String(value)).toBe(false);
  });

  it('names products by a short code and writes values as short lowercase words', () => {
    expect([productCode('carebase'), productCode('caremetric-intel'), productCode('intel'), productCode('advisors'), productCode('breathe')]).toEqual(['carebase', 'intel', 'intel', 'advisors', null]);
    expect(tagValue('Growth Intel  Touch 1')).toBe('growth-intel-touch-1');
    expect(tagValue('trial_checkin')).toBe('trial_checkin');
    expect(tagValue('--https://evil.test/a?b=c--')).toBe('https-evil-test-a-b-c');
    expect(tagValue(null)).toBe('');
    expect(tagValue('x'.repeat(200))).toHaveLength(80);
  });
});

describe('tagging an address', () => {
  it('adds the tags in a fixed order before the fragment, and replaces tags it carried', () => {
    expect(taggedUrl('https://cmcarebase.com/signup', tags)).toBe(`https://cmcarebase.com/signup?${query}`);
    expect(taggedUrl('https://www.caremetricintel.com/#pricing', tags)).toBe(`https://www.caremetricintel.com/?${query}#pricing`);
    expect(taggedUrl('https://www.caremetricintel.com', tags)).toBe(`https://www.caremetricintel.com/?${query}`);
    expect(taggedUrl('https://cmcarebase.com/signup?utm_source=old&utm_campaign=old', { campaign: 'new', source: 'caremetric' }))
      .toBe('https://cmcarebase.com/signup?utm_source=caremetric&utm_campaign=new');
    expect(taggedUrl('https://cmcarebase.com/signup', { source: 'Face Book', medium: '', campaign: null })).toBe('https://cmcarebase.com/signup?utm_source=face-book');
  });

  it('with no tags, removes the ones it carried; it never changes another address', () => {
    expect(taggedUrl(`https://www.caremetricintel.com/?${query}#pricing`, null)).toBe('https://www.caremetricintel.com/#pricing');
    expect(taggedUrl('https://cmcarebase.com/signup', {})).toBe('https://cmcarebase.com/signup');
    for (const value of [articleUrl('assign-annual-training'), officialSources['cms-home-health'].url, 'https://calendly.com/caremetric?month=2026-11', 'https://cmcarebase.com/signup?ref=abc', 'mailto:support@caremetric.ai']) {
      expect(taggedUrl(value, tags), value).toBe(value);
    }
  });

  it('keeps every product page exactly as listed underneath its tags', () => {
    for (const page of productPages) {
      const tagged = taggedUrl(page.url, tags);
      expect(tagged, page.id).not.toBe(page.url);
      expect(untaggedUrl(tagged), page.id).toBe(page.url);
      expect(tagsOf(tagged), page.id).toEqual(tags);
      expect(linkAllowed(tagged, [page.url]), page.id).toBe(true);
      expect(new URL(tagged).searchParams.get('utm_campaign'), page.id).toBe('growth-intel-touch1');
    }
  });

  it('tags every product page in a text, keeps the punctuation after it and leaves other addresses alone', () => {
    const text = 'Try it (https://cmcarebase.com/signup). Pricing: https://cmcarebase.com/#pricing, guide https://help.caremetric.ai/help/articles/a-guide.\n[Features](https://cmcarebase.com/features) and https://www.cms.gov/x?y=1';
    expect(tagLinks(text, tags)).toBe(`Try it (https://cmcarebase.com/signup?${query}). Pricing: https://cmcarebase.com/?${query}#pricing, guide https://help.caremetric.ai/help/articles/a-guide.\n[Features](https://cmcarebase.com/features?${query}) and https://www.cms.gov/x?y=1`);
    expect(tagLinks('Start: https://cmcarebase.com/signup?utm_source=google', tags)).toBe(`Start: https://cmcarebase.com/signup?${query}`);
    // A product-site address with a query of its own is left for the checks to refuse.
    expect(tagLinks('https://cmcarebase.com/signup?next=https://evil.test', tags)).toBe('https://cmcarebase.com/signup?next=https://evil.test');
    expect(tagLinks(`https://cmcarebase.com/signup?${query}`, null)).toBe('https://cmcarebase.com/signup');
    expect(addressesIn(`See https://cmcarebase.com/signup?${query}. Or https://help.caremetric.ai/help.`)).toEqual([`https://cmcarebase.com/signup?${query}`, 'https://help.caremetric.ai/help']);
  });
});

describe('the link check', () => {
  const allowed = new Set(['https://cmcarebase.com/signup', 'https://www.caremetricintel.com/#pricing', 'https://help.caremetric.ai/help/articles/a-guide', officialSources['cms-data'].url, 'https://calendly.com/caremetric']);

  it('accepts an allowed address, plain or with well-formed tags', () => {
    expect(linkAllowed('https://cmcarebase.com/signup', allowed)).toBe(true);
    expect(linkAllowed(`https://cmcarebase.com/signup?${query}`, allowed)).toBe(true);
    expect(linkAllowed('https://cmcarebase.com/signup?utm_campaign=sales-carebase', allowed)).toBe(true);
    expect(linkAllowed(`https://www.caremetricintel.com/?${query}#pricing`, allowed)).toBe(true);
    expect(linkAllowed('https://calendly.com/caremetric', [...allowed])).toBe(true);
  });

  it('never lets a tag carry another host, path, parameter or fragment', () => {
    for (const value of [
      `https://evil.test/signup?${query}`,
      `https://cmcarebase.com.evil.test/signup?${query}`,
      `https://cmcarebase.com/signup/../admin?${query}`,
      `https://cmcarebase.com/other?${query}`,
      `https://cmcarebase.com/signup?${query}&next=https://evil.test`,
      'https://cmcarebase.com/signup?next=https://evil.test&utm_source=caremetric',
      'https://cmcarebase.com/signup?utm_source=evil.test',
      'https://cmcarebase.com/signup?utm_source=https://evil.test/',
      'https://cmcarebase.com/signup?utm_source=a/b',
      'https://cmcarebase.com/signup?utm_source=a%2Fb',
      'https://cmcarebase.com/signup?utm_source=a@b',
      'https://cmcarebase.com/signup?utm_source=Caremetric',
      'https://cmcarebase.com/signup?utm_source=',
      'https://cmcarebase.com/signup?utm_source=a&utm_source=b',
      'https://cmcarebase.com/signup?utm_term=x',
      'https://cmcarebase.com/signup?utm_source=a?utm_medium=b',
      `https://cmcarebase.com/signup?utm_source=${'a'.repeat(81)}`,
      'https://cmcarebase.com/signup?&utm_source=a',
      `https://cmcarebase.com/signup?${query}#evil`,
      'https://www.caremetricintel.com/#pricing?utm_source=a',
      `https://www.caremetricintel.com/?${query}`,
      `http://cmcarebase.com/signup?${query}`,
      `https://CMCAREBASE.com/signup?${query}`,
    ]) expect(linkAllowed(value, allowed), value).toBe(false);
  });

  it('never accepts tags on a citation, a help-center guide or the booking page', () => {
    expect(linkAllowed(`${officialSources['cms-data'].url}?${query}`, allowed)).toBe(false);
    expect(linkAllowed(`https://help.caremetric.ai/help/articles/a-guide?${query}`, allowed)).toBe(false);
    expect(linkAllowed(`https://calendly.com/caremetric?${query}`, allowed)).toBe(false);
  });
});

describe('what each agent writes', () => {
  it('uses short lowercase values, the product code and no personal data', () => {
    const written = [
      campaignTags.outreach({ product: 'caremetric-intel', touch: 2, variant: 'concise' }),
      campaignTags.success({ product: 'carebase', kind: 'trial' }),
      campaignTags.account({ product: 'caremetric-intel', template: 'trial_checkin' }),
      campaignTags.sales({ product: 'carebase', route: 'sms' }),
      campaignTags.socialPost({ platform: 'instagram', product: 'caremetric-intel', pillar: 'tip' }),
      campaignTags.socialReply({ platform: 'messenger', product: 'carebase', kind: 'message' }),
      campaignTags.ad({ platform: 'meta', product: 'carebase', content: '2026-11-09-1' }),
      campaignTags.article({ product: 'intel', slug: 'territory-planning-with-public-data' }),
      campaignTags.listing({ directory: 'software_advice', product: 'intel' }),
      campaignTags.pitch({ audience: 'provider_association', product: 'advisors' }),
    ];
    expect(written).toEqual([
      { source: 'caremetric', medium: 'email', campaign: 'growth-intel-touch2', content: 'concise' },
      { source: 'caremetric', medium: 'email', campaign: 'success-carebase-trial' },
      { source: 'caremetric', medium: 'email', campaign: 'account-intel-trial_checkin' },
      { source: 'caremetric', medium: 'sms', campaign: 'sales-carebase' },
      { source: 'instagram', medium: 'social', campaign: 'social-intel', content: 'tip' },
      { source: 'facebook', medium: 'social', campaign: 'social-carebase-reply', content: 'message' },
      { source: 'facebook', medium: 'paid_social', campaign: 'ads-carebase', content: '2026-11-09-1' },
      { source: 'help-center', medium: 'referral', campaign: 'article-intel', content: 'territory-planning-with-public-data' },
      { source: 'software_advice', medium: 'referral', campaign: 'listing-intel' },
      { source: 'partner', medium: 'email', campaign: 'pitch-advisors', content: 'provider_association' },
    ]);
    for (const item of written) for (const [key, value] of Object.entries(item)) {
      expect(tagKeys).toContain(key);
      expect(valid(value), `${key}=${value}`).toBe(true);
    }
    // A link made from any of them passes the check for its page.
    for (const item of written) expect(linkAllowed(taggedUrl('https://cmcarebase.com/signup', item), ['https://cmcarebase.com/signup'])).toBe(true);
    expect(campaignTags.sales({ product: 'carebase', route: 'fax' }).medium).toBe('email');
    expect(campaignTags.outreach({ product: 'carebase', touch: null }).campaign).toBe('growth-carebase-touch1');
  });
});
