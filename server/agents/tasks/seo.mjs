/**
 * The SEO Analyst's weekly check: audit each public website from the outside and email the owner what to fix.
 * The scheduled task runs every morning and catches up once per Eastern week; owner-requested checks run on any day.
 *
 * Three parts, each optional except the first:
 * - The crawl (no model): each site's findings, the pages that are app shells, and any two of the company's hosts that
 *   serve the same page ("pick one canonical home page").
 * - Search Console, when HUB_SEARCH_CONSOLE_CREDENTIALS and HUB_SEARCH_CONSOLE_SITES are set: clicks, impressions,
 *   click-through rate and position against the 28 days before, the top searches and pages, searches close to the
 *   first page, pages seen often but rarely clicked, and searches two of the company's sites compete for. Without it
 *   the report says so once, with the steps to connect it. It is read while the sites are crawled.
 * - Suggested titles and descriptions, when the model runtime is configured (an Anthropic key is set): one call a week
 *   for up to five pages, from each page's own public text and its searches, checked by code (see seo/rewrite.mjs).
 *   Without a model the section is left out; a model that fails or is over budget leaves one line and never holds up
 *   the report. The call is paid for once per report: a retry in this process reuses the checked output, and a report
 *   that already has an email under its own dedupe key gets no new call.
 *
 * The report carries counts, page addresses on the company's own sites, fixed-vocabulary findings, Search Console's
 * figures and searches, and the checked suggestions. It never quotes what a page says. The stored result holds counts
 * and codes only: no page text, no search and no suggestion.
 */
import { auditSite, clip, pageLimit, summarizeFindings } from '../seo/audit.mjs';
import { crossHostDuplicates } from '../seo/duplicates.mjs';
import { searchInsights } from '../seo/insights.mjs';
import {
  buildUserMessage, checkSuggestions, describeAnswer, promptVersion as rewritePromptVersion, responseSchema, rewriteCandidates, systemPrompt, validateAnswer,
} from '../seo/rewrite.mjs';
import { searchConsoleReader } from '../seo/search-console.mjs';
import { sites as defaultSites } from '../seo/sites.mjs';
import { weekStart } from '../accounts/week.mjs';
import { delivered } from '../notify.mjs';
import { plural, recordRun } from './shared.mjs';

const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const dayLabel = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });
const searchDay = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
const wording = { high: 'Urgent', medium: 'Worth fixing', low: 'Minor' };
const perSite = 6;
// The notification row keeps 4,000 characters of the body; the email itself is built from the blocks.
const bodyLimit = 4000;
const efforts = new Set(['low', 'medium', 'high']);
// The scheduler stops a task after four minutes. The suggestions call must be over well before then, so the report still goes out.
export const timing = Object.freeze({ modelDeadlineMs: 200_000, modelMinimumMs: 20_000 });

const countGroups = (groups, severity) => groups.filter(group => group.severity === severity).length;
const number = new Intl.NumberFormat('en-US');
const count = value => number.format(Math.round(value));
const share = value => `${(value * 100).toFixed(1)}%`;
const hostOf = address => { try { return new URL(address).host.toLowerCase(); } catch { return ''; } };
/** A page address without its scheme, as the report lists it. */
const shortPage = url => clip(String(url).replace(/^https?:\/\//i, ''), pageLimit);

const shellWords = audit => {
  const shells = audit.appShells ?? [];
  if (!shells.length || audit.failed) return null;
  const which = shells.length === 1 ? `${shells[0]} is a single-page app shell` : `${shells.length} pages (for example ${shells[0]}) are single-page app shells`;
  return `${audit.label}: ${which}. Search engines and AI assistants that do not run JavaScript see almost nothing there: no text and no links, only what the page's head says, such as its title and description. Put the text of public pages in the HTML itself, prerendered or rendered on the server.`;
};

const duplicateReason = entry => [
  entry.reasons.includes('same_product') ? `both are home pages for ${entry.product}` : null,
  entry.reasons.includes('canonical') ? 'one names the other as its canonical address' : null,
  entry.reasons.includes('same_title') ? (entry.sharedTitles === 1 ? 'they have a page with the same title' : `they have ${entry.sharedTitles} titles in common`) : null,
].filter(Boolean).join('; ');

const connectSteps = 'To connect it: in Google Cloud, create a service account with a JSON key and enable the Google Search Console API for its project; in Search Console, add the service account\'s email address as a user on each property; then set HUB_SEARCH_CONSOLE_CREDENTIALS (the whole key file) and HUB_SEARCH_CONSOLE_SITES (the properties, for example sc-domain:cmcarebase.com) on the Hub service.';
const notConnected = {
  not_configured: `Search Console is not connected, so this report has no clicks, impressions or searches. ${connectSteps}`,
  credentials_missing: `Search Console is not connected: HUB_SEARCH_CONSOLE_SITES is set but HUB_SEARCH_CONSOLE_CREDENTIALS is empty. ${connectSteps}`,
  credentials_invalid: `Search Console is not connected: the key in HUB_SEARCH_CONSOLE_CREDENTIALS could not be read. Paste the service account's whole JSON key file, as Google downloads it. ${connectSteps}`,
  no_properties: 'Search Console is not connected: HUB_SEARCH_CONSOLE_SITES names no property it can read. Write each one as Search Console shows it, for example sc-domain:cmcarebase.com or https://www.caremetricintel.com/, separated by commas.',
};

const writtenAsShown = 'Write it in HUB_SEARCH_CONSOLE_SITES exactly as Search Console shows it: an address prefix ends with /.';
const failureWords = (code, account) => ({
  not_permitted: `the service account${account ? ` (${account})` : ''} cannot read this property. Add it in Search Console under Settings, Users and permissions. ${writtenAsShown}`,
  property_not_found: `Search Console does not know this property. ${writtenAsShown}`,
  request_rejected: `Google refused the request. ${writtenAsShown}`,
  token_refused: 'Google refused the service account\'s key. Check HUB_SEARCH_CONSOLE_CREDENTIALS, and that the key has not been deleted or disabled.',
  rate_limited: 'Google asked the Hub to slow down. It will be read again next week.',
}[code] ?? 'Google did not answer in time, or its answer could not be read. It will be read again next week.');

const trend = (now, before) => {
  if (!(before > 0)) return now > 0 ? 'none the 28 days before' : 'none either time';
  const change = Math.round(((now - before) / before) * 100);
  return change === 0 ? 'unchanged' : `${change > 0 ? 'up' : 'down'} ${Math.abs(change)}%`;
};
const pointTrend = change => (change === null ? '' : Math.abs(change) < 0.0005 ? ', unchanged' : `, ${change > 0 ? 'up' : 'down'} ${Math.abs(change * 100).toFixed(1)} points`);
const positionTrend = change => (change === null ? '' : Math.abs(change) < 0.05 ? ', unchanged' : `, ${Math.abs(change).toFixed(1)} ${change < 0 ? 'better' : 'worse'}`);
const totalsWords = site => {
  const { current, previous } = site.totals;
  if (!(current.impressions > 0)) return `no impressions in the last 28 days (${count(previous.impressions)} the 28 days before).`;
  return `${count(current.clicks)} clicks (${trend(current.clicks, previous.clicks)}), ${count(current.impressions)} impressions (${trend(current.impressions, previous.impressions)}), `
    + `${share(current.ctr)} clicked${pointTrend(site.change.ctr)}, average position ${current.position.toFixed(1)}${positionTrend(site.change.position)}.`;
};
const windowWords = window => {
  if (!window) return 'the last 28 days';
  const label = date => searchDay.format(new Date(`${date}T00:00:00Z`));
  return `${label(window.current.startDate)} to ${label(window.current.endDate)}`;
};
const strikingWords = row => `average position ${row.position.toFixed(1)}, ${count(row.impressions)} impressions, ${plural(Math.round(row.clicks), 'click')}${row.page ? `; ${shortPage(row.page)}` : ''}`;
const lowCtrWords = row => `${count(row.impressions)} impressions, ${share(row.ctr)} clicked at average position ${row.position.toFixed(1)}, where about ${share(row.typical)} is usual`;
const competingWords = entry => entry.hosts.map(host => `${shortPage(host.page)} (position ${host.position.toFixed(1)}, ${count(host.impressions)} impressions)`).join(' and ');

/** The Search Console part of the report, as body paragraphs and email blocks. */
function searchSection(search) {
  if (!search) return { body: [], blocks: [] };
  if (search.state !== 'connected') {
    const text = notConnected[search.state] ?? notConnected.not_configured;
    return { body: [text], blocks: [{ type: 'paragraph', text }] };
  }
  const { insights, account } = search;
  const body = [];
  const blocks = [];
  const skipped = search.invalidProperties > 0 ? ` ${search.invalidProperties === 1 ? '1 entry' : `${search.invalidProperties} entries`} in HUB_SEARCH_CONSOLE_SITES ${search.invalidProperties === 1 ? 'was' : 'were'} not understood and skipped.` : '';
  const intro = `Search Console, ${windowWords(insights.window)}, against the 28 days before.${skipped}`;
  body.push([intro, ...insights.sites.map(site => `${site.property}: ${totalsWords(site)}`), ...insights.failures.map(failure => `${failure.property} could not be read: ${failureWords(failure.code, account)}`)].join('\n'));
  blocks.push({ type: 'paragraph', text: intro });
  for (const site of insights.sites) {
    blocks.push({ type: 'details', rows: [
      [site.property, totalsWords(site)],
      ['Top searches', site.topQueries.length ? site.topQueries.map(row => `${row.query} (${plural(Math.round(row.clicks), 'click')})`).join(', ') : 'None yet'],
      ['Top pages', site.topPages.length ? site.topPages.map(row => `${shortPage(row.page)} (${plural(Math.round(row.clicks), 'click')})`).join(', ') : 'None yet'],
    ] });
  }
  if (insights.failures.length) blocks.push({ type: 'details', rows: insights.failures.map(failure => [failure.property, `Could not be read: ${failureWords(failure.code, account)}`]) });
  if (!insights.sites.length) return { body, blocks };

  const lists = [
    [insights.striking, 'Close to the first page: searches where a site sits at an average position of 8 to 20 and is seen often. These are the cheapest wins: strengthen the page that ranks and link to it from the rest of the site.', row => [row.query, strikingWords(row)]],
    [insights.lowCtr, 'Seen often, rarely clicked: first-page results clicked less than half as often as is usual for their position. Their titles and descriptions are worth rewriting.', row => [shortPage(row.page), lowCtrWords(row)]],
    [insights.competing, 'Your own sites compete: two of your sites appear for the same search and split its clicks. Pick one page for each search, and redirect or link the other to it.', entry => [entry.query, competingWords(entry)]],
  ];
  let any = false;
  for (const [rows, text, row] of lists) {
    if (!rows.length) continue;
    any = true;
    blocks.push({ type: 'paragraph', text }, { type: 'details', rows: rows.map(row) });
    body.push(`${text.split(':')[0]}: ${rows.map(item => { const [label, value] = row(item); return `${label} (${value})`; }).join('; ')}.`);
  }
  if (!any) {
    const text = 'No quick wins stood out in Search Console this week.';
    blocks.push({ type: 'paragraph', text });
    body.push(text);
  }
  return { body, blocks };
}

const suggestionStates = {
  none: 'No page needed a new title or description this week.',
  budget: 'Suggested titles and descriptions were skipped this week: the SEO Analyst\'s daily model budget does not cover them.',
  refused: 'The model declined to suggest titles and descriptions this week.',
  no_time: 'Suggested titles and descriptions were skipped this week: the checks took too long to leave time for them.',
  too_slow: 'Suggested titles and descriptions could not be written this week: the model did not answer in time.',
  unavailable: 'Suggested titles and descriptions could not be written this week: the model was unavailable.',
  already_sent: 'This report has already been sent or tried once, so its suggested titles and descriptions are not paid for again.',
};

/** The suggestions part of the report. Omitted entirely without a model. */
function suggestionSection(suggestions) {
  if (!suggestions) return { body: [], blocks: [] };
  if (suggestions.state !== 'ok') {
    const text = suggestionStates[suggestions.state] ?? suggestionStates.unavailable;
    return { body: [text], blocks: [{ type: 'paragraph', text }] };
  }
  const dropped = suggestions.dropped > 0 ? ` ${plural(suggestions.dropped, 'suggestion')} did not pass the checks and ${suggestions.dropped === 1 ? 'is' : 'are'} not shown.` : '';
  if (!suggestions.items.length) {
    const text = `The model's suggested titles and descriptions did not pass the checks this week, so none are shown.`;
    return { body: [text], blocks: [{ type: 'paragraph', text }] };
  }
  const intro = `Suggested titles and descriptions, written by the model from each page's own text and the searches that show it, and checked by code. Nothing was changed: copy the ones you want into the page.${dropped}`;
  return {
    body: [intro, ...suggestions.items.map(item => `${item.url}\nTitle: ${item.title}\nDescription: ${item.description}`)],
    blocks: [
      { type: 'paragraph', text: intro },
      ...suggestions.items.map(item => ({ type: 'details', rows: [['Page', item.url], ['Why', item.why], ['New title', item.title], ['New description', item.description]] })),
    ],
  };
}

/** The body as stored: whole paragraphs, as many as fit in the notification row. */
function fitBody(paragraphs) {
  const kept = [];
  let length = 0;
  for (const paragraph of paragraphs) {
    const next = length + (kept.length ? 2 : 0) + paragraph.length;
    if (next > bodyLimit - 4) { kept.push('…'); break; }
    kept.push(paragraph);
    length = next;
  }
  return kept.join('\n\n');
}

/**
 * Turns the audits into { subject, body, blocks, headline, groups }. Pure: the same inputs give the same email.
 * `duplicates` (crossHostDuplicates), `search` ({ state, account, insights, invalidProperties }) and `suggestions`
 * ({ state, items, dropped }) are optional: each adds its own section only when given.
 */
export function composeSeoReport(audits, { now = new Date(), publicOrigin, duplicates = [], search = null, suggestions = null } = {}) {
  const summaries = audits.map(audit => ({ audit, groups: summarizeFindings(audit.findings) }));
  const all = summaries.flatMap(summary => summary.groups);
  const urgent = countGroups(all, 'high');
  // Two hosts serving one page is worth fixing, like any other finding.
  const worth = countGroups(all, 'medium') + duplicates.length;
  const minor = countGroups(all, 'low');
  const total = all.length + duplicates.length;
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

  const lines = summaries.flatMap(({ audit, groups }) => {
    const first = groups.slice(0, perSite).map(group => `${group.title} (${group.count})`);
    if (audit.failed) return [`${audit.label}: the check could not run this week.`];
    if (audit.redirectsTo) return [`${audit.label}: redirects to ${audit.redirectsTo}, so search engines see one site${groups.length ? `; ${first.join('; ')}` : ''}.`];
    return [
      `${audit.label} (score ${audit.score}, ${plural(audit.checked, 'page')} checked${audit.incomplete ? ', stopped early' : ''}): ${groups.length ? first.join('; ') + (groups.length > perSite ? `; and ${groups.length - perSite} more` : '') : 'nothing to fix'}.`,
      shellWords(audit),
    ].filter(Boolean);
  });
  const duplicateIntro = 'Pick one canonical home page: two of your sites serve the same pages and compete for the same searches. Choose one, and redirect the other to it permanently.';
  const duplicateLines = duplicates.length ? [`${duplicateIntro}\n${duplicates.map(entry => `${entry.urls[0]} and ${entry.urls[1]}: ${duplicateReason(entry)}.`).join('\n')}`] : [];
  const searchPart = searchSection(search);
  const suggestionPart = suggestionSection(suggestions);
  const closing = 'Pages are read without running scripts, the way many crawlers and AI assistants read them.';
  const body = fitBody([headline, ...lines, ...duplicateLines, ...searchPart.body, ...suggestionPart.body, closing]);

  return {
    headline, urgent, total, groups: all,
    subject: clear ? 'Weekly SEO report: nothing to fix'
      : total === 0 ? 'Weekly SEO report: nothing found, but not every check finished'
        : `Weekly SEO report: ${plural(total, 'thing')} to fix across ${plural(audits.length, 'site')}${urgent ? `, ${urgent} urgent` : ''}`,
    body,
    blocks: [
      { type: 'callout', tone: urgent ? 'warning' : clear ? 'success' : 'info', title: clear ? 'All clear.' : 'SEO check.', text: headline },
      ...summaries.flatMap(({ audit, groups }) => {
        if (audit.failed) return [{ type: 'paragraph', text: `${audit.label}: the check could not run this week.` }];
        if (audit.redirectsTo) {
          return [
            { type: 'paragraph', text: `${audit.label}: redirects to ${audit.redirectsTo}, so search engines see one site.` },
            ...(groups.length ? [{ type: 'details', rows: groups.slice(0, perSite).map(group => [`${wording[group.severity]}: ${group.title}`, `${group.example.page} (${group.example.detail})`]) }] : []),
          ];
        }
        const shell = shellWords(audit);
        return [
          { type: 'paragraph', text: `${audit.label}: score ${audit.score} of 100, ${plural(audit.checked, 'page')} checked${audit.incomplete ? '. The check stopped early because the site was slow.' : '.'}` },
          ...(groups.length ? [{ type: 'details', rows: [
            ...groups.slice(0, perSite).map(group => [`${wording[group.severity]}: ${group.title}`, group.count === 1 ? `${group.example.page} (${group.example.detail})` : `${group.count} places, for example ${group.example.page} (${group.example.detail})`]),
            ...(groups.length > perSite ? [['And more', `${plural(groups.length - perSite, 'other kind')} of problem`]] : []),
          ] }] : [{ type: 'paragraph', text: 'Nothing to fix.' }]),
          ...(shell ? [{ type: 'callout', tone: 'warning', title: 'Invisible without JavaScript.', text: shell }] : []),
        ];
      }),
      ...(duplicates.length ? [
        { type: 'callout', tone: 'warning', title: 'Pick one canonical home page.', text: duplicateIntro },
        { type: 'details', rows: duplicates.map(entry => [`${entry.hosts[0]} and ${entry.hosts[1]}`, `${entry.urls[0]} and ${entry.urls[1]}: ${duplicateReason(entry)}.`]) },
      ] : []),
      ...searchPart.blocks,
      ...suggestionPart.blocks,
      { type: 'paragraph', text: 'Pages are read without running scripts, the way many crawlers and AI assistants read them. A page that looks empty here may look fine in a browser, and that is itself worth knowing.' },
      ...(total && link ? [{ type: 'button', label: 'Open the AI team', url: link }] : []),
    ],
    dateLabel: dayLabel.format(now),
  };
}

/** What the stored result keeps of Search Console: states, figures and counts, never a search or a page. */
function searchResult(search) {
  if (!search) return undefined;
  if (search.state !== 'connected') return { state: search.state };
  const { insights } = search;
  return {
    state: 'connected',
    properties: [
      ...insights.sites.map(site => ({ property: clip(site.property, 120), clicks: Math.round(site.totals.current.clicks), impressions: Math.round(site.totals.current.impressions), previousClicks: Math.round(site.totals.previous.clicks), previousImpressions: Math.round(site.totals.previous.impressions) })),
      ...insights.failures.map(failure => ({ property: clip(failure.property, 120), code: failure.code })),
    ],
    striking: insights.striking.length, lowCtr: insights.lowCtr.length, competing: insights.competing.length,
  };
}

export function seoHandlers({
  store, notifier, publicOrigin, fetchImpl = fetch, sites = defaultSites, audit = auditSite, log = line => console.warn(line),
  model = null, searchConsole = undefined, env = process.env, clock = () => Date.now(), limits = {},
}) {
  // Search Console is read only when the owner has set both variables; `searchConsole` replaces the reader in tests (null: none at all).
  const reader = searchConsole === undefined
    ? searchConsoleReader({ credentials: env.HUB_SEARCH_CONSOLE_CREDENTIALS, sites: env.HUB_SEARCH_CONSOLE_SITES, fetchImpl, log })
    : searchConsole;
  // The suggestions need the shared model runtime with a key, as the Concierge's drafting does. Without it the section is left out.
  const rewriter = model?.configured === true && typeof model.run === 'function' ? model : null;
  const config = { ...timing, ...limits };
  const owners = [...new Set(sites.flatMap(site => [site.origin, ...(site.variants ?? [])]).map(hostOf))];
  // The checked suggestions of the last few reports, by the report's dedupe key. A report tried again in this process (its delivery
  // failed, or its task was retried) reuses them instead of paying for the model again.
  const written = new Map();
  const remember = (key, value) => {
    written.delete(key);
    written.set(key, value);
    while (written.size > 4) written.delete(written.keys().next().value);
  };

  /**
   * Whether this report already has an email under its own dedupe key: sent, on its way, or tried. Its suggestions are then not paid
   * for twice. The count is by prefix, and the scheduled report's key (seo:<day>) begins every key of the owner's own reports that day
   * (seo:<day>:<task>), so those are counted on their own and taken away. A check that fails answers no: the report is then written in
   * full, at the cost of one call.
   */
  async function alreadySent(dedupeKey) {
    if (typeof store.notificationCount !== 'function') return false;
    try {
      const since = new Date(0);
      const [all, longer] = await Promise.all([
        store.notificationCount({ prefix: dedupeKey, channel: 'email', since }),
        store.notificationCount({ prefix: `${dedupeKey}:`, channel: 'email', since }),
      ]);
      return Number(all) - Number(longer) > 0;
    } catch {
      log(JSON.stringify({ event: 'hub_seo_sent_check_failed' }));
      return false;
    }
  }

  async function readSearch(moment, signal) {
    if (!reader) return null;
    if (!reader.configured) return { state: reader.state };
    let read;
    try {
      read = await reader.read({ signal, now: moment });
    } catch {
      // Only the task's own signal stops a read; the report goes on without it and the check before sending ends the task.
      read = { window: null, properties: reader.properties.map(property => ({ property, ok: false, code: 'aborted' })) };
    }
    return { state: 'connected', account: reader.account, invalidProperties: reader.invalidProperties, insights: searchInsights(read, { owners }) };
  }

  async function suggest(task, audits, insights, started, signal) {
    const candidates = rewriteCandidates({ audits, sites, insights });
    if (!candidates.length) return { state: 'none', offered: 0 };
    const left = started + config.modelDeadlineMs - clock();
    if (left < config.modelMinimumMs) return { state: 'no_time', offered: candidates.length };
    const limit = AbortSignal.timeout(left);
    const effort = efforts.has(task.agent?.config?.effort) ? task.agent.config.effort : 'low';
    let result;
    try {
      result = await rewriter.run(task, {
        promptVersion: rewritePromptVersion, system: [{ text: systemPrompt, cache: true }], user: buildUserMessage(candidates), schema: responseSchema,
        effort, maxTokens: 3000, validate: validateAnswer, describe: describeAnswer,
      }, { signal: signal ? AbortSignal.any([signal, limit]) : limit });
    } catch (error) {
      const code = /^[a-z][a-z_]{0,59}$/.test(error?.code ?? '') ? error.code : 'ai_error';
      log(JSON.stringify({ event: 'hub_seo_suggestions_failed', code }));
      return { state: limit.aborted && !signal?.aborted ? 'too_slow' : 'unavailable', code, offered: candidates.length };
    }
    if (result.outcome === 'budget_exhausted') return { state: 'budget', offered: candidates.length };
    if (result.outcome === 'refused') return { state: 'refused', offered: candidates.length };
    const checked = checkSuggestions(result.output, candidates);
    return { state: 'ok', items: checked.kept, dropped: checked.dropped.length, offered: candidates.length };
  }

  async function weekly(task, { signal, now = () => new Date() } = {}) {
    const moment = now();
    const week = weekStart(moment);
    const started = clock();
    const date = dayKey.format(moment);
    const dedupeKey = task.sourceKind === 'owner' ? `seo:${date}:${task.id}` : `seo:${week}`;
    if (task.sourceKind === 'schedule' && store.notificationStatus && ['sent','unknown','pending','suppressed'].includes(await store.notificationStatus(dedupeKey))) return { result: { skipped: 'already_attempted', week } };

    // The sites are different hosts, so they are checked side by side: each has its own deadline, well inside the task's.
    // Search Console is read at the same time.
    const [audits, search] = await Promise.all([
      Promise.all(sites.map(site => audit(site, { fetchImpl, signal }).catch(() => {
        log(JSON.stringify({ event: 'hub_seo_audit_failed', site: site.key }));
        return { key: site.key, label: site.label, checked: 0, findings: [], counts: { high: 0, medium: 0, low: 0 }, score: 0, incomplete: true, failed: true };
      }))),
      readSearch(moment, signal),
    ]);
    const duplicates = crossHostDuplicates(audits, sites);
    // The paid call is made once per report: not again for a retry that has the checked output in hand, nor for a report already sent.
    let suggestions = null;
    if (rewriter) {
      const kept = written.get(dedupeKey);
      if (kept) suggestions = { ...kept, reused: true };
      else if (await alreadySent(dedupeKey)) suggestions = { state: 'already_sent', offered: 0 };
      else {
        suggestions = await suggest(task, audits, search?.insights ?? null, started, signal);
        if (suggestions.state === 'ok') remember(dedupeKey, suggestions);
      }
    }
    // The scheduler has stopped waiting for this task (its time is up, or the owner cancelled it): nothing is sent from here.
    if (signal?.aborted) throw Object.assign(new Error('The task was stopped.'), { code: 'task_timeout', transient: true });

    const report = composeSeoReport(audits, { now: moment, publicOrigin, duplicates, search, suggestions });
    const results = await notifier.send({
      severity: report.urgent > 0 ? 'warning' : 'info', subject: report.subject, body: report.body, blocks: report.blocks,
      dedupeKey, agentKey: task.agentKey, taskId: task.id,
    });
    const delivery = results.map(item => `${item.channel}:${item.delivery}`);
    const reached = results.some(delivered);
    const extras = [
      search?.state === 'connected' ? `Search Console: ${search.insights.sites.length} of ${search.insights.sites.length + search.insights.failures.length} properties read.` : null,
      suggestions?.state === 'ok' ? `${plural(suggestions.items.length, 'suggested title')} for ${plural(suggestions.offered, 'page')}.` : null,
    ].filter(Boolean).join(' ');
    await recordRun({ store, log }, task, {
      promptVersion: 'seo.1',
      summary: reached ? `Sent the SEO report: ${report.headline}${extras ? ` ${extras}` : ''}` : `The SEO report was written but not delivered (${delivery.join(', ')}).`,
      outcome: reached ? 'completed' : 'failed', errorCode: reached ? null : 'not_delivered',
    });
    return {
      result: {
        date, delivery, headline: report.headline,
        sites: audits.map(entry => ({
          key: entry.key, score: entry.score, checked: entry.checked, incomplete: entry.incomplete, counts: entry.counts,
          top: summarizeFindings(entry.findings).slice(0, 8).map(group => ({ code: group.code, severity: group.severity, count: group.count, page: clip(group.example.page, pageLimit) })),
          ...(entry.redirectsTo ? { redirectsTo: entry.redirectsTo } : {}),
          ...(entry.appShells?.length ? { appShells: entry.appShells.length } : {}),
        })),
        ...(duplicates.length ? { duplicates: duplicates.map(entry => entry.hosts) } : {}),
        ...(search ? { search: searchResult(search) } : {}),
        ...(suggestions ? { suggestions: {
          state: suggestions.state, offered: suggestions.offered, kept: suggestions.items?.length ?? 0, dropped: suggestions.dropped ?? 0, ...(suggestions.reused ? { reused: true } : {}),
        } } : {}),
      },
    };
  }
  return { 'seo.weekly': weekly };
}
