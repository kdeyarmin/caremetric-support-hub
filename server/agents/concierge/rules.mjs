/**
 * What a message looks like, by word matching alone: no model, no text kept. The categories only
 * decide how loudly the owner is told (and whether a fixed acknowledgment is offered), so the
 * rules favour catching the urgent kinds over being right about the rest; a false alarm costs the
 * owner a glance, a missed outage costs a customer.
 *
 * Categories, most urgent first: security, legal, outage (the owner is texted), cancellation,
 * billing (emailed, never answered by the Concierge), sales (an inquiry for the owner), general.
 * An automatic reply, an empty message or a bounce is `auto_reply` and is not triaged at all: but only when it opens
 * like one ("Automatic reply:", "Out of office:", "Undeliverable:" at the start of the subject or the message), and
 * never when the text also matches an urgent kind, because "our account was hacked while I was out of the office" is
 * a security report and a missed one costs more than a glance. A person's message that merely mentions being away,
 * or an undeliverable email, is triaged like any other.
 * The answer names the rules that matched, never what the customer wrote.
 *
 * Patterns stay bounded, with no unbounded repetition inside another, so a hostile message cannot
 * make a scan slow.
 */
const limit = 20_000;

// What a machine opens with. Each pattern is tried against the start of the subject and the start of the message, so a
// person who mentions it in the middle of a real message is not mistaken for one. A label a mail system adds on its own
// ("Automatic reply:", "Out of office:", "Undeliverable:") is trusted; an opening sentence a person could also write ("We will be
// out of the office next week...") is not trusted over a cancellation or a billing matter in the same message.
const reply = '(?:(?:re|fwd?)\\s*:\\s*)*';
const autoLabel = new RegExp(`^${reply}(?:(?:automatic reply|auto-?reply|auto response|vacation (?:auto-?)?(?:reply|response))\\b|out of (?:the )?office\\s*:)`, 'i');
const bounceLabel = new RegExp(`^${reply}(?:undeliverable|delivery (?:status )?notification|mail delivery (?:failed|subsystem)|returned mail|failure notice)\\b`, 'i');
const autoSentence = new RegExp(`^${reply}(?:(?:please )?do not reply|(?:thank you for (?:your|the) (?:email|message)[.!,]?\\s*)?(?:i am|i'm|i will be|we are|we will be) (?:currently |now )?(?:out of (?:the )?office|away from (?:my|the) (?:desk|office)))\\b`, 'i');
const emptyMessage = /^\[empty (?:text message|email)\]$/i;
// Addresses only machines write from, anywhere in the first lines.
const machineSender = /\b(?:mailer-daemon|postmaster@|no-?reply@)/i;
const urgentKinds = new Set(['security', 'legal', 'outage']);
const businessKinds = new Set(['cancellation', 'billing']);

const categories = [
  ['security', [
    ['hacked', /\b(?:hack(?:ed|er|ing)?|hijack(?:ed)?|compromised|data breach|breach(?:ed)?|phish(?:ing|ed)?|ransomware|malware|identity theft|stolen (?:password|credentials|account))\b/i],
    ['unauthorized', /\bunauthori[sz]ed\b/i],
    ['someone_in_account', /\b(?:someone|somebody|a stranger)\b[^.\n]{0,40}\b(?:logged|signed|accessed|got into|using my|using our)\b/i],
    ['suspicious', /\b(?:suspicious|strange|unknown) (?:login|log-in|sign-?in|activity|charge|access)\b/i],
  ]],
  ['legal', [
    ['counsel', /\b(?:attorney|lawyer|law firm|lawsuit|su(?:e|ed|ing)|subpoena|cease and desist|litigation|court order|legal (?:action|department|counsel|notice))\b/i],
    ['hipaa', /\bhipaa\b[^.\n]{0,30}\b(?:complaint|violation|breach|incident)\b/i],
    ['regulator', /\b(?:report(?:ing)? (?:you|this|it) to|file a complaint|ombudsman|attorney general|better business bureau)\b/i],
  ]],
  ['outage', [
    ['outage', /\boutage\b/i],
    ['down_for_all', /\b(?:down|offline|not (?:working|loading|responding)|unavailable)\b[^.\n]{0,30}\bfor (?:everyone|everybody|all|every user|our (?:whole |entire )?(?:staff|team|facility|building))\b/i],
    ['nobody_can', /\b(?:everyone|everybody|all (?:of )?(?:our|my) (?:staff|users|team))\b[^.\n]{0,30}\b(?:can'?t|cannot|unable to)\b[^.\n]{0,25}\b(?:log ?in|sign ?in|access|open|use|connect|load)\b/i],
    ['nobody_can_positive', /\b(?:nobody|no ?one|none of (?:us|our (?:staff|users|team)))\b[^.\n]{0,30}\b(?:can|is able to|are able to)\b[^.\n]{0,25}\b(?:log ?in|sign ?in|access|open|use|connect|load)\b/i],
    ['site_down', /\b(?:site|website|app|system|platform|server|service|portal|everything)\b[^.\n]{0,15}\b(?:is|are|was|went)\s+(?:completely\s+)?(?:down|offline|unavailable|broken)\b/i],
  ]],
  ['cancellation', [
    ['cancel', /\b(?:cancel(?:l?ing|l?ed)?|terminat(?:e|ing)|clos(?:e|ing)|end(?:ing)?|stop(?:ping)?)\b[^.\n]{0,20}\b(?:subscription|account|contract|membership|agreement)\b/i],
    ['cancel_service', /\bcancel(?:l?ing|l?ed)?\b[^.\n]{0,25}\b(?:service|plan)\b/i],
    ['cancel_threat', /\b(?:we(?:'ll| will| are going to)|i(?:'ll| will| am going to)|going to|about to|will)\s+(?:have to\s+)?cancel\b/i],
    ['switching', /\b(?:switch(?:ing)?|mov(?:e|ing)) to (?:another|a different|a competitor)\b/i],
  ]],
  ['billing', [
    ['refund', /\b(?:refund(?:ed|s)?|chargeback|overcharg(?:e|ed|ing))\b/i],
    ['charged', /\b(?:(?:double|twice|incorrectly|wrongly|unexpectedly) (?:charged|billed)|charged (?:twice|again|incorrectly|too much))\b/i],
    ['payment', /\b(?:payment (?:failed|declined|problem|issue)|billing (?:error|issue|problem|dispute|question)|dispute(?:d)? (?:a |the |this )?(?:charge|payment|invoice))\b/i],
    ['invoice', /\b(?:invoice|receipt|credit card)\b/i],
  ]],
  ['sales', [
    ['pricing', /\b(?:pricing|price|quote|how much|free trial|demo(?:nstration)?)\b/i],
    ['consulting', /\b(?:consult(?:ation|ing|ant)|proposal|purchase|sign(?:ing)? up|interested in (?:your|the))\b/i],
  ]],
];

/** { category, reasons } for a message; `subject` is only the subject of an email conversation. */
export function categorize({ text, subject = null } = {}) {
  const body = String(text ?? '').slice(0, limit);
  const whole = `${subject ?? ''}\n${body}`.slice(0, limit);
  const matching = ([category, rules]) => {
    const reasons = rules.filter(([, pattern]) => pattern.test(whole)).map(([reason]) => `${category}.${reason}`);
    return reasons.length ? { category, reasons } : null;
  };
  const firstOf = kinds => {
    for (const entry of categories) {
      if (!kinds.has(entry[0])) continue;
      const hit = matching(entry);
      if (hit) return hit;
    }
    return null;
  };
  const starts = [String(subject ?? '').trimStart().slice(0, 160), body.trimStart().slice(0, 160)];
  const opens = pattern => starts.some(start => pattern.test(start));

  if (emptyMessage.test(body.trim())) return { category: 'auto_reply', reasons: ['empty'] };
  // The urgent kinds are decided first: no guess that a message is automatic can hide one from the owner.
  const urgent = firstOf(urgentKinds);
  if (urgent) return urgent;
  if (opens(autoLabel)) return { category: 'auto_reply', reasons: ['auto_reply'] };
  if (opens(bounceLabel) || machineSender.test(whole.slice(0, 400))) return { category: 'auto_reply', reasons: ['bounce'] };
  const business = firstOf(businessKinds);
  if (business) return business;
  if (opens(autoSentence)) return { category: 'auto_reply', reasons: ['auto_reply'] };
  return firstOf(new Set(['sales'])) ?? { category: 'general', reasons: [] };
}
