/**
 * An agency's own standing (owner rule: an email never states an agency's own ratings, scores, rank or share). Intel's agency brief holds
 * them for research, and the account brief keeps them in its research part; these checks keep them out of what the writer reads and out
 * of the email itself. The county's own figures (how many agencies, the three largest agencies' share of patients) are not an agency's
 * standing and pass.
 */
const ordinal = '(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|\\d+(?:st|nd|rd|th))';

/** In a brief's writer part, any statement about a rating, a rank or a share is left out: the writer never needs one. */
const briefPatterns = [
  /\b\d(?:\.\d)?[- ]?stars?\b/i,
  /\bstars?\s+(?:rating|score)s?\b/i,
  /\b(?:ratings?|rated|scores?|scored)\b/i,
  /\b(?:ranks?|ranked|ranking)\b/i,
  /#\s?\d+\b/,
  /\bnumber (?:one|two|three|four|five|\d+)\b/i,
  /\b(?:market|county|patient|referral)\s+share\b/i,
  /\bshare of (?:the )?(?:market|county|patients|referrals|admissions)\b/i,
  new RegExp(`\\b${ordinal}[- ](?:largest|biggest|busiest|smallest)\\b`, 'i'),
];
export const statesStanding = sentence => briefPatterns.some(pattern => pattern.test(String(sentence ?? '')));

/**
 * In an email: a star rating, or a rank (ranks ninth, ranked #3, the fourth-largest), which can only be the agency's own or another
 * agency's. Words about what the product shows ("see the public ratings in your county") pass.
 */
const emailPatterns = [
  /\b\d(?:\.\d)?[- ]?stars?\b/i,
  /\bstar rating (?:of|is|was)\b/i,
  new RegExp(`\\b(?:ranks?|ranked|ranking)\\s+(?:#\\s?\\d+|${ordinal}|top|among|highest|lowest|near|in the top|no\\.)`, 'i'),
  // A rank given to the agency itself, with the agency named between ("ranks your agency highest", "ranked yours #2").
  new RegExp(`\\b(?:ranks?|ranked)\\s+(?:your|the|this)\\s+agency\\s+(?:#\\s?\\d+|${ordinal}|top|highest|lowest|last)\\b|\\b(?:ranks?|ranked)\\s+(?:yours|you)\\s+(?:#\\s?\\d+|${ordinal}|top|highest|lowest|last)\\b`, 'i'),
  /#\s?\d+\s+(?:in|among|of|for)\b/i,
  new RegExp(`\\b${ordinal}[- ](?:largest|biggest|busiest|smallest)\\b`, 'i'),
  /\b(?:rated|scored)\s+(?:a\s+)?\d/i,
];
// How Intel describes its own report: "the physicians Intel ranks highest as referral sources" (playbook.mjs, draft.mjs, report-link.mjs,
// since 2026-11-17). That ranks physicians, never an agency, so it is set aside before the patterns are read: with it left in, "ranks
// highest" refused 35 of the writer's first emails in a day, each twice. Only physicians, doctors, clinicians and referral sources are
// set aside, and only as Intel ranks them; an agency's rank ("Intel ranks your agency highest") is still refused.
const productRanking = /\b(?:physicians?|doctors?|clinicians?|referral sources?|referrers?)\b[^.!?\n]{0,60}?\bIntel\s+(?:ranks?|ranked)\s+(?:highest|high|top|most)\b/gi;
export const emailStatesStanding = text => {
  const words = String(text ?? '').replace(productRanking, ' ');
  return emailPatterns.some(pattern => pattern.test(words));
};
