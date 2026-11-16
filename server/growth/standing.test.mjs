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
});
