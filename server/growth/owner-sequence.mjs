/**
 * The owner's own email sequences (owner handoff 2026-11-27, "Pennsylvania cold email, batch 1"; docs/OWNER_SEQUENCES.md;
 * 20261127150000_owner_sequences.sql).
 *
 * The owner writes the emails, word for word, and chooses the people (a send list, one row per person) and the dates. The Hub prepares
 * each person's emails: it finds the agency's CMS certification number through Intel's marketing feed (`agency_match`), reads which county
 * its market report covers (`agency_brief`), signs a 90-day report link carrying the row's reference and checks once that Intel serves it
 * (the check is signed without the reference, so it is never counted as an open). An agency with no confident match, or no report, gets
 * the copy's fallback first email instead. The owner reviews every email on Growth and approves the sequence once; nothing is sent before.
 *
 * The Marketing Manager's `growth.sequences` task (every five minutes) then sends one email a run, plain text exactly as approved, from
 * the growth sender in the owner's name with replies to the support inbox, on weekdays in the sequence's window (9 to 11 Eastern). The
 * database decides what is due and stops a person on any reply, a bounce, an opt-out or an automatic reply that says they have left; an
 * opt-out ("no thanks" counts) forbids the address, the agency's domain and its CCN for good. Each run first tells the owner about every
 * reply, stop and first report open. Email goes through SendGrid only: Amazon SES does not allow unsolicited email.
 */
import { randomUUID } from 'node:crypto';
import { live } from '../live.mjs';

export const ownerSequencesFeature = 'platform.agents.owner-sequences.v1';
export const ownerSequenceRequestsFeature = 'platform.agents.owner-sequence-requests.v1';
/** A report link in an owner sequence lives 90 days (the handoff); Intel accepts up to 180. */
export const sequenceLinkDays = 90;
/** The most people one prepared sequence holds: each needs a few feed requests, paced a second apart. */
export const maxPeople = 30;
/** Cambria County and the seven counties bordering it: they compete with the company the owner manages (owner handoff 2026-11-27). */
export const excludedCounties = Object.freeze(['Cambria', 'Clearfield', 'Centre', 'Blair', 'Bedford', 'Somerset', 'Westmoreland', 'Indiana']);
/** Mail services whose domain says nothing about the business (the database's growth_free_mail). */
const freeMail = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com', 'icloud.com',
  'me.com', 'mac.com', 'aol.com', 'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'bellsouth.net', 'cox.net', 'charter.net', 'protonmail.com',
  'proton.me', 'mail.com', 'gmx.com', 'zoho.com', 'fastmail.com', 'hey.com']);

const refPattern = /^[A-Za-z0-9_-]{1,40}$/;
const emailPattern = /^[^\s@<>"(),;:]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/;
const domainPattern = /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/;
const ccnPattern = /^[0-9A-Z]{6}$/;
const campaignPattern = /^[a-z0-9-]{1,60}$/;
const origin = 'https://www.caremetricintel.com';

// ---------------------------------------------------------------------------------------
// The owner's copy. Every sentence is the owner's, as the handoff gives it; only blank lines between paragraphs are added, as a plain-text
// email needs them. Changing a word is a code change reviewed like any other, and the test pins the words.
// ---------------------------------------------------------------------------------------

const signature = ['Kevin Deyarmin', 'CareMetric Healthcare Advisors', '117 Jennings Rd, South Fork, PA 15956'].join('\n');
const optOutLine = 'Not relevant? Reply "no thanks" and I won\'t write again.';
/** A page of Intel's site with the sequence's campaign tags, in the handoff's order. */
export const taggedUrl = (url, { campaign, content, ref }) =>
  `${url}${url.includes('?') ? '&' : '?'}utm_source=caremetric&utm_medium=email&utm_campaign=${campaign}&utm_content=${content}&utm_term=${encodeURIComponent(ref)}`;
const letter = (person, paragraphs) => [person.firstName ? `Hi ${person.firstName},` : 'Hi there,', ...paragraphs, signature, optOutLine].join('\n\n');

export const templates = Object.freeze({
  // The handoff of 2026-11-27, checked against Intel's code that day: the weekly email's "Sources sending fewer referrals", the competitor
  // alerts (star rating, owner, service area), county share rankings, the 30-day trial on one county with no card, the 74-second
  // walkthrough on the home page and the free county report's contents.
  'intel-pa-cold-2026-11': Object.freeze({
    label: 'CareMetric Intel, Pennsylvania cold email (November 27, 2026 copy)',
    fromName: 'Kevin Deyarmin',
    steps: 3,
    render(person, { campaign }) {
      const report = person.reportUrl
        ? {
          subject: `${person.agency} in ${person.county} County`,
          body: letter(person, [
            'I\'ve managed a home health and hospice company in western Pennsylvania for 17 years. Finding referral sources, keeping them and watching competitors is most of the job, so I built CareMetric Intel to put that work in one place.',
            `I ran ${person.agency} through it. Your report shows where you stand in ${person.county} County, your largest competitors there, the hospitals the county's residents use most and your CMS ratings:\n${person.reportUrl}`,
            'There\'s nothing to sign up for to read it.',
          ]),
        }
        : {
          subject: `Which hospitals ${person.county} County residents use most`,
          body: letter(person, [
            'I\'ve managed a home health and hospice company in western Pennsylvania for 17 years, and I built CareMetric Intel for that work.',
            `Do you know which hospitals ${person.county} County's residents use most?`,
            `The free county report answers that. It also covers the county's older population and Medicare enrollment, and the home health agencies, hospices and nursing homes located there. It arrives by email as a PDF:\n${taggedUrl(`${origin}/county-report`, { campaign, content: 'email-1', ref: person.ref })}`,
            'Intel is the tool behind it. It keeps that research and your marketers\' accounts and visits in one place.',
          ]),
        };
      return [
        report,
        {
          subject: 'When a referral source goes quiet',
          body: letter(person, [
            'When a physician who used to refer stops sending patients, how soon does your team find out?',
            'Intel keeps each referral source\'s visits and referrals in one record, and its weekly email flags any source that starts sending fewer referrals, so you know who needs a visit.',
            `There's a 74-second walkthrough on our home page:\n${taggedUrl(`${origin}/`, { campaign, content: 'email-2', ref: person.ref })}`,
          ]),
        },
        {
          subject: `Last note on ${person.county} County`,
          body: letter(person, [
            'Last note from me.',
            'Intel also ranks agencies by share in each county, and alerts you when a competitor\'s star rating, owner or service area changes.',
            `You can try it on ${person.county} County free for 30 days, with no card:\n${taggedUrl(`${origin}/login?signup=true`, { campaign, content: 'email-3', ref: person.ref })}`,
            'If you have a question first, reply here and I\'ll answer in writing.',
          ]),
        },
      ];
    },
  }),
});
export const defaultTemplate = 'intel-pa-cold-2026-11';

// ---------------------------------------------------------------------------------------
// The send list.
// ---------------------------------------------------------------------------------------

/** RFC 4180 rows: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text) {
  const source = String(text ?? '').replace(/^﻿/, '');
  if (source.length > 200_000) throw Object.assign(new Error('The send list is too large.'), { code: 'too_large' });
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === '') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += char;
  }
  if (quoted) throw Object.assign(new Error('The send list has an unclosed quote.'), { code: 'unclosed_quote' });
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(cells => cells.some(cell => cell.trim() !== ''));
}

const columnAliases = {
  ref: ['ref', 'reference'],
  email: ['email', 'email_address', 'e_mail'],
  firstName: ['first_name', 'firstname', 'first'],
  agency: ['agency_display', 'agency', 'agency_name'],
  matchName: ['agency_name_for_matching', 'matching_name', 'legal_name'],
  city: ['city'],
  county: ['county'],
  state: ['state'],
  setting: ['setting', 'service', 'type'],
  website: ['website', 'domain', 'site'],
  ccn: ['ccn', 'cms_certification_number'],
};
const headerKey = value => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const titleCounty = value => String(value ?? '').trim().replace(/\s+county$/i, '').replace(/\s+/g, ' ')
  .toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, gap, letter) => gap + letter.toUpperCase());
export const isExcludedCounty = county => excludedCounties.includes(titleCounty(county));
const settingOf = value => {
  const key = headerKey(value);
  return ['hha', 'home_health', 'home_health_agency', 'homehealth'].includes(key) ? 'hha' : ['hospice'].includes(key) ? 'hospice' : null;
};
const domainOf = value => {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return null;
  let host = text;
  try { host = new URL(/^https?:\/\//.test(text) ? text : `https://${text}`).hostname; } catch { return null; }
  host = host.replace(/^www\./, '');
  return domainPattern.test(host) ? host : null;
};

/**
 * The people of a send list ({ ref, email, firstName, agency, matchName, city, county, setting, domain, ccn }) and the rows left out
 * ({ row, ref, agency, reason }): a missing or malformed field, a state other than Pennsylvania, a county in the owner's home area, a
 * repeated reference or address.
 */
export function readSendList(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return { people: [], problems: [{ row: 1, ref: null, agency: null, reason: 'empty' }] };
  const header = rows[0].map(headerKey);
  const index = Object.fromEntries(Object.entries(columnAliases).map(([key, names]) => [key, header.findIndex(name => names.includes(name))]));
  const missing = ['ref', 'email', 'agency', 'county', 'setting'].filter(key => index[key] < 0);
  if (missing.length) return { people: [], problems: [{ row: 1, ref: null, agency: null, reason: `missing_columns:${missing.join(',')}` }] };
  const people = []; const problems = []; const refs = new Set(); const emails = new Set();
  rows.slice(1).forEach((cells, offset) => {
    const cell = key => (index[key] >= 0 ? String(cells[index[key]] ?? '').trim() : '');
    const ref = cell('ref'); const agency = cell('agency').replace(/\s+/g, ' ');
    const left = reason => problems.push({ row: offset + 2, ref: ref || null, agency: agency || null, reason });
    const email = cell('email').toLowerCase();
    const first = cell('firstName');
    const state = cell('state');
    const county = titleCounty(cell('county'));
    const setting = settingOf(cell('setting'));
    const ccn = cell('ccn').toUpperCase();
    if (!refPattern.test(ref)) return left('ref');
    if (!emailPattern.test(email) || email.length > 320) return left('email');
    if (!agency || agency.length > 200) return left('agency');
    if (!county || county.length > 80 || !/^[A-Za-z .'-]+$/.test(county)) return left('county');
    if (state && !['pa', 'pennsylvania'].includes(state.toLowerCase())) return left('state');
    if (!setting) return left('setting');
    if (first && !/^[A-Za-z][A-Za-z'’ .-]{0,58}$/.test(first)) return left('first_name');
    if (ccn && !ccnPattern.test(ccn)) return left('ccn');
    if (isExcludedCounty(county)) return left('home_area');
    if (refs.has(ref)) return left('duplicate_ref');
    if (emails.has(email)) return left('duplicate_email');
    refs.add(ref); emails.add(email);
    const emailDomain = email.slice(email.lastIndexOf('@') + 1);
    const domain = domainOf(cell('website')) ?? (freeMail.has(emailDomain) ? null : emailDomain);
    people.push({ ref, email, firstName: first ? first.replace(/\s+/g, ' ') : null, agency, matchName: (cell('matchName') || agency).slice(0, 200),
      city: cell('city').slice(0, 100) || null, county, setting, domain: domain && !freeMail.has(domain) ? domain : null, ccn: ccn || null });
  });
  return { people, problems };
}

/** The weekdays a sequence sends on: 1 to 5 dates (YYYY-MM-DD), each a weekday, in order, none before `today`. */
export function checkDates(dates, today) {
  if (!Array.isArray(dates) || dates.length < 1 || dates.length > 5) return 'dates';
  for (let i = 0; i < dates.length; i++) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dates[i]))) return 'dates';
    const day = new Date(`${dates[i]}T12:00:00Z`);
    if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== dates[i] || [0, 6].includes(day.getUTCDay())) return 'weekday';
    if (dates[i] < today || (i > 0 && dates[i] <= dates[i - 1])) return 'order';
  }
  return null;
}
export const easternToday = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Prepares each person: the agency's CCN (from the list, else Intel's `agency_match` by name and city in Pennsylvania; a match of the other
 * setting is not taken), the county its report covers (the report's county wins over the list's, and a report in the owner's home area
 * leaves the person out), the report link with the person's reference, checked once, and their emails. Returns { people, problems }.
 * `feed` is Intel's feed reader, `reports` the report link signer (report-link.mjs).
 */
export async function preparePeople(people, { feed, reports, template, campaign, sendDates, signal, paceMs = feed?.paceMs ?? 1100, wait = pause } = {}) {
  const copy = templates[template];
  if (!copy) throw Object.assign(new Error('Unknown copy.'), { code: 'template' });
  if (sendDates.length !== copy.steps) throw Object.assign(new Error(`This copy has ${copy.steps} emails.`), { code: 'steps' });
  const problems = []; const prepared = [];
  const matches = new Map();
  const asking = people.filter(person => !person.ccn);
  if (asking.length && feed?.configured) {
    for (let i = 0; i < asking.length; i += 25) {
      if (i) await wait(paceMs);
      const chunk = asking.slice(i, i + 25);
      try {
        const answer = await feed.agencyMatch({ signal, candidates: chunk.map(person => ({ key: person.ref, name: person.matchName, state: 'PA',
          ...(person.city ? { city: person.city } : {}), ...(person.domain && domainPattern.test(person.domain) ? { domain: person.domain } : {}) })) });
        for (const match of answer.matches ?? []) matches.set(match.key, match);
      } catch (error) {
        if (signal?.aborted) throw error;
        for (const person of chunk) matches.set(person.ref, { ccn: null, reason: 'feed_unavailable' });
      }
    }
  }
  for (const person of people) {
    signal?.throwIfAborted();
    const notes = {};
    let ccn = person.ccn;
    if (!ccn) {
      const match = matches.get(person.ref);
      const matchedSetting = match?.agency?.setting === 'hospice' ? 'hospice' : match?.agency?.setting === 'home_health' ? 'hha' : null;
      if (match?.ccn && matchedSetting === person.setting) { ccn = match.ccn; notes.matchedBy = match.matched_by ?? null; }
      else notes.noMatch = match?.ccn ? 'other_setting' : (match?.reason ?? (feed?.configured ? 'no_match' : 'feed_not_configured'));
    }
    let county = person.county;
    if (ccn && feed?.configured) {
      await wait(paceMs);
      try {
        const brief = await feed.agencyBrief({ ccn, signal });
        const reported = brief?.brief?.county?.name ? titleCounty(brief.brief.county.name) : null;
        if (reported && reported !== county) { notes.listCounty = county; county = reported; }
      } catch (error) { if (signal?.aborted) throw error; notes.countyUnchecked = true; }
    }
    if (isExcludedCounty(county)) { problems.push({ row: null, ref: person.ref, agency: person.agency, reason: 'home_area' }); continue; }
    let reportUrl = null;
    if (ccn) {
      reportUrl = await reports?.checkedAgencyLink?.({ ccn, setting: person.setting, ref: person.ref, days: sequenceLinkDays }, { signal }) ?? null;
      if (!reportUrl) notes.noReport = true;
    }
    const ready = { ...person, id: randomUUID(), ccn, county, reportUrl, notes };
    const messages = copy.render(ready, { campaign }).map((message, i) => ({ step: i + 1, sendOn: sendDates[i], ...message }));
    prepared.push({ ...ready, messages });
  }
  return { people: prepared, problems };
}

// ---------------------------------------------------------------------------------------
// The owner's operations (Growth) and the Marketing Manager's task.
// ---------------------------------------------------------------------------------------

/**
 * `store`: ownerSequenceStore (store.mjs). `feed`: an Intel feed reader for matching (owner-initiated, so it is not gated by the roster's
 * switch). `reports`: the report link signer. `unsubscribeToken`/`hash`: growth's signing. `mail`: a SendGrid sender for growth email.
 */
export function ownerSequences({ store, feed = null, reports = null, features = null, enabled = false, mail = null, publicOrigin = '',
  unsubscribeToken = null, hash = null, optOutPath = '/api/growth/preferences/', now = () => new Date() }) {
  const declared = () => (features instanceof Set ? features.has(ownerSequencesFeature) : Array.isArray(features) && features.includes(ownerSequencesFeature));
  const unsubscribeKey = recipientId => `owner-sequence:${recipientId}`;
  const requestsDeclared = () => (features instanceof Set ? features.has(ownerSequenceRequestsFeature) : Array.isArray(features) && features.includes(ownerSequenceRequestsFeature))
    && typeof store?.requestNext === 'function';
  /**
   * Reads a send list and prepares every person: the record the database saves as a draft, or null when every row was left out, and the
   * rows left out ({ row, ref, agency, reason }). `check` asks the database which people may not be emailed (the owner's command on Growth,
   * or the server's own for a request).
   */
  async function prepareRecord({ name, csv, template = defaultTemplate, campaign, sendDates, dailyLimit = 8 } = {}, { check, signal } = {}) {
    const copy = templates[template];
    if (!copy) throw Object.assign(new Error('Choose the copy to send.'), { code: 'template' });
    if (!campaignPattern.test(String(campaign ?? ''))) throw Object.assign(new Error('The campaign tag is lower-case letters, digits and hyphens.'), { code: 'campaign' });
    const dateProblem = checkDates(sendDates, easternToday(now()));
    if (dateProblem) throw Object.assign(new Error('Each send date is a weekday from today on, in order.'), { code: dateProblem });
    if (sendDates.length !== copy.steps) throw Object.assign(new Error(`This copy has ${copy.steps} emails: give one date for each.`), { code: 'steps' });
    if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 30) throw Object.assign(new Error('Most emails a day is 1 to 30.'), { code: 'daily_limit' });
    if (typeof unsubscribeToken !== 'function' || typeof hash !== 'function') throw Object.assign(new Error('Set the growth signing key first.'), { code: 'signing' });
    const list = readSendList(csv);
    if (list.people.length > maxPeople) throw Object.assign(new Error(`A sequence holds at most ${maxPeople} people.`), { code: 'too_many' });
    const problems = [...list.problems];
    const leaveOut = (people, blocked) => people.filter(person => {
      if (!blocked?.[person.ref]) return true;
      problems.push({ row: null, ref: person.ref, agency: person.agency, reason: blocked[person.ref] }); return false;
    });
    const asked = people => people.map(person => ({ ref: person.ref, email: person.email, domain: person.domain, ccn: person.ccn }));
    const allowed = list.people.length ? leaveOut(list.people, await check(asked(list.people))) : [];
    if (!allowed.length) return { record: null, problems };
    const ready = await preparePeople(allowed, { feed, reports, template, campaign, sendDates, signal });
    problems.push(...ready.problems);
    // A CCN found here can be on the do-not-contact list too: the database refuses the draft, so check once more by CCN.
    const withCcn = ready.people.filter(person => person.ccn);
    const people = withCcn.length ? leaveOut(ready.people, await check(asked(withCcn))) : ready.people;
    if (!people.length) return { record: null, problems };
    return { problems, record: {
      name: String(name ?? '').trim().slice(0, 120) || 'Owner sequence', template, campaign, sendDates, dailyLimit, sender: { fromName: copy.fromName },
      people: people.map(person => ({ id: person.id, ref: person.ref, email: person.email, domain: person.domain, firstName: person.firstName,
        agency: person.agency, county: person.county, setting: person.setting, ccn: person.ccn, reportUrl: person.reportUrl,
        unsubscribeHash: hash(unsubscribeToken(unsubscribeKey(person.id))), notes: person.notes,
        messages: person.messages.map(message => ({ step: message.step, sendOn: message.sendOn, subject: message.subject, body: message.body })) })),
    } };
  }
  /**
   * The next request an operator queued for the owner (20261127200000_owner_sequence_requests.sql): prepared exactly as the Growth page
   * prepares a send list, saved in the owner's name and approved when the request asked. The owner is told what came of it.
   */
  async function prepareRequest({ notifier, task, signal }) {
    if (!requestsDeclared()) return null;
    const request = await store.requestNext();
    if (!request?.id) return null;
    const payload = request.payload ?? {};
    let outcome; let problems = [];
    try {
      const prepared = await prepareRecord(payload, { check: people => store.requestCheck(request.id, people), signal });
      problems = prepared.problems;
      outcome = await store.requestFinish(request.id, prepared.record, problems, prepared.record ? null : 'nothing_prepared');
    } catch (error) {
      if (signal?.aborted) throw error;
      outcome = await store.requestFinish(request.id, null, problems, String(error?.code ?? error?.message ?? 'prepare_failed').slice(0, 300));
    }
    await tellRequest({ notifier, task, request, payload, outcome, problems });
    return { request: request.id, status: outcome?.status ?? 'failed', approved: outcome?.approved === true };
  }
  const service = {
    declared, get enabled() { return live(enabled) === true; },
    templates: Object.entries(templates).map(([id, copy]) => ({ id, label: copy.label, steps: copy.steps })),
    readiness() {
      return { declared: declared(), enabled: live(enabled) === true, mail: mail?.configured === true, feed: feed?.configured === true,
        reports: reports?.configured === true, signing: typeof unsubscribeToken === 'function' };
    },
    list: token => store.list(token),
    detail: (token, id) => store.detail(token, id),
    approve: (token, id, version) => store.approve(token, id, version),
    stop: (token, id, recipient = null) => store.stop(token, id, recipient),
    discard: (token, id) => store.discard(token, id),
    /** Reads the send list, prepares every person and saves the draft for the owner's review. */
    async prepare(token, input, { signal } = {}) {
      const { record, problems } = await prepareRecord(input, { check: people => store.check(token, people), signal });
      return { saved: record ? await store.create(token, record) : null, problems };
    },
    /** The mail service's event for a sequence's email. */
    delivery: (event, id, kind, at, suppress = true) => store.delivery(event, id, kind, at, suppress),
    /** The one-click unsubscribe of a sequence's email: true when the link was a sequence's. */
    unsubscribe: tokenHash => store.unsubscribe(tokenHash),
    /** Report opens Intel recorded whose reference is a sequence person's. */
    recordViews: views => store.views(views),
    /**
     * One run of the Marketing Manager's task: tell the owner what changed (replies, stops, first opens), then send at most one due email.
     */
    async run(task, { notifier = null, signal } = {}) {
      if (!declared()) return { result: { skipped: 'not_declared' } };
      if (live(enabled) !== true) return { result: { skipped: 'off' } };
      if (task?.agent?.autonomy === 'observe') return { result: { skipped: 'observe_only' } };
      const request = await prepareRequest({ notifier, task, signal });
      const review = await store.review();
      const told = { ...await tell(review, { notifier, task }), ...(request ? { request } : {}) };
      if (!mail?.configured) return { result: { ...told, skipped: 'mail_not_configured' } };
      if (typeof unsubscribeToken !== 'function') return { result: { ...told, skipped: 'signing' } };
      signal?.throwIfAborted();
      const claimed = await store.claim();
      if (!claimed?.send) return { result: { ...told, sent: 0, status: claimed?.status ?? 'none_due' } };
      const token = unsubscribeToken(unsubscribeKey(claimed.recipientId));
      if (hash(token) !== claimed.unsubscribeHash) {
        await store.finish(claimed.id, 'failed', null);
        await warn(notifier, task, claimed, 'The signing key changed since the sequence was prepared, so its unsubscribe link no longer matches. Stop the sequence and prepare it again.');
        return { result: { ...told, sent: 0, status: 'unsubscribe_key_changed' } };
      }
      const link = `${String(publicOrigin).replace(/\/+$/, '')}${optOutPath}${token}`;
      let outcome;
      try {
        outcome = await mail.send({ to: claimed.to, subject: claimed.subject, text: claimed.body, html: null, unsubscribeUrl: link,
          fromName: claimed.sender?.fromName ?? null, customArgs: { owner_sequence_message_id: claimed.id } });
      } catch { outcome = { delivery: 'unknown', id: null }; }
      const status = outcome?.delivery === 'sent' ? 'accepted' : outcome?.delivery === 'failed' ? 'failed' : 'unknown';
      await store.finish(claimed.id, status, outcome?.id ?? null);
      if (status !== 'accepted') {
        await warn(notifier, task, claimed, status === 'failed'
          ? 'The mail service refused it, so the person\'s later emails wait. Check the address and the growth sender in Settings → Email, then stop the person or the sequence on Growth if it should not go.'
          : 'The mail service did not confirm it. It is never sent again on its own: check SendGrid\'s activity for the address before anything else goes to this person.');
      }
      return { result: { ...told, sent: status === 'accepted' ? 1 : 0, status } };
    },
  };
  return service;
}

const reasonWords = {
  replied: 'replied',
  opted_out: 'asked not to be emailed again. The address, the agency\'s domain and its CCN are on the do-not-contact list for good',
  left: 'sent an automatic reply that says the person has left',
  bounced: 'bounced. No other address will be tried',
  complaint: 'marked your email as spam. The address and the agency are on the do-not-contact list for good',
  unsubscribed: 'used the unsubscribe link. The address and the agency are on the do-not-contact list for good',
  suppressed: 'is on the suppression list, so nothing more was sent',
  do_not_contact: 'is on the do-not-contact list, so nothing more was sent',
};

async function tell(review, { notifier, task }) {
  const stopped = Array.isArray(review?.stopped) ? review.stopped : [];
  const opened = Array.isArray(review?.opened) ? review.opened : [];
  if (notifier) {
    for (const item of stopped) {
      const agency = String(item.agency ?? 'An agency').slice(0, 120);
      const replied = ['replied', 'opted_out', 'left'].includes(item.reason);
      await notifier.send({ severity: 'info', attention: replied ? 'now' : 'update',
        subject: `${agency} ${item.reason === 'replied' ? 'replied to your email' : item.reason === 'opted_out' ? 'said no thanks' : 'stopped in your sequence'} (${item.ref})`,
        body: `${agency} (${item.ref}, "${String(item.sequence ?? '').slice(0, 120)}") ${reasonWords[item.reason] ?? 'stopped'}. No more emails in the sequence go to them.${replied ? ' The reply is in Communications; nothing is sent back unless you send it.' : ''}`,
        dedupeKey: `owner-sequence:stopped:${item.id}`, agentKey: task?.agentKey ?? null, taskId: task?.id ?? null });
    }
    for (const item of opened) {
      const agency = String(item.agency ?? 'An agency').slice(0, 120);
      await notifier.send({ severity: 'info', attention: 'update', subject: `${agency} opened its market report (${item.ref})`,
        body: `${agency} (${item.ref}) opened the market report from your email (${new Date(item.at).toLocaleString('en-US', { timeZone: 'America/New_York' })} Eastern). Its next email goes out as approved.`,
        dedupeKey: `owner-sequence:opened:${item.id}`, agentKey: task?.agentKey ?? null, taskId: task?.id ?? null });
    }
  }
  return { stopped: stopped.length, opened: opened.length };
}

/** Why a row was left out, in the owner's words (the Growth panel's `leftOut`). */
export const leftOutWords = Object.freeze({
  home_area: 'in Cambria County or a county bordering it', do_not_contact: 'said no before (on the do-not-contact list)',
  suppressed: 'on the suppression list', in_sequence: 'already in an approved sequence',
  growth_contacted: 'the Marketing Manager emailed this agency in the last 90 days', duplicate_ref: 'reference repeated', duplicate_email: 'address repeated',
});

async function tellRequest({ notifier, task, request, payload, outcome, problems }) {
  if (!notifier) return;
  const name = String(payload?.name ?? 'Your sequence').slice(0, 120);
  const left = (problems ?? []).map(p => `${[p.ref, p.agency].filter(Boolean).join(' · ') || `row ${p.row}`}: ${leftOutWords[p.reason] ?? p.reason}`);
  const dates = Array.isArray(payload?.sendDates) ? payload.sendDates.join(', ') : '';
  const prepared = outcome?.status === 'prepared';
  await notifier.send({ severity: prepared ? 'info' : 'warning', attention: prepared ? 'update' : 'now',
    subject: prepared ? `"${name}" is ${outcome.approved ? 'approved and scheduled' : 'ready for your review'}` : `"${name}" could not be prepared`,
    body: prepared
      ? `${outcome.approved ? 'Approved as you asked: the emails go out' : 'Prepared: read every email on Growth → Your own sequences, then approve. The emails go out'} on ${dates}, weekdays from 9:00 Eastern.${left.length ? `\n\nLeft out:\n${left.join('\n')}` : ''}`
      : `Nothing was saved (${String(outcome?.error ?? 'unknown').slice(0, 300)}).${left.length ? `\n\nLeft out:\n${left.join('\n')}` : ''}`,
    dedupeKey: `owner-sequence:request:${request.id}`, agentKey: task?.agentKey ?? null, taskId: task?.id ?? null });
}

async function warn(notifier, task, claimed, body) {
  if (!notifier) return;
  await notifier.send({ severity: 'warning', attention: 'now', subject: `An email in your sequence was not sent (step ${claimed.step})`,
    body: `The email to ${claimed.to} (step ${claimed.step}) was not sent. ${body}`, dedupeKey: `owner-sequence:failed:${claimed.id}`,
    agentKey: task?.agentKey ?? null, taskId: task?.id ?? null });
}

/** The Marketing Manager's `growth.sequences` task, registered once the database declares the feature. */
export function sequenceHandlers({ sequences, notifier = null }) {
  if (!sequences?.declared?.()) return {};
  return { 'growth.sequences': (task, { signal } = {}) => sequences.run(task, { notifier, signal }) };
}
