/**
 * The Social Media Manager's work. Every task reads Meta live and proposes actions the owner approves (or, once a kind of work is
 * handed over after its supervised week, that the agent is trusted with); nothing here posts, replies or changes an ad by itself.
 *
 * - `social.plan` (each morning, once a week): drafts the week's posts for Facebook, Instagram and LinkedIn from the fact sheet, the
 *   sales playbook and what earned engagement in the last four weeks; checks every word; proposes each Facebook and Instagram post held
 *   for its time slot; and emails the owner the plan with LinkedIn posts ready to paste (LinkedIn is not connected).
 * - `social.inbox` (every 15 minutes): finds new comments and messages from other people and gives each its own task.
 * - `social.interaction`: reads one comment or message from Meta, and with the owner's switch for customer text to AI on, drafts a
 *   checked reply (or proposes hiding spam); a public comment that appears to carry personal or health information is proposed for
 *   hiding and the owner is warned. Without the switch the owner is told and answers on Meta.
 * - `social.ads` (each morning): evaluates every ad with rules.mjs and proposes pausing losers, new copy where an ad set needs it, and
 *   (only with a cap set) a measured budget increase that only the owner can approve.
 * - `social.report` (each morning, once a week): how posts and ads did, and what is waiting for the owner.
 *
 * Nothing another person wrote is kept: not in a task, a run, an action or an owner email. Posts and replies are CareMetric's words.
 */
import { weekStart, easternDate, easternMidnight } from '../accounts/week.mjs';
import { delivered } from '../notify.mjs';
import { redact } from '../concierge/redact.mjs';
import { screenIdentifiers } from '../concierge/screen.mjs';
import { dueMoment, permanent, plural, recordRun, when } from '../tasks/shared.mjs';
import { playbookFor } from '../../growth/playbook.mjs';
import {
  adPromptVersion, adSchema, adSystem, checkSocialText, planPromptVersion, planSchema, planSystem, replyPromptVersion, replySchema, replySystem,
  replyUserMessage, socialLinks, socialProducts, withHashtags,
} from './content.mjs';
import { evaluateAds, rankPosts, rulesVersion } from './rules.mjs';

const day = 86_400_000;
const labels = { facebook: 'Facebook', instagram: 'Instagram', messenger: 'Messenger', linkedin: 'LinkedIn' };
const productNames = { carebase: 'CareBase', 'caremetric-intel': 'CareMetric Intel' };
const weekly = { facebook: 3, instagram: 2, linkedin: 3 };
const slots = { facebook: [10, 30], instagram: [12, 15] };
const modelAttempts = 3;
const money = cents => `$${(cents / 100).toFixed(2)}`;
const firstLine = text => String(text ?? '').split('\n')[0].slice(0, 90);
const productOf = url => { try { const host = new URL(url).hostname.replace(/^www\./, ''); return host === 'cmcarebase.com' ? 'carebase' : host === 'caremetricintel.com' ? 'caremetric-intel' : null; } catch { return null; } };

export function socialHandlers({ store, notifier, model = null, meta, settings = {}, imageUrls = [], customerTextToAi = false, publicOrigin = null, log = line => console.warn(line) }) {
  const drafting = customerTextToAi === true && model?.configured === true;
  const open = async () => new Set(await store.socialOpenTargets());
  const effort = task => (['low', 'medium', 'high'].includes(task.agent?.config?.effort) ? task.agent.config.effort : 'medium');

  async function propose(task, { kind, targetKind, targetId, preview, input }) {
    try {
      const proposal = await store.proposeAction({ taskId: task.id, kind, targetKind, targetId, preview: preview.slice(0, 6000), input });
      return proposal;
    } catch (error) {
      if (error?.code === '42501') return null;
      throw error;
    }
  }

  async function runModel(task, request, signal) {
    try {
      return await model.run(task, request, { signal });
    } catch (error) {
      if (signal?.aborted || (error?.transient === true && (task.attempts ?? 1) < modelAttempts)) throw error;
      return { outcome: 'unavailable', code: /^[a-z][a-z_]{0,59}$/.test(error?.code ?? '') ? error.code : 'ai_error' };
    }
  }

  // ---- The weekly plan ---------------------------------------------------------------------------------------------------------------
  async function plan(task, { now = () => new Date(), signal } = {}) {
    if (!model?.configured) return { result: { skipped: 'model_not_configured' } };
    if (task.agent?.autonomy === 'observe') return { result: { skipped: 'observe_only' } };
    const moment = now();
    const week = weekStart(dueMoment(task) ?? moment);
    const asked = task.sourceKind === 'owner';
    const key = `social:plan:${week}`;
    if (!asked && await store.notificationCount({ prefix: key, channel: 'email', since: new Date(0) }) > 0) return { result: { skipped: 'already_planned', week } };
    const counts = { facebook: meta.configured.pages ? weekly.facebook : 0, instagram: meta.configured.instagram && imageUrls.length ? weekly.instagram : 0, linkedin: weekly.linkedin };
    let posts = [];
    let performance = 'read';
    try { if (meta.configured.pages || meta.configured.instagram) posts = await meta.recentPosts({ signal }); else performance = 'not_connected'; }
    catch (error) { if (signal?.aborted || error?.transient) throw error; performance = error?.code ?? 'meta_error'; }
    const ranked = rankPosts(posts, { now: moment });
    const links = Object.fromEntries(socialProducts.map(product => [product, socialLinks(product).map(({ id, label }) => ({ id, label }))]));
    const user = JSON.stringify({
      weekStarting: week, postsToWrite: counts, links,
      bestRecent: ranked.slice(0, 3).map(post => ({ platform: post.platform, engagement: post.engagement, text: post.text.slice(0, 240) })),
      weakestRecent: ranked.length > 3 ? ranked.slice(-2).map(post => ({ platform: post.platform, engagement: post.engagement, text: post.text.slice(0, 160) })) : [],
      recentOpenings: posts.slice(0, 12).map(post => firstLine(post.text)),
    });
    const result = await runModel(task, { promptVersion: planPromptVersion, system: [{ text: planSystem, cache: true }], user, schema: planSchema, maxTokens: 6000, effort: effort(task),
      describe: output => `Planned ${plural(output.posts.length, 'social post')} for the week of ${week}.` }, signal);
    if (result.outcome !== 'completed') return { result: { skipped: result.outcome, week, ...(result.code ? { code: result.code } : {}) } };

    const targets = await open();
    const used = { facebook: 0, instagram: 0, linkedin: 0 };
    const rejected = {};
    const linkedin = [];
    let proposed = 0;
    for (const draft of result.output.posts ?? []) {
      signal?.throwIfAborted();
      if (!socialProducts.includes(draft.product) || used[draft.platform] === undefined || used[draft.platform] >= counts[draft.platform]) continue;
      const page = draft.linkId ? socialLinks(draft.product).find(link => link.id === draft.linkId) : null;
      if (draft.linkId && !page) { rejected.link = (rejected.link ?? 0) + 1; continue; }
      const link = draft.platform === 'instagram' ? null : page?.url ?? null;
      // A Facebook link travels beside the text (it renders as a card); LinkedIn copy is pasted by hand, so it carries the address.
      const text = withHashtags(draft.platform === 'linkedin' && link ? `${draft.text.trim()}\n\n${link}` : draft.text, draft.hashtags);
      const checked = checkSocialText(text, { surface: draft.platform, product: draft.product });
      if (!checked.ok) { rejected[checked.reason] = (rejected[checked.reason] ?? 0) + 1; continue; }
      used[draft.platform] += 1;
      if (draft.platform === 'linkedin') { linkedin.push({ product: draft.product, pillar: draft.pillar, text: checked.text }); continue; }
      const scheduledFor = slotFor({ week, day: draft.day, platform: draft.platform, index: used[draft.platform], now: moment });
      const targetId = `${draft.platform}:${week}:${used[draft.platform]}`;
      if (targets.has(`social.post:${targetId}`)) continue;
      const imageUrl = draft.platform === 'instagram' ? imageUrls[(Number(week.replaceAll('-', '')) + used.instagram) % imageUrls.length] : null;
      const proposal = await propose(task, {
        kind: 'social.post', targetKind: 'social_post', targetId,
        preview: `${labels[draft.platform]} post about ${productNames[draft.product]} (${draft.pillar}), to publish ${when(scheduledFor)}:\n\n${checked.text}${link ? `\n\nLink: ${link}` : ''}${imageUrl ? `\n\nImage: ${imageUrl}` : ''}`,
        input: { platform: draft.platform, product: draft.product, pillar: draft.pillar, message: checked.text, link, imageUrl, scheduledFor },
      });
      if (!proposal) break;
      if (proposal.created !== false) { await store.socialSchedule(proposal.id, null); proposed += 1; }
    }

    const body = `${plural(proposed, 'post')} proposed for Facebook and Instagram, ${plural(linkedin.length, 'LinkedIn post')} to paste.${Object.keys(rejected).length ? ` ${Object.values(rejected).reduce((a, b) => a + b, 0)} drafts failed the checks and were dropped.` : ''}`;
    const blocks = [
      { type: 'callout', tone: 'info', title: `Social plan for the week of ${week}.`, text: body },
      { type: 'paragraph', text: proposed ? 'Approve each Facebook and Instagram post in the AI team. An approved post waits for its time slot.' : 'No Facebook or Instagram post is waiting: the accounts are not connected, or no draft passed the checks.' },
      ...(performance === 'read' ? [] : [{ type: 'paragraph', text: performance === 'not_connected' ? 'Facebook and Instagram are not connected, so this plan could not learn from past posts.' : `Past posts could not be read from Meta (${performance.replaceAll('_', ' ')}).` }]),
      ...linkedin.flatMap((post, index) => [{ type: 'paragraph', text: `LinkedIn post ${index + 1} (${productNames[post.product]}, ${post.pillar})` }, { type: 'message', text: post.text }]),
      ...(/^https:\/\//i.test(publicOrigin ?? '') && proposed ? [{ type: 'button', label: 'Open the AI team', url: `${publicOrigin.replace(/\/+$/, '')}/admin/team` }] : []),
    ];
    const results = await notifier.send({ severity: 'info', subject: `Social plan: ${plural(proposed, 'post')} to approve`, body, blocks, dedupeKey: asked ? `social:plan:run:${task.id}` : key, agentKey: task.agentKey, taskId: task.id });
    return { status: proposed ? 'awaiting_approval' : 'done', result: { week, proposed, linkedin: linkedin.length, rejected, performance, delivery: results.map(item => `${item.channel}:${item.delivery}`) } };
  }

  // ---- The inbox ----------------------------------------------------------------------------------------------------------------------
  async function inbox(task, { now = () => new Date(), signal } = {}) {
    if (!meta.configured.pages && !meta.configured.instagram) return { result: { skipped: 'meta_not_configured' } };
    if (task.agent?.autonomy === 'observe') return { result: { skipped: 'observe_only' } };
    let items;
    try { items = await meta.recentInbox({ signal, now: now() }); }
    catch (error) {
      if (signal?.aborted || error?.transient) throw error;
      await tellAboutAccess(task, error?.code ?? 'meta_error', now());
      return { result: { skipped: error?.code ?? 'meta_error' } };
    }
    const fresh = { comment: 0, message: 0 };
    for (const item of items.slice(0, 40)) {
      signal?.throwIfAborted();
      const id = await store.enqueue(task.agentKey, 'social.interaction', `social:${item.platform}:${item.kind}:${item.id}`.slice(0, 200), {
        payload: { platform: item.platform, kind: item.kind, id: item.id, parentId: item.parentId, url: item.url ?? null }, priority: 4, sourceKind: 'agent', sourceRef: `${item.platform}:${item.kind}`,
      });
      if (id) fresh[item.kind] += 1;
    }
    const total = fresh.comment + fresh.message;
    if (total && notifier) {
      await notifier.send({
        severity: 'info', subject: `${total} new social ${total === 1 ? 'comment or message' : 'comments and messages'}`,
        body: `${plural(fresh.comment, 'comment')} and ${plural(fresh.message, 'private message')} arrived on Facebook or Instagram.\n\n${drafting ? 'Drafted replies wait for you in the AI team; anything that needs you personally is left for you.' : 'Answer them on your Facebook Page and Instagram. Turning on customer text to AI lets the team draft replies for you to approve.'}`,
        dedupeKey: `social:inbox:${task.id}`, agentKey: task.agentKey, taskId: task.id,
      });
    }
    return { result: { seen: items.length, enqueued: total, comments: fresh.comment, messages: fresh.message } };
  }

  async function tellAboutAccess(task, code, moment) {
    if (!notifier || !['meta_token_invalid', 'meta_permission'].includes(code)) return;
    await notifier.send({ severity: 'warning', subject: 'The Social Media Manager cannot reach Meta',
      body: `Meta refused the Social Media Manager's token (${code.replaceAll('_', ' ')}). Renew the system user token or its permissions and update HUB_META_ACCESS_TOKEN; until then no comment or message is read.`,
      dedupeKey: `social:access:${code}:${easternDate(moment)}`, agentKey: task.agentKey, taskId: task.id });
  }

  // ---- One comment or message --------------------------------------------------------------------------------------------------------
  async function interaction(task, { now = () => new Date(), signal } = {}) {
    const item = task.payload ?? {};
    if (!['facebook', 'instagram', 'messenger'].includes(item.platform) || !['comment', 'message'].includes(item.kind) || typeof item.id !== 'string' || !item.id || item.id.length > 150
      || (item.kind === 'message' && (typeof item.parentId !== 'string' || !item.parentId))) throw permanent('invalid_payload');
    const where = `${labels[item.platform]} ${item.kind === 'comment' ? 'comment' : 'message'}`;
    const target = `${item.platform}:${item.id}`;
    let read;
    try { read = await meta.readItem(item, { signal, now: now() }); }
    catch (error) { if (signal?.aborted || error?.transient) throw error; return { result: { outcome: 'skipped', reason: error?.code ?? 'meta_error' } }; }
    const skip = read.gone ? 'gone' : read.fromPage ? 'own' : read.answered ? 'answered' : item.kind === 'message' && !read.open ? 'window_closed' : !String(read.text ?? '').trim() ? 'no_text' : null;
    if (skip) return { result: { outcome: 'skipped', reason: skip, platform: item.platform, kind: item.kind } };

    const flagged = screenIdentifiers(read.text).flagged || (read.history ?? []).some(message => screenIdentifiers(message.text).flagged);
    const personal = async () => {
      if (notifier) await notifier.send({ severity: 'warning', subject: `A ${where} may contain personal information`,
        body: `A ${where} appears to contain personal or health information. Nothing has been posted in reply.${item.kind === 'comment' ? ' Hiding it is waiting for your approval in the AI team.' : ''}${item.url ? `\n\nReview it on Meta: ${item.url}` : ''}`,
        dedupeKey: `social:phi:${item.platform}:${item.id}`, agentKey: task.agentKey, taskId: task.id });
      if (item.kind !== 'comment') return { result: { outcome: 'left_for_owner', reason: 'personal_information', platform: item.platform, kind: item.kind } };
      const proposal = await propose(task, { kind: 'social.moderate', targetKind: 'social_item', targetId: target,
        preview: `Hide a ${where} that appears to contain personal or health information.${item.url ? `\n\nOpen it on Meta: ${item.url}` : ''}`,
        input: { operation: 'hide', platform: item.platform, kind: item.kind, id: item.id, url: item.url ?? null, reason: 'personal_information' } });
      return { status: proposal ? 'awaiting_approval' : 'done', result: { outcome: proposal ? 'proposed' : 'observe_only', reply: 'hide', reason: 'personal_information', platform: item.platform, kind: item.kind } };
    };
    if (flagged) return personal();
    if (!drafting) return { result: { outcome: 'left_for_owner', reason: 'customer_text_to_ai_off', platform: item.platform, kind: item.kind } };

    const text = redact(read.text, { limit: 2000 }).text;
    const history = (read.history ?? []).map(message => ({ direction: message.direction, text: redact(message.text, { limit: 600 }).text }));
    const result = await runModel(task, {
      promptVersion: replyPromptVersion, system: [{ text: replySystem, cache: true }], schema: replySchema, maxTokens: 2000, effort: effort(task),
      user: replyUserMessage({ platform: labels[item.platform], kind: item.kind, words: item.kind === 'message' ? 100 : 50, links: socialLinks(null), text, history }),
      describe: output => `Read a ${where}: ${output.intent}${output.needsOwner ? ', needs the owner' : ''}${output.hide ? ', hide' : ''}.`,
    }, signal);
    if (result.outcome !== 'completed') return { result: { outcome: 'left_for_owner', reason: result.code ?? result.outcome, platform: item.platform, kind: item.kind } };
    const reading = result.output;
    if (reading.possiblePhi) return personal();
    if (reading.hide && item.kind === 'comment') {
      const proposal = await propose(task, { kind: 'social.moderate', targetKind: 'social_item', targetId: target,
        preview: `Hide a ${where} that reads as spam or abuse.${item.url ? `\n\nOpen it on Meta: ${item.url}` : ''}`,
        input: { operation: 'hide', platform: item.platform, kind: item.kind, id: item.id, url: item.url ?? null, reason: 'spam' } });
      return { status: proposal ? 'awaiting_approval' : 'done', result: { outcome: proposal ? 'proposed' : 'observe_only', reply: 'hide', intent: reading.intent, platform: item.platform, kind: item.kind } };
    }
    if (reading.needsOwner || reading.hide || !reading.reply.trim()) return { result: { outcome: 'left_for_owner', reason: 'needs_owner', intent: reading.intent, platform: item.platform, kind: item.kind } };
    const product = socialProducts.includes(reading.product) ? reading.product : null;
    const checked = checkSocialText(reading.reply, { surface: item.kind === 'message' ? 'message' : 'comment', product, theirText: [text, ...history.map(message => message.text)].join('\n') });
    if (!checked.ok) return { result: { outcome: 'left_for_owner', reason: `draft_${checked.reason}`, intent: reading.intent, platform: item.platform, kind: item.kind } };
    const proposal = await propose(task, { kind: 'social.reply', targetKind: 'social_item', targetId: target,
      preview: `Reply to a ${where}${item.url ? ` (${item.url})` : ''}:\n\n${checked.text}`,
      input: { platform: item.platform, kind: item.kind, id: item.id, parentId: item.parentId ?? null, message: checked.text, url: item.url ?? null, intent: reading.intent, product } });
    return { status: proposal ? 'awaiting_approval' : 'done', result: { outcome: proposal ? 'proposed' : 'observe_only', reply: 'drafted', intent: reading.intent, platform: item.platform, kind: item.kind } };
  }

  // ---- The daily ad review ------------------------------------------------------------------------------------------------------------
  async function ads(task, { now = () => new Date(), signal } = {}) {
    if (!meta.configured.ads) return { result: { skipped: 'ads_not_configured' } };
    if (task.agent?.autonomy === 'observe') return { result: { skipped: 'observe_only' } };
    const moment = now();
    let overview;
    try { overview = await meta.adsOverview({ signal, now: moment }); }
    catch (error) { if (signal?.aborted || error?.transient) throw error; await tellAboutAccess(task, error?.code ?? 'meta_error', moment); return { result: { skipped: error?.code ?? 'meta_error' } }; }
    const { recommendations, adsets } = evaluateAds({ ...overview, now: moment, settings });
    const targets = await open();
    const today = easternDate(moment);
    const counts = { pause: 0, budget: 0, create: 0, skipped: 0, rejected: 0 };
    for (const rec of recommendations) {
      signal?.throwIfAborted();
      if (rec.kind === 'pause') {
        if (targets.has(`social.ad_pause:${rec.adId}`)) { counts.skipped += 1; continue; }
        if (await propose(task, { kind: 'social.ad_pause', targetKind: 'social_ad', targetId: rec.adId, preview: `Pause the ad "${rec.adName}" in "${rec.adsetName}": it ${rec.reason}.`, input: { adId: rec.adId, adsetId: rec.adsetId, reason: rec.reason } })) counts.pause += 1;
      } else if (rec.kind === 'budget') {
        if (targets.has(`social.ad_budget:${rec.adsetId}`)) { counts.skipped += 1; continue; }
        if (await propose(task, { kind: 'social.ad_budget', targetKind: 'social_adset', targetId: rec.adsetId,
          preview: `Raise the daily budget of "${rec.adsetName}" from ${money(rec.from)} to ${money(rec.to)}: ${rec.reason}. Your cap is ${money(settings.maxDailyBudgetCents)} a day. Only you can approve a budget change.`,
          input: { adsetId: rec.adsetId, from: rec.from, to: rec.to, reason: rec.reason } })) counts.budget += 1;
      } else if (rec.kind === 'refresh') {
        if (!model?.configured || [...targets].some(value => value.startsWith(`social.ad_create:${rec.adsetId}:`))) { counts.skipped += 1; continue; }
        counts.create += await refresh(task, rec, overview, today, signal, counts);
      }
    }
    const proposed = counts.pause + counts.budget + counts.create;
    if (proposed && notifier) {
      await notifier.send({ severity: 'info', subject: `Ad review: ${plural(proposed, 'change')} to approve`,
        body: `${plural(counts.pause, 'ad')} to pause, ${plural(counts.create, 'new ad')} to start and ${plural(counts.budget, 'budget change')}, from the last seven days' results (rules ${rulesVersion}). Open the AI team to review them.`,
        dedupeKey: task.sourceKind === 'owner' ? `social:ads:run:${task.id}` : `social:ads:${today}`, agentKey: task.agentKey, taskId: task.id });
    }
    await recordRun({ store, log }, task, { promptVersion: rulesVersion, summary: `Reviewed ${plural(adsets.length, 'ad set')}: ${plural(recommendations.length, 'recommendation')}, ${plural(proposed, 'change')} proposed.` });
    return { status: proposed ? 'awaiting_approval' : 'done', result: { adsets: adsets.length, recommendations: recommendations.length, ...counts } };
  }

  async function refresh(task, rec, overview, today, signal, counts) {
    const base = overview.ads.find(ad => ad.id === rec.basedOn);
    const product = productOf(base?.copy?.link);
    if (!base || !product) { counts.skipped += 1; return 0; }
    const allowed = socialLinks(product).map(link => link.url);
    const link = allowed.includes(base.copy.link) ? base.copy.link : playbookFor(product).nextStep.url;
    const adset = overview.adsets.find(item => item.id === rec.adsetId);
    const thisWeek = new Map(overview.current.map(row => [row.adId, row]));
    const peers = overview.ads.filter(ad => ad.adsetId === rec.adsetId && ad.id !== base.id).slice(0, 4);
    const user = JSON.stringify({
      product: productNames[product], adSet: adset?.name ?? '', objective: adset?.objective ?? null, why: rec.reason,
      best: { copy: base.copy, results: thisWeek.get(base.id) ?? null }, others: peers.map(ad => ({ copy: ad.copy, active: ad.active, results: thisWeek.get(ad.id) ?? null })),
    });
    const result = await runModel(task, { promptVersion: adPromptVersion, system: [{ text: adSystem, cache: true }], user, schema: adSchema, maxTokens: 3000, effort: effort(task),
      describe: output => `Wrote ${plural(output.variants.length, 'ad variant')} for an ad set.` }, signal);
    if (result.outcome !== 'completed') { counts.skipped += 1; return 0; }
    let made = 0;
    for (const [index, variant] of (result.output.variants ?? []).slice(0, 2).entries()) {
      const parts = [checkSocialText(variant.message, { surface: 'ad_message', product }), checkSocialText(variant.headline, { surface: 'ad_headline', product }), checkSocialText(variant.description, { surface: 'ad_description', product })];
      if (parts.some(part => !part.ok) || parts[0].text.length < 60) { counts.rejected += 1; continue; }
      const [message, headline, description] = parts.map(part => part.text);
      const callToAction = variant.callToAction === 'SIGN_UP' ? 'SIGN_UP' : 'LEARN_MORE';
      const name = `${adset?.name ?? 'Ad set'} · ${String(variant.angle ?? 'variant').slice(0, 30)} · ${today}`;
      const proposal = await propose(task, { kind: 'social.ad_create', targetKind: 'social_adset', targetId: `${rec.adsetId}:${today}:${index + 1}`,
        preview: `New ad for "${adset?.name ?? rec.adsetId}" (${rec.reason}). It runs inside the ad set's existing budget.\n\nPrimary text: ${message}\nHeadline: ${headline}\nDescription: ${description}\nButton: ${callToAction === 'SIGN_UP' ? 'Sign up' : 'Learn more'}\nLink: ${link}\nImage: the same as "${base.name}"`,
        input: { adsetId: rec.adsetId, name, message, headline, description, link, imageHash: base.imageHash ?? null, callToAction, product, basedOn: base.id } });
      if (proposal) made += 1;
    }
    return made;
  }

  // ---- The weekly report --------------------------------------------------------------------------------------------------------------
  async function report(task, { now = () => new Date(), signal } = {}) {
    if (!meta.configured.pages && !meta.configured.instagram && !meta.configured.ads) return { result: { skipped: 'meta_not_configured' } };
    const moment = now();
    const week = weekStart(dueMoment(task) ?? moment);
    const asked = task.sourceKind === 'owner';
    const notes = [];
    let posts = [];
    try { if (meta.configured.pages || meta.configured.instagram) posts = rankPosts(await meta.recentPosts({ signal }), { now: moment, days: 7 }); }
    catch (error) { if (signal?.aborted || error?.transient) throw error; notes.push(`Posts could not be read (${String(error?.code ?? 'meta_error').replaceAll('_', ' ')}).`); }
    let adsets = [];
    try { if (meta.configured.ads) adsets = evaluateAds({ ...(await meta.adsOverview({ signal, now: moment })), now: moment, settings }).adsets.filter(item => item.impressions > 0 || item.active); }
    catch (error) { if (signal?.aborted || error?.transient) throw error; notes.push(`Ads could not be read (${String(error?.code ?? 'meta_error').replaceAll('_', ' ')}).`); }
    const waiting = (await open()).size;
    const byPlatform = ['facebook', 'instagram'].map(platform => { const mine = posts.filter(post => post.platform === platform); return [platform, mine.length, mine.reduce((sum, post) => sum + post.engagement, 0)]; });
    const spend = adsets.reduce((sum, item) => sum + item.spendCents, 0);
    const results = adsets.reduce((sum, item) => sum + item.results, 0);
    const body = `${plural(posts.length, 'post')} in the last 7 days with ${posts.reduce((sum, post) => sum + post.engagement, 0)} engagement points; ads spent ${money(spend)} for ${plural(results, 'result')}. ${plural(waiting, 'change')} waiting for you.`;
    const blocks = [
      { type: 'callout', tone: waiting ? 'warning' : 'info', title: 'Social media this week.', text: body },
      { type: 'paragraph', text: 'Posts' },
      { type: 'details', rows: byPlatform.map(([platform, count, points]) => [labels[platform], `${plural(count, 'post')}, ${points} engagement points`]) },
      ...(posts.length ? [{ type: 'paragraph', text: 'What earned the most engagement' }, { type: 'details', rows: posts.slice(0, 3).map(post => [`${labels[post.platform]}: ${firstLine(post.text)}`, `${post.engagement} (${post.reactions} reactions, ${post.comments} comments, ${post.shares} shares)`]) }] : []),
      ...(adsets.length ? [{ type: 'paragraph', text: 'Ads, last 7 days' }, { type: 'details', rows: adsets.map(item => [item.name.slice(0, 80), `${money(item.spendCents)} spent, ${item.impressions} impressions, ${(item.ctr * 100).toFixed(1)}% click rate, ${plural(item.results, 'result')}${item.costPerResult !== null ? ` at ${money(item.costPerResult)} each` : ''}, ${plural(item.activeAds, 'active ad')}`]) }] : []),
      { type: 'paragraph', text: 'Engagement points count reactions, comments twice and shares three times. Results are leads and sign-ups as Meta reports them.' },
      ...notes.map(text => ({ type: 'paragraph', text })),
      ...(/^https:\/\//i.test(publicOrigin ?? '') && waiting ? [{ type: 'button', label: 'Open the AI team', url: `${publicOrigin.replace(/\/+$/, '')}/admin/team` }] : []),
    ];
    const sent = await notifier.send({ severity: 'info', subject: `Social media weekly: ${plural(posts.length, 'post')}, ${money(spend)} ad spend`, body, blocks,
      dedupeKey: asked ? `social:report:run:${task.id}` : `social:report:${week}`, agentKey: task.agentKey, taskId: task.id });
    if (!asked && sent.every(item => item.delivery === 'duplicate')) return { result: { skipped: sent.some(delivered) ? 'already_sent' : 'earlier_attempt_unconfirmed', week } };
    await recordRun({ store, log }, task, { promptVersion: 'social-report.1', summary: `Sent the weekly social report: ${body}` });
    return { result: { week, posts: posts.length, spendCents: spend, results, waiting } };
  }

  return { 'social.plan': plan, 'social.inbox': inbox, 'social.interaction': interaction, 'social.ads': ads, 'social.report': report };
}

/**
 * When a post in the plan should publish: its day of the week at the platform's slot (10:30 Eastern on Facebook, 12:15 on Instagram),
 * moved forward a day at a time until it is at least an hour away, and never more than seven days ahead.
 */
export function slotFor({ week, day: dayOfWeek, platform, index = 1, now = new Date() }) {
  const [hour, minute] = slots[platform] ?? [11, 0];
  const offset = Math.min(Math.max(Number.isInteger(dayOfWeek) ? dayOfWeek : index * 2, 1), 7) - 1;
  const date = new Date(`${week}T12:00:00Z`);
  for (let step = 0; step < 14; step += 1) {
    const candidate = new Date(date.getTime() + (offset + step) * day);
    const at = new Date(easternMidnight(candidate.toISOString().slice(0, 10)).getTime() + (hour * 60 + minute) * 60_000);
    if (at.getTime() - now.getTime() >= 3_600_000) return at.getTime() - now.getTime() <= 7 * day ? at.toISOString() : new Date(now.getTime() + 7 * day - 3_600_000).toISOString();
  }
  return new Date(now.getTime() + 2 * 3_600_000).toISOString();
}
