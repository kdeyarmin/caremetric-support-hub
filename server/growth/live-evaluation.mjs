/**
 * The live writing evaluation (stage 3 of the 2026-11-17 review, docs/AI_WORKFORCE_REVIEW_2026-11-17.md; owner's sign-off the same day).
 * `growth.evaluate_live` runs every morning at 06:50 Eastern and does its work on Mondays (or when the owner presses Run now), while
 * Settings → Customer growth → "Run a live writing evaluation each Monday" is on:
 *
 * 1. Twelve made-up CareMetric Intel agencies (`liveEvaluationCases`): the four triggers the sweep writes from (newly certified, a new
 *    owner, the CMS record alone, the agency's own website), each three times, so every pairing of with or without an account brief and
 *    the agency's own report or the free county report page comes up three times. (Until 2026-11-17 the second half of each pairing was the
 *    short or the standard first email; every first email built around a report now has one form, so the link it carries took its place.)
 *    Invented names, places, numbers and sites; no person, address or phone.
 * 2. Each is written on the real writer path (draft.mjs `draftMessage`, the real model, the top model where the sweep would use it, the
 *    approved learning memo where the sweep would use it) and read by the real reader (draft.mjs `criticPromptVersion`), as a first
 *    email built around a report. Nothing is saved as a message and nothing is sent.
 *    Like the sweep, it gives the writer the one dated reason code finds (reason-now.mjs, the Nov 24 measurement): the brief's dated
 *    trigger, the invented agency's Medicare record, or a CMS release Intel loaded, read from the same feed. The CMS-record-only case has
 *    no trigger of its own, so it shows what the email says when only a release, or nothing, gives a reason.
 * 3. It passes when every draft passed the code checks, the reader scored every one, their average "would reply" is at least 3.5 and
 *    none is below 2 (`gradeLiveEvaluation`). Recorded as private.agent_evaluations version 'growth.live.1' (reach.mjs
 *    `liveEvaluationVersion`), which the send claim never reads (it reads 'growth.1'): a weak week never holds up sending. The Monday
 *    scorecard reports it (`liveEvaluationNote`); the owner is told only when it does not pass.
 *
 * One task cannot write twelve emails inside the scheduler's four minutes, so each case's grade is kept as it is written
 * (private.growth_live_eval_record) and the task comes back a minute later for the rest. Kept: grades and codes only, never an email's
 * words. About $2 to $3 a week from the Marketing Manager's budget; a day's budget that runs out ends the run as incomplete.
 */
import { createHash } from 'node:crypto';
import { live } from '../live.mjs';
import { marketedNow, markets } from '../agents/marketing.mjs';
import { weekStart } from '../agents/accounts/week.mjs';
import { dueMoment } from '../agents/tasks/shared.mjs';
import { draftMessage, weaknessMeanings } from './draft.mjs';
import { hasGrowthReach, liveEvaluationVersion } from './reach.mjs';
import { recentReleases } from './reason-now.mjs';

const product = 'caremetric-intel';
const day = 86_400_000;
const easternWeekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' });
/** The pass mark the owner signed off on (2026-11-17). */
export const passAverage = 3.5;
export const passLowest = 2;
/** Cases written side by side in one task run, and when a run stops starting more (the scheduler stops a task at four minutes). */
export const liveConcurrency = 3;
export const liveStartBudgetMs = 100_000;
export const liveDeadlineMs = 200_000;
export const liveRetryMs = 60_000;

export const liveTriggers = Object.freeze(['new_agency', 'new_owner', 'cms_record', 'web']);
// Every pairing of a brief and the link the first email carries (the agency's own report, or the free county report page for an agency with
// no roster record); each trigger leaves out one pairing, so each pairing comes up three times in twelve cases.
const pairings = Object.freeze([{ brief: true, link: 'report' }, { brief: true, link: 'review' }, { brief: false, link: 'report' }, { brief: false, link: 'review' }]);

// Invented agencies: no real business, person, address or phone. The county figure is invented too, and stated as a county fact.
const agencies = Object.freeze({
  new_agency: { name: 'Millbrook Valley Home Health', city: 'Millbrook', county: 'Brookhaven County', ccn: '990101', domain: 'millbrookvalleyhh.example' },
  new_owner: { name: 'Cedar Ridge Home Care', city: 'Cedar Ridge', county: 'Hollins County', ccn: '990102', domain: 'cedarridgehomecare.example' },
  cms_record: { name: 'Three Rivers Visiting Nurses', city: 'Riverton', county: 'Alder County', ccn: '990103', domain: 'threeriversvna.example' },
  web: { name: 'Summit Home Health Partners', city: 'Summitville', county: 'Larch County', ccn: '990104', domain: 'summithomehealthpartners.example' },
});
const isoDay = date => date.toISOString().slice(0, 10);

/** The evidence one invented agency carries for its trigger: what the sweep reads from the roster and the agency's own site. */
function evidenceFor(trigger, agency, now) {
  const seen = new Date(now.getTime() - 2 * day).toISOString();
  const record = `CMS Provider of Services file, 2026Q3: ${agency.name} (CCN ${agency.ccn}) is a Medicare-certified home health agency in ${agency.city}, PA`;
  const site = { id: `site-${trigger}`, source_url: `https://${agency.domain}/about`, confidence: 'high', observed_at: seen,
    claim: `${agency.name}'s website says it provides skilled nursing, physical therapy and home health aide visits across ${agency.county}.` };
  const cms = claim => ({ id: `cms-${trigger}`, source_url: 'https://data.cms.gov/provider-data/', confidence: 'high', observed_at: seen, claim });
  if (trigger === 'new_agency') return [cms(`${record}; certified ${isoDay(new Date(now.getTime() - 120 * day))}; ownership type: Proprietary; newly listed by CMS in 2026Q3.`), site];
  if (trigger === 'new_owner') return [cms(`${record}; ownership type: Proprietary; change of ownership recorded ${isoDay(new Date(now.getTime() - 90 * day))}.`), site];
  if (trigger === 'cms_record') return [cms(`${record}; ownership type: Non-profit.`), site];
  return [site, { id: `news-${trigger}`, source_url: `https://${agency.domain}/news`, confidence: 'high', observed_at: seen,
    claim: `${agency.name} posted on its website that it is hiring a community liaison to work with hospitals in ${agency.county}.` }];
}

/** The writer part of an account brief, as brief.mjs saves it: what the agency is, its triggers, its likely problems and a cited opening. */
function briefFor(trigger, agency, evidence) {
  const site = evidence.find(item => item.id.startsWith('site-'));
  return {
    setting: 'home_health', briefVersion: 1,
    summary: `${agency.name} is a home health agency serving ${agency.county}, offering skilled nursing, therapy and aide visits.`,
    serviceArea: agency.county, ownership: trigger === 'cms_record' ? 'Non-profit' : 'Proprietary',
    // A trigger only where the evidence states one, dated where it gives a date: the Medicare record's change of ownership or
    // certification, and the agency's own news page. The CMS record alone states no trigger (until 2026-11-24 it was given the hiring one).
    triggers: trigger === 'cms_record' ? [] : [{ fact: trigger === 'new_owner' ? 'A change of ownership was recorded with CMS this year.' : trigger === 'new_agency' ? 'It was newly certified by Medicare this year.'
      : 'It is hiring a community liaison to work with hospitals.', date: trigger === 'web' ? null : evidence[0].claim.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1] ?? null,
      sourceUrl: (trigger === 'web' ? evidence.find(item => item.id.startsWith('news-')) : evidence[0]).source_url }],
    pains: [{ question: 'Which hospitals and physicians send home health patients in the county today?', capability: 'referral sources' },
      { question: 'Which referral sources have slowed down in recent months?', capability: 'slipping sources' }],
    angle: trigger === 'web' ? 'hospital_outcomes' : 'referral_sources',
    hook: { sentence: site.claim, sourceUrl: site.source_url },
    countyFact: { key: 'home_health_agencies_in_county', claim: `${agency.county}, PA had 31 Medicare-certified home health agencies located in it in 2024 (CMS).`, source: 'CMS' },
  };
}

/**
 * The twelve cases. A `report` case carries the agency's own report link, as the sweep gives an agency on the roster; a `review` case
 * carries none, so its email points to the free county report page.
 */
export function liveEvaluationCases(now = new Date(), policy = {}) {
  const cases = [];
  liveTriggers.forEach((trigger, index) => {
    const agency = agencies[trigger];
    pairings.filter((_, i) => i !== index).forEach(({ brief, link }) => {
      const evidence = evidenceFor(trigger, agency, now);
      const base = { product, version: 1, stage: 'qualified', owner_agent: 'marketing_manager', contact_id: 'live-eval-contact', name: agency.name,
        domain: agency.domain, goal: 'A reply or a trial', memory: {}, events: [], touches: 0, evidence, next_at: new Date(now.getTime() - day).toISOString(),
        policy: { approved_claim: policy.approvedClaim, max_touches: Number(policy.maxTouches) || 3, experiment_enabled: policy.experiment === true, version: policy.version ?? 1 } };
      const id = `live-eval-${trigger}-${brief ? 'brief' : 'plain'}-${link}`;
      const opportunity = { ...base, id, organization_id: id };
      const token = createHash('sha256').update(id).digest('hex').slice(0, 16);
      cases.push({ key: `${trigger}.${brief ? 'brief' : 'plain'}.${link}`, trigger, brief, link, opportunity,
        report: link === 'report' ? { label: `Free market report for ${agency.name}`, url: `https://www.caremetricintel.com/report/live-eval.${token}` } : null,
        briefPart: brief ? briefFor(trigger, agency, evidence) : null });
    });
  });
  return cases;
}

/** A case's grade: codes and scores only. `draft` is what draftMessage returned (or null), `problems` the check codes it reported. */
export function gradeCase(item, draft, problems = []) {
  const score = Number(draft?.arms?.critic);
  const ok = Boolean(draft) && draft.modelGenerated === true;
  return {
    kind: item.trigger, brief: item.brief, link: item.link, ok,
    wouldReply: ok && Number.isInteger(score) && score >= 1 && score <= 5 ? score : null,
    ...(ok && typeof draft.arms?.weakness === 'string' ? { weakness: draft.arms.weakness } : {}),
    ...(ok && draft.arms?.form ? { formWritten: draft.arms.form } : {}),
    // The kind of dated reason the email was given (reason-now.mjs): trigger, record, release or none.
    ...(ok && typeof draft.arms?.reason === 'string' ? { reason: draft.arms.reason } : {}),
    ...(!ok && problems.length ? { problem: String(problems.at(-1)).slice(0, 60) } : {}),
  };
}

/**
 * The run's verdict (owner's sign-off, 2026-11-17): every draft passed the code checks, the reader scored every one, the average "would
 * reply" is at least 3.5 and none is below 2. An incomplete run (a day's budget ran out) never passes.
 */
export function gradeLiveEvaluation(results, { incomplete = false, cases = 12 } = {}) {
  const scored = results.filter(item => item.ok && item.wouldReply !== null);
  const average = scored.length ? Math.round(scored.reduce((sum, item) => sum + item.wouldReply, 0) / scored.length * 100) / 100 : null;
  const lowest = scored.length ? Math.min(...scored.map(item => item.wouldReply)) : null;
  const weaknesses = {};
  for (const item of scored) if (item.weakness && item.weakness !== 'none') weaknesses[item.weakness] = (weaknesses[item.weakness] ?? 0) + 1;
  const failures = [
    ...(incomplete || results.length < cases ? ['incomplete'] : []),
    ...(results.some(item => !item.ok) ? ['checks'] : []),
    ...(results.some(item => item.ok && item.wouldReply === null) ? ['unread'] : []),
    ...(average !== null && average < passAverage ? ['average'] : []),
    ...(lowest !== null && lowest < passLowest ? ['lowest'] : []),
    ...(!scored.length ? ['no_scores'] : []),
  ];
  return { passed: failures.length === 0, cases: results.length, passedChecks: results.filter(item => item.ok).length, average, lowest, weaknesses, failures };
}

/** The Monday scorecard's line for the latest live evaluation (private.growth_live_evaluation_latest), or null when there is none. */
export function liveEvaluationNote(latest) {
  const summary = latest?.results?.summary;
  if (!latest || !summary) return null;
  const top = Object.entries(summary.weaknesses ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const scores = summary.average === null || summary.average === undefined ? 'the reader scored none of them'
    : `the reader's average "would reply" was ${Number(summary.average).toFixed(1)} of 5 (lowest ${summary.lowest})`;
  const verdict = latest.passed ? 'passed' : summary.failures?.includes('incomplete') ? 'did not finish' : 'did not pass';
  return `Live writing evaluation ${verdict}: ${summary.passedChecks} of ${summary.cases} drafts passed the checks; ${scores}.`
    + (top && weaknessMeanings[top[0]] ? ` Commonest weakness: ${weaknessMeanings[top[0]]}.` : '');
}

export function liveEvaluationHandlers({ growth, model, notifier = null, features = null, marketed = null, clock = () => Date.now() }) {
  if (!growth || !hasGrowthReach(features) || typeof growth.store?.liveEvalState !== 'function' || typeof growth.store?.liveEvalRecord !== 'function'
    || typeof growth.store?.evaluate !== 'function') return {};

  async function writeCase(item, task, { signal, memo, quality, releases }) {
    let exhausted = false;
    // The real model, watched for a day's budget running out (the draft then comes back empty and would read as a failed check).
    const watched = { configured: true, run: async (...args) => {
      const answer = await model.run(...args);
      if (answer?.outcome === 'budget_exhausted') exhausted = true;
      return answer;
    } };
    const problems = [];
    const draft = await draftMessage({ opportunity: item.opportunity, work: { kind: 'outreach', key: 'outreach:0', action: 'Offer one relevant next step based on verified product fit.',
      success: 'A qualified reply, trial or explicit disposition is recorded.' }, task, model: watched, signal, memo, report: item.report,
      brief: item.briefPart, quality: Boolean(item.briefPart) && quality, critic: true, releases, onReject: code => problems.push(code) });
    return { exhausted, grade: gradeCase(item, draft, problems) };
  }

  async function evaluateLive(task, { signal, now = () => new Date() } = {}) {
    if (live(growth.liveEvaluation?.enabled) !== true) return { result: { skipped: 'off' } };
    if (task.agent?.autonomy === 'observe') return { result: { skipped: 'observe_only' } };
    if (!model?.configured || typeof model.run !== 'function') return { result: { skipped: 'model_not_configured' } };
    const moment = now();
    const asked = task.sourceKind === 'owner';
    const due = asked ? moment : dueMoment(task) ?? moment;
    if (!asked && easternWeekday.format(due) !== 'Mon') return { result: { skipped: 'not_monday' } };
    if (!markets(await marketedNow(marketed), product)) return { result: { skipped: 'product_not_marketed' } };
    const run = asked ? `run:${task.id}` : `week:${weekStart(due)}`;
    const state = await growth.store.liveEvalState(run);
    const graded = new Map((state?.cases ?? []).map(entry => [entry.key, entry.result]));
    if (graded.has('final')) return { result: { skipped: 'already_done', run } };
    const policy = state?.policy;
    if (!policy?.approvedClaim) return { result: { skipped: 'no_approved_claim', run } };
    const cases = liveEvaluationCases(moment, policy);
    const memo = live(growth.learning?.enabled) === true && typeof growth.store.learningActive === 'function'
      ? await growth.store.learningActive(product).catch(() => null) : null;
    const quality = live(growth.briefs?.qualityWriter) === true;
    // The CMS releases the sweep would name, from the same feed (none when the feed is off or does not answer).
    const releases = await recentReleases(growth.roster?.feed, { signal });
    const started = clock();
    // Each case stops at the run's deadline, so a slow one is written again next time rather than the scheduler stopping the task.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), liveDeadlineMs);
    timer.unref?.();
    const caseSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    let exhausted = false, retry = false, written = 0;
    try {
      const pending = cases.filter(item => !graded.has(item.key));
      for (let at = 0; at < pending.length && !exhausted && !retry; at += liveConcurrency) {
        if (clock() - started > liveStartBudgetMs) break;
        const batch = pending.slice(at, at + liveConcurrency);
        const outcomes = await Promise.all(batch.map(item => writeCase(item, task, { signal: caseSignal, memo, quality, releases }).then(outcome => ({ item, outcome }), error => ({ item, error }))));
        signal?.throwIfAborted();
        for (const { item, outcome, error } of outcomes) {
          if (error) {
            // Stopped at the deadline, or a passing fault (a rate limit, an outage): written again on the next try.
            if (deadline.signal.aborted || error?.transient === true) { retry = true; continue; }
            const grade = { kind: item.trigger, brief: item.brief, link: item.link, ok: false, wouldReply: null,
              problem: /^[a-z][a-z_]{0,59}$/.test(error?.code ?? '') ? error.code : 'error' };
            await growth.store.liveEvalRecord(run, item.key, grade); graded.set(item.key, grade); written += 1;
            continue;
          }
          // A day's budget that ran out ends the run: the case is not graded as a writing failure.
          if (outcome.exhausted) { exhausted = true; continue; }
          await growth.store.liveEvalRecord(run, item.key, outcome.grade); graded.set(item.key, outcome.grade); written += 1;
        }
      }
    } finally { clearTimeout(timer); }
    const results = cases.filter(item => graded.has(item.key)).map(item => ({ key: item.key, ...graded.get(item.key) }));
    if (!exhausted && results.length < cases.length) {
      return { status: 'queued', retryAt: new Date(moment.getTime() + liveRetryMs), result: { run, graded: results.length, of: cases.length, written } };
    }
    const summary = gradeLiveEvaluation(results, { incomplete: exhausted, cases: cases.length });
    await growth.store.evaluate(product, liveEvaluationVersion, summary.passed, { run, summary, results });
    await growth.store.liveEvalRecord(run, 'final', { passed: summary.passed });
    if (!summary.passed && notifier) {
      const note = liveEvaluationNote({ passed: false, results: { summary } });
      await notifier.send({ severity: 'warning', subject: 'The live writing evaluation did not pass',
        body: `${note} Nothing was held up: sending does not depend on it. The Monday scorecard has the details.`,
        dedupeKey: `growth:live-eval:${run}`, agentKey: task.agentKey, taskId: task.id, attention: 'update' });
    }
    return { result: { run, version: liveEvaluationVersion, ...summary } };
  }

  return { 'growth.evaluate_live': evaluateLive };
}
