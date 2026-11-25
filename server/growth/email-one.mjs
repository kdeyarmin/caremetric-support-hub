/**
 * The three limits the first email keeps until the owner turns them on (Settings → Customer growth). Each stays off, so a deploy
 * changes nothing, and each is applied by code after the writer is checked: the model is never asked to invent a rating, a price
 * or a booking link.
 *
 * - One fact: a quality-of-patient-care rating of 4 stars or higher, or a rise in Medicare fee-for-service patients. Never a rank,
 *   a share, a drop, or a rating under 4.
 * - A short P.S.: the free trial and the Founders Sale, in the fact sheet's own words.
 * - A walkthrough link: only when a booking address is saved. Blank means the line is not written.
 */
import { products } from '../agents/content/facts.mjs';

const starSentence = /^Medicare's quality of patient care rating for this agency is (?:4(?:\.\d)?|5) stars\.$/;
const trendSentence = /^Medicare fee-for-service patients rose from (\d{1,6}) to (\d{1,6})\.$/;

/** The one sentence a first email may add about the agency itself, or null. `intel` is Intel's agency brief. */
export function positiveAgencyFact(intel) {
  if (!intel || typeof intel !== 'object') return null;
  const stars = starRating(intel);
  if (stars !== null && stars >= 4 && stars <= 5) {
    const shown = Number.isInteger(stars) ? String(stars) : String(Math.round(stars * 10) / 10);
    return `Medicare's quality of patient care rating for this agency is ${shown} stars.`;
  }
  const trend = patientTrend(intel.history);
  if (!trend) return null;
  return `Medicare fee-for-service patients rose from ${trend.from} to ${trend.to}.`;
}

function starRating(intel) {
  const direct = Number(intel.quality?.care_star_rating);
  if (Number.isFinite(direct)) return direct;
  for (const line of intel.ratings ?? []) {
    const match = String(line).match(/quality of patient care[^0-9]{0,40}([1-5](?:\.\d)?)\s*stars?/i);
    if (match) return Number(match[1]);
  }
  return null;
}

function patientTrend(history) {
  const rows = (Array.isArray(history) ? history : [])
    .map(row => ({ year: String(row?.data_year ?? ''), patients: Number(row?.patients) }))
    .filter(row => /^\d{4}$/.test(row.year) && Number.isInteger(row.patients) && row.patients > 0 && row.patients <= 100_000)
    .sort((a, b) => a.year.localeCompare(b.year));
  if (rows.length < 2) return null;
  const [earlier, later] = rows.slice(-2);
  if (later.patients <= earlier.patients) return null;
  return { from: earlier.patients, to: later.patients };
}

/** True only for a sentence `positiveAgencyFact` would write. A brief cannot smuggle in a rank or a low rating. */
export function allowedPositiveFact(text) {
  const line = String(text ?? '').trim();
  if (starSentence.test(line)) return line;
  const trend = trendSentence.exec(line);
  if (!trend || Number(trend[2]) <= Number(trend[1])) return null;
  return line;
}

/** True when Medicare's payment adjustment for the agency is a real non-zero percent. The email never states the percent. */
export function paymentChanged(facts) {
  const raw = facts?.hhvbp?.paymentAdjustmentPct ?? facts?.hhvbpAdjustmentPct;
  const value = Number(raw);
  return Number.isFinite(value) && value !== 0 && value >= -100 && value <= 100;
}

const saleLine = () => {
  const offer = products.intel.offers.find(item => item.startsWith('Founders Sale: '));
  const match = offer?.match(/^Founders Sale: (\d+% off) eligible subscription charges for the first (\d+ months)/);
  return match ? `Founders Sale: ${match[1]} the first ${match[2]}. It is applied on its own when a paid plan starts.` : null;
};

/**
 * The lines code adds under the writer's opening on a first Intel email, or ''. `oneFact` / `oneOffer` are the settings.
 * `bookingUrl` is used only when it is an https address with no login in it.
 */
export function emailOneNote({ oneFact = false, fact = null, oneOffer = false, trialUrl = null, bookingUrl = null } = {}) {
  const lines = [];
  if (oneFact && fact) lines.push(fact);
  const sale = saleLine();
  if (oneOffer && trialUrl && sale) {
    lines.push(`P.S. You can try CareMetric Intel free for ${products.intel.trialDays} days on one county. ${sale}\n${trialUrl}`);
  }
  if (isBookingUrl(bookingUrl)) lines.push(`If a short walkthrough would help, you can book one here:\n${bookingUrl.trim()}`);
  return lines.join('\n\n');
}

export function isBookingUrl(value) {
  if (typeof value !== 'string' || value.length > 1000 || /[\s\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

/** A draft still quoting the Founders Sale at 50% off, which the fact sheet no longer says. */
export function quotesOldSale(text) {
  const words = String(text ?? '');
  return /founders sale:\s*50%\s*off/i.test(words) || /50%\s*off your first 12 months/i.test(words) || /50%\s*off eligible/i.test(words);
}
