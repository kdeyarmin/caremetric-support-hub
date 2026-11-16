/**
 * Which agencies opened their market report (20261116120000_growth_report_views.sql; owner decision 2026-11-16).
 *
 * `growth.views`, every 15 minutes, while Settings → Customer growth → "Learn which agencies opened their report" is on, reads the opens
 * Intel recorded since the last read (Intel's signed POST /api/hub/report-views: the Hub's reference on the link, the CCN and the time;
 * never who opened it), a few pages at most, and the database records each one that came after the agency's first email. The owner is
 * told when an agency opens its report for the first time; the Marketing Manager's second email to it reads the open
 * (draft.mjs `viewedTouchAngle`). Only counts are returned.
 */
import { live } from '../live.mjs';

export const growthReportViewsFeature = 'platform.agents.growth-report-views.v1';
export const viewPagesPerRun = 5;
const pageSize = 200;

export function viewsHandlers({ growth, features = null, notifier = null }) {
  const declared = features instanceof Set ? features.has(growthReportViewsFeature) : Array.isArray(features) && features.includes(growthReportViewsFeature);
  if (!growth || !declared || typeof growth.store?.reportViewsRecord !== 'function') return {};
  async function views(task, { signal } = {}) {
    if (live(growth.views?.enabled) !== true) return { result: { skipped: 'off' } };
    if (task.agent?.autonomy === 'observe') return { result: { skipped: 'observe_only' } };
    const feed = growth.views?.feed;
    if (!feed?.configured || typeof feed.reportViews !== 'function') return { result: { skipped: 'feed_not_configured' } };
    let after = Number(await growth.store.reportViewsCursor()) || 0;
    const counts = { read: 0, recorded: 0, ignored: 0, firstViews: 0 };
    for (let page = 0; page < viewPagesPerRun; page++) {
      signal?.throwIfAborted();
      const answer = await feed.reportViews({ afterId: after, limit: pageSize, signal });
      if (!answer.views.length) break;
      const saved = await growth.store.reportViewsRecord(answer.views.map(view => ({ id: view.id, ref: view.ref, ccn: view.ccn, viewed_at: view.viewed_at })), answer.next_after_id);
      counts.read += answer.views.length; counts.recorded += Number(saved?.recorded ?? 0); counts.ignored += Number(saved?.ignored ?? 0);
      for (const first of saved?.firstViews ?? []) {
        counts.firstViews++;
        if (!notifier) continue;
        const name = String(first.name ?? 'An agency').slice(0, 120);
        await notifier.send({ severity: 'info', subject: `${name} opened its market report`,
          body: `${name} opened the free market report from its CareMetric Intel email (${new Date(first.viewedAt).toLocaleString('en-US', { timeZone: 'America/New_York' })} Eastern). Its second email will follow up on the report instead of starting a new angle. Open Growth to see the agency and its brief.`,
          dedupeKey: `growth:report-viewed:${first.opportunity}`, agentKey: task.agentKey, taskId: task.id });
      }
      after = answer.next_after_id;
      if (answer.views.length < pageSize) break;
    }
    return { result: counts };
  }
  return { 'growth.views': views };
}
