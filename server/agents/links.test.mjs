import { describe, expect, it } from 'vitest';
import { productPages } from './content/facts.mjs';
import { campaignProduct, linkTags, productPageFor, tagLinks, taggedUrl, tagValue, untaggedUrl, untagLinks, validTagValue } from './links.mjs';

const tags = { source: 'caremetric', medium: 'email', campaign: 'growth-carebase-touch1' };

describe('taggedUrl', () => {
  it('adds source, medium, campaign and content to a product page, before its fragment', () => {
    expect(taggedUrl('https://cmcarebase.com/signup', tags)).toBe('https://cmcarebase.com/signup?utm_source=caremetric&utm_medium=email&utm_campaign=growth-carebase-touch1');
    expect(taggedUrl('https://cmcarebase.com/#pricing', { ...tags, content: 'post' })).toBe('https://cmcarebase.com/?utm_source=caremetric&utm_medium=email&utm_campaign=growth-carebase-touch1&utm_content=post#pricing');
    expect(taggedUrl('https://www.caremetricintel.com/#how-it-works', tags)).toBe('https://www.caremetricintel.com/?utm_source=caremetric&utm_medium=email&utm_campaign=growth-carebase-touch1#how-it-works');
  });

  it('leaves every address that is not exactly a product page as it is: citations, the help center, unsubscribe and booking links', () => {
    for (const url of [
      'https://www.pacodeandbulletin.gov/secure/pacode/data/055/chapter2600/s2600.132.html',
      'https://help.caremetric.ai/help/articles/assign-annual-training',
      'https://cmcarebase.com/app/help',
      'https://hub.example.test/api/growth/unsubscribe/abc',
      'https://calendly.com/caremetric/intro',
      'https://cmcarebase.com',
      'https://cmcarebase.com/signup?ref=1',
    ]) expect(taggedUrl(url, tags)).toBe(url);
  });

  it('refuses a missing or unsafe tag value rather than writing it', () => {
    expect(() => taggedUrl('https://cmcarebase.com/', { source: 'caremetric', medium: 'email' })).toThrow(/utm_campaign/);
    for (const bad of ['Upper', 'a b', 'name@example.com', 'x/y', 'x%2F', 'x&y=z', 'x?y', '-lead', 'a'.repeat(41), '']) {
      expect(() => taggedUrl('https://cmcarebase.com/', { ...tags, campaign: bad }), bad).toThrow();
    }
  });

  it('round-trips every product page through untaggedUrl', () => {
    for (const page of productPages) {
      expect(productPageFor(page.url)).toBe(page);
      expect(untaggedUrl(taggedUrl(page.url, { ...tags, content: 'ad' }))).toBe(page.url);
    }
  });
});

describe('untaggedUrl', () => {
  it('reads a tagged product link as its page, whatever the order of the tags', () => {
    expect(untaggedUrl('https://cmcarebase.com/signup?utm_campaign=c&utm_source=s&utm_medium=m')).toBe('https://cmcarebase.com/signup');
  });

  it('never reads anything but well-formed tags on an exact product page as one', () => {
    for (const url of [
      'https://cmcarebase.com/signup',
      'https://cmcarebase.com/signup?utm_source=s&utm_medium=m',
      'https://cmcarebase.com/signup?utm_source=s&utm_medium=m&utm_campaign=c&next=https://evil.example',
      'https://cmcarebase.com/signup?utm_source=s&utm_source=t&utm_medium=m&utm_campaign=c',
      'https://cmcarebase.com/signup?utm_source=s&utm_medium=m&utm_campaign=c&utm_term=t',
      'https://cmcarebase.com/signup?utm_source=s&utm_medium=m&utm_campaign=evil.example/x',
      'https://cmcarebase.com/signup?utm_source=s&utm_medium=m&utm_campaign=x=person@example.com',
      'https://cmcarebase.com/signup?utm_source=s&utm_medium=m&utm_campaign=x=y',
      'https://cmcarebase.com/signup?utm_source=s@evil.example&utm_medium=m&utm_campaign=c',
      'https://cmcarebase.com/signup?utm_source=%2F%2Fevil&utm_medium=m&utm_campaign=c',
      'https://cmcarebase.com/signup?utm_source=&utm_medium=m&utm_campaign=c',
      'https://cmcarebase.com/signup?utm_source=s&utm_medium=m&utm_campaign=c#frag',
      'https://cmcarebase.com/other?utm_source=s&utm_medium=m&utm_campaign=c',
      'https://cmcarebase.com.evil.example/signup?utm_source=s&utm_medium=m&utm_campaign=c',
      'https://user@cmcarebase.com/signup?utm_source=s&utm_medium=m&utm_campaign=c',
      'http://cmcarebase.com/signup?utm_source=s&utm_medium=m&utm_campaign=c',
      'https://evil.example/?utm_source=s&utm_medium=m&utm_campaign=c',
    ]) expect(untaggedUrl(url), url).toBeNull();
  });
});

describe('tagLinks and untagLinks', () => {
  it('tag product pages in text and Markdown, keep punctuation, and leave other addresses alone', () => {
    const text = 'Start here: https://cmcarebase.com/signup.\nSee [features](https://cmcarebase.com/features) and https://help.caremetric.ai/help/articles/x';
    const tagged = tagLinks(text, tags);
    expect(tagged).toBe('Start here: https://cmcarebase.com/signup?utm_source=caremetric&utm_medium=email&utm_campaign=growth-carebase-touch1.\nSee [features](https://cmcarebase.com/features?utm_source=caremetric&utm_medium=email&utm_campaign=growth-carebase-touch1) and https://help.caremetric.ai/help/articles/x');
    expect(untagLinks(tagged)).toBe(text);
  });

  it('replace well-formed tags already on a product page with the agent\'s own', () => {
    expect(tagLinks('https://cmcarebase.com/signup?utm_source=x&utm_medium=y&utm_campaign=z', tags)).toBe(taggedUrl('https://cmcarebase.com/signup', tags));
  });

  it('leave a malformed tag as written, so the link check that follows refuses it', () => {
    expect(tagLinks('https://cmcarebase.com/signup?utm_source=x&next=y', tags)).toBe('https://cmcarebase.com/signup?utm_source=x&next=y');
    const text = 'https://cmcarebase.com/signup?utm_source=s&utm_medium=m&utm_campaign=c&next=https://evil.example';
    expect(untagLinks(text)).toBe(text);
  });
});

describe('the tags each agent uses', () => {
  it('are short, lowercase and free of personal data', () => {
    expect(linkTags.growthOutreach('carebase', 2)).toEqual({ source: 'caremetric', medium: 'email', campaign: 'growth-carebase-touch2' });
    expect(linkTags.growthOutreach('caremetric-intel', 1)).toEqual({ source: 'caremetric', medium: 'email', campaign: 'growth-intel-touch1' });
    expect(linkTags.accountEmail('caremetric-intel', 'onboarding')).toEqual({ source: 'caremetric', medium: 'email', campaign: 'account-intel-onboarding' });
    expect(linkTags.sales('carebase', 'sms')).toEqual({ source: 'caremetric', medium: 'sms', campaign: 'sales-carebase' });
    expect(linkTags.social('instagram', 'carebase', 'reply')).toEqual({ source: 'instagram', medium: 'social', campaign: 'social-carebase', content: 'reply' });
    expect(linkTags.social('messenger', null, 'reply')).toMatchObject({ source: 'facebook', campaign: 'social-caremetric' });
    expect(linkTags.social('linkedin', 'caremetric-intel', 'ad', { paid: true })).toEqual({ source: 'linkedin', medium: 'paid_social', campaign: 'social-intel', content: 'ad' });
    expect(linkTags.article('advisors')).toEqual({ source: 'help_center', medium: 'article', campaign: 'content-advisors' });
    expect(linkTags.listing('software_advice', 'intel')).toEqual({ source: 'software-advice', medium: 'directory', campaign: 'outreach-intel' });
    expect(campaignProduct('unknown')).toBe('caremetric');
    expect(tagValue('Growth', 'CareBase', 'touch 3')).toBe('growth-carebase-touch-3');
    expect(validTagValue('paid_social')).toBe(true);
    expect(() => tagValue('—')).toThrow();
  });
});
