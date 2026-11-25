/**
 * The one dated reason a first cold email goes now (the Nov 24 measurement, docs/AI_WORKFORCE_REVIEW_2026-11-17_TEAM.md: the reader named
 * "nothing says why this matters to the agency now" in 17 of 51 first emails, and in 7 of the 12 live evaluation cases).
 *
 * Code chooses it, from facts the drafter already has, and the writer is told to state it once and never to invent another
 * (playbook.mjs `reasonNowRule`). In order:
 *
 * 1. `trigger`: a dated trigger in the agency's account brief (a liaison job listing, a new location or service line, a leadership change)
 *    from the last 120 days, the newest first; a trigger without a date counts when the page it came from was read in the last 30 days.
 * 2. `record`: the agency's Medicare record (the CMS Provider of Services evidence the roster wrote, roster.mjs `rosterClaim`): a
 *    certification in the last 18 months, or a change of ownership in the last 12.
 * 3. `release`: a new CMS release for the reader's own kind of care, published in the last 45 days, from the releases Intel has loaded
 *    (intel-feed.mjs `releases`, catalog metadata only). Stated as Medicare news, with its month and day, never its file's name or year.
 *
 * With none of them there is no dated reason, and the email says only that the report or the next step is ready now. Nothing here is
 * read from a person, and nothing is stored but the kind (`arms.reason`).
 */
const day = 86_400_000;
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const reasonKinds = Object.freeze(['trigger', 'record', 'release']);
export const triggerDays = 120;
export const undatedTriggerDays = 30;
export const certifiedMonths = 18;
export const ownershipMonths = 12;
export const releaseDays = 45;

const isoDay = value => (/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '')) ? String(value) : null);
const timeOf = value => { const at = Date.parse(isoDay(value) ? `${value}T12:00:00Z` : String(value ?? '')); return Number.isFinite(at) ? at : null; };
const within = (at, now, days) => at !== null && at <= now.getTime() + day && now.getTime() - at <= days * day;
/** "November 12": a month and day, no year, as an email may state a release. */
export const monthDay = value => { const day_ = isoDay(value); if (!day_) return null; const [, m, d] = day_.split('-').map(Number); return `${months[m - 1]} ${d}`; };
const longDate = /\b(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4})\b/;
const parseLong = text => { const match = longDate.exec(text); if (!match) return null; const at = Date.UTC(Number(match[3]), months.indexOf(match[1]), Number(match[2]), 12); return { at, words: match[0] }; };

/** The reader's kind of care, as the release titles name it. An agency whose kind is not known reads home health and hospice releases. */
const releaseTopics = {
  home_health: [['home health', /\bhome health\b/i]],
  hospice: [['hospice', /\bhospice\b/i]],
  both: [['home health', /\bhome health\b/i], ['hospice', /\bhospice\b/i]],
  agency: [['home health', /\bhome health\b/i], ['hospice', /\bhospice\b/i]],
  nursing_home: [['nursing home', /\b(?:nursing home|skilled nursing)\b/i]],
};

/**
 * The CMS releases worth naming to this kind of reader, newest first: `{ topic, date, fact }` with `fact` the one sentence an email may
 * state ("CMS released new home health data on November 12."). A release with no publication date is left out: when Intel loaded it is
 * not when CMS released it.
 */
export function releaseNews(releases, { setting = 'agency', now = new Date() } = {}) {
  const topics = releaseTopics[setting] ?? releaseTopics.agency;
  const found = [];
  for (const release of Array.isArray(releases) ? releases : []) {
    const published = isoDay(release?.published);
    if (!published || !within(timeOf(published), now, releaseDays)) continue;
    const topic = topics.find(([, pattern]) => pattern.test(String(release.title ?? '')))?.[0];
    if (!topic) continue;
    found.push({ topic, date: published, fact: `CMS released new ${topic} data on ${monthDay(published)}.` });
  }
  return found.sort((a, b) => b.date.localeCompare(a.date) || a.topic.localeCompare(b.topic));
}

/**
 * The reason, or null. `sources` are the draft's evidence (id, claim, observed_at), `triggers` the brief's (fact, date, sourceId) as the
 * drafter maps them, `releases` Intel's recent releases, `setting` the reader's kind (`campaignSettings`). Returns `{ kind, fact, date,
 * sourceId }`: `date` is YYYY-MM-DD or null, `sourceId` the evidence the fact comes from ('release' for a release: the drafter adds it
 * as a source of its own, never a stored citation).
 */
export function reasonNow({ sources = [], triggers = [], releases = [], setting = 'agency', now = new Date() } = {}) {
  const byId = new Map((sources ?? []).map(source => [source.id, source]));
  // 1. The brief's triggers: dated ones first, the newest; an undated one only from a page read in the last 30 days.
  const dated = [], undated = [];
  for (const trigger of triggers ?? []) {
    const fact = String(trigger?.fact ?? '').trim();
    const source = byId.get(trigger?.sourceId);
    if (!fact || !source) continue;
    const at = timeOf(trigger.date);
    if (isoDay(trigger.date) && within(at, now, triggerDays)) dated.push({ kind: 'trigger', fact, date: trigger.date, sourceId: source.id, at });
    else if (!isoDay(trigger.date) && within(timeOf(source.observed_at), now, undatedTriggerDays)) undated.push({ kind: 'trigger', fact, date: null, sourceId: source.id, at: 0 });
  }
  const trigger = dated.sort((a, b) => b.at - a.at)[0] ?? undated[0];
  if (trigger) { const { at, ...reason } = trigger; return reason; }
  // 2. The Medicare record: a recent certification, then a recent change of ownership.
  for (const source of sources ?? []) {
    const claim = String(source?.claim ?? '');
    if (!claim.startsWith('CMS Provider of Services file')) continue;
    const certifiedAt = claim.indexOf('; certified ');
    const certified = certifiedAt >= 0 ? parseLong(claim.slice(certifiedAt)) : null;
    if (certified && within(certified.at, now, certifiedMonths * 30.44)) {
      return { kind: 'record', fact: `Medicare certified it on ${certified.words}.`, date: new Date(certified.at).toISOString().slice(0, 10), sourceId: source.id };
    }
    const at = claim.indexOf('change of ownership recorded ');
    const changed = at >= 0 ? parseLong(claim.slice(at)) : null;
    if (changed && within(changed.at, now, ownershipMonths * 30.44)) {
      return { kind: 'record', fact: `A change of ownership was recorded with Medicare on ${changed.words}.`, date: new Date(changed.at).toISOString().slice(0, 10), sourceId: source.id };
    }
  }
  // 3. A new CMS release for the reader's own kind of care.
  const news = releaseNews(releases, { setting, now })[0];
  if (news) return { kind: 'release', fact: news.fact, date: news.date, sourceId: 'release' };
  return null;
}

/** The source a release reason adds to the draft's sources, so its words pass the checks. Never stored as a citation. */
export const releaseSource = (reason, now = new Date()) => (reason?.kind === 'release'
  ? { id: 'release', claim: reason.fact, source_url: 'https://data.cms.gov/', observed_at: now.toISOString() } : null);

// Intel's releases, read at most once every six hours per feed: every first email of a sweep reads the same list.
const cached = new WeakMap();
export const releaseCacheMs = 6 * 3_600_000;
/**
 * The CMS releases Intel loaded in the last 45 days, or [] when the feed is not configured or does not answer: a first email is never
 * held up for them.
 */
export async function recentReleases(feed, { signal, now = Date.now } = {}) {
  if (typeof feed?.releases !== 'function') return [];
  // The feed reader's `configured` is a getter (intel-feed.mjs); a stand-in may give a function.
  if ((typeof feed.configured === 'function' ? feed.configured() : feed.configured) === false) return [];
  const kept = cached.get(feed);
  if (kept && now() - kept.at < releaseCacheMs) return kept.releases;
  let releases = [];
  try { releases = (await feed.releases({ sinceDays: releaseDays, signal }))?.releases ?? []; }
  catch (error) { if (signal?.aborted) throw error; return kept?.releases ?? []; }
  cached.set(feed, { at: now(), releases });
  return releases;
}
