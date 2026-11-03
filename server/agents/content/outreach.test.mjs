import { describe, expect, it } from 'vitest';
import { renderOwnerEmail } from '../notify.mjs';
import { outreachDraft } from './fixtures.mjs';
import { checkOutreach, composeOutreachEmail, maxDrafts, outreachSchema, outreachSystemPrompt } from './outreach.mjs';

const listing = (over = {}) => ({ ...outreachDraft.listings[0], ...over });
const pitch = (over = {}) => ({ ...outreachDraft.pitches[0], ...over });

describe('the monthly outreach drafts', () => {
  it('keeps drafts that pass, exactly as written', () => {
    const result = checkOutreach(outreachDraft);
    expect(result).toEqual({ listings: outreachDraft.listings, pitches: outreachDraft.pitches, dropped: 0, reasons: [], rewrites: 0 });
  });

  it('leaves out a draft that fails a check and records only the name of the check', () => {
    const result = checkOutreach({
      listings: [listing(), listing({ description: `${listing().description} Only $4 per resident.` }), listing({ product: 'advisors' })],
      pitches: [pitch(), pitch({ body: `${pitch().body} Call us to set it up.` }), pitch({ body: `${pitch().body} See https://example.com/offer.` }), pitch({ subject: 'Hi' })],
    });
    expect(result.listings).toHaveLength(1);
    expect(result.pitches).toHaveLength(1);
    expect(result.dropped).toBe(5);
    expect(result.reasons).toEqual(['call_offer', 'link_not_allowed', 'subject_length', 'unknown_target', 'unlisted_price']);
    expect(JSON.stringify(result.reasons)).not.toMatch(/resident|example\.com/);
  });

  it('applies the same claim, vocabulary and privacy rules as an article', () => {
    const verdict = over => checkOutreach({ listings: [], pitches: [pitch(over)] });
    expect(verdict({ body: `${pitch().body} CareBase ensures compliance.` }).reasons).toEqual(['compliance_assurance']);
    expect(verdict({ body: `${pitch().body} It is the proof surveyors want.` }).reasons).toEqual(['prove_word']);
    expect(verdict({ body: `${pitch().body} Our AI answers your calls.` }).reasons).toEqual(['voice_claim']);
    expect(verdict({ body: `${pitch().body} Write to pat@example.com.` }).reasons).toEqual(['contact_detail']);
    expect(verdict({ body: `${pitch().body} **Bold** words.` }).reasons).toEqual(['markup']);
    expect(verdict({ body: `${pitch().body} Ask your financial auditor.` }).reasons).toEqual(['ambiguous_term']);
    const rewritten = verdict({ subject: 'A resource for your ALR members', body: pitch().body.replace('Assisted Living Facilities', 'Assisted Living Residences') });
    expect(rewritten.pitches[0].subject).toBe('A resource for your ALF members');
    expect(rewritten.pitches[0].body).toContain('Assisted Living Facilities');
    expect(rewritten.rewrites).toBe(2);
    // The company's own sites may be named as a bare domain.
    expect(verdict({ body: `${pitch().body} More at www.caremetricintel.com and caremetricadvisors.com.` }).reasons).toEqual([]);
  });

  it('reads at most five of each', () => {
    const many = checkOutreach({ listings: Array.from({ length: 8 }, () => listing()), pitches: Array.from({ length: 8 }, () => pitch()) });
    expect([many.listings.length, many.pitches.length, maxDrafts]).toEqual([5, 5, 5]);
    expect(checkOutreach(null)).toEqual({ listings: [], pitches: [], dropped: 0, reasons: [], rewrites: 0 });
  });

  it('asks the model for a closed shape: four directories, five kinds of partner, software only for listings', () => {
    expect(outreachSchema.properties.listings.items.properties.directory.enum).toEqual(['capterra', 'g2', 'getapp', 'software_advice']);
    expect(outreachSchema.properties.listings.items.properties.product.enum).toEqual(['carebase', 'intel']);
    expect(outreachSchema.properties.pitches.items.properties.audience.enum).toEqual(['provider_association', 'senior_care_consultant', 'pharmacy_partner', 'therapy_partner', 'compliance_trainer']);
    expect(outreachSystemPrompt).toContain('Nothing you write is sent automatically.');
    expect(outreachSystemPrompt).toContain('$199 per facility per month');
  });
});

describe("the owner's outreach email", () => {
  const checked = checkOutreach(outreachDraft);
  const email = composeOutreachEmail({ month: '2026-11', label: 'November 2026', ...checked });

  it('says what is ready in its subject and stored body, with counts only', () => {
    expect(email.subject).toBe('Outreach drafts for November 2026: 2 listings, 1 pitch');
    expect(email.body).toBe('2 directory listings and 1 partnership pitch are ready for you to send yourself. Nothing was sent to anyone else.');
    for (const words of ['Staff training', 'CareBase Core', '$199', 'newsletter']) expect(email.subject + email.body, words).not.toContain(words);
  });

  it('carries the drafts in the email itself, word for word, and renders', () => {
    const text = JSON.stringify(email.blocks);
    expect(text).toContain('Capterra listing for CareMetric CareBase');
    expect(text).toContain('Pitch to state and regional provider associations about CareMetric CareBase');
    expect(email.blocks.find(block => block.type === 'message').text).toBe(`Tagline: ${outreachDraft.listings[0].tagline}\n\n${outreachDraft.listings[0].description}`);
    const rendered = renderOwnerEmail({ subject: email.subject, body: email.body, blocks: email.blocks, publicOrigin: 'https://hub.example.test' });
    expect(rendered.text).toContain(outreachDraft.pitches[0].body);
  });

  it('says so when nothing passed', () => {
    const none = composeOutreachEmail({ month: '2026-11', label: 'November 2026', listings: [], pitches: [], dropped: 2, reasons: ['unlisted_price'] });
    expect(none.subject).toBe('Outreach drafts for November 2026: none passed the checks');
    expect(none.body).toBe('No draft passed the checks this month (unlisted price). Nothing was sent to anyone else.');
  });
});
