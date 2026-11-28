import { describe, expect, it } from 'vitest';
import { allowedPositiveFact, emailOneNote, isBookingUrl, paymentChanged, positiveAgencyFact, quotesOldSale } from './email-one.mjs';
import { outdatedWords } from './draft.mjs';

describe('the three first-email settings', () => {
  it('keeps a 4-star rating or a rise in patients, and drops a low rating, a rank and a fall', () => {
    expect(positiveAgencyFact({ quality: { care_star_rating: 4.5 } })).toBe('Medicare\'s quality of patient care rating for this agency is 4.5 stars.');
    expect(positiveAgencyFact({ ratings: ['Quality of patient care: 4 stars'] })).toBe('Medicare\'s quality of patient care rating for this agency is 4 stars.');
    expect(positiveAgencyFact({ quality: { care_star_rating: 3 } })).toBeNull();
    expect(positiveAgencyFact({ history: [{ data_year: '2022', patients: 80 }, { data_year: '2024', patients: 110 }] }))
      .toBe('Medicare fee-for-service patients rose from 80 to 110.');
    expect(positiveAgencyFact({ history: [{ data_year: '2022', patients: 110 }, { data_year: '2024', patients: 80 }] })).toBeNull();
    expect(allowedPositiveFact('You rank 9th.')).toBeNull();
    expect(allowedPositiveFact('Medicare\'s quality of patient care rating for this agency is 3 stars.')).toBeNull();
    expect(allowedPositiveFact(positiveAgencyFact({ quality: { care_star_rating: 5 } }))).toBe('Medicare\'s quality of patient care rating for this agency is 5 stars.');
  });

  it('writes the P.S. and the walkthrough only when asked, and only for an https link', () => {
    const trial = 'https://www.caremetricintel.com/login?signup=true';
    expect(emailOneNote({})).toBe('');
    expect(emailOneNote({ oneOffer: true, trialUrl: trial })).toContain('Founding member pricing: the price you start with never goes up while you stay subscribed.');
    expect(emailOneNote({ oneOffer: true, trialUrl: trial })).not.toMatch(/Founders Sale|%/);
    expect(emailOneNote({ oneOffer: true, trialUrl: trial })).toContain(trial);
    expect(emailOneNote({ bookingUrl: 'http://cal.example/kevin' })).toBe('');
    expect(emailOneNote({ bookingUrl: 'https://user:pass@cal.example/kevin' })).toBe('');
    expect(isBookingUrl('https://cal.example/kevin')).toBe(true);
    expect(emailOneNote({ bookingUrl: 'https://cal.example/kevin' })).toContain('https://cal.example/kevin');
    expect(paymentChanged({ hhvbp: { paymentAdjustmentPct: -1.4 } })).toBe(true);
    expect(paymentChanged({ hhvbp: { paymentAdjustmentPct: 0 } })).toBe(false);
    expect(paymentChanged({ hhvbpAdjustmentPct: 2 })).toBe(true);
  });

  it('turns down a draft that still quotes the Founders Sale, which ended for Intel', () => {
    const waiting = body => outdatedWords({ product: 'caremetric-intel', subject: 'Your market report', body, purpose: 'marketing' });
    expect(quotesOldSale('Founders Sale: 50% off eligible subscription charges for the first 12 months')).toBe(true);
    expect(waiting('Founders Sale: 50% off the first 12 months.')).toBe('old_offer');
    expect(waiting('50% off your first 12 months')).toBe('old_offer');
    expect(waiting('Founders Sale: 75% off the first 12 months.')).toBe('old_offer');
    expect(waiting('75% off your first 12 months')).toBe('old_offer');
    expect(waiting('Founding member pricing: the price you start with never goes up while you stay subscribed.')).toBeNull();
  });
});
