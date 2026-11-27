/**
 * The AI team builds the owner's next cold email batch itself (owner, 2026-11-27: "train my AI workforce on how to do this. I can't sit here
 * and keep hitting accept all day"). Batch 2 was built by hand; this is the same work, done by the Marketing Manager once a week while
 * Settings → Customer growth → "Build your next sequence batch" is on (docs/OWNER_SEQUENCES.md, "The AI team builds the next batch").
 *
 * 1. The database names the agencies ready for a batch (private.owner_sequence_batch_plan; 20261127240000_owner_sequence_open.sql):
 *    every Pennsylvania roster agency, whoever owns it and however many offices it has (owner, 2026-11-27: "I don't think any agencies
 *    should be off limits. Maybe focus on smaller organizations"), smallest first (fewer offices, then fewer Medicare patients), outside
 *    the owner's home area, on a domain of its own, never written to by the Marketing Manager, not stopped, in no sequence, with a person
 *    whose work address the Marketing Manager's people step or Hunter confirmed.
 * 2. Here, for each: its website is not a page builder's or another business's host (it has no mailbox of its own there), and its person
 *    must decide (an owner, a corporate officer, the president or CEO, the administrator, the executive director or a managing employee
 *    CMS lists). An owner CMS lists (Intel's agency_facts) is preferred when the people step named one.
 * 3. The send list is queued as a request in the owner's name with the next week's dates (a Tuesday at least four days out and a week
 *    after the previous batch's first email, then that Friday and the next Wednesday, as batches 1 and 2). The request is prepared exactly
 *    as the Growth page prepares a send list, with every check again, and approved only while "Approve the batches the AI team builds" is on.
 *
 * Nothing is sent here. Never a guessed address: only addresses the people step confirmed.
 */
import { live } from '../live.mjs';
import { nameParts } from './mailbox.mjs';
import { ownerRank, titleRank } from './people.mjs';
import { displayName } from './roster.mjs';
import { defaultTemplate, easternToday } from './owner-sequence.mjs';

export const ownerSequenceBatchesFeature = 'platform.agents.owner-sequence-batches.v1';
export const batchCampaign = 'pa-cold-email';
export const defaultBatchSize = 8;
/** Fewer agencies than this are not worth a batch: the builder waits for more. */
export const minimumBatch = 3;
/** The most decisive title a batch's person may hold: owner (0), CEO or president (1), administrator (2), executive director (3). */
export const decidingRank = 3;

// Page builders and hosts that are not an agency's own website (batch 1's review: 4 of 25 agencies had none of their own).
const hostedSites = /(^|\.)(lovable\.app|weebly\.com|wixsite\.com|wix\.com|squarespace\.com|godaddysites\.com|business\.site|sites\.google\.com|dr-leonardo\.com|webflow\.io|wordpress\.com|blogspot\.com|facebook\.com|carrd\.co|square\.site|myshopify\.com|yolasite\.com|jimdosite\.com|mystrikingly\.com|ueniweb\.com|site123\.me)$/i;
const legalForm = /,?\s+(?:LLC|L\.L\.C\.?|Inc\.?|Incorporated|Corp\.?|Corporation|LP|L\.P\.?|LLP|Ltd\.?|Co\.?|PC|P\.C\.?|PLLC)\.?$/i;
const day = 86_400_000;
const iso = ms => new Date(ms).toISOString().slice(0, 10);
const utc = value => Date.parse(`${value}T00:00:00Z`);

/** True for a website on a page builder's or another business's host, not the agency's own domain. */
export const hostedSite = domain => hostedSites.test(String(domain ?? '').trim().toLowerCase());

/**
 * The next batch's three send dates: the first Tuesday at least four days from `today` and at least a week after `lastFirstDate` (the
 * newest batch's first email), then that Friday and the next Wednesday.
 */
export function nextBatchDates(today, lastFirstDate = null) {
  let earliest = utc(today) + 4 * day;
  if (lastFirstDate && Number.isFinite(utc(lastFirstDate))) earliest = Math.max(earliest, utc(lastFirstDate) + 7 * day);
  const tuesday = earliest + ((2 - new Date(earliest).getUTCDay() + 7) % 7) * day;
  return [iso(tuesday), iso(tuesday + 3 * day), iso(tuesday + 8 * day)];
}

const same = (a, b) => { const x = nameParts(a); const y = nameParts(b); return Boolean(x && y && x.first === y.first && x.last === y.last); };
const capital = word => word.replace(/(^|[-'’])([a-z])/g, (_, gap, letter) => gap + letter.toUpperCase());

/** A person's first name as an email greets them ("DOROTHY MAYLATH" → "Dorothy"), or null. */
export function firstNameOf(name) {
  const parts = nameParts(name);
  if (!parts) return null;
  const written = String(name).replace(/\s+/g, ' ').trim().split(/[\s,]+/).find(word => word.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '') === parts.first);
  const shaped = written && /^[A-Za-z][A-Za-z'’-]{1,29}$/.test(written) ? written : null;
  const word = shaped ? (shaped === shaped.toUpperCase() || shaped === shaped.toLowerCase() ? capital(shaped.toLowerCase()) : shaped) : capital(parts.first);
  return /^[A-Za-z][A-Za-z'’ .-]{0,58}$/.test(word) ? word : null;
}

/** The agency as an email names it: CMS's name as people write it, without its legal form ("COMPASS HOME HEALTH & REHAB LLC" → "Compass Home Health & Rehab"). */
export function agencyDisplay(name) {
  let text = displayName(name);
  for (let i = 0; i < 3 && legalForm.test(text); i += 1) text = text.replace(legalForm, '').trim();
  return text.replace(/[,\s]+$/, '');
}

/**
 * The person a batch writes to: one whose role decides, best first (CMS's owner or officer, then a title on the agency's own pages or the
 * NPI registry), preferring one CMS also lists as an owner. Null when nobody decides.
 */
export function decider(people, owners = []) {
  const ranked = (people ?? []).filter(person => person?.email && nameParts(person.name)).map(person => {
    const rank = person.source === 'cms_owners' ? ownerRank(person.title) : titleRank(person.title);
    const owner = (owners ?? []).find(item => item?.kind === 'individual' && same(item.name, person.name));
    return { ...person, rank: owner ? Math.min(rank, ownerRank(owner.role)) : rank, owner: Boolean(owner) };
  }).filter(person => Number.isFinite(person.rank) && person.rank <= decidingRank);
  ranked.sort((a, b) => a.rank - b.rank || Number(b.owner) - Number(a.owner));
  return ranked[0] ?? null;
}

const csvCell = value => { const text = String(value ?? ''); return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };

/**
 * The send list for a batch: { people, csv, skipped }. `candidates` come from the database in order (most Medicare patients first),
 * `facts` maps a CCN to its agency_facts entry, `counties` a county FIPS code to its name.
 */
export function buildSendList(candidates, { size = defaultBatchSize, number, facts = new Map(), counties = new Map() } = {}) {
  const people = []; const skipped = [];
  for (const candidate of candidates ?? []) {
    if (people.length >= size) break;
    const agency = String(candidate?.name ?? '').slice(0, 200);
    const skip = reason => skipped.push({ agency, reason });
    const target = (Array.isArray(candidate?.targets) ? candidate.targets : [])[0];
    if (!target?.ccn) { skip('no_roster_entry'); continue; }
    if (!candidate.domain || hostedSite(candidate.domain)) { skip('no_website_of_its_own'); continue; }
    const county = counties.get(target.countyFips);
    if (!county) { skip('county_unknown'); continue; }
    const person = decider(candidate.people, facts.get(target.ccn)?.owners ?? []);
    if (!person) { skip('no_decider'); continue; }
    const firstName = firstNameOf(person.name);
    people.push({ ref: `pa-b${number}-${String(people.length + 1).padStart(2, '0')}`, firstName: firstName ?? '', email: person.email,
      agency: agencyDisplay(target.name || agency), matchName: target.name || agency, city: target.city ?? '', county: String(county).replace(/\s+county$/i, ''),
      setting: target.setting === 'hospice' ? 'hospice' : 'hha', website: candidate.domain, ccn: target.ccn, name: person.name, title: person.title });
  }
  const header = ['ref', 'first_name', 'email', 'agency_display', 'agency_name_for_matching', 'city', 'county', 'setting', 'state', 'website', 'ccn'];
  const rows = people.map(p => [p.ref, p.firstName, p.email, p.agency, p.matchName, p.city, p.county, p.setting, 'PA', p.website, p.ccn]);
  return { people, skipped, csv: `${[header, ...rows].map(row => row.map(csvCell).join(',')).join('\n')}\n` };
}

const skipWords = { no_roster_entry: 'no roster entry', no_website_of_its_own: 'no website of its own', county_unknown: 'county unknown',
  no_decider: 'no owner or administrator with a confirmed address' };

/**
 * The weekly builder. `build` returns null when the feature is not declared or the setting is off, else what it did: { skipped } or
 * { queued, people, approve }.
 */
export function sequenceBatches({ store, feed = null, features = null, enabled = false, size = defaultBatchSize, now = () => new Date() }) {
  const declared = () => (features instanceof Set ? features.has(ownerSequenceBatchesFeature) : Array.isArray(features) && features.includes(ownerSequenceBatchesFeature))
    && typeof store?.batchPlan === 'function';
  const batchSize = () => { const value = Number(live(size)); return Number.isInteger(value) && value >= 1 && value <= 30 ? value : defaultBatchSize; };
  async function build({ notifier = null, task = null, signal } = {}) {
    if (!declared() || live(enabled) !== true) return null;
    const wanted = batchSize();
    const plan = await store.batchPlan(Math.min(200, wanted * 5));
    if (plan?.due !== true) return { skipped: plan?.why ?? 'not_due' };
    if (!feed?.configured || typeof feed.counties !== 'function') return { skipped: 'feed' };
    const candidates = Array.isArray(plan.candidates) ? plan.candidates : [];
    const today = easternToday(now());
    if (candidates.length < Math.min(minimumBatch, wanted)) return { skipped: 'too_few_ready', ready: candidates.length };
    // The agencies' CMS owners, only so an owner CMS lists is preferred among the people with a confirmed address: never a reason to
    // leave an agency out, and a feed that fails leaves the choice to the people's titles.
    const facts = new Map();
    const ccns = [...new Set(candidates.map(candidate => candidate?.targets?.[0]?.ccn).filter(Boolean))];
    if (typeof feed.agencyFacts === 'function') {
      try {
        for (let at = 0; at < ccns.length; at += 25) {
          signal?.throwIfAborted();
          for (const agency of (await feed.agencyFacts({ ccns: ccns.slice(at, at + 25), signal })).agencies ?? []) facts.set(agency.ccn, agency);
        }
      } catch (error) { if (signal?.aborted) throw error; }
    }
    const counties = new Map(((await feed.counties({ states: ['PA'], signal })).counties ?? []).map(county => [county.county_fips, county.county_name]));
    const number = Number(plan.lastNumber ?? 0) + 1;
    const list = buildSendList(candidates, { size: wanted, number, facts, counties });
    if (list.people.length < Math.min(minimumBatch, wanted)) return { skipped: 'too_few_ready', ready: list.people.length, left: list.skipped.length };
    const sendDates = nextBatchDates(today, plan.lastFirstDate ?? null);
    const name = `Pennsylvania cold email, batch ${number}`;
    const queued = await store.batchQueue({ name, campaign: batchCampaign, template: defaultTemplate, sendDates, dailyLimit: Math.min(wanted, 10), csv: list.csv });
    if (queued?.queued !== true) return { skipped: queued?.why ?? 'not_queued' };
    if (notifier) {
      const lines = list.people.map(p => `- ${p.ref}: ${p.agency} (${p.county} County, ${p.setting === 'hospice' ? 'hospice' : 'home health'}): ${p.name}, ${String(p.title ?? '').toLowerCase() || 'owner'}`);
      const left = list.skipped.length ? `\n\nLeft out on the way: ${list.skipped.slice(0, 12).map(s => `${s.agency} (${skipWords[s.reason] ?? s.reason})`).join('; ')}.` : '';
      await notifier.send({ severity: 'info', attention: queued.approve ? 'update' : 'now', subject: `The AI team picked ${name} (${list.people.length} agencies)`,
        body: `${name}: ${list.people.length} agencies, smaller ones first, never written to before, each with an owner or administrator whose address was confirmed. Emails go out ${sendDates.join(', ')}, from 9:00 Eastern, your words exactly.\n\n${lines.join('\n')}${left}\n\nThe Marketing Manager prepares it within five minutes with every check again${queued.approve ? ' and approves it (Settings → Customer growth → Approve the batches the AI team builds)' : '. It waits for you on Growth → Your own sequences'}. Stop anyone there.`,
        dedupeKey: `owner-sequence:batch:${queued.id}`, agentKey: task?.agentKey ?? null, taskId: task?.id ?? null });
    }
    return { queued: queued.id, people: list.people.length, approve: queued.approve === true };
  }
  return { declared, build };
}
