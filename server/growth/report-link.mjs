/**
 * A link to one agency's free market report on Intel (`https://www.caremetricintel.com/report/<token>`), for the Marketing Manager's
 * outreach (owner decision 2026-11-15: send each agency a really good report of its own). Intel draws the report from public CMS and
 * Census data: where the agency stands among the agencies in its county, the county's largest agencies and its demand, the hospitals
 * its residents use, the physicians Intel ranks highest as referral sources, its public ratings and three moves the figures point to.
 *
 * The link names the agency by its CMS certification number, which the Medicare roster's public record on the opportunity carries
 * (roster.mjs `rosterClaim`: "... (CCN 397001) is a Medicare-certified home health agency ..."). A prospect found on the web gets the
 * same record once growth.match finds its CCN through Intel (agency-match.mjs); until then it gets no link. The email never states a
 * figure from the report; the reader opens it.
 *
 * The token is Intel's format (Intel `server/lib/agencyReportToken.ts`, `docs/HUB_MARKETING_FEED.md` "Agency report links"):
 * base64url(JSON claims) "." base64url(first 16 bytes of HMAC-SHA256(key, base64url(JSON claims))), where key is
 * HMAC-SHA256(HUB_INTEL_FEED_SECRET, "caremetric.agency-report.v1"): the marketing feed's shared secret, under a label of its own so a
 * feed signature and a report link can never stand in for each other. Claims: { v: 1, c: CCN, s: "hha" | "hospice", e: expiry in
 * Unix seconds, r: the opportunity id }. A test pins the same vector as Intel's.
 */
import { createHmac } from 'node:crypto';

export const reportKeyLabel = 'caremetric.agency-report.v1';
export const reportOrigin = 'https://www.caremetricintel.com';
/** How long a link lives: a prospect reads an email weeks later, and re-asks come months after. Intel accepts up to 180 days. */
export const reportLinkDays = 150;

const b64 = value => Buffer.from(value).toString('base64url');
const ccnPattern = /^[0-9A-Z]{6}$/;
const refPattern = /^[A-Za-z0-9_-]{1,40}$/;

/** The token for `claims`, signed with `secret`. Throws on claims Intel would refuse. */
export function reportToken({ ccn, setting = null, expires, ref = null }, secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw new TypeError('A report link needs the marketing feed secret (32 characters or more).');
  if (!ccnPattern.test(String(ccn ?? ''))) throw new TypeError('A report link names a six-character CCN.');
  if (setting !== null && setting !== 'hha' && setting !== 'hospice') throw new TypeError('A report link names home health or hospice.');
  if (!Number.isSafeInteger(expires) || expires <= 0) throw new TypeError('A report link needs an expiry.');
  if (ref !== null && !refPattern.test(String(ref))) throw new TypeError('A report link reference is short letters, digits, "-" or "_".');
  const body = b64(JSON.stringify({ v: 1, c: ccn, ...(setting ? { s: setting } : {}), e: expires, ...(ref ? { r: ref } : {}) }));
  const key = createHmac('sha256', secret).update(reportKeyLabel).digest();
  return `${body}.${b64(createHmac('sha256', key).update(body).digest().subarray(0, 16))}`;
}

// The roster's public record, as rosterClaim writes it: the CCN in brackets, then the setting.
const rosterRecord = /CMS Provider of Services file[^:]*:.*?\(CCN ([0-9A-Z]{6})\) is a Medicare-certified (home health agency|hospice)\b/;

/** The agency's CCN and setting from its Medicare roster record on the opportunity's evidence, or null. */
export function rosterAgency(evidence) {
  for (const item of evidence ?? []) {
    const match = rosterRecord.exec(String(item?.claim ?? ''));
    if (match) return { ccn: match[1], setting: match[2] === 'hospice' ? 'hospice' : 'hha' };
  }
  return null;
}

/**
 * The report links the Marketing Manager may offer. `linkFor(opportunity)` is `{ label, url }` for a CareMetric Intel prospect whose
 * evidence carries its Medicare roster record, or null (another product, no record, no secret).
 */
export function reportLinks({ key = null, now = () => Date.now() } = {}) {
  const configured = typeof key === 'string' && key.length >= 32;
  return {
    configured,
    linkFor(opportunity) {
      if (!configured || opportunity?.product !== 'caremetric-intel') return null;
      const agency = rosterAgency(opportunity.evidence);
      if (!agency) return null;
      const ref = refPattern.test(String(opportunity.id ?? '')) ? String(opportunity.id) : null;
      const expires = Math.floor(now() / 1000) + reportLinkDays * 86_400;
      const name = String(opportunity.name ?? '').trim();
      return {
        label: `Free market report${name ? ` for ${name.slice(0, 120)}` : ''}`,
        url: `${reportOrigin}/report/${reportToken({ ...agency, expires, ref }, key)}`,
      };
    },
  };
}
