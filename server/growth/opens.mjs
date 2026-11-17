/**
 * Whether words say or imply that CareMetric saw a reader open, view or read something it sent: a report, a link or an email. The
 * Sales Executive's replies (agents/sales/check.mjs) and every growth email (draft.mjs `draftProblem`, and again at send time in
 * worker.mjs) are refused when they do. Intel tells the Hub which market reports were opened (views.mjs), and an email that reveals it
 * reads as surveillance. A reply may say so only when the prospect said it first (`prospect`).
 */
/**
 * Words that say or imply CareMetric saw the prospect open, view or read something (a report, a link, an email). Words that invite them
 * to ("you can open the report here", "when you open it", "if you've looked at the report") pass.
 */
const openPatterns = [
  /\b(?:saw|see|seen|noticed|notice|noticing|spotted|can tell|could tell)\s+(?:that\s+)?(?:you|your team|someone(?:\s+(?:at|from)\s+your\s+(?:agency|team|organization))?|your agency|your organization)\s+(?:have\s+|has\s+|had\s+|'ve\s+|’ve\s+)?(?:already\s+|recently\s+|just\s+|finally\s+)?(?:opened|viewed|looked|checked|read|downloaded|clicked|visited|spent|went|got|took|been|opening|viewing|looking|checking|reading)\b/i,
  /\b(?:thanks|thank you|glad|great|good|nice|happy)\b[^.?!\n]{0,15}?\b(?:for|that you|you)\s+(?:opening|viewing|looking at|looked at|looking over|looked over|checking out|checked out|reading|read|downloading|downloaded|taking a look|took a look|having a look|had a look|opened|viewed|clicking|clicked|going through|went through|digging into|dug into)(?:\s+(?:at|on|over|through))?\s+(?:it\b|(?:the|your|our|that|this|my)\s+(?:free\s+)?(?:market\s+|county\s+)?(?:report|review|link|email|pdf|data|numbers|figures)\b)/i,
  /\byou(?:'ve|’ve| have)\s+been\s+(?:looking at|looking over|reading|checking out|viewing|exploring|going through|digging into|opening|clicking)\b/i,
  /(?<!\b(?:if|once|when|after|whether|before|until|as soon as)\s+)\byou(?:'ve|’ve| have)?\s+(?:already\s+|recently\s+|just\s+|finally\s+)?(?:opened|viewed|downloaded|clicked(?:\s+on)?)\s+(?:the|your|our|it|that|this)\b/i,
  // Written as if the reader has already seen it ("now that you have seen where your agency stands"): growth email review 2026-11-17.
  /\b(?:now that|since)\s+(?:you|your team|your agency)(?:'ve|’ve| have)?\s+(?:already\s+)?(?:seen|read|opened|viewed|looked (?:at|over|through)|had a (?:chance|look)|gone through|went through|checked out)\b/i,
  // Only our own tracking: "the data shows" is how an Intel answer talks about public Medicare data.
  /\bour\s+(?:records?|tracking|analytics|logs?)\s+(?:show|shows|showed|say|says|said|tell|tells|indicate|indicates|suggest|suggests)\b/i,
];
/** The prospect said they opened, read or looked at it: then the reply may say so too. */
const prospectSaysOpened = /\b(?:opened|open|read|reading|looked|looking|saw|seen|viewed|went through|got|received|checked|downloaded)\b[^.?!\n]{0,40}\b(?:report|review|link|email|pdf)\b|\b(?:report|review|link|pdf)\b[^.?!\n]{0,40}\b(?:opened|read|looked|saw|seen|viewed|went through|got|received|checked|downloaded)\b/i;
export const mentionsOpen = (words, prospect = '') => !prospectSaysOpened.test(String(prospect ?? '')) && openPatterns.some(pattern => pattern.test(String(words ?? '')));
