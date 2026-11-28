/**
 * What Instantly tells the Hub about every campaign in the workspace, Pennsylvania's built by hand included (POST /api/growth/instantly;
 * docs/STATE_LAUNCHES.md, "Replies and opt-outs"). Instantly's webhook carries the header the Hub gave it when it subscribed, a key made
 * from the growth signing key (HUB_GROWTH_SIGNING_KEY), so no other secret is needed.
 *
 * - "no thanks", "not interested", "remove me" and the like, an unsubscribe, or a lead Instantly marks not interested: the address, its
 *   business's own domain and the facility go on the Hub's do-not-contact list, for good, across every campaign and the owner's own
 *   sequences.
 * - A bounce: the facility is marked bounced (Instantly stops the lead itself).
 * - "yes" to a state launch's email: Intel emails the free county report for the lead's county, once, and the owner is told.
 * - Any other reply, or a lead Instantly marks interested: the owner is told, to answer it in Instantly.
 * Automatic replies (out of office, has left) and every other event are accepted and left alone.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const webhookHeader = 'x-caremetric-webhook-key';
export const countyReportUrl = 'https://www.caremetricintel.com/api/public/county-report';

/** The key Instantly's webhook carries, derived from the growth signing key; null without one. */
export const webhookKeyFor = signingKey => (typeof signingKey === 'string' && signingKey.length >= 32
  ? createHmac('sha256', signingKey).update('instantly:webhook').digest('hex') : null);

export function keyMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/** The sender's own words in a reply: everything above the first quoted line, "On ... wrote:", an Outlook header or a forward. */
export function ownWords(text) {
  const lines = String(text ?? '').slice(0, 20_000).replace(/\r/g, '').split('\n');
  const kept = [];
  for (const line of lines) {
    if (/^\s*>/.test(line) || /^\s*on .{0,250}wrote\s*:?\s*$/i.test(line) || /^\s*-{2,}\s*(original|forwarded) message/i.test(line)
      || /^\s*begin forwarded message/i.test(line) || /^\s*from\s*:\s/i.test(line)) break;
    kept.push(line);
  }
  return kept.join('\n').replace(/\s+/g, ' ').trim();
}

/** 'no' for an opt-out, 'yes' for a short yes to the county report, 'auto' for an automatic reply, else 'other'. */
export function classifyReply(text) {
  const words = ownWords(text).toLowerCase();
  if (!words) return 'other';
  if (/\b(out of (the )?office|automatic reply|auto-?reply|autoreply|on (vacation|leave|holiday)|away from (the|my) (office|desk)|limited access to (e-?mail|my email)|no longer (with|employed)|has left the (company|organization))\b/.test(words)) return 'auto';
  if (/\b(no thanks|no thank you|not interested|unsubscribe|remove me|take me off|stop (emailing|e-mailing|contacting|sending)|do not (email|contact)|don'?t (email|contact)|please remove|opt(ed)? out)\b/.test(words)
    || /^(no|nope|stop|remove)[.!]*$/.test(words)) return 'no';
  if (words.length <= 160 && /^(yes|yes please|yes,? please|sure|sure thing|ok(ay)?|yep|yeah|please( do)?|please send( it)?|send( it)?( please)?|i('| woul)d (like|love) (it|one|that|the report)|absolutely|definitely)\b/.test(words)
    && !/\b(not|no|don'?t|isn'?t|wasn'?t)\b/.test(words)) return 'yes';
  return 'other';
}

const kinds = { reply_received: 'reply', lead_unsubscribed: 'opted_out', lead_not_interested: 'opted_out', email_bounced: 'bounced',
  lead_interested: 'interested', lead_wrong_person: 'reply' };

/** Instantly's event as the Hub reads it, or null for one it leaves alone. */
export function readEvent(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const kind = kinds[body.event_type];
  const email = String(body.lead_email ?? '').trim().toLowerCase();
  if (!kind || !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email) || email.length > 320) return null;
  const campaign = /^[0-9a-f-]{36}$/.test(String(body.campaign_id ?? '')) ? body.campaign_id : null;
  const reply = String(body.reply_text ?? body.reply_text_snippet ?? '').slice(0, 20_000);
  return { kind, email, campaign, campaignName: String(body.campaign_name ?? '').slice(0, 200), reply,
    answer: kind === 'reply' ? classifyReply(reply) : null };
}

/**
 * Asks Intel to email the county report to the person who said yes, as the Pennsylvania workflows do. { sent: true } or { sent: false, why }.
 */
export async function sendCountyReport({ state, countyFips, email, utmCampaign, fetchImpl = globalThis.fetch, signal } = {}) {
  if (!/^[A-Z]{2}$/.test(state ?? '') || !/^\d{5}$/.test(countyFips ?? '')) return { sent: false, why: 'no_county' };
  let response;
  try {
    response = await fetchImpl(countyReportUrl, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'CareMetric-Hub/1.0 (+https://help.caremetric.ai)' },
      body: JSON.stringify({ state, county_fips: countyFips, email, attribution: { utmSource: 'cold-email', utmMedium: 'email', utmCampaign, utmContent: 'reply-yes' } }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
  } catch (error) {
    if (signal?.aborted) throw error;
    return { sent: false, why: 'unreachable' };
  }
  await response.body?.cancel?.().catch(() => {});
  return response.ok ? { sent: true } : { sent: false, why: `status_${response.status}` };
}
