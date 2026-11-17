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
  new RegExp(`\\b(?:ranks?|ranked|ranking)\\s+(?:#\\s?\\d+|${ordinal}|among|near|in the top|no\\.)`, 'i'),
  // A rank given to the agency itself, with the agency named between ("ranks your agency highest", "ranked yours #2").
  new RegExp(`\\b(?:ranks?|ranked)\\s+(?:your|the|this)\\s+agency\\s+(?:#\\s?\\d+|${ordinal}|top|highest|lowest|last)\\b|\\b(?:ranks?|ranked)\\s+(?:yours|you)\\s+(?:#\\s?\\d+|${ordinal}|top|highest|lowest|last)\\b`, 'i'),
  /#\s?\d+\s+(?:in|among|of|for)\b/i,
  new RegExp(`\\b${ordinal}[- ](?:largest|biggest|busiest|smallest)\\b`, 'i'),
  /\b(?:rated|scored)\s+(?:a\s+)?\d/i,
];
/**
 * "Ranks highest", "ranked top" or "ranks lowest" is an agency's standing unless it is plainly about the physicians, clinicians or
 * referral sources a market report lists ("the physicians Intel ranks highest as referral sources", email review 2026-11-17: the
 * writer's own instructions used those words, and this check refused every draft that followed them). It is about them when the words
 * after it say so ("as referral sources", "for home health outreach"), or when they are the nearest thing named before it in the
 * sentence, with no agency, "you" or "it" in between. (Main fixed the same refusal the same day by setting aside "the physicians
 * Intel ranks highest", #270: 35 own_standing refusals in 55 writer sweeps. This reading covers that wording and the others the
 * writer's plans now use, and #270's own cases are kept in the test.)
 */
const superlativeRank = /\b(?:ranks?|ranked|ranking)\s+(?:top|highest|lowest)\b/gi;
const sourcesNamed = /\b(?:physicians?|clinicians?|doctors?|practitioners?|referral\s+sources?)\b/gi;
const agencyBetween = /\b(?:agency|agencies|hospices?|organi[sz]ations?|compan(?:y|ies)|you|it|they)\b/i;
const aboutSources = /^\s+(?:as\s+referral\s+sources\b|for\s+(?:[a-z-]+\s+){0,3}outreach\b)/i;
function ranksAnAgency(sentence) {
  for (const match of sentence.matchAll(superlativeRank)) {
    if (aboutSources.test(sentence.slice(match.index + match[0].length))) continue;
    const before = sentence.slice(0, match.index);
    const named = [...before.matchAll(sourcesNamed)].at(-1);
    if (named && !agencyBetween.test(before.slice(named.index + named[0].length))) continue;
    return true;
  }
  return false;
}
export function emailStatesStanding(text) {
  const words = String(text ?? '');
  return emailPatterns.some(pattern => pattern.test(words)) || words.split(/(?<=[.?!])\s+|\n+/).some(ranksAnAgency);
}
