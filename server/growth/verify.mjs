/**
 * Addresses checked before the first email, and the bounce guard (20261116100000_growth_address_check.sql; owner decision 2026-11-16).
 *
 * `growth.verify`, every half hour, while Settings → Customer growth → "Check an address before the first email" is on:
 *
 * 1. The database hands out a few permitted cold-email addresses never yet written to (an email waiting first, then the best fit).
 * 2. Each is asked of its business's own mail server with the people finder's checker (mailbox.mjs: a made-up mailbox first, then the
 *    address, from the null sender, no message ever sent), and of the verification service when the server gives no clear answer and
 *    the owner has switched it on (address-service.mjs). The answer is recorded. An address whose mailbox does not exist becomes
 *    undeliverable, its waiting emails are cancelled and its business goes back to the people finder; one the server could not answer
 *    for is asked again later, at most three times.
 * 3. While the bounce guard is tripped (Settings → Customer growth → "Pause cold email at this bounce rate"), the owner is told once a
 *    day. Cold email itself waits in the send executor (worker.mjs), not here.
 *
 * Only counts are returned: never an address or a server's words. Once platform.agents.growth-diagnostics.v1 is declared, why a server
 * gave no answer is recorded on the contact and counted (`why`) as one of a few fixed reasons, so the retries can be judged.
 */
import { growthAddressCheckFeature, growthDay, growthDiagnosticsFeature } from './worker.mjs';

export { growthAddressCheckFeature, growthDiagnosticsFeature };
/** Addresses asked about per run: each conversation ends within a minute, and the run stops starting new ones after two. */
export const verifyPerRun = 6;
const startBudgetMs = 120_000;
const results = new Set(['verified', 'rejected', 'catch_all', 'unknown', 'unreachable']);
/** Why a server gave no answer (mailbox.mjs), as recorded; anything else the checker said is 'error'. */
// The STARTTLS reasons (mailbox.mjs, 20261117180000_work_recovery.sql): a server that asks for TLS without offering it, and one whose TLS
// conversation failed.
export const unansweredReasons = new Set(['temporary', 'blocked', 'refused', 'sender_refused', 'unexpected', 'dropped', 'no_mail', 'invalid', 'tls_required', 'tls_failed']);
const reasonFor = (result, answer) => (result === 'unreachable' ? 'unreachable'
  : result === 'unknown' ? (unansweredReasons.has(answer?.reason) ? answer.reason : 'error') : null);
const domainOf = email => String(email ?? '').slice(String(email ?? '').lastIndexOf('@') + 1).toLowerCase();

/** The owner's alert while the guard holds cold email: counts only, and what to do. */
export function guardAlert(guard) {
  const spam = Number(guard?.complaints ?? 0);
  const bounced = Number(guard?.bounced ?? 0), sent = Number(guard?.sent ?? 0);
  const why = spam > 0
    ? `${spam === 1 ? 'Someone' : `${spam} people`} marked a cold email as spam`
    : `${bounced} of the ${sent} cold emails sent since ${String(guard?.since ?? '').slice(0, 10)} bounced for good, above your ${guard?.percent}% limit`;
  return {
    subject: 'Cold email is paused',
    body: `${why}. No cold email goes out until you resume it on Growth (Send guard). Replies to people who wrote in and customer emails still go. `
      + 'Before resuming, check the growth sender\'s domain records (SPF, DKIM, DMARC) and turn on "Check an address before the first email" under Settings → Customer growth.',
  };
}

export function verifyHandlers({ growth, features = null, notifier = null, clock = () => Date.now() }) {
  const declared = features instanceof Set ? features.has(growthAddressCheckFeature) : Array.isArray(features) && features.includes(growthAddressCheckFeature);
  if (!growth || !declared || typeof growth.store?.mailboxCandidates !== 'function') return {};
  // Why an address got no answer is recorded once the database can hold it (20261117160000_growth_diagnostics.sql).
  const diagnosing = features instanceof Set ? features.has(growthDiagnosticsFeature) : Array.isArray(features) && features.includes(growthDiagnosticsFeature);
  async function verify(task, { signal, now = () => new Date() } = {}) {
    if (task.agent?.autonomy === 'observe') return { result: { skipped: 'observe_only' } };
    const started = clock();
    // The owner hears about a tripped guard whether or not addresses are being checked.
    const guard = await growth.store.sendGuardState();
    let alerted = false;
    if (guard?.tripped === true && notifier) {
      const alert = guardAlert(guard);
      await notifier.send({ severity: 'warning', subject: alert.subject, body: alert.body, dedupeKey: `growth:bounce-guard:${growthDay(now())}`,
        agentKey: task.agentKey, taskId: task.id });
      alerted = true;
    }
    const guardResult = guard?.on === true ? { guard: guard.tripped === true ? 'tripped' : 'clear', ...(alerted ? { alerted } : {}) } : {};
    const mailbox = growth.people?.mailbox;
    // A checker with no host name to introduce the Hub with can ask nothing.
    if (typeof mailbox?.check !== 'function' || mailbox.configured !== true) return { result: { ...guardResult, skipped: 'checker_not_configured' } };
    // Empty while checking is off (the database reads the owner's setting).
    const candidates = await growth.store.mailboxCandidates(verifyPerRun);
    // byService: answers the verification service gave when the mail server would not (address-service.mjs).
    const counts = { checked: 0, verified: 0, rejected: 0, catch_all: 0, unknown: 0, unreachable: 0, undeliverable: 0, cancelled: 0, byService: 0 };
    const why = {};
    let stopped = null;
    for (const candidate of candidates) {
      signal?.throwIfAborted();
      if (clock() - started > startBudgetMs) { stopped = 'time'; break; }
      // Resting after three mail servers in a row could not be reached (outbound port 25 blocked): asking now would only spend a try.
      if (mailbox.available?.() === false) { stopped = 'mail_servers_unreachable'; break; }
      let answer;
      try { answer = await mailbox.check(domainOf(candidate.email), [candidate.email], { signal }); }
      catch (error) { if (signal?.aborted) throw error; answer = { result: 'unknown' }; }
      const result = results.has(answer?.result) ? answer.result : 'unknown';
      const reason = reasonFor(result, answer);
      let saved;
      try { saved = diagnosing ? await growth.store.mailboxRecord(candidate.id, result, reason) : await growth.store.mailboxRecord(candidate.id, result); }
      catch (error) { if (error?.code !== '22023') throw error; continue; }
      counts.checked++; counts[result]++;
      if (answer?.via === 'service') counts.byService++;
      if (reason) why[reason] = (why[reason] ?? 0) + 1;
      if (saved?.eligibility === 'undeliverable') counts.undeliverable++;
      counts.cancelled += Number(saved?.cancelled ?? 0);
    }
    const kept = Object.fromEntries(Object.entries(counts).filter(([key, value]) => key === 'checked' || value > 0));
    return { result: { ...guardResult, ...kept, ...(Object.keys(why).length ? { why } : {}), ...(stopped ? { stopped } : {}) } };
  }
  return { 'growth.verify': verify };
}
