/**
 * A verification service for the addresses a business's own mail server will not answer for (owner decision 2026-11-17). The Hub's
 * own check (mailbox.mjs) asks the business's mail server from the Hub's cloud server, and most mail servers refuse that or give no
 * clear answer: on 2026-11-16 it confirmed 2 of 27 addresses, and every reason recorded since was a policy refusal ('blocked').
 *
 * `withAddressService` wraps the Hub's own checker with the same interface. The mail server is always asked first; only when it gives
 * no clear answer (a refusal about the Hub, a temporary answer, no answer at all) is the service asked, address by address in the
 * order given (the best shape of a name first), at most `serviceGuesses` of them, each one reserved in the database under Settings →
 * Customer growth → "Most verification service checks a day". It is used only while "Ask a verification service when a mail server
 * won't answer" is on, the ZeroBounce API key is set, and the database declares platform.agents.growth-address-service.v1.
 *
 * ZeroBounce (api.zerobounce.net, version 2, checked 2026-11-17): one address per request, at one fixed HTTPS address, no redirects, a
 * bounded answer. Only its status is read: valid confirms the address; invalid, spam trap, abuse and do-not-mail refuse it (except a
 * role address such as info@ that is marked do-not-mail only for being a role address: its mailbox exists); catch-all confirms
 * nothing; unknown leaves the mail server's own answer standing. The key never reaches a log, an error or a result, and an address is
 * never logged.
 */
import { live } from '../live.mjs';

export const growthAddressServiceFeature = 'platform.agents.growth-address-service.v1';
/** Addresses asked of the service per person: the shapes of a name most likely to be the one in use. */
export const serviceGuesses = 3;
const origin = 'https://api.zerobounce.net';
const maxBytes = 100_000;
// The mail server's answers worth a second opinion: it said nothing about the mailbox. A domain with no mail host, or an address the
// checker would not ask about, is not.
const unanswered = new Set(['temporary', 'blocked', 'refused', 'sender_refused', 'unexpected', 'dropped', 'tls_required', 'tls_failed', 'error']);
const easternDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const failure = (code, transient = false) => Object.assign(new Error('The verification service could not be read.'), { code, transient });

/** A ZeroBounce answer as the Hub's checker answers: verified, rejected, catch_all or unknown. */
export function zeroBounceResult(answer) {
  const status = String(answer?.status ?? '').toLowerCase();
  const sub = String(answer?.sub_status ?? '').toLowerCase();
  if (status === 'valid') return 'verified';
  if (status === 'catch-all') return 'catch_all';
  if (status === 'invalid' || status === 'spamtrap' || status === 'abuse') return 'rejected';
  if (status === 'do_not_mail') return sub === 'role_based' ? 'verified' : sub === 'role_based_catch_all' ? 'catch_all' : 'rejected';
  return 'unknown';
}

async function readJson(response) {
  const reader = response.body?.getReader?.();
  if (!reader) throw failure('service_response_invalid');
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw failure('service_response_too_large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('service_response_invalid'); }
}

export function zeroBounce({ apiKey = '', fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const key = String(apiKey ?? '').trim();
  return {
    configured: key.length > 0,
    /** Whether ZeroBounce says `email` can receive mail: { result }. Throws a coded error when it cannot answer. */
    async check(email, { signal } = {}) {
      if (!key) throw failure('service_not_configured');
      const address = String(email ?? '').toLowerCase();
      if (!/^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,}$/.test(address)) throw failure('service_invalid_address');
      const query = new URLSearchParams({ api_key: key, email: address, ip_address: '' });
      let response;
      try {
        response = await fetchImpl(`${origin}/v2/validate?${query}`, { redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json' },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw failure('service_unavailable', true);
      }
      if (!response.ok) { await response.body?.cancel?.().catch(() => {}); throw failure(response.status === 429 || response.status >= 500 ? 'service_unavailable' : 'service_refused', response.status === 429 || response.status >= 500); }
      const answer = await readJson(response);
      // A wrong key or no credits left comes back as 200 with an error and no status.
      if (answer?.error || typeof answer?.status !== 'string') throw failure('service_refused');
      return { result: zeroBounceResult(answer) };
    },
  };
}

/**
 * The Hub's checker (mailbox.mjs), asking the verification service when the mail server gives no clear answer. `enabled` is the owner's
 * setting (a reader), `declared` whether the database can reserve the service's checks, `reserve(n)` that reservation. The answer has
 * the checker's shape; one the service gave carries `via: 'service'`, and a service that could not help leaves the mail server's answer
 * with `service` saying why (daily_limit, or the service's error code).
 */
export function withAddressService({ mailbox, service = null, enabled = false, declared = () => false, reserve = null, guesses = serviceGuesses,
  clock = () => Date.now() }) {
  if (!mailbox) return mailbox;
  const on = () => live(enabled) === true && service?.configured === true && typeof reserve === 'function' && declared() === true;
  // A service that refused (no credits left, or a wrong key: 200 with an error) is not asked again that Eastern day, so the day's
  // reserved checks are not spent on refusals (the Nov 24 measurement: none answered after November 17), and the refusal is reported.
  let refusedOn = null;
  const today = () => easternDay.format(clock());
  return {
    /** The Eastern day the service last refused, or null: the growth.verify task tells the owner (verify.mjs). */
    serviceRefusedOn: () => refusedOn,
    configured: mailbox.configured,
    // The service still answers while the mail servers are resting (three unreachable in a row).
    available: () => mailbox.available?.() !== false || (mailbox.configured === true && on()),
    state: () => mailbox.state?.(),
    async check(domain, addresses, { signal } = {}) {
      const first = await mailbox.check(domain, addresses, { signal });
      const unclear = first?.result === 'unreachable' || (first?.result === 'unknown' && (!first.reason || unanswered.has(first.reason)));
      if (!unclear || !on()) return first;
      if (refusedOn === today()) return { ...first, service: 'refused_today' };
      const host = String(domain ?? '').toLowerCase();
      const asked = (addresses ?? []).map(value => String(value).toLowerCase())
        .filter(value => value.slice(value.lastIndexOf('@') + 1) === host).slice(0, guesses);
      let refused = 0;
      for (const email of asked) {
        signal?.throwIfAborted();
        let reserved;
        try { reserved = await reserve(1); } catch { return { ...first, service: 'not_reserved' }; }
        if (!reserved) return { ...first, service: 'daily_limit' };
        let answer;
        try { answer = await service.check(email, { signal }); }
        catch (error) {
          if (signal?.aborted) throw error;
          if (error?.code === 'service_refused') refusedOn = today();
          return { ...first, service: error?.code ?? 'service_unavailable' };
        }
        if (answer?.result === 'verified') return { result: 'verified', email, via: 'service' };
        if (answer?.result === 'catch_all') return { result: 'catch_all', via: 'service' };
        if (answer?.result !== 'rejected') return { ...first, service: 'unknown' };
        refused += 1;
      }
      return refused ? { result: 'rejected', via: 'service' } : first;
    },
  };
}
