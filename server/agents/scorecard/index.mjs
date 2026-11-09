/**
 * `scorecard.weekly`: the Chief of Staff's Monday scorecard (supabase/migrations/20261109120000_monday_scorecard.sql). One email at
 * 07:50 Eastern in place of the five weekly reports: six numbers per product beside last week's, what changed, and at most three
 * things that need the owner. It uses no model and sends nothing to a customer.
 *
 * It reads what the five reports already read, side by side, and none of them holds up the others:
 * - its own counts (private.agent_scorecard_facts) for the week and the week before: county reports, trial sign-ups, first activations,
 *   outbound email outcomes, replies and the AI spend on agent runs;
 * - the morning brief's facts: proposals waiting for approval and products that are down;
 * - the Account Manager's billing snapshot: MRR with the Billing screen's maths, new paying customers and the accounts that need attention;
 * - the Sales Executive's pipeline (the growth snapshot): deals that need the owner;
 * - the Social Media Manager's ad accounts, when one is connected: ad spend and ads losing money;
 * - the SEO Analyst's crawl of the websites (urgent problems) and Search Console, when it is connected (organic clicks).
 * A source that cannot be read is named in the email; only the scorecard's own counts are required.
 *
 * The schedule fires every morning, and every scheduled run in an Eastern week uses `scorecard:<Monday>`, so the first run of the week
 * sends (normally Monday's) and later ones find it attempted and do nothing. A send the provider refused is tried again under the same
 * key a few minutes later. "Run now" always reports, under a key of its own. The week reported is the Monday-to-Sunday before the week
 * the run is due in, so a run caught up on Tuesday reports the same week.
 *
 * What is kept: the task result, the run summary and the alert's subject and stored body carry counts only. Money travels in the
 * email's blocks, which the notifier never stores.
 */
import { delivered } from '../notify.mjs';
import { easternMidnight, weekStart } from '../accounts/week.mjs';
import { composeAccountsReport } from '../accounts/report.mjs';
import { composeReview, readPipeline } from '../sales/review.mjs';
import { evaluateAds } from '../social/rules.mjs';
import { auditSite, summarizeFindings } from '../seo/audit.mjs';
import { searchConsoleReader } from '../seo/search-console.mjs';
import { sites as defaultSites } from '../seo/sites.mjs';
import { readAccountsSnapshot } from '../tasks/accounts.mjs';
import { dueMoment, mustHaveReached, recordRun } from '../tasks/shared.mjs';
import { billingFigures, composeScorecard, composeVersion, searchFigures } from './compose.mjs';

export const scorecardFeature = 'platform.agents.scorecard.v1';
export const scorecardDeclared = features => (features instanceof Set ? features.has(scorecardFeature) : Array.isArray(features) && features.includes(scorecardFeature));

const stopped = () => Object.assign(new Error('The task was stopped.'), { code: 'task_timeout', transient: true });
const shift = (date, days) => { const [year, month, day] = date.split('-').map(Number); return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10); };

/**
 * Registered only when the database declares platform.agents.scorecard.v1 (and the store has its read), so a Hub whose database lacks the
 * migration still starts and the schedule stays due. `growth` is the customer growth service (its pipeline snapshot), `ads` the Social
 * Media Manager's ad accounts (`{ sources: () => [{ name, client }], settings }`, or null), `searchConsole` replaces the reader in tests,
 * and `visitors` is a connected analytics source (`async ({ since, until, signal }) => { products: { [key]: { visitors, previous } } }`);
 * there is none today, so the email says "Not connected".
 */
export function scorecardHandlers({
  store, notifier, publicOrigin = null, features = null, growth = null, ads = null, searchConsole = undefined, env = process.env, fetchImpl = fetch,
  sites = defaultSites, audit = auditSite, visitors = null, log = line => console.warn(line),
}) {
  if (!scorecardDeclared(features) || typeof store?.scorecardFacts !== 'function') return {};
  const reader = searchConsole === undefined
    ? searchConsoleReader({ credentials: env.HUB_SEARCH_CONSOLE_CREDENTIALS, sites: env.HUB_SEARCH_CONSOLE_SITES, fetchImpl, log })
    : searchConsole;

  // One optional source: its value, or null after a logged, named failure. The task's own stop is never swallowed.
  const optional = async (name, work, signal) => {
    try { return await work(); } catch (error) {
      if (signal?.aborted) throw stopped();
      log(JSON.stringify({ event: 'hub_scorecard_source_unread', source: name, code: /^[a-z][a-z_]{0,59}$/.test(error?.code ?? '') ? error.code : 'error' }));
      return null;
    }
  };

  /**
   * Ad spend for the reported week and the week before: the ad accounts' two seven-day windows end the day before `now`, so they are
   * read as of the week's end (Monday's midnight). The ads losing money are judged on the last seven days, so a run later in the week
   * (a catch-up, or Run now) reads the accounts a second time as of now.
   */
  async function readAds({ moment, until }, signal) {
    const sources = ads?.sources?.() ?? [];
    if (!sources.length) return null;
    const sameDay = moment.getTime() - until.getTime() < 86_400_000;
    let spendCents = 0;
    let previousSpendCents = 0;
    let failing = 0;
    for (const source of sources) {
      const week = await source.client.adsOverview({ signal, now: until });
      spendCents += (week.current ?? []).reduce((sum, row) => sum + (Number(row.spendCents) || 0), 0);
      previousSpendCents += (week.previous ?? []).reduce((sum, row) => sum + (Number(row.spendCents) || 0), 0);
      const recent = sameDay ? week : await source.client.adsOverview({ signal, now: moment });
      failing += evaluateAds({ ...recent, now: moment, settings: ads.settings ?? {} }).recommendations.filter(item => item.kind === 'pause').length;
    }
    return { spendCents, previousSpendCents, failing };
  }

  async function readSearch(moment, signal) {
    if (!reader) return null;
    if (!reader.configured || typeof reader.totals !== 'function') return { state: reader.state ?? 'not_configured' };
    return searchFigures(await reader.totals({ signal, now: moment, days: 7 }));
  }

  // The SEO Analyst's crawl, for the urgent problems only: the same findings its report counts as urgent.
  async function siteProblems(signal) {
    const audits = await Promise.all(sites.map(site => audit(site, { fetchImpl, signal }).catch(() => ({ findings: [], failed: true }))));
    if (audits.every(entry => entry.failed)) throw Object.assign(new Error('No site could be checked.'), { code: 'sites_unreachable' });
    return audits.flatMap(entry => summarizeFindings(entry.findings ?? [])).filter(group => group.severity === 'high').length;
  }

  async function weekly(task, { now = () => new Date(), signal } = {}) {
    const moment = now();
    const asked = task.sourceKind === 'owner';
    const due = asked ? moment : dueMoment(task) ?? moment;
    const thisWeek = weekStart(due);
    const week = shift(thisWeek, -7);
    const since = easternMidnight(week);
    const until = easternMidnight(thisWeek);
    const before = easternMidnight(shift(thisWeek, -14));
    const dedupeKey = asked ? `scorecard:run:${task.id}` : `scorecard:${thisWeek}`;
    // A scheduled run whose week was already sent, is on its way, or was switched off does no work. A failed send is tried again.
    if (!asked && typeof store.notificationStatus === 'function'
      && ['sent', 'unknown', 'pending', 'suppressed'].includes(await store.notificationStatus(dedupeKey))) {
      return { result: { skipped: 'already_attempted', week: thisWeek } };
    }

    const [current, previous, brief, snapshot, pipeline, adFigures, search, urgent, seen] = await Promise.all([
      store.scorecardFacts({ since, until }),
      store.scorecardFacts({ since: before, until: since }),
      optional('brief', () => store.briefFacts(), signal),
      optional('billing', () => readAccountsSnapshot(store), signal),
      growth?.store?.snapshot ? optional('pipeline', () => readPipeline(growth, signal), signal) : null,
      ads?.sources?.().length ? optional('ads', () => readAds({ moment, until }, signal), signal).then(value => value ?? { unavailable: true }) : null,
      optional('search_console', () => readSearch(moment, signal), signal),
      optional('websites', () => siteProblems(signal), signal),
      visitors ? optional('visitors', () => visitors({ since, until, signal }), signal) : null,
    ]);
    // The scheduler may have stopped waiting while the figures were read: the scorecard is not sent after that.
    if (signal?.aborted) throw stopped();

    const accounts = snapshot ? composeAccountsReport({ snapshot, now: moment, publicOrigin }).result : null;
    const review = pipeline ? composeReview({ items: pipeline, now: moment, publicOrigin }).result : null;
    const notes = [
      brief ? null : 'The approvals waiting and products down could not be read this morning.',
      snapshot ? null : 'Billing could not be read this morning, so MRR, new paying customers and accounts needing attention are missing.',
      growth?.store?.snapshot && !pipeline ? 'The pipeline could not be read this morning, so deals waiting on you are missing.' : null,
      urgent === null ? 'The websites could not be checked this morning.' : null,
    ].filter(Boolean);
    const card = composeScorecard({
      week, facts: { current, previous }, billing: billingFigures(snapshot, { now: moment, until }), search, ads: adFigures, visitors: seen, publicOrigin, notes,
      needs: {
        incidents: Array.isArray(brief?.incidents) ? brief.incidents.length : 0, approvals: brief?.approvals ?? null,
        accounts: accounts?.needsYou ?? null, stuckDeals: review?.needsYou ?? null, failingAds: adFigures?.failing ?? null, siteProblems: urgent,
      },
    });

    const results = await notifier.send({
      severity: card.needsYou ? 'warning' : 'info', subject: card.subject, body: card.body, blocks: card.blocks,
      dedupeKey, agentKey: task.agentKey, taskId: task.id,
    });
    if (!asked && results.every(item => item.delivery === 'duplicate')) return { result: { skipped: results.some(delivered) ? 'already_sent' : 'earlier_attempt_unconfirmed', week: thisWeek } };
    const delivery = results.map(item => `${item.channel}:${item.delivery}`);
    const reached = results.some(delivered);
    await recordRun({ store, log }, task, {
      promptVersion: composeVersion,
      summary: reached ? `Sent the Monday scorecard: ${card.headline}` : `The Monday scorecard was written but not delivered (${delivery.join(', ')}).`,
      outcome: reached ? 'completed' : 'failed', errorCode: reached ? null : 'not_delivered',
    });
    // A scorecard the provider refused is tried again under the same key; the run above stays as the record of this attempt.
    mustHaveReached(results);
    return { result: { week: thisWeek, reported: week, since: since.toISOString(), until: until.toISOString(), delivery, ...card.result } };
  }

  return { 'scorecard.weekly': weekly };
}
