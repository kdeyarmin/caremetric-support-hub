import { describe, expect, it } from 'vitest';
import { emailStatesStanding, statesStanding } from './standing.mjs';

describe('an agency\'s own standing', () => {
  it('keeps every rating, rank or share out of a brief\'s writer part, and lets the county\'s own figures through', () => {
    for (const sentence of ['Valley Home Health has a 4.5-star quality rating.', 'It ranks ninth in Erie County.', 'It is the third-largest agency in the county.',
      'Its patient survey score fell last year.', 'It holds 12% market share.', 'It is #3 among Erie County agencies.', 'It was rated highly by patients.']) {
      expect(statesStanding(sentence), sentence).toBe(true);
    }
    for (const sentence of ['48 home health agencies located in Allegheny County.', 'Valley Home Health serves Erie and Crawford counties.',
      'It opened a second office in Meadville in 2025.', 'The three largest home health agencies located in Erie County served 61% of their Medicare patients.']) {
      expect(statesStanding(sentence), sentence).toBe(false);
    }
  });

  it('refuses an email that states a star rating or a rank, and passes one that asks where the agency stands', () => {
    for (const text of ['Valley Home Health has a 4.5-star rating.', 'Your agency ranks ninth in Erie County.', 'You are ranked #3 there.', 'the fourth-largest agency in the county',
      'Your agency is #2 in Erie County.', 'Rated 4 out of 5 by patients.', 'Your star rating of 3 stands out.']) {
      expect(emailStatesStanding(text), text).toBe(true);
    }
    for (const text of ['See where your agency ranks in its county.', 'Where does your agency rank?', 'Intel shows the public ratings of every agency in your county.',
      'The three largest home health agencies located in Erie County served 61% of their Medicare patients.', 'Rank your referral sources by admissions.']) {
      expect(emailStatesStanding(text), text).toBe(false);
    }
  });

  // Email review 2026-11-17: the writer was told to say "the physicians Intel ranks highest as referral sources", and this check
  // refused it as a rank.
  it('lets a rank that is plainly about physicians or referral sources pass, and still refuses an agency\'s', () => {
    for (const text of ['It shows the hospitals its residents use and the physicians Intel ranks highest as referral sources.',
      'the physicians ranked highest as referral sources', 'The clinicians Intel ranks highest are listed with their practice locations.',
      'It lists the physicians in your county that Intel ranks highest as referral sources.', 'The doctors ranked highest for home health outreach are on page two.',
      'the highest-ranked physicians for outreach']) {
      expect(emailStatesStanding(text), text).toBe(false);
    }
    for (const text of ['Your agency ranks highest in Erie County.', 'Valley Home Health ranked top in the county last year.', 'It ranks lowest of the agencies there.',
      'Physicians know that your agency ranks highest in the county.', 'Your agency ranks among the top agencies in the county.', 'You rank near the bottom.']) {
      expect(emailStatesStanding(text), text).toBe(true);
    }
  });
});
