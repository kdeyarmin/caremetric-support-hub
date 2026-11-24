import { describe, expect, it } from 'vitest';
import { mentionedProduct, messageProduct, productNames } from './product.mjs';

describe('the product a support message is about (the Nov 24 follow-up)', () => {
  it('reads one product the message names, unmistakably, and none from an everyday word or a chip', () => {
    expect(mentionedProduct('How do I add a county in CareMetric Intel?')).toBe('caremetric-intel');
    expect(mentionedProduct('Our Intel trial ends Friday. How do I add a seat?')).toBe('caremetric-intel');
    expect(mentionedProduct('The page is slow on my Intel processor laptop')).toBeNull();
    expect(mentionedProduct('Lots of market intel in your email, thanks')).toBeNull();
    expect(mentionedProduct('Where is the staff roster in CareBase?')).toBe('carebase');
    expect(mentionedProduct('the carebase login page will not load')).toBe('carebase');
    expect(mentionedProduct('Our Breathe app shows no residents')).toBe('breathe');
    expect(mentionedProduct('CareMetric Breathe question')).toBe('breathe');
    // A clinical "breathe" is never the product.
    expect(mentionedProduct('A resident could not breathe well overnight. Breathe deeply and rest.')).toBeNull();
    // Two products named: nobody can tell which.
    expect(mentionedProduct('We use CareBase and are trying Intel')).toBeNull();
    expect(mentionedProduct('')).toBeNull();
    expect(mentionedProduct(null)).toBeNull();
  });

  it('takes the conversation\'s product first, then the sender\'s, then the one the message names', () => {
    expect(messageProduct({ productSlug: 'carebase', senderProduct: 'caremetric-intel', body: 'About the Breathe app' })).toEqual({ slug: 'carebase', source: 'conversation' });
    expect(messageProduct({ productSlug: null, senderProduct: 'caremetric-intel', body: 'CareBase question' })).toEqual({ slug: 'caremetric-intel', source: 'sender' });
    expect(messageProduct({ productSlug: null, senderProduct: null, subject: 'CareBase export', body: 'How?' })).toEqual({ slug: 'carebase', source: 'mention' });
    expect(messageProduct({ productSlug: null, senderProduct: null, subject: null, body: 'How do I export a report?' })).toEqual({ slug: null, source: null });
    // Anything that is not a product slug is ignored.
    expect(messageProduct({ productSlug: 'Not a slug!', senderProduct: { slug: 'x' }, body: 'hello' })).toEqual({ slug: null, source: null });
    expect(messageProduct()).toEqual({ slug: null, source: null });
  });

  it('names every product the Hub sells', () => {
    for (const slug of ['advisors', 'breathe', 'carebase', 'caremetric-emr', 'caremetric-go', 'caremetric-intel', 'pennsync']) expect(productNames[slug]).toMatch(/^CareMetric /);
  });
});
