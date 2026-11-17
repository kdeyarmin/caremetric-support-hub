/**
 * The Content Marketer's two tasks. Both call the model, so both register only when the database declares
 * platform.agents.content.v1 and the model runtime has a key; otherwise their schedules stay due and nothing runs.
 *
 * `content.weekly` ("Weekly help article"): the schedule fires every morning at 07:45 Eastern and the work happens on Tuesdays
 * and Fridays (`writingDays`; a run the owner starts with Run now works on any day), so a Tuesday that was missed, or whose draft
 * failed its checks, costs three days instead of the week. It picks one topic from the curated backlog (topics.mjs), asks the
 * model for one structured article, checks it in code (validate.mjs) and, when it passes, proposes a `content.publish` action
 * whose preview is the whole article. A draft that fails the checks proposes nothing; the task's result and the run's summary
 * name the checks it failed. An agent in Observe never calls the model.
 *
 * `content.outreach` ("Monthly outreach drafts"): the schedule fires every morning at 08:05 Eastern and the work happens once
 * a month, from the first Wednesday on (a server that was down that day writes them on its next run that month). It asks the
 * model for directory listings and partnership pitches, checks each one, and emails the ones that pass to the owner, who sends
 * them personally. Nothing goes to anyone else.
 *
 * What is kept: the task result and the run summary carry topic keys, slugs, counts and check names, never a draft's text. A
 * proposed article is kept in its action (the owner must read it to approve it); outreach drafts travel only in the owner's
 * email's blocks, which the notifier never stores.
 */
import { contentDeclared } from '../content/executor.mjs';
import { articleHomeUrl, products } from '../content/facts.mjs';
import { marketedNow, markets } from '../marketing.mjs';
import { buildUserMessage, promptVersion, responseSchema, systemPrompt } from '../content/prompt.mjs';
import { catalogBlocks, featuresText } from '../content/features.mjs';
import { checkOutreach, composeOutreachEmail, outreachProducts, outreachPromptVersion, outreachSchema, outreachSystemPrompt, outreachUserMessage } from '../content/outreach.mjs';
import { chooseTopic, countyTopic, topics as backlog } from '../content/topics.mjs';
import { checkDraft } from '../content/validate.mjs';
import { delivered } from '../notify.mjs';
import { searchConsoleReader } from '../seo/search-console.mjs';
import { live, rebuilt } from '../../live.mjs';
import { dueMoment, plural } from './shared.mjs';

const easternParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
const monthLabel = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'long', year: 'numeric' });
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const efforts = new Set(['low', 'medium', 'high']);
const openStatuses = new Set(['proposed', 'approved', 'auto_approved', 'executing', 'executed']);

/** The Eastern calendar date of a moment: { year, month, day, weekday (0 = Sunday) }. */
export function easternDate(moment) {
  const parts = Object.fromEntries(easternParts.formatToParts(moment).map(part => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), weekday: weekdays.indexOf(parts.weekday) };
}
/** True from the first Wednesday of the Eastern month to the month's end. */
export function onOrAfterFirstWednesday(moment) {
  const { day, weekday } = easternDate(moment);
  const firstWeekday = (((weekday - (day - 1)) % 7) + 7) % 7;
  return day >= 1 + ((3 - firstWeekday + 7) % 7);
}
const monthKey = moment => { const { year, month } = easternDate(moment); return `${year}-${String(month).padStart(2, '0')}`; };
const effortOf = task => (efforts.has(task.agent?.config?.effort) ? task.agent.config.effort : 'medium');
// A used-up budget waits for the next Eastern day, which is when the budget starts again.
const nextBudgetDay = (task, moment) => {
  const start = new Date(task.budget?.dayStart ?? NaN);
  return Number.isNaN(start.getTime()) ? new Date(moment.getTime() + 24 * 3_600_000) : new Date(start.getTime() + 24 * 3_600_000 + 5 * 60_000);
};
const aborted = () => Object.assign(new Error('The agent task is no longer running.'), { code: 'task_cancelled' });

/** The Eastern weekdays a scheduled article is written on: Tuesday and Friday. */
export const writingDays = Object.freeze([2, 5]);

/** How many of the roster's counties the Content Marketer considers for county topics. */
export const countyTopicLimit = 12;

/**
 * Reach (team review 2026-11-17, stage 6; the database's platform.agents.reach.v1, seen as the store's `contentRosterCounties`):
 * - topics whose article was published more than a quarter ago are written again (topics.mjs `rewrite`);
 * - Search Console's recent queries (the SEO Analyst's properties, Settings → Search, and its key in Railway) nudge topics people search;
 * - with Settings → AI team → "Write articles about the roster's counties" on, the counties with the most roster agencies are topics too,
 *   named from Intel's county list (a county the list does not name is left out).
 */
export function contentHandlers({ store, notifier, model = null, features = null, topics: allTopics = backlog, marketed = null, log = line => console.warn(line),
  feed = null, rosterStates = null, countyTopics = false, searchConsoleSites = undefined, fetchImpl = fetch, searchConsole = undefined, env = process.env }) {
  // Articles and outreach only for the products the team markets (marketing.mjs: the owner's switches, read when each task starts).
  if (!contentDeclared(features) || model?.configured !== true) return {};
  const reader = searchConsole === undefined
    ? rebuilt(() => ({ credentials: env.HUB_SEARCH_CONSOLE_CREDENTIALS, sites: (value => (Array.isArray(value) ? value.join(',') : value))(searchConsoleSites === undefined ? env.HUB_SEARCH_CONSOLE_SITES : live(searchConsoleSites)) }),
      input => searchConsoleReader({ ...input, fetchImpl, log }))
    : searchConsole;

  // The recent queries people searched, lowercased; none when Search Console is not set up or cannot be read.
  async function recentQueries(signal, moment) {
    const current = typeof reader === 'function' ? reader() : reader;
    if (!current?.configured) return [];
    try {
      const answer = await current.read({ signal, now: moment });
      return [...new Set((answer?.properties ?? []).filter(item => item.ok).flatMap(item => (item.queries ?? []).map(row => String(row.keys?.[0] ?? '').toLowerCase().slice(0, 200))).filter(Boolean))].slice(0, 500);
    } catch (error) {
      if (signal?.aborted) throw error;
      log(JSON.stringify({ event: 'hub_content_search_console_unread', code: /^[a-z_]{1,40}$/.test(error?.code ?? '') ? error.code : 'search_console_error' }));
      return [];
    }
  }

  // County topics: the roster's counties with the most agencies, named from Intel's county list for the roster's states.
  async function rosterCountyTopics() {
    if (live(countyTopics) !== true || typeof store.contentRosterCounties !== 'function' || !feed?.configured || typeof feed.counties !== 'function') return [];
    const states = (Array.isArray(live(rosterStates)) ? live(rosterStates) : []).filter(state => /^[A-Z]{2}$/.test(state));
    if (!states.length) return [];
    try {
      const counties = (await store.contentRosterCounties(countyTopicLimit)) ?? [];
      if (!counties.length) return [];
      const names = new Map(((await feed.counties({ states }))?.counties ?? []).map(county => [county.county_fips, county.county_name]));
      return counties.map(county => countyTopic({ countyFips: county.countyFips, state: county.state, name: names.get(county.countyFips) })).filter(Boolean);
    } catch (error) {
      if (error?.transient) throw error;
      log(JSON.stringify({ event: 'hub_content_counties_unread', code: /^[a-z_]{1,40}$/.test(error?.code ?? '') ? error.code : 'county_error' }));
      return [];
    }
  }

  async function weekly(task, { signal, now = () => new Date() } = {}) {
    const moment = now();
    // The schedule fires every morning; only a Tuesday's or a Friday's firing (read from the task, so a deferred one keeps its day) writes.
    if (task.sourceKind === 'schedule' && !writingDays.includes(easternDate(dueMoment(task) ?? moment).weekday)) return { result: { skipped: 'not_a_writing_day' } };
    // Observe reads and reports only: it could not propose the article, so it does not pay for one.
    if (task.agent?.autonomy === 'observe') return { result: { skipped: 'observe_only' } };

    const marketedList = await marketedNow(marketed);
    const reach = typeof store.contentRosterCounties === 'function';
    const topics = [...allTopics, ...(reach ? await rosterCountyTopics() : [])].filter(item => markets(marketedList, item.product));
    if (!topics.length) return { result: { skipped: 'no_marketed_product' } };
    const state = await store.contentState(topics.map(item => item.slug));
    const queries = reach ? await recentQueries(signal, moment) : [];
    const topic = chooseTopic({ backlog: topics, articles: state?.articles ?? [], takenSlugs: state?.takenSlugs ?? [], questions: state?.questions ?? [], queries, now: moment, rewrite: reach });
    if (!topic) return { result: { skipped: 'no_topic' } };

    let verdict = null;
    const ran = await model.run(task, {
      promptVersion, system: [{ text: systemPrompt, cache: true }, ...catalogBlocks([topic.product])], user: buildUserMessage(topic, { productName: products[topic.product].name }),
      schema: responseSchema, maxTokens: 8000, effort: effortOf(task),
      // The run's summary names the topic and the checks, never the draft.
      describe: output => {
        verdict = checkDraft(output, { topic, promptVersion, features: featuresText(topic.product) });
        return verdict.ok
          ? `Drafted the ${topic.key} article: it passed the checks${verdict.rewrites ? ` (${plural(verdict.rewrites, 'term')} rewritten)` : ''}.`
          : `Drafted the ${topic.key} article: not proposed (${verdict.reasons.join(', ')}).`;
      },
    }, { signal });
    if (ran.outcome === 'budget_exhausted') return { status: 'queued', retryAt: nextBudgetDay(task, moment), result: { deferred: 'budget', topic: topic.key } };
    if (ran.outcome === 'refused') return { result: { outcome: 'refused', topic: topic.key } };

    const checked = verdict ?? checkDraft(ran.output, { topic, promptVersion, features: featuresText(topic.product) });
    if (!checked.ok) return { result: { outcome: 'rejected', topic: topic.key, reasons: checked.reasons } };
    if (signal?.aborted) throw aborted();
    // The model may have chosen a different address than the topic suggested: it must still be free.
    const slug = checked.article.slug;
    const again = await store.contentState([slug]);
    if ((again?.takenSlugs ?? []).includes(slug) || (again?.articles ?? []).some(article => article.slug === slug && openStatuses.has(article.status))) {
      return { result: { outcome: 'rejected', topic: topic.key, reasons: ['slug_taken'] } };
    }
    const proposal = await store.proposeAction({
      taskId: task.id, runId: ran.runId ?? null, kind: 'content.publish', targetKind: 'content_item', targetId: slug, preview: checked.preview, input: checked.article,
    });
    log(JSON.stringify({ event: 'hub_content_article_proposed', task_id: task.id, topic: topic.key, action_id: proposal?.id ?? null }));
    // The address the article will live at: Intel's website for an Intel article, the help center for the rest.
    return { status: 'awaiting_approval', result: { outcome: 'proposed', topic: topic.key, slug, url: articleHomeUrl(checked.article.product, slug), actionId: proposal?.id ?? null, rewrites: checked.rewrites } };
  }

  async function outreach(task, { signal, now = () => new Date() } = {}) {
    const moment = now();
    const due = dueMoment(task) ?? moment;
    const asked = task.sourceKind === 'owner';
    const month = monthKey(due);
    if (!asked) {
      if (!onOrAfterFirstWednesday(due)) return { result: { skipped: 'not_yet_this_month', month } };
      const state = await store.contentState([]);
      if ((state?.outreachMonths ?? []).includes(month)) return { result: { skipped: 'already_sent', month } };
    }
    if (task.agent?.autonomy === 'observe') return { result: { skipped: 'observe_only', month } };
    const marketedList = await marketedNow(marketed);
    if (!outreachProducts(marketedList).pitches.length) return { result: { skipped: 'no_marketed_product', month } };

    let summary = null;
    const label = monthLabel.format(due);
    const ran = await model.run(task, {
      promptVersion: outreachPromptVersion, system: [{ text: outreachSystemPrompt, cache: true }, ...catalogBlocks(marketedList)], user: outreachUserMessage(label, marketedList),
      schema: outreachSchema, maxTokens: 6000, effort: effortOf(task),
      describe: output => {
        summary = checkOutreach(output, { marketed: marketedList });
        return `Drafted outreach for ${month}: ${plural(summary.listings.length, 'listing')} and ${plural(summary.pitches.length, 'pitch').replace('pitchs', 'pitches')} passed the checks${summary.dropped ? `, ${summary.dropped} left out (${summary.reasons.join(', ')})` : ''}.`;
      },
    }, { signal });
    if (ran.outcome === 'budget_exhausted') return { status: 'queued', retryAt: nextBudgetDay(task, moment), result: { deferred: 'budget', month } };
    if (ran.outcome === 'refused') return { result: { outcome: 'refused', month } };

    const checked = summary ?? checkOutreach(ran.output, { marketed: marketedList });
    if (signal?.aborted) throw aborted();
    const email = composeOutreachEmail({ month, label, ...checked });
    const results = await notifier.send({
      severity: 'info', subject: email.subject, body: email.body, blocks: email.blocks,
      dedupeKey: asked ? `content:outreach:run:${task.id}` : `content:outreach:${month}`, agentKey: task.agentKey, taskId: task.id,
    });
    const delivery = results.map(item => `${item.channel}:${item.delivery}`);
    return {
      result: {
        outcome: results.some(delivered) ? 'sent' : 'not_delivered', month, delivery,
        listings: checked.listings.length, pitches: checked.pitches.length, dropped: checked.dropped, reasons: checked.reasons,
      },
    };
  }

  return { 'content.weekly': weekly, 'content.outreach': outreach };
}
