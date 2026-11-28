/**
 * State launches (docs/STATE_LAUNCHES.md; 20261128100000_state_launches.sql): the owner picks the next state on Growth → State launches,
 * and the Marketing Manager builds that state's cold email in Instantly the way Pennsylvania was built by hand, then waits for the owner's
 * one click (owner, 2026-11-28: "I'd prefer this to be fully automated so that I can just choose the next state and all of this is
 * automatically done"; his choices: Instantly sends, the Hub builds, nothing goes out until he clicks Launch).
 *
 * The Marketing Manager's task `outreach.launch` (every five minutes, while Settings → Customer growth → "Build state launches in
 * Instantly" is on) takes the oldest open launch one stage further each run:
 * 1. gather: every nursing home in the state (CMS), every home health agency and hospice (Intel's feed) and the state's counties, sorted
 *    into campaigns and left-out facilities (segment.mjs);
 * 2. contacts: a person and a checked work address for each facility, chains and groups first, then the owner's local nursing homes, then
 *    the rest smaller first (people.mjs), until every facility is looked up or the state's Hunter searches are spent ("Most Hunter searches
 *    for one state");
 * 3. campaigns: every person checked again against the do-not-contact list, one per address and per business domain, then one draft
 *    campaign per segment in Instantly with the owner's copy (copy.mjs) and the people as its leads; the launch is ready and the owner is
 *    told;
 * 4. after the owner clicks Launch: each campaign is started in Instantly.
 * One state at a time (owner, 2026-11-28: "Finish PA before going to the next state"): the next state can be chosen only once the open
 * one is launched or cancelled. Pennsylvania, built by hand, is the first launch, ready with its five campaigns.
 * Instantly's replies and opt-outs come back through webhook.mjs, for every campaign of the workspace. Nothing is sent before Launch.
 */
import { live } from '../live.mjs';
import { nursingHomes } from './cms.mjs';
import { campaignName, launchSequences, segments, utmCampaigns } from './copy.mjs';
import { campaignBody, leadFor, leadsPerRequest } from './instantly.mjs';
import { findPerson } from './people.mjs';
import { isState, sendingZone, stateNames } from './places.mjs';
import { defaultLocalCounties, launchTargets } from './segment.mjs';
import { keyMatches, readEvent, sendCountyReport, webhookHeader, webhookKeyFor } from './webhook.mjs';

export const stateLaunchesFeature = 'platform.agents.state-launches.v1';
export const defaultHunterPerLaunch = 400;
export const defaultDailyLimit = 30;
/** Instantly events the Hub subscribes to (webhook.mjs reads each). */
export const webhookEvents = Object.freeze(['reply_received', 'lead_unsubscribed', 'lead_not_interested', 'email_bounced', 'lead_interested']);
const runBudgetMs = 3 * 60_000;
const pendingPerRound = 25;
const free = /(^|\.)(gmail|yahoo|aol|hotmail|outlook|live|msn|icloud|me|comcast|verizon|att|sbcglobal|bellsouth|charter|cox|earthlink|frontier|windstream|ymail|protonmail)\.(com|net)$/;

const number = (value, fallback, min, max) => { const n = Number(live(value)); return Number.isInteger(n) && n >= min && n <= max ? n : fallback; };
const list = value => (Array.isArray(live(value)) ? live(value).filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()) : []);
const tally = (rows, key) => rows.reduce((counts, row) => { const k = key(row); if (k) counts[k] = (counts[k] ?? 0) + 1; return counts; }, {});
const fail = (message, code) => Object.assign(new Error(message), { code });

export function stateLaunches({ store, feed = null, hunter = null, npi = null, instantly = null, features = null, senders = [], dailyLimit = defaultDailyLimit,
  localCounties = defaultLocalCounties, hunterPerLaunch = defaultHunterPerLaunch, signingKey = '', publicOrigin = '', fetchImpl = globalThis.fetch,
  now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), paceMs = 1100 }) {
  const declared = () => (features instanceof Set ? features.has(stateLaunchesFeature) : Array.isArray(features) && features.includes(stateLaunchesFeature))
    && typeof store?.next === 'function';
  const webhookKey = webhookKeyFor(signingKey);
  const hookUrl = () => (/^https:\/\//.test(publicOrigin ?? '') ? `${String(publicOrigin).replace(/\/+$/, '')}/api/growth/instantly` : null);
  let notifier = null;
  let subscribed = false;

  const tell = (message, task = null) => (notifier ? notifier.send({ agentKey: task?.agentKey ?? 'marketing_manager', taskId: task?.id ?? null, ...message })
    .catch(() => {}) : Promise.resolve());

  function readiness() {
    return { declared: declared(), instantly: instantly?.configured === true, hunter: hunter?.configured === true, feed: feed?.configured === true,
      senders: list(senders).length, webhook: Boolean(webhookKey && hookUrl()), subscribed };
  }

  // Instantly's webhooks for every campaign of the workspace (Pennsylvania's built by hand included): one per event the Hub reads.
  async function subscribe(signal) {
    if (subscribed || !instantly?.configured || !webhookKey || !hookUrl()) return;
    const existing = await instantly.webhooks({ signal });
    const active = new Set(existing.filter(hook => hook?.target_hook_url === hookUrl() && hook?.status !== -1 && !hook?.campaign).map(hook => hook.event_type));
    for (const event of webhookEvents) {
      if (active.has(event)) continue;
      await instantly.createWebhook({ target_hook_url: hookUrl(), event_type: event, name: `CareMetric Hub: ${event}`, headers: { [webhookHeader]: webhookKey } }, { signal });
    }
    subscribed = true;
  }

  async function gather(launch, { signal, task }) {
    const state = launch.state;
    const warnings = [];
    const homes = await nursingHomes({ state, fetchImpl, signal });
    let agencies = []; let counties = [];
    if (feed?.configured) {
      counties = (await feed.counties({ states: [state], signal })).counties ?? [];
      let cursor = null;
      for (let page = 0; page < 40; page += 1) {
        signal?.throwIfAborted();
        if (page) await sleep(feed.paceMs ?? 1000);
        const answer = await feed.roster({ states: [state], cursor, limit: 500, signal });
        agencies.push(...(answer.items ?? []).filter(item => item.state === state || item.state == null));
        cursor = answer.next_cursor;
        if (!cursor) break;
      }
    } else warnings.push('feed');
    const rows = launchTargets({ nursingHomes: homes, agencies, counties, localCounties: list(localCounties).length ? list(localCounties) : defaultLocalCounties });
    for (let at = 0; at < rows.length; at += 1000) await store.addTargets(launch.id, rows.slice(at, at + 1000));
    const progress = { ...launch.progress, warnings, gathered: tally(rows, row => row.setting), held: tally(rows.filter(row => row.hold), row => row.hold),
      segments: tally(rows.filter(row => !row.hold), row => row.segment), hunterSearches: 0, passSearches: 0, looked: 0, found: 0, notFound: 0 };
    await store.save(launch.id, { stage: 'contacts', progress });
    if (warnings.includes('feed')) {
      await tell({ severity: 'warning', attention: 'now', subject: `${stateNames[state]}: home health and hospice left out`,
        body: `The ${stateNames[state]} launch has the state's nursing homes but no home health agencies or hospices: Intel's marketing feed is not set up (HUB_INTEL_FEED_SECRET in Railway). The nursing homes go ahead; their county reports need the feed too.`,
        dedupeKey: `state-launch:feed:${launch.id}` }, task);
    }
    return { gathered: rows.length };
  }

  async function contacts(launch, { signal, task }) {
    const progress = { hunterSearches: 0, passSearches: 0, looked: 0, found: 0, notFound: 0, warnings: [], ...launch.progress };
    const cap = number(hunterPerLaunch, defaultHunterPerLaunch, 0, 5000);
    const budget = () => cap - (progress.passSearches ?? 0);
    const done = async extra => { await store.save(launch.id, { stage: 'campaigns', progress: { ...progress, ...extra } }); return { looked: progress.looked }; };
    if (!hunter?.configured) return done({ warnings: [...new Set([...(progress.warnings ?? []), 'hunter'])] });
    const started = now();
    while (now() - started < runBudgetMs) {
      signal?.throwIfAborted();
      if (budget() < 1) return done({ stoppedAt: 'search_limit' });
      const pending = await store.pending(launch.id, pendingPerRound);
      if (!Array.isArray(pending) || !pending.length) return done({});
      // The agencies' CMS owners (Intel's agency_facts), only to name a person when Hunter finds nobody who decides.
      const owners = new Map();
      const ccns = pending.filter(target => target.setting !== 'nursing_home').map(target => target.ccn);
      if (ccns.length && feed?.configured && typeof feed.agencyFacts === 'function') {
        try { for (const agency of (await feed.agencyFacts({ ccns: ccns.slice(0, 25), signal })).agencies ?? []) owners.set(agency.ccn, agency.owners ?? []); }
        catch (error) { if (signal?.aborted) throw error; }
      }
      for (const target of pending) {
        if (now() - started >= runBudgetMs) break;
        if (budget() < 1) return done({ stoppedAt: 'search_limit' });
        let found;
        try {
          found = await findPerson(target, { hunter, npi, owners: owners.get(target.ccn) ?? [], state: launch.state, budget, signal });
        } catch (error) {
          if (error?.code === 'hunter_limited') { await store.save(launch.id, { progress }); return { looked: progress.looked, waiting: 'hunter_rate' }; }
          if (error?.code === 'hunter_refused') {
            await tell({ severity: 'warning', attention: 'now', subject: `Hunter refused the ${stateNames[launch.state]} launch`,
              body: 'Hunter refused the API key (HUNTER_API_KEY in Railway), or its searches ran out. The launch goes on with the people found so far; once Hunter is topped up, open Growth → State launches and choose "Find more people".',
              dedupeKey: `state-launch:hunter-refused:${launch.id}` }, task);
            return done({ stoppedAt: 'hunter_refused' });
          }
          throw error;
        }
        if (found.status === 'not_found' && found.note === 'search_limit' && !found.searches) return done({ stoppedAt: 'search_limit' });
        progress.hunterSearches = (progress.hunterSearches ?? 0) + found.searches;
        progress.passSearches = (progress.passSearches ?? 0) + found.searches;
        progress.looked = (progress.looked ?? 0) + 1;
        progress[found.status === 'found' ? 'found' : 'notFound'] = (progress[found.status === 'found' ? 'found' : 'notFound'] ?? 0) + 1;
        await store.targetSave(target.id, found);
        await sleep(paceMs);
      }
      await store.save(launch.id, { progress });
    }
    return { looked: progress.looked };
  }

  async function campaigns(launch, { signal, task }) {
    const state = launch.state;
    const progress = { ...launch.progress };
    if (!instantly?.configured || !list(senders).length) {
      const missing = !instantly?.configured ? 'instantly' : 'senders';
      if (progress.waiting !== missing) {
        await store.save(launch.id, { progress: { ...progress, waiting: missing } });
        await tell({ severity: 'warning', attention: 'now', subject: `${stateNames[state]} is waiting for Instantly`,
          body: missing === 'instantly' ? `The ${stateNames[state]} people are found, but the Hub cannot reach Instantly: paste an Instantly API key (all scopes, from Instantly's Settings → Integrations) into Railway as INSTANTLY_API_KEY. The launch continues by itself once it is there.`
            : `The ${stateNames[state]} people are found, but no Instantly mailbox is chosen: add them in Settings → Customer growth → Instantly mailboxes for state launches.`,
          dedupeKey: `state-launch:waiting:${missing}:${launch.id}` }, task);
      }
      return { waiting: missing };
    }
    const people = await store.leads(launch.id);
    const skips = new Map();
    const skip = (person, reason) => { if (!skips.has(reason)) skips.set(reason, []); skips.get(reason).push(person.id); };
    const emails = new Set(); const domains = new Set(); const bySegment = new Map();
    for (const person of Array.isArray(people) ? people : []) {
      if (person.blocked) { skip(person, person.blocked); continue; }
      if (emails.has(person.email)) { skip(person, 'same_person'); continue; }
      const domain = person.email.split('@')[1];
      if (!free.test(domain) && domains.has(domain)) { skip(person, 'same_business'); continue; }
      emails.add(person.email); domains.add(domain);
      if (!bySegment.has(person.segment)) bySegment.set(person.segment, []);
      bySegment.get(person.segment).push(person);
    }
    for (const [reason, ids] of skips) for (let at = 0; at < ids.length; at += 1000) await store.mark(ids.slice(at, at + 1000), 'skipped', reason, null);
    const made = { ...launch.campaigns };
    const sequences = launchSequences(state);
    const limit = number(dailyLimit, defaultDailyLimit, 1, 100);
    let remaining = null; let planFull = false;
    for (const segment of segments) {
      const leads = bySegment.get(segment) ?? [];
      if (!leads.length) continue;
      signal?.throwIfAborted();
      if (!made[segment]?.id) {
        const name = campaignName(state, segment, stateNames[state]);
        const created = await instantly.createCampaign(campaignBody({ name, sequences: sequences[segment], senders: list(senders), dailyLimit: limit,
          timezone: sendingZone(state) }), { signal });
        made[segment] = { id: created.id, name, leads: 0 };
        // Saved at once, so a run that stops here never makes a second campaign for the segment.
        await store.save(launch.id, { campaigns: made });
      }
      for (let at = 0; at < leads.length; at += leadsPerRequest) {
        const chunk = leads.slice(at, at + leadsPerRequest);
        let answer;
        try { answer = await instantly.addLeads(made[segment].id, chunk.map(person => leadFor(person, { state })), { signal }); }
        catch (error) { if (error?.code === 'instantly_plan') { planFull = true; break; } throw error; }
        remaining = answer.remaining ?? remaining;
        const created = answer.created ? new Set(answer.created) : null;
        const added = created ? chunk.filter(person => created.has(person.email)) : chunk;
        const already = created ? chunk.filter(person => !created.has(person.email)) : [];
        if (added.length) await store.mark(added.map(person => person.id), 'added', null, made[segment].id);
        if (already.length) await store.mark(already.map(person => person.id), 'skipped', 'already_in_instantly', null);
        made[segment].leads = (made[segment].leads ?? 0) + added.length;
        await store.save(launch.id, { campaigns: made });
      }
      if (planFull) break;
    }
    const left = await store.pending(launch.id, 1);
    const summary = {
      campaigns: segments.filter(segment => made[segment]).map(segment => ({ segment, ...made[segment] })),
      leads: segments.reduce((sum, segment) => sum + (made[segment]?.leads ?? 0), 0),
      skipped: Object.fromEntries([...skips].map(([reason, ids]) => [reason, ids.length])),
      notFound: progress.notFound ?? 0, found: progress.found ?? 0, hunterSearches: progress.hunterSearches ?? 0,
      pendingLeft: Array.isArray(left) && left.length > 0, remainingInPlan: remaining, planFull,
    };
    await store.save(launch.id, { status: 'ready', stage: 'done', summary, campaigns: made, progress: { ...progress, waiting: null } });
    const lines = summary.campaigns.map(c => `- ${c.name}: ${c.leads} people`);
    await tell({ severity: 'info', attention: summary.leads ? 'decision' : 'update',
      subject: summary.leads ? `${stateNames[state]} is ready to launch (${summary.leads} people)` : `${stateNames[state]}: nobody to email yet`,
      body: summary.leads
        ? `The AI team built ${stateNames[state]}'s cold email in Instantly, as Pennsylvania's: ${summary.leads} people in ${summary.campaigns.length} draft campaigns, your copy word for word.\n\n${lines.join('\n')}\n\nNothing is sent until you open Growth → State launches and click Launch.${summary.pendingLeft ? ' Some facilities were not looked up: the Hunter searches for this state ran out. Choose "Find more people" when Hunter is topped up.' : ''}${planFull ? ' Instantly\'s plan is full: some people could not be added.' : ''}`
        : `The ${stateNames[state]} launch found nobody it may email (${summary.found} found, ${summary.notFound} not found). See Growth → State launches.`,
      dedupeKey: `state-launch:ready:${launch.id}:${summary.leads}` }, task);
    return { ready: summary.leads };
  }

  async function activate(launch, { signal, task }) {
    const started = [];
    for (const segment of segments) {
      const campaign = launch.campaigns?.[segment];
      if (!campaign?.id || campaign.started) continue;
      // A campaign the owner already started in Instantly himself (or that finished) is left as it is.
      const status = typeof instantly.campaignStatus === 'function' ? await instantly.campaignStatus(campaign.id, { signal }) : NaN;
      if (![1, 3].includes(status)) await instantly.activate(campaign.id, { signal });
      launch.campaigns[segment] = { ...campaign, started: true };
      started.push(campaign.name);
      await store.save(launch.id, { campaigns: launch.campaigns });
    }
    await store.save(launch.id, { status: 'launched', stage: 'done' });
    await tell({ severity: 'info', attention: 'update', subject: `${stateNames[launch.state]} is sending`,
      body: `Started in Instantly: ${Object.values(launch.campaigns).map(c => c.name).join('; ')}. Replies arrive in Instantly's Unibox; a "yes" gets its county report from Intel, and a "no thanks" goes on the do-not-contact list.`,
      dedupeKey: `state-launch:launched:${launch.id}` }, task);
    return { launched: started.length };
  }

  async function run(task, { signal } = {}) {
    if (!declared()) return { result: { skipped: 'not_declared' } };
    if (task?.agent?.autonomy === 'observe') return { result: { skipped: 'observe_only' } };
    try { await subscribe(signal); } catch (error) { if (signal?.aborted) throw error; }
    const launch = await store.next();
    if (!launch) return { result: { idle: true } };
    const step = launch.status === 'launching' ? activate : launch.stage === 'gather' ? gather : launch.stage === 'contacts' ? contacts : campaigns;
    if (launch.status === 'launching' && !instantly?.configured) return { result: { waiting: 'instantly' } };
    try {
      return { result: { state: launch.state, stage: launch.status === 'launching' ? 'launch' : launch.stage, ...await step(launch, { signal, task }) } };
    } catch (error) {
      if (signal?.aborted) throw error;
      const code = String(error?.code ?? 'failed').slice(0, 60);
      if (error?.retryable) { await store.save(launch.id, { progress: { ...launch.progress, lastError: code } }); return { result: { state: launch.state, retry: code } }; }
      if (launch.status === 'launching') {
        await store.save(launch.id, { progress: { ...launch.progress, lastError: code } });
        await tell({ severity: 'warning', attention: 'now', subject: `${stateNames[launch.state]} could not be started in Instantly`,
          body: `Instantly refused to start a campaign (${String(error?.message ?? code).slice(0, 200)}). The Hub tries again every five minutes; you can also start the campaigns in Instantly yourself.`,
          dedupeKey: `state-launch:activate:${launch.id}:${code}` }, task);
        return { result: { state: launch.state, retry: code } };
      }
      await store.save(launch.id, { status: 'failed', error: String(error?.message ?? code).slice(0, 300) });
      await tell({ severity: 'warning', attention: 'now', subject: `The ${stateNames[launch.state]} launch stopped`,
        body: `The ${stateNames[launch.state]} launch stopped at "${launch.stage}" (${String(error?.message ?? code).slice(0, 200)}). Nothing was sent. Choose the state again on Growth → State launches to start over; facilities and campaigns already made are kept in Instantly as drafts.`,
        dedupeKey: `state-launch:failed:${launch.id}` }, task);
      return { result: { state: launch.state, failed: code } };
    }
  }

  // ---- Instantly's webhook (POST /api/growth/instantly). ----
  async function event(raw, headers, { signal } = {}) {
    if (!declared()) throw fail('State launches are not available yet.', 'not_declared');
    if (!webhookKey) throw fail('The Instantly webhook is not configured.', 'not_configured');
    if (!keyMatches(headers?.[webhookHeader], webhookKey)) throw fail('Invalid webhook key.', 'unauthorized');
    let body;
    try { body = JSON.parse(raw); } catch { throw fail('Invalid event.', 'invalid'); }
    const item = readEvent(body);
    if (!item) return { accepted: 0 };
    if (item.kind === 'opted_out' || (item.kind === 'reply' && item.answer === 'no')) { await store.event(item.campaign, item.email, 'opted_out'); return { accepted: 1, recorded: 'opted_out' }; }
    if (item.kind === 'bounced') { await store.event(item.campaign, item.email, 'bounced'); return { accepted: 1, recorded: 'bounced' }; }
    // An automatic reply (out of office, has left) changes nothing: Instantly keeps or stops the lead itself.
    if (item.kind === 'reply' && item.answer === 'auto') return { accepted: 1, recorded: 'auto_reply' };
    const answer = await store.event(item.campaign, item.email, 'replied');
    const target = answer?.target ?? null;
    // A campaign built by hand (Pennsylvania's) has its own Instantly workflows for the report and is read in Instantly's Unibox.
    if (!target) return { accepted: 1, recorded: 'reply' };
    const who = `${target.personName ?? item.email} (${target.name}${target.county ? `, ${target.county} County` : ''})`;
    if (item.kind === 'reply' && item.answer === 'yes' && !target.reportSent) {
      if (!(await store.reportClaim(target.id))) return { accepted: 1, recorded: 'reply' };
      const segmentUtm = utmCampaigns(target.state)[target.segment] ?? `${target.state.toLowerCase()}-starter`;
      const report = await sendCountyReport({ state: target.state, countyFips: target.countyFips, email: item.email, utmCampaign: segmentUtm, fetchImpl, signal });
      await tell({ severity: report.sent ? 'info' : 'warning', attention: report.sent ? 'update' : 'now',
        subject: report.sent ? `${who} asked for the county report: sent` : `${who} asked for the county report`,
        body: report.sent ? `${who} replied yes in the ${item.campaignName || 'state launch'} campaign. Intel emailed the free ${target.county ?? ''} County report. Follow up in Instantly's Unibox.`
          : `${who} replied yes, but the report could not be sent (${report.why}). Send it from Intel and answer in Instantly's Unibox.`,
        dedupeKey: `state-launch:report:${target.id}` });
      return { accepted: 1, recorded: report.sent ? 'report_sent' : 'report_failed' };
    }
    await tell({ severity: 'info', attention: 'now', subject: `Reply from ${who}`,
      body: `${who} ${item.kind === 'interested' ? 'was marked interested' : 'replied'} in the ${item.campaignName || 'state launch'} campaign. Answer in Instantly's Unibox.${item.reply ? `\n\n"${item.reply.replace(/\s+/g, ' ').slice(0, 400)}"` : ''}`,
      dedupeKey: `state-launch:reply:${target.id}` });
    return { accepted: 1, recorded: 'reply' };
  }

  return {
    declared, readiness, webhookKey,
    useNotifier(value) { notifier = value ?? null; },
    run, event,
    list: async token => ({ ...await store.list(token), services: readiness(), states: Object.entries(stateNames).filter(([code]) => isState(code)).map(([code, name]) => ({ code, name })) }),
    detail: (token, id) => store.detail(token, id),
    request: (token, state) => { if (!isState(state)) throw fail('Choose a state by its two-letter code', 'state'); return store.request(token, state); },
    approve: (token, id) => store.approve(token, id),
    more: (token, id) => store.more(token, id),
    cancel: (token, id) => store.cancel(token, id),
  };
}

/** The Marketing Manager's `outreach.launch` task, registered once the database declares the feature. */
export function launchHandlers({ launches, notifier = null }) {
  if (!launches?.declared?.()) return {};
  launches.useNotifier(notifier);
  return { 'outreach.launch': (task, { signal } = {}) => launches.run(task, { signal }) };
}
