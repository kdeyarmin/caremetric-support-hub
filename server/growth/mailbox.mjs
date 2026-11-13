/**
 * The Hub's own address finder for a named decision-maker (owner decision 2026-11-13: do in the Hub what Apollo did, guessing and
 * checking addresses included). Given a person's name and their business's domain it builds the usual shapes of a work address
 * (jane.doe@, jdoe@, jane@ …) and asks the business's own mail server which one is a real mailbox, the way a mail server is asked
 * before any message is sent:
 *
 * - Only the business's MX hosts (RFC 5321), at most two, on port 25. A name that resolves to a private, loopback or link-local
 *   address, or no address, is never connected to; the connection is made to the address that was checked.
 * - Each question is its own transaction from the null sender: `MAIL FROM:<>`, one `RCPT TO`, then `RSET`. No message is ever sent:
 *   there is no `DATA`, and the session ends with `QUIT`.
 * - A made-up mailbox is asked first. A server that accepts it accepts every address (a catch-all), so it can confirm nothing and no
 *   address is kept. Only a server that refuses the made-up mailbox and accepts a guessed one confirms it.
 * - A refusal that is about the Hub rather than the mailbox (5.7.x, a block list, a policy) or a temporary answer (4xx, often
 *   greylisting) confirms nothing either.
 * - At most `maxGuesses` shapes per person, best first: a shape learned from the business's own published addresses goes first.
 * - Railway allows outbound port 25 on its Pro plan only. When three businesses in a row cannot be reached at all the checker rests
 *   for six hours and says so (`state`), so a blocked port costs one try, not one per business.
 *
 * Addresses are built only from letters a to z, so nothing a page or a name says can add a command to the conversation. Only the
 * answer's code is read; the server's words are never stored or logged.
 */
import { randomBytes } from 'node:crypto';
import { lookup as dnsLookup, resolveMx as dnsResolveMx } from 'node:dns/promises';
import { connect as netConnect, isIP } from 'node:net';
import { privateAddress, roleLocalParts } from './contacts.mjs';
import { isCredential } from './team.mjs';

/** The usual shapes of a work address, most common first. */
export const addressPatterns = Object.freeze(['first.last', 'flast', 'first', 'firstlast', 'f.last', 'first_last', 'firstl', 'last']);
export const maxGuesses = 6;
const restAfterFailures = 3;
const restMs = 6 * 60 * 60 * 1000;
const replyBytes = 64_000;
const hostPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/;

const prefixes = new Set(['dr', 'mr', 'mrs', 'ms', 'miss', 'mx', 'rev', 'prof', 'sister', 'fr']);
const particles = new Set(['de', 'del', 'della', 'der', 'di', 'da', 'du', 'la', 'le', 'van', 'von', 'st', 'mac', 'dos', 'das', 'ten', 'ter']);
const letters = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');

/**
 * A person's first and last name as letters a to z ({ first, last }), or null when the name is not a person's full name. Reads
 * "Jane A. Doe, RN", "Dr. Jane Doe", "DOE, JANE" and "María de la Cruz"; drops nicknames in quotes or brackets.
 */
export function nameParts(name) {
  let text = String(name ?? '').replace(/(^|\s)["“'‘(][^"“”'‘’()]{1,30}["”'’)](?=\s|,|$)/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 200 || /[@\d]/.test(text)) return null;
  // Segments after a comma are credentials ("Jane Doe, RN, BSN") or, once those are gone, a first name ("Doe, Jane").
  const segments = text.split(',').map(part => part.trim()).filter(Boolean);
  const credentialsOnly = part => { const words = part.split(/[\s/.-]+/).filter(Boolean);
    return words.some(isCredential) && words.every(word => isCredential(word) || letters(word).length === 1); };
  const kept = [segments[0], ...segments.slice(1).filter(part => !credentialsOnly(part))];
  if (kept.length > 2) return null;
  text = kept.length === 2 ? `${kept[1]} ${kept[0]}` : kept[0];
  const tokens = text.split(/\s+/).filter(Boolean);
  while (tokens.length && prefixes.has(letters(tokens[0]))) tokens.shift();
  while (tokens.length && isCredential(tokens.at(-1))) tokens.pop();
  if (tokens.length < 2 || tokens.length > 5) return null;
  const first = letters(tokens[0]);
  let start = tokens.length - 1;
  while (start > 1 && particles.has(letters(tokens[start - 1]))) start -= 1;
  const last = tokens.slice(start).map(letters).join('');
  if (first.length < 2 || first.length > 30 || last.length < 2 || last.length > 40) return null;
  return { first, last };
}

/** The local part `pattern` gives for a name, or null. */
export function localPart(parts, pattern) {
  if (!parts) return null;
  const { first, last } = parts;
  const shapes = { 'first.last': `${first}.${last}`, flast: `${first[0]}${last}`, first, firstlast: `${first}${last}`, 'f.last': `${first[0]}.${last}`,
    first_last: `${first}_${last}`, firstl: `${first}${last[0]}`, last };
  const value = shapes[pattern];
  return value && value.length <= 64 ? value : null;
}

/**
 * The shape the business's own published addresses follow, learned from those that belong to a person the team knows there
 * (jdoe@ beside "John Doe" is flast), or null. A role address (info@) teaches nothing.
 */
export function learnPattern(addresses, people) {
  const counts = new Map();
  const names = (people ?? []).map(person => nameParts(person?.name)).filter(Boolean);
  for (const address of addresses ?? []) {
    const local = String(address ?? '').toLowerCase().split('@')[0];
    if (!local || roleLocalParts.includes(local)) continue;
    for (const parts of names) {
      const pattern = addressPatterns.find(shape => shape !== 'first' && shape !== 'last' && localPart(parts, shape) === local)
        ?? addressPatterns.find(shape => localPart(parts, shape) === local);
      if (pattern) { counts.set(pattern, (counts.get(pattern) ?? 0) + 1); break; }
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || addressPatterns.indexOf(a[0]) - addressPatterns.indexOf(b[0]))[0]?.[0] ?? null;
}

/** The addresses worth asking about for one person at `domain`, best first: the learned shape, then the usual ones. */
export function addressGuesses(name, domain, { learned = null, limit = maxGuesses } = {}) {
  const parts = nameParts(name);
  const host = String(domain ?? '').toLowerCase();
  if (!parts || !hostPattern.test(host)) return [];
  const order = learned && addressPatterns.includes(learned) ? [learned, ...addressPatterns.filter(shape => shape !== learned)] : addressPatterns;
  const out = [];
  for (const shape of order) {
    const local = localPart(parts, shape);
    if (!local || roleLocalParts.includes(local)) continue;
    const address = `${local}@${host}`;
    if (!out.includes(address)) out.push(address);
    if (out.length >= limit) break;
  }
  return out;
}

/** Whether `email` is a person's address that `name` could have: one of the usual shapes of that name on exactly `domain`. */
export function addressFits(email, name, domain) {
  const [local, host] = String(email ?? '').toLowerCase().split('@');
  if (!local || host !== String(domain ?? '').toLowerCase()) return false;
  const parts = nameParts(name);
  // A first name or last name alone is too common to tie an address to one person without the mail server.
  return Boolean(parts) && addressPatterns.some(shape => shape !== 'first' && shape !== 'last' && localPart(parts, shape) === local);
}

const failure = reason => ({ result: 'unknown', reason });

/** A reply's code, its enhanced status (5.1.1) when it has one, and whether it is about the sender rather than the mailbox. */
function readReply(lines) {
  const code = Number(lines.at(-1).slice(0, 3));
  const text = lines.map(line => line.slice(4)).join(' ');
  const enhanced = /^\s*([245])\.(\d{1,3})\.(\d{1,3})\b/.exec(text)?.slice(1, 4).join('.') ?? null;
  const policy = (enhanced?.startsWith('5.7.') ?? false) || /\b(block|blacklist|blocklist|spamhaus|rbl|dnsbl|reputation|banned|policy|not allowed to send|client host|denied by|access denied, banned)/i.test(text);
  return { code, enhanced, policy };
}

/** One SMTP conversation over `socket`: send a line, read one whole (possibly multi-line) reply. */
function conversation(socket, timeoutMs) {
  let buffer = '';
  let bytes = 0;
  let pending = null;
  let ended = null;
  const settle = () => {
    if (!pending) return;
    if (ended) { const { reject } = pending; pending = null; reject(ended); return; }
    const lines = [];
    let from = 0;
    for (;;) {
      const end = buffer.indexOf('\n', from);
      if (end === -1) return;
      const line = buffer.slice(from, end).replace(/\r$/, '');
      from = end + 1;
      if (!/^\d{3}([ -]|$)/.test(line)) { ended = Object.assign(new Error('Not an SMTP reply'), { code: 'EPROTO' }); buffer = ''; settle(); return; }
      lines.push(line);
      if (line.length === 3 || line[3] === ' ') {
        buffer = buffer.slice(from);
        const { resolve } = pending;
        pending = null;
        resolve(readReply(lines));
        return;
      }
    }
  };
  socket.setEncoding?.('latin1');
  socket.setTimeout?.(timeoutMs, () => socket.destroy(Object.assign(new Error('SMTP timeout'), { code: 'ETIMEDOUT' })));
  socket.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > replyBytes) { socket.destroy(Object.assign(new Error('SMTP reply too large'), { code: 'EPROTO' })); return; }
    buffer += chunk;
    settle();
  });
  socket.on('error', error => { ended ??= error; settle(); });
  socket.on('close', () => { ended ??= Object.assign(new Error('SMTP connection closed'), { code: 'ECONNRESET' }); settle(); });
  const reply = () => new Promise((resolve, reject) => { pending = { resolve, reject }; settle(); });
  return {
    reply,
    async command(line) {
      if (/[\r\n]/.test(line)) throw new Error('A command is one line');
      socket.write(`${line}\r\n`);
      return reply();
    },
    /** Says goodbye and waits briefly for the answer, then closes the connection whatever happens. */
    async close() {
      if (!ended && !socket.destroyed) {
        const timer = setTimeout(() => socket.destroy(), 2000);
        try { socket.write('QUIT\r\n'); await reply(); } catch { /* closed meanwhile */ } finally { clearTimeout(timer); }
      }
      socket.destroy();
    },
  };
}

export function mailboxChecker({ heloName = '', resolveMx = dnsResolveMx, lookup = dnsLookup, connect = netConnect, timeoutMs = 15_000, deadlineMs = 60_000,
  now = Date.now, made = () => `cm${randomBytes(8).toString('hex')}` } = {}) {
  const helo = String(heloName ?? '').toLowerCase();
  const configured = hostPattern.test(helo);
  let failures = 0;
  let restingUntil = 0;
  let reachable = null;

  // The business's mail hosts, best first, or null when it takes no mail.
  async function mailHosts(domain) {
    let records;
    try { records = await resolveMx(domain); } catch { return null; }
    const hosts = (Array.isArray(records) ? records : []).filter(record => typeof record?.exchange === 'string')
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)).map(record => record.exchange.toLowerCase().replace(/\.$/, ''))
      .filter(host => hostPattern.test(host) && !isIP(host));
    return hosts.length ? [...new Set(hosts)].slice(0, 2) : null;
  }

  // A connected socket to one checked address of `host`, or null when it has none the checker may use or cannot be reached.
  async function open(host, signal) {
    let addresses;
    try { addresses = await lookup(host, { all: true }); } catch { return null; }
    if (!Array.isArray(addresses) || !addresses.length || addresses.some(entry => privateAddress(entry?.address))) return null;
    const address = (addresses.find(entry => entry.family === 4) ?? addresses[0]).address;
    return new Promise(resolve => {
      const socket = connect({ host: address, port: 25 });
      let timer = null;
      const done = value => { clearTimeout(timer); signal?.removeEventListener('abort', fail); if (!value) socket.destroy(); resolve(value); };
      const fail = () => done(null);
      timer = setTimeout(fail, timeoutMs);
      signal?.addEventListener('abort', fail, { once: true });
      socket.once('error', fail);
      socket.once('connect', () => done(socket));
    });
  }

  /**
   * Which of `addresses` (all on `domain`) the business's mail server confirms: { result: 'verified', email }, or 'rejected' (it
   * refused every one), 'catch_all' (it accepts any address), 'unknown' with a reason, or 'unreachable' (no mail host answered).
   */
  async function check(domain, addresses, { signal } = {}) {
    const host = String(domain ?? '').toLowerCase();
    if (!configured || !hostPattern.test(host)) return failure('invalid');
    const asked = (addresses ?? []).map(value => String(value).toLowerCase())
      .filter(value => /^[a-z0-9._-]{1,64}@/.test(value) && value.slice(value.indexOf('@') + 1) === host).slice(0, maxGuesses);
    if (!asked.length) return failure('invalid');
    if (now() < restingUntil) return { result: 'unreachable' };
    const hosts = await mailHosts(host);
    if (!hosts) return failure('no_mail');
    let socket = null;
    for (const name of hosts) {
      signal?.throwIfAborted();
      socket = await open(name, signal);
      if (socket) break;
    }
    signal?.throwIfAborted();
    if (!socket) {
      failures += 1;
      if (failures >= restAfterFailures) { restingUntil = now() + restMs; reachable = false; failures = 0; }
      return { result: 'unreachable' };
    }
    const smtp = conversation(socket, timeoutMs);
    const stop = () => socket.destroy();
    signal?.addEventListener('abort', stop, { once: true });
    // A server may slow every refused address down; the whole conversation still ends within `deadlineMs`.
    const deadline = setTimeout(() => socket.destroy(Object.assign(new Error('SMTP deadline'), { code: 'ETIMEDOUT' })), deadlineMs);
    try {
      const greeting = await smtp.reply();
      failures = 0; reachable = true;
      if (greeting.code !== 220) return failure(greeting.policy ? 'blocked' : 'refused');
      let hello = await smtp.command(`EHLO ${helo}`);
      if (hello.code !== 250) hello = await smtp.command(`HELO ${helo}`);
      if (hello.code !== 250) return failure(hello.policy ? 'blocked' : 'refused');
      const ask = async address => {
        const from = await smtp.command('MAIL FROM:<>');
        if (from.code !== 250) return { ...from, sender: true };
        const answer = await smtp.command(`RCPT TO:<${address}>`);
        await smtp.command('RSET');
        return answer;
      };
      const judge = answer => {
        if (answer.sender) return failure(answer.policy ? 'blocked' : 'sender_refused');
        if (answer.code >= 400 && answer.code < 500) return failure('temporary');
        if (answer.code >= 500 && answer.policy) return failure('blocked');
        if (answer.code >= 500) return null;
        return failure('unexpected');
      };
      const probe = await ask(`${made()}@${host}`);
      if (probe.code === 250 || probe.code === 251) return { result: 'catch_all' };
      const refusal = judge(probe);
      if (refusal) return refusal;
      for (const address of asked) {
        signal?.throwIfAborted();
        const answer = await ask(address);
        if (answer.code === 250 || answer.code === 251) return { result: 'verified', email: address };
        const stopped = judge(answer);
        if (stopped) return stopped;
      }
      return { result: 'rejected' };
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      return failure('dropped');
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener('abort', stop);
      await smtp.close();
    }
  }

  return {
    configured,
    /** Whether a check can be made now: a host name to introduce the Hub with, and not resting after unreachable servers. */
    available: () => configured && now() >= restingUntil,
    /** 'reachable', 'unreachable' (resting: outbound port 25 seems blocked) or 'unknown' (not tried yet). */
    state: () => (reachable === null ? 'unknown' : now() < restingUntil ? 'unreachable' : reachable ? 'reachable' : 'unknown'),
    check,
  };
}
