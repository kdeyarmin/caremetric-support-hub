/**
 * A link to one agency's free market report on Intel (`https://www.caremetricintel.com/report/<token>`), for the Marketing Manager's
 * outreach (owner decision 2026-11-15: send each agency a really good report of its own). Intel draws the report from public CMS and
 * Census data: where the agency stands among the agencies in its county, the county's largest agencies and its demand, the hospitals
 * its residents use, the highest-ranked physicians for outreach, its public ratings and up to three moves the figures point to.
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
import { createHmac, timingSafeEqual } from 'node:crypto';

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

/** How long the answer to "does this agency's report open?" is kept: a report that opens, and one that doesn't (Intel's data may change). */
export const reportOpensMs = 12 * 3_600_000;
export const reportMissingMs = 3_600_000;
const reportCheckTimeoutMs = 20_000;

/**
 * The report links the Marketing Manager may offer. `linkFor(opportunity)` is `{ label, url }` for a CareMetric Intel prospect whose
 * evidence carries its Medicare roster record, or null (another product, no record, no secret). `checkedLinkFor(opportunity)` is the
 * same link only once Intel has answered it with the PDF: an agency Intel has no report for (one Medicare's directory doesn't list
 * yet) gets null, so its email offers the market review page instead of a link that opens "No report for this link". The answer is
 * kept per agency (`reportOpensMs`, `reportMissingMs`); a timeout or a refused request counts as no report.
 */
export function reportLinks({ key = null, now = () => Date.now(), fetchImpl = globalThis.fetch } = {}) {
  const configured = typeof key === 'string' && key.length >= 32;
  const opened = new Map();
  async function opens(ccn, url, signal) {
    const known = opened.get(ccn);
    if (known && now() - known.at < (known.ok ? reportOpensMs : reportMissingMs)) return known.ok;
    let ok = false;
    try {
      const timeout = AbortSignal.timeout(reportCheckTimeoutMs);
      const response = await fetchImpl(url, { method: 'GET', redirect: 'error', headers: { accept: 'application/pdf' },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      ok = response.status === 200 && /application\/pdf/i.test(response.headers.get('content-type') ?? '');
      try { await response.body?.cancel(); } catch { /* The answer is already known. */ }
    } catch (error) {
      if (signal?.aborted) throw error;
      ok = false;
    }
    opened.set(ccn, { ok, at: now() });
    return ok;
  }
  function linkFor(opportunity) {
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
  }
  return {
    configured,
    // Rendering only: drafting still allows exactly the report issued for that opportunity.
    accepts(url) {
      if (!configured || typeof url !== 'string') return false;
      const match = /^https:\/\/www\.caremetricintel\.com\/report\/([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{22})$/.exec(url);
      if (!match) return false;
      try {
        const claims = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
        if (claims.v !== 1 || claims.e <= Math.floor(now() / 1000)) return false;
        const expected = reportToken({ ccn: claims.c, setting: claims.s ?? null, expires: claims.e, ref: claims.r ?? null }, key);
        const token = `${match[1]}.${match[2]}`;
        return token.length === expected.length && timingSafeEqual(Buffer.from(token), Buffer.from(expected));
      } catch { return false; }
    },
    linkFor,
    async checkedLinkFor(opportunity, { signal } = {}) {
      const link = linkFor(opportunity);
      if (!link) return null;
      // The check opens a link for the same agency signed without the reference, so Intel never records the Hub's own check as an open
      // of the agency's report (Intel docs/HUB_MARKETING_FEED.md "Report views").
      const agency = rosterAgency(opportunity.evidence);
      const probe = `${reportOrigin}/report/${reportToken({ ...agency, expires: Math.floor(now() / 1000) + 3_600 }, key)}`;
      return (await opens(agency.ccn, probe, signal)) ? link : null;
    },
  };
}
