/**
 * The SEO Analyst's weekly check: audit each public website from the outside and email the owner what to fix.
 * It uses no model. The scheduled task runs every morning but does its work only on Mondays (Eastern time), so
 * the report arrives once a week; a check the owner starts with Run now runs on any day.
 *
 * The report carries counts, page addresses on the company's own sites and fixed-vocabulary findings. It never
 * quotes anything a page says beyond a length or a count.
 */
import { auditSite, clip, pageLimit, summarizeFindings } from '../seo/audit.mjs';
import { sites as defaultSites } from '../seo/sites.mjs';
import { delivered } from '../notify.mjs';
import { plural, recordRun } from './shared.mjs';

const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' });
const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const dayLabel = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });
const wording = { high: 'Urgent', medium: 'Worth fixing', low: 'Minor' };
const perSite = 6;

const countGroups = (groups, severity) => groups.filter(group => group.severity === severity).length;

/** Turns the audits into { subject, body, blocks, headline, groups }. Pure: the same audits give the same email. */
export function composeSeoReport(audits, { now = new Date(), publicOrigin } = {}) {
  const summaries = audits.map(audit => ({ audit, groups: summarizeFindings(audit.findings) }));
  const all = summaries.flatMap(summary => summary.groups);
  const urgent = countGroups(all, 'high');
  const worth = countGroups(all, 'medium');
  const minor = countGroups(all, 'low');
  const total = all.length;
  // A site that failed or stopped early has told us nothing about the pages it never reached: no findings is not "all clear".
  const unfinished = summaries.filter(({ audit }) => audit.failed || audit.incomplete).length;
  const clear = total === 0 && unfinished === 0;
  const unfinishedNote = unfinished ? `${plural(unfinished, 'site')} could not be fully checked.` : null;
  const headline = clear
    ? 'Nothing to fix this week.'
    : total === 0
      ? `Nothing found in what was checked. ${unfinishedNote}`
      : [[urgent ? `${plural(urgent, 'problem')} could keep pages out of search results` : null, worth ? `${worth} worth fixing` : null, minor ? `${minor} minor` : null]
        .filter(Boolean).join(', ').replace(/^(.)/, letter => letter.toUpperCase()).concat('.'), unfinishedNote].filter(Boolean).join(' ');
  const link = /^https:\/\//i.test(publicOrigin ?? '') ? `${publicOrigin.replace(/\/+$/, '')}/admin/team` : null;

  const lines = summaries.map(({ audit, groups }) => {
    if (audit.failed) return `${audit.label}: the check could not run this week.`;
    const first = groups.slice(0, perSite).map(group => `${group.title} (${group.count})`);
    return `${audit.label} (score ${audit.score}, ${plural(audit.checked, 'page')} checked${audit.incomplete ? ', stopped early' : ''}): ${groups.length ? first.join('; ') + (groups.length > perSite ? `; and ${groups.length - perSite} more` : '') : 'nothing to fix'}.`;
  });
  const body = [headline, ...lines, 'Pages are read without running scripts, the way many crawlers and AI assistants read them.'].join('\n\n');

  return {
    headline, urgent, total, groups: all,
    subject: clear ? 'Weekly SEO report: nothing to fix'
      : total === 0 ? 'Weekly SEO report: nothing found, but not every check finished'
        : `Weekly SEO report: ${plural(total, 'thing')} to fix across ${plural(audits.length, 'site')}${urgent ? `, ${urgent} urgent` : ''}`,
    body,
    blocks: [
      { type: 'callout', tone: urgent ? 'warning' : clear ? 'success' : 'info', title: clear ? 'All clear.' : 'SEO check.', text: headline },
      ...summaries.flatMap(({ audit, groups }) => audit.failed ? [{ type: 'paragraph', text: `${audit.label}: the check could not run this week.` }] : [
        { type: 'paragraph', text: `${audit.label}: score ${audit.score} of 100, ${plural(audit.checked, 'page')} checked${audit.incomplete ? '. The check stopped early because the site was slow.' : '.'}` },
        ...(groups.length ? [{ type: 'details', rows: [
          ...groups.slice(0, perSite).map(group => [`${wording[group.severity]}: ${group.title}`, group.count === 1 ? `${group.example.page} (${group.example.detail})` : `${group.count} places, for example ${group.example.page} (${group.example.detail})`]),
          ...(groups.length > perSite ? [['And more', `${plural(groups.length - perSite, 'other kind')} of problem`]] : []),
        ] }] : [{ type: 'paragraph', text: 'Nothing to fix.' }]),
      ]),
      { type: 'paragraph', text: 'Pages are read without running scripts, the way many crawlers and AI assistants read them. A page that looks empty here may look fine in a browser, and that is itself worth knowing.' },
      ...(total && link ? [{ type: 'button', label: 'Open the AI team', url: link }] : []),
    ],
    dateLabel: dayLabel.format(now),
  };
}

export function seoHandlers({ store, notifier, publicOrigin, fetchImpl = fetch, sites = defaultSites, audit = auditSite, log = line => console.warn(line) }) {
  async function weekly(task, { signal, now = () => new Date() } = {}) {
    const moment = now();
    // The schedule fires every morning; only Monday's is the weekly check. A check the owner asked for always runs.
    if (task.sourceKind === 'schedule' && weekday.format(moment) !== 'Mon') return { result: { skipped: 'not_monday' } };

    // The sites are different hosts, so they are checked side by side: each has its own deadline, well inside the task's.
    const audits = await Promise.all(sites.map(site => audit(site, { fetchImpl, signal }).catch(() => {
      log(JSON.stringify({ event: 'hub_seo_audit_failed', site: site.key }));
      return { key: site.key, label: site.label, checked: 0, findings: [], counts: { high: 0, medium: 0, low: 0 }, score: 0, incomplete: true, failed: true };
    })));
    const report = composeSeoReport(audits, { now: moment, publicOrigin });
    const date = dayKey.format(moment);
    const results = await notifier.send({
      severity: report.urgent > 0 ? 'warning' : 'info', subject: report.subject, body: report.body, blocks: report.blocks,
      dedupeKey: task.sourceKind === 'owner' ? `seo:${date}:${task.id}` : `seo:${date}`, agentKey: task.agentKey, taskId: task.id,
    });
    const delivery = results.map(item => `${item.channel}:${item.delivery}`);
    const reached = results.some(delivered);
    await recordRun({ store, log }, task, {
      promptVersion: 'seo.1',
      summary: reached ? `Sent the SEO report: ${report.headline}` : `The SEO report was written but not delivered (${delivery.join(', ')}).`,
      outcome: reached ? 'completed' : 'failed', errorCode: reached ? null : 'not_delivered',
    });
    return {
      result: {
        date, delivery, headline: report.headline,
        sites: audits.map(entry => ({ key: entry.key, score: entry.score, checked: entry.checked, incomplete: entry.incomplete, counts: entry.counts,
          top: summarizeFindings(entry.findings).slice(0, 8).map(group => ({ code: group.code, severity: group.severity, count: group.count, page: clip(group.example.page, pageLimit) })) })),
      },
    };
  }
  return { 'seo.weekly': weekly };
}
