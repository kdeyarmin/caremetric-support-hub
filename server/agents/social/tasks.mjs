/**
 * The Social Media Manager's work. Every task reads Meta and LinkedIn live and proposes actions the owner approves (or, once a kind of
 * work is handed over after its supervised week, that the agent is trusted with); nothing here posts, replies or changes an ad by itself.
 *
 * - `social.plan` (each morning, once a week): drafts the week's posts for Facebook, Instagram and LinkedIn from the fact sheet, the
 *   sales playbook and what earned engagement in the last four weeks; checks every word; proposes each post held for its time slot; and
 *   emails the owner the plan. Without a LinkedIn connection the LinkedIn posts are in that email, ready to paste.
 * - `social.inbox` (every 15 minutes): finds new comments and messages from other people and gives each its own task.
 * - `social.interaction`: reads one comment or message again, and with the owner's switch for customer text to AI on, drafts a
 *   checked reply (or proposes hiding spam); a public comment that appears to carry personal or health information is proposed for
 *   hiding and the owner is warned. Without the switch the owner is told and answers on the platform. LinkedIn has no "hide", so there
 *   the proposal is to delete, and because a deletion cannot be undone it is proposed only while the owner approves each one: once
 *   replies are handed over, a LinkedIn comment that should go is left for the owner.
 * - `social.ads` (each morning): evaluates every Meta ad and LinkedIn creative with rules.mjs and proposes pausing losers, new copy
 *   where an ad set or campaign needs it, and (only with a cap set) a measured budget increase that only the owner can approve.
 * - `social.report` (each morning, once a week): how posts and ads did, and what is waiting for the owner.
 *
 * Nothing another person wrote is kept: not in a task, a run, an action or an owner email. Posts and replies are CareMetric's words.
 */
import { weekStart, easternDate, easternMidnight } from '../accounts/week.mjs';
import { delivered } from '../notify.mjs';
import { redact } from '../concierge/redact.mjs';
import { screenIdentifiers } from '../concierge/screen.mjs';
import { dueMoment, heldForScorecard, heldResult, permanent, plural, recordRun, when } from '../tasks/shared.mjs';
import { playbookFor } from '../../growth/playbook.mjs';
import {
  adPromptVersion, adSchema, adSystem, checkSocialText, planPromptVersion, planSchema, planSystem, replyPromptVersion, replySchema, replySystem,
  replyUserMessage, socialLinks, socialProducts, tagSocialLink, tagSocialText, withHashtags,
} from './content.mjs';
import { evaluateAds, rankPosts, rulesVersion } from './rules.mjs';
import { marketedNow, markets } from '../marketing.mjs';
import { untaggedUrl } from '../links.mjs';
import { live } from '../../live.mjs';

const day = 86_400_000;
const labels = { facebook: 'Facebook', instagram: 'Instagram', messenger: 'Messenger', linkedin: 'LinkedIn' };
const productNames = { carebase: 'CareBase', 'caremetric-intel': 'CareMetric Intel' };
const weekly = { facebook: 3, instagram: 2, linkedin: 3 };
const slots = { facebook: [10, 30], instagram: [12, 15], linkedin: [8, 45] };
const modelAttempts = 3;
const money = cents => `$${(cents / 100).toFixed(2)}`;
const firstLine = text => String(text ?? '').split('\n')[0].slice(0, 90);
const productOf = url => { try { const host = new URL(url).hostname.replace(/^www\./, ''); return host === 'cmcarebase.com' ? 'carebase' : host === 'caremetricintel.com' ? 'caremetric-intel' : null; } catch { return null; } };

export function socialHandlers({ store, notifier, model = null, meta, linkedin = null, settings = {}, imageUrls: imageUrlsOption = [], customerTextToAi = false, publicOrigin = null, marketed = null, log = line => console.warn(line), creative = null }) {
  // The approved brand images (Settings → Social media) may be a function, read each time they are used.
  const images = () => live(imageUrlsOption) ?? [];
  // Only the products the team markets (marketing.mjs, read when each task starts) get posts, reply links, new ads and budget increases.
  const offeredNow = async () => { const list = await marketedNow(marketed); return socialProducts.filter(product => markets(list, product)); };
  // LinkedIn is optional: without its token and Page id, LinkedIn posts are emailed to the owner to paste, as before.
  const li = linkedin ?? { configured: { page: false, ads: false } };
  const clientFor = platform => (platform === 'linkedin' ? li : meta);
  // Read on each run: the Page and Instagram ids are Hub settings, so a page connected in Settings is used from the next run.
  const metaPosts = () => meta.configured.pages || meta.configured.instagram;
  // The owner's switch (Settings → AI team), read each time it matters, so turning it off applies at once.
  const draftingOn = () => live(customerTextToAi) === true && model?.configured === true;
  const open = async () => new Set(await store.socialOpenTargets());
  const effort = task => (['low', 'medium', 'high'].includes(task.agent?.config?.effort) ? task.agent.config.effort : 'medium');
  // Approved Creative Director images, served from the Hub under each asset's public token (only while it is approved or live), so Meta and
  // LinkedIn can fetch them. Without the Creative Director, or without an https public origin, nothing changes.
  const assetOrigin = /^https:\/\//i.test(publicOrigin ?? '') ? publicOrigin.replace(/\/+$/, '') : null;
  const imagePlacements = { meta: ['meta.feed_square', 'meta.feed_portrait'], linkedin: ['linkedin.single_image', 'linkedin.square'] };
  async function approvedImages(product, platform) {
    if (!creative?.approved || !assetOrigin) return [];
    try {
      return (await creative.approved({ product, platform, limit: 10 })).filter(asset => asset.kind === 'static' && imagePlacements[platform].includes(asset.placement) && /^[0-9a-f]{64}$/.test(asset.token ?? ''))
        .map(asset => ({ ...asset, url: `${assetOrigin}/api/creative/a/${asset.token}.png` }));
    } catch (error) {
      if (error?.transient) throw error;
      log(JSON.stringify({ event: 'hub_social_creative_unread', code: /^[a-z][a-z_]{0,59}$/.test(error?.code ?? '') ? error.code : 'creative_error' }));
      return [];
    }
  }

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
    const offered = await offeredNow();
    if (!offered.length) return { result: { skipped: 'no_marketed_product' } };
    const moment = now();
    const week = weekStart(dueMoment(task) ?? moment);
    const asked = task.sourceKind === 'owner';
    const key = `social:plan:${week}`;
    if (!asked && await store.notificationCount({ prefix: key, channel: 'email', since: new Date(0) }) > 0) return { result: { skipped: 'already_planned', week } };
    // Approved creative, per product and platform, used once each in this plan before the approved brand images.
    const creativeImages = {};
    for (const product of offered) for (const platform of ['meta', 'linkedin']) creativeImages[`${product}:${platform}`] = await approvedImages(product, platform);
    const anyMetaCreative = offered.some(product => creativeImages[`${product}:meta`].length);
    const counts = { facebook: meta.configured.pages ? weekly.facebook : 0, instagram: meta.configured.instagram && (images().length || anyMetaCreative) ? weekly.instagram : 0, linkedin: weekly.linkedin };
    let posts = [];
    let performance = metaPosts() || li.configured.page ? 'read' : 'not_connected';
    for (const [on, client] of [[metaPosts(), meta], [li.configured.page, li]]) {
      if (!on) continue;
      try { posts = posts.concat(await client.recentPosts({ signal })); }
      catch (error) { if (signal?.aborted || error?.transient) throw error; performance = error?.code ?? 'social_error'; }
    }
    const ranked = rankPosts(posts, { now: moment });
    const links = Object.fromEntries(offered.map(product => [product, socialLinks(product).map(({ id, label }) => ({ id, label }))]));
    const user = JSON.stringify({
      weekStarting: week, products: offered, postsToWrite: counts, links,
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
      if (socialProducts.includes(draft.product) && !offered.includes(draft.product)) { rejected.not_marketed = (rejected.not_marketed ?? 0) + 1; continue; }
      if (!offered.includes(draft.product) || used[draft.platform] === undefined || used[draft.platform] >= counts[draft.platform]) continue;
      const page = draft.linkId ? socialLinks(draft.product).find(link => link.id === draft.linkId) : null;
      if (draft.linkId && !page) { rejected.link = (rejected.link ?? 0) + 1; continue; }
      // The page's address with campaign tags for this platform (links.mjs): social-<product>, utm_content post.
      const link = draft.platform === 'instagram' ? null : tagSocialLink(page?.url ?? null, { platform: draft.platform, product: draft.product, content: 'post' });
      // A Facebook or connected LinkedIn link travels beside the text (it renders as a card); LinkedIn copy pasted by hand carries it.
      const pasted = draft.platform === 'linkedin' && !li.configured.page;
      // A product link the model wrote into the text gets the same tags as the one beside it.
      const text = tagSocialText(withHashtags(pasted && link ? `${draft.text.trim()}\n\n${link}` : draft.text, draft.hashtags), { platform: draft.platform, product: draft.product, content: 'post' });
      const checked = checkSocialText(text, { surface: draft.platform, product: draft.product });
      if (!checked.ok) { rejected[checked.reason] = (rejected[checked.reason] ?? 0) + 1; continue; }
      used[draft.platform] += 1;
      if (pasted) { linkedin.push({ product: draft.product, pillar: draft.pillar, text: checked.text }); continue; }
      const scheduledFor = slotFor({ week, day: draft.day, platform: draft.platform, index: used[draft.platform], now: moment });
      const targetId = `${draft.platform}:${week}:${used[draft.platform]}`;
      if (targets.has(`social.post:${targetId}`)) continue;
      // Instagram needs an image; a LinkedIn post shows one beside its link (LinkedIn builds no preview for an API post). Approved creative
      // comes first; then the approved brand images (Settings → Social media).
      const pictured = ['instagram', 'linkedin'].includes(draft.platform);
      const approvedAsset = pictured ? creativeImages[`${draft.product}:${draft.platform === 'instagram' ? 'meta' : 'linkedin'}`]?.[0] ?? null : null;
      const brandImages = images();
      if (draft.platform === 'instagram' && !approvedAsset && !brandImages.length) continue;
      const imageUrl = approvedAsset?.url ?? (pictured && brandImages.length ? brandImages[(Number(week.replaceAll('-', '')) + used[draft.platform]) % brandImages.length] : null);
      const proposal = await propose(task, {
        kind: 'social.post', targetKind: 'social_post', targetId,
        preview: `${labels[draft.platform]} post about ${productNames[draft.product]} (${draft.pillar}), to publish ${when(scheduledFor)}:\n\n${checked.text}${link ? `\n\nLink: ${link}` : ''}${imageUrl ? `\n\nImage: ${approvedAsset ? `approved creative ${approvedAsset.id} (${imageUrl})` : imageUrl}` : ''}`,
        input: { platform: draft.platform, product: draft.product, pillar: draft.pillar, message: checked.text, link, imageUrl, scheduledFor,
          ...(draft.platform === 'linkedin' && link ? { linkLabel: page.label } : {}), ...(approvedAsset ? { creativeAssetId: approvedAsset.id } : {}) },
      });
      if (!proposal) break;
      if (approvedAsset) creativeImages[`${draft.product}:${draft.platform === 'instagram' ? 'meta' : 'linkedin'}`].shift();
      if (proposal.created !== false) { await store.socialSchedule(proposal.id, null); proposed += 1; }
    }

    const body = `${plural(proposed, 'post')} proposed${linkedin.length ? `, ${plural(linkedin.length, 'LinkedIn post')} to paste` : ''}.${Object.keys(rejected).length ? ` ${Object.values(rejected).reduce((a, b) => a + b, 0)} drafts failed the checks and were dropped.` : ''}`;
    const blocks = [
      { type: 'callout', tone: 'info', title: `Social plan for the week of ${week}.`, text: body },
      { type: 'paragraph', text: proposed ? 'Approve each post in the AI team. An approved post waits for its time slot.' : 'No post is waiting: the accounts are not connected, or no draft passed the checks.' },
      ...(performance === 'read' ? [] : [{ type: 'paragraph', text: performance === 'not_connected' ? 'No social account is connected, so this plan could not learn from past posts.' : `Some past posts could not be read (${performance.replaceAll('_', ' ')}).` }]),
      ...linkedin.flatMap((post, index) => [{ type: 'paragraph', text: `LinkedIn post ${index + 1} (${productNames[post.product]}, ${post.pillar})` }, { type: 'message', text: post.text }]),
      ...(/^https:\/\//i.test(publicOrigin ?? '') && proposed ? [{ type: 'button', label: 'Open the AI team', url: `${publicOrigin.replace(/\/+$/, '')}/admin/team` }] : []),
    ];
    const results = await notifier.send({ severity: 'info', subject: `Social plan: ${plural(proposed, 'post')} to approve`, body, blocks, dedupeKey: asked ? `social:plan:run:${task.id}` : key, agentKey: task.agentKey, taskId: task.id });
    // The Creative Director turns the week's plan into ad creative (when it is switched on); a failure here never fails the plan.
    if (creative?.planned) {
      try { await creative.planned(week); } catch { log(JSON.stringify({ event: 'hub_social_creative_plan_unqueued', week })); }
    }
    return { status: proposed ? 'awaiting_approval' : 'done', result: { week, proposed, linkedin: linkedin.length, rejected, performance, delivery: results.map(item => `${item.channel}:${item.delivery}`) } };
  }

  // ---- The inbox ----------------------------------------------------------------------------------------------------------------------
  async function inbox(task, { now = () => new Date(), signal } = {}) {
    if (!metaPosts() && !li.configured.page) return { result: { skipped: 'meta_not_configured' } };
    if (task.agent?.autonomy === 'observe') return { result: { skipped: 'observe_only' } };
    let items = [];
    const refused = [];
    let reached = 0;
    for (const [on, client] of [[metaPosts(), meta], [li.configured.page, li]]) {
      if (!on) continue;
      try { items = items.concat(await client.recentInbox({ signal, now: now() })); reached += 1; }
      catch (error) {
        if (signal?.aborted || error?.transient) throw error;
        refused.push(error?.code ?? 'social_error');
        await tellAboutAccess(task, error?.code ?? 'social_error', now());
      }
    }
    if (!reached) return { result: { skipped: refused[0] } };
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
        body: `${plural(fresh.comment, 'comment')} and ${plural(fresh.message, 'private message')} arrived on Facebook, Instagram or LinkedIn.\n\n${draftingOn() ? 'Drafted replies wait for you in the AI team; anything that needs you personally is left for you.' : 'Answer them on the platforms. Turning on customer text to AI lets the team draft replies for you to approve.'}`,
        dedupeKey: `social:inbox:${task.id}`, agentKey: task.agentKey, taskId: task.id,
      });
    }
    return { result: { seen: items.length, enqueued: total, comments: fresh.comment, messages: fresh.message, ...(refused.length ? { refused } : {}) } };
  }

  async function tellAboutAccess(task, code, moment) {
    if (!notifier || !['meta_token_invalid', 'meta_permission', 'linkedin_token_invalid', 'linkedin_permission'].includes(code)) return;
    const onLinkedIn = code.startsWith('linkedin_');
    await notifier.send({ severity: 'warning', subject: `The Social Media Manager cannot reach ${onLinkedIn ? 'LinkedIn' : 'Meta'}`,
      body: onLinkedIn
        ? `LinkedIn refused the Social Media Manager's token (${code.replaceAll('_', ' ')}). Renew the access token (or its refresh token) or its permissions and update HUB_LINKEDIN_ACCESS_TOKEN; until then LinkedIn is not read.`
        : `Meta refused the Social Media Manager's token (${code.replaceAll('_', ' ')}). Renew the system user token or its permissions and update HUB_META_ACCESS_TOKEN; until then no comment or message is read.`,
      dedupeKey: `social:access:${code}:${easternDate(moment)}`, agentKey: task.agentKey, taskId: task.id });
  }

  // ---- One comment or message --------------------------------------------------------------------------------------------------------
  async function interaction(task, { now = () => new Date(), signal } = {}) {
    const item = task.payload ?? {};
    if (!['facebook', 'instagram', 'messenger', 'linkedin'].includes(item.platform) || !['comment', 'message'].includes(item.kind) || typeof item.id !== 'string' || !item.id || item.id.length > 150
      || (item.platform === 'linkedin' && (item.kind !== 'comment' || typeof item.parentId !== 'string'))
      || (item.kind === 'message' && (typeof item.parentId !== 'string' || !item.parentId))) throw permanent('invalid_payload');
    // LinkedIn has no "hide": its moderation deletes the comment, which the owner approves like any other action.
    const removal = item.platform === 'linkedin' ? { operation: 'delete', verb: 'Delete', pending: 'Deleting' } : { operation: 'hide', verb: 'Hide', pending: 'Hiding' };
    // A deletion is never automatic: with replies handed over (social.moderate approved on the spot), it is not proposed at all.
    const handedOver = task.agent?.autonomy === 'act' && Array.isArray(task.agent?.config?.auto_approve_kinds) && task.agent.config.auto_approve_kinds.includes('social.moderate');
    const canRemove = item.kind === 'comment' && !(removal.operation === 'delete' && handedOver);
    const where = `${labels[item.platform]} ${item.kind === 'comment' ? 'comment' : 'message'}`;
    const target = `${item.platform}:${item.id}`;
    let read;
    try { read = await clientFor(item.platform).readItem(item, { signal, now: now() }); }
    catch (error) { if (signal?.aborted || error?.transient) throw error; return { result: { outcome: 'skipped', reason: error?.code ?? 'social_error' } }; }
    const skip = read.gone ? 'gone' : read.fromPage ? 'own' : read.answered ? 'answered' : item.kind === 'message' && !read.open ? 'window_closed' : !String(read.text ?? '').trim() ? 'no_text' : null;
    if (skip) return { result: { outcome: 'skipped', reason: skip, platform: item.platform, kind: item.kind } };

    const flagged = screenIdentifiers(read.text).flagged || (read.history ?? []).some(message => screenIdentifiers(message.text).flagged);
    const personal = async () => {
      if (notifier) await notifier.send({ severity: 'warning', subject: `A ${where} may contain personal information`,
        body: `A ${where} appears to contain personal or health information. Nothing has been posted in reply.${canRemove ? ` ${removal.pending} it is waiting for your approval in the AI team.` : item.kind === 'comment' ? ' Please delete it yourself if it should not stay public.' : ''}${item.url ? `\n\nReview it: ${item.url}` : ''}`,
        dedupeKey: `social:phi:${item.platform}:${item.id}`, agentKey: task.agentKey, taskId: task.id });
      if (!canRemove) return { result: { outcome: 'left_for_owner', reason: 'personal_information', platform: item.platform, kind: item.kind } };
      const proposal = await propose(task, { kind: 'social.moderate', targetKind: 'social_item', targetId: target,
        preview: `${removal.verb} a ${where} that appears to contain personal or health information.${item.url ? `\n\nOpen it: ${item.url}` : ''}`,
        input: { operation: removal.operation, platform: item.platform, kind: item.kind, id: item.id, parentId: item.parentId ?? null, url: item.url ?? null, reason: 'personal_information' } });
      return { status: proposal ? 'awaiting_approval' : 'done', result: { outcome: proposal ? 'proposed' : 'observe_only', reply: removal.operation, reason: 'personal_information', platform: item.platform, kind: item.kind } };
    };
    if (flagged) return personal();
    if (!draftingOn()) return { result: { outcome: 'left_for_owner', reason: 'customer_text_to_ai_off', platform: item.platform, kind: item.kind } };

    const offered = await offeredNow();
    const text = redact(read.text, { limit: 2000 }).text;
    const history = (read.history ?? []).map(message => ({ direction: message.direction, text: redact(message.text, { limit: 600 }).text }));
    const result = await runModel(task, {
      promptVersion: replyPromptVersion, system: [{ text: replySystem, cache: true }], schema: replySchema, maxTokens: 2000, effort: effort(task),
      user: replyUserMessage({ platform: labels[item.platform], kind: item.kind, words: item.kind === 'message' ? 100 : 50, links: offered.flatMap(product => socialLinks(product)), text, history }),
      describe: output => `Read a ${where}: ${output.intent}${output.needsOwner ? ', needs the owner' : ''}${output.hide ? ', hide' : ''}.`,
    }, signal);
    if (result.outcome !== 'completed') return { result: { outcome: 'left_for_owner', reason: result.code ?? result.outcome, platform: item.platform, kind: item.kind } };
    const reading = result.output;
    if (reading.possiblePhi) return personal();
    if (reading.hide && item.kind === 'comment' && !canRemove) return { result: { outcome: 'left_for_owner', reason: 'spam', intent: reading.intent, platform: item.platform, kind: item.kind } };
    if (reading.hide && item.kind === 'comment') {
      const proposal = await propose(task, { kind: 'social.moderate', targetKind: 'social_item', targetId: target,
        preview: `${removal.verb} a ${where} that reads as spam or abuse.${item.url ? `\n\nOpen it: ${item.url}` : ''}`,
        input: { operation: removal.operation, platform: item.platform, kind: item.kind, id: item.id, parentId: item.parentId ?? null, url: item.url ?? null, reason: 'spam' } });
      return { status: proposal ? 'awaiting_approval' : 'done', result: { outcome: proposal ? 'proposed' : 'observe_only', reply: removal.operation, intent: reading.intent, platform: item.platform, kind: item.kind } };
    }
    if (reading.needsOwner || reading.hide || !reading.reply.trim()) return { result: { outcome: 'left_for_owner', reason: 'needs_owner', intent: reading.intent, platform: item.platform, kind: item.kind } };
    // A question about a product the team is not marketing yet (CareBase in its pilot) is the owner's to answer.
    if (socialProducts.includes(reading.product) && !offered.includes(reading.product)) return { result: { outcome: 'left_for_owner', reason: 'product_not_marketed', intent: reading.intent, platform: item.platform, kind: item.kind } };
    const product = socialProducts.includes(reading.product) ? reading.product : null;
    const checked = checkSocialText(tagSocialText(reading.reply, { platform: item.platform, product, content: 'reply' }), { surface: item.kind === 'message' ? 'message' : 'comment', product, theirText: [text, ...history.map(message => message.text)].join('\n') });
    if (!checked.ok) return { result: { outcome: 'left_for_owner', reason: `draft_${checked.reason}`, intent: reading.intent, platform: item.platform, kind: item.kind } };
    const proposal = await propose(task, { kind: 'social.reply', targetKind: 'social_item', targetId: target,
      preview: `Reply to a ${where}${item.url ? ` (${item.url})` : ''}:\n\n${checked.text}`,
      input: { platform: item.platform, kind: item.kind, id: item.id, parentId: item.parentId ?? null, message: checked.text, url: item.url ?? null, intent: reading.intent, product } });
    return { status: proposal ? 'awaiting_approval' : 'done', result: { outcome: proposal ? 'proposed' : 'observe_only', reply: 'drafted', intent: reading.intent, platform: item.platform, kind: item.kind } };
  }

  // ---- The daily ad review ------------------------------------------------------------------------------------------------------------
  // Meta's ads keep their ids as targets; LinkedIn's carry a "linkedin:" prefix, so the two never collide.
  const adSources = () => [
    { platform: 'meta', name: 'Meta', client: meta, on: meta.configured.ads, key: id => id },
    { platform: 'linkedin', name: 'LinkedIn', client: li, on: li.configured.ads, key: id => `linkedin:${id}` },
  ].filter(source => source.on);

  async function ads(task, { now = () => new Date(), signal } = {}) {
    const sources = adSources();
    if (!sources.length) return { result: { skipped: 'ads_not_configured' } };
    if (task.agent?.autonomy === 'observe') return { result: { skipped: 'observe_only' } };
    const moment = now();
    const marketedList = await marketedNow(marketed);
    const targets = await open();
    const today = easternDate(moment);
    const counts = { pause: 0, budget: 0, create: 0, skipped: 0, rejected: 0 };
    let adsetCount = 0;
    let recommendationCount = 0;
    const refused = [];
    for (const source of sources) {
      let overview;
      try { overview = await source.client.adsOverview({ signal, now: moment }); }
      catch (error) {
        if (signal?.aborted || error?.transient) throw error;
        refused.push(error?.code ?? 'social_error');
        await tellAboutAccess(task, error?.code ?? 'social_error', moment);
        continue;
      }
      const { recommendations, adsets } = evaluateAds({ ...overview, now: moment, settings });
      adsetCount += adsets.length;
      recommendationCount += recommendations.length;
      const platform = source.platform === 'linkedin' ? { platform: 'linkedin' } : {};
      const where = source.platform === 'linkedin' ? 'LinkedIn campaign' : 'ad set';
      for (const rec of recommendations) {
        signal?.throwIfAborted();
        if (rec.kind === 'pause') {
          if (targets.has(`social.ad_pause:${source.key(rec.adId)}`)) { counts.skipped += 1; continue; }
          if (await propose(task, { kind: 'social.ad_pause', targetKind: 'social_ad', targetId: source.key(rec.adId),
            preview: `Pause the ${source.name} ad "${rec.adName}" in the ${where} "${rec.adsetName}": it ${rec.reason}.`, input: { adId: rec.adId, adsetId: rec.adsetId, reason: rec.reason, ...platform } })) counts.pause += 1;
        } else if (rec.kind === 'budget') {
          if (targets.has(`social.ad_budget:${source.key(rec.adsetId)}`)) { counts.skipped += 1; continue; }
          // No more money for an ad set that sends people to a product the team is not marketing.
          if (overview.ads.some(ad => ad.adsetId === rec.adsetId && productOf(ad.copy?.link) && !markets(marketedList, productOf(ad.copy?.link)))) { counts.skipped += 1; continue; }
          if (await propose(task, { kind: 'social.ad_budget', targetKind: 'social_adset', targetId: source.key(rec.adsetId),
            preview: `Raise the daily budget of the ${source.name} ${where} "${rec.adsetName}" from ${money(rec.from)} to ${money(rec.to)}: ${rec.reason}. Your cap is ${money(settings.maxDailyBudgetCents)} a day. Only you can approve a budget change.`,
            input: { adsetId: rec.adsetId, from: rec.from, to: rec.to, reason: rec.reason, ...platform } })) counts.budget += 1;
        } else if (rec.kind === 'refresh') {
          if (!model?.configured || [...targets].some(value => value.startsWith(`social.ad_create:${source.key(rec.adsetId)}:`))) { counts.skipped += 1; continue; }
          counts.create += await refresh(task, rec, overview, today, signal, counts, source, marketedList);
        }
      }
    }
    if (!adsetCount && refused.length === sources.length) return { result: { skipped: refused[0] } };
    const proposed = counts.pause + counts.budget + counts.create;
    if (proposed && notifier) {
      await notifier.send({ severity: 'info', subject: `Ad review: ${plural(proposed, 'change')} to approve`,
        body: `${plural(counts.pause, 'ad')} to pause, ${plural(counts.create, 'new ad')} to start and ${plural(counts.budget, 'budget change')}, from the last seven days' results (rules ${rulesVersion}). Open the AI team to review them.`,
        dedupeKey: task.sourceKind === 'owner' ? `social:ads:run:${task.id}` : `social:ads:${today}`, agentKey: task.agentKey, taskId: task.id });
    }
    await recordRun({ store, log }, task, { promptVersion: rulesVersion, summary: `Reviewed ${plural(adsetCount, 'ad set')}: ${plural(recommendationCount, 'recommendation')}, ${plural(proposed, 'change')} proposed.` });
    return { status: proposed ? 'awaiting_approval' : 'done', result: { adsets: adsetCount, recommendations: recommendationCount, ...counts, ...(refused.length ? { refused } : {}) } };
  }

  async function refresh(task, rec, overview, today, signal, counts, source, marketedList) {
    const base = overview.ads.find(ad => ad.id === rec.basedOn);
    const product = productOf(base?.copy?.link);
    if (!base || !product || !markets(marketedList, product)) { counts.skipped += 1; return 0; }
    // Approved Creative Director creative for this product and platform is used before writing new copy: its words already passed the
    // creative checks, its image is the one the owner approved, and its link carries the asset's id for the weekly report.
    const fromCreative = await creativeAd(task, rec, overview, today, source, product);
    if (fromCreative !== null) return fromCreative;
    const allowed = socialLinks(product).map(link => link.url);
    // The base ad's page (read through any campaign tags it already carries), else the product's next step, tagged as a paid ad.
    const page = [base.copy.link, untaggedUrl(base.copy.link)].find(url => allowed.includes(url)) ?? playbookFor(product).nextStep.url;
    const link = tagSocialLink(page, { platform: source.platform === 'linkedin' ? 'linkedin' : 'facebook', product, content: 'ad', paid: true });
    const adset = overview.adsets.find(item => item.id === rec.adsetId);
    const thisWeek = new Map(overview.current.map(row => [row.adId, row]));
    const peers = overview.ads.filter(ad => ad.adsetId === rec.adsetId && ad.id !== base.id).slice(0, 4);
    const user = JSON.stringify({
      platform: source.name, product: productNames[product], adSet: adset?.name ?? '', objective: adset?.objective ?? null, why: rec.reason,
      best: { copy: base.copy, results: thisWeek.get(base.id) ?? null }, others: peers.map(ad => ({ copy: ad.copy, active: ad.active, results: thisWeek.get(ad.id) ?? null })),
    });
    const result = await runModel(task, { promptVersion: adPromptVersion, system: [{ text: adSystem, cache: true }], user, schema: adSchema, maxTokens: 3000, effort: effort(task),
      describe: output => `Wrote ${plural(output.variants.length, 'ad variant')} for a ${source.name} ad set.` }, signal);
    if (result.outcome !== 'completed') { counts.skipped += 1; return 0; }
    let made = 0;
    for (const [index, variant] of (result.output.variants ?? []).slice(0, 2).entries()) {
      const parts = [checkSocialText(variant.message, { surface: 'ad_message', product }), checkSocialText(variant.headline, { surface: 'ad_headline', product }), checkSocialText(variant.description, { surface: 'ad_description', product })];
      if (parts.some(part => !part.ok) || parts[0].text.length < 60) { counts.rejected += 1; continue; }
      const [message, headline, description] = parts.map(part => part.text);
      const callToAction = variant.callToAction === 'SIGN_UP' ? 'SIGN_UP' : 'LEARN_MORE';
      const name = `${adset?.name ?? 'Ad set'} · ${String(variant.angle ?? 'variant').slice(0, 30)} · ${today}`;
      const linkedinAd = source.platform === 'linkedin';
      const brandImage = linkedinAd && !base.imageHash && images().length ? images()[index % images().length] : null;
      const imageLine = base.imageHash ? `Image: the same as "${base.name}"` : brandImage ? `Image: ${brandImage}` : 'Image: none';
      const proposal = await propose(task, { kind: 'social.ad_create', targetKind: 'social_adset', targetId: `${source.key(rec.adsetId)}:${today}:${index + 1}`,
        preview: `New ${source.name} ad for "${adset?.name ?? rec.adsetId}" (${rec.reason}). It runs inside the ${linkedinAd ? 'campaign' : 'ad set'}'s existing budget.\n\n${linkedinAd ? 'Post text' : 'Primary text'}: ${message}\nHeadline: ${headline}\nDescription: ${description}\n${linkedinAd ? '' : `Button: ${callToAction === 'SIGN_UP' ? 'Sign up' : 'Learn more'}\n`}Link: ${link}\n${imageLine}`,
        input: { adsetId: rec.adsetId, name, message, headline, description, link, imageHash: base.imageHash ?? null, callToAction, product, basedOn: base.id, ...(linkedinAd ? { platform: 'linkedin', imageUrl: brandImage } : {}) } });
      if (proposal) made += 1;
    }
    return made;
  }

  async function creativeAd(task, rec, overview, today, source, product) {
    const assets = await approvedImages(product, source.platform);
    const adset = overview.adsets.find(item => item.id === rec.adsetId);
    const linkedinAd = source.platform === 'linkedin';
    for (const asset of assets) {
      const parts = [checkSocialText(asset.primaryText, { surface: 'ad_message', product }), checkSocialText(asset.headline, { surface: 'ad_headline', product }),
        checkSocialText(asset.description || asset.headline, { surface: 'ad_description', product })];
      if (parts.some(part => !part.ok) || parts[0].text.length < 60 || !/^https:\/\//.test(asset.landingUrl ?? '') || !checkSocialText(`Start here: ${asset.landingUrl}`, { surface: 'facebook', product }).ok) continue;
      const [message, headline, description] = parts.map(part => part.text);
      const callToAction = /\b(?:trial|sign ?up|start)\b/i.test(asset.cta ?? '') ? 'SIGN_UP' : 'LEARN_MORE';
      const name = `${adset?.name ?? 'Ad set'} · creative ${asset.id.slice(0, 8)} · ${today}`;
      const proposal = await store.proposeAction({ taskId: task.id, kind: 'social.ad_create', targetKind: 'social_adset', targetId: `${source.key(rec.adsetId)}:${today}:c`,
        preview: `New ${source.name} ad for "${adset?.name ?? rec.adsetId}" (${rec.reason}) from approved creative ${asset.id}. It runs inside the ${linkedinAd ? 'campaign' : 'ad set'}'s existing budget.\n\n${linkedinAd ? 'Post text' : 'Primary text'}: ${message}\nHeadline: ${headline}\nDescription: ${description}\n${linkedinAd ? '' : `Button: ${callToAction === 'SIGN_UP' ? 'Sign up' : 'Learn more'}\n`}Link: ${asset.landingUrl}\nImage: ${asset.url}`.slice(0, 6000),
        input: { adsetId: rec.adsetId, name, message, headline, description, link: asset.landingUrl, imageHash: null, imageUrl: asset.url, callToAction, product, basedOn: base(rec, overview), creativeAssetId: asset.id, ...(linkedinAd ? { platform: 'linkedin' } : {}) } })
        .catch(error => { if (error?.code === '42501') return null; throw error; });
      return proposal ? 1 : 0;
    }
    return null;
  }
  const base = (rec, overview) => overview.ads.find(ad => ad.id === rec.basedOn)?.id ?? null;

  // ---- The weekly report --------------------------------------------------------------------------------------------------------------
  async function report(task, { now = () => new Date(), signal } = {}) {
    const sources = adSources();
    if (!metaPosts() && !li.configured.page && !sources.length) return { result: { skipped: 'meta_not_configured' } };
    const moment = now();
    const week = weekStart(dueMoment(task) ?? moment);
    const asked = task.sourceKind === 'owner';
    // The Monday scorecard carries this report (ad spend and failing ads) while the owner's "Send the individual weekly reports" is off.
    if (await heldForScorecard({ store, log }, task)) return heldResult({ week });
    const notes = [];
    let posts = [];
    for (const [on, client, name] of [[metaPosts(), meta, 'Meta'], [li.configured.page, li, 'LinkedIn']]) {
      if (!on) continue;
      try { posts = posts.concat(await client.recentPosts({ signal })); }
      catch (error) { if (signal?.aborted || error?.transient) throw error; notes.push(`${name} posts could not be read (${String(error?.code ?? 'social_error').replaceAll('_', ' ')}).`); }
    }
    posts = rankPosts(posts, { now: moment, days: 7 });
    let adsets = [];
    for (const source of sources) {
      try { adsets = adsets.concat(evaluateAds({ ...(await source.client.adsOverview({ signal, now: moment })), now: moment, settings }).adsets
        .filter(item => item.impressions > 0 || item.active).map(item => ({ ...item, name: `${source.name}: ${item.name}` }))); }
      catch (error) { if (signal?.aborted || error?.transient) throw error; notes.push(`${source.name} ads could not be read (${String(error?.code ?? 'social_error').replaceAll('_', ' ')}).`); }
    }
    const waiting = (await open()).size;
    const platforms = ['facebook', 'instagram', ...(li.configured.page ? ['linkedin'] : [])];
    const byPlatform = platforms.map(platform => { const mine = posts.filter(post => post.platform === platform); return [platform, mine.length, mine.reduce((sum, post) => sum + post.engagement, 0)]; });
    const spend = adsets.reduce((sum, item) => sum + item.spendCents, 0);
    const results = adsets.reduce((sum, item) => sum + item.results, 0);
    const body = `${plural(posts.length, 'post')} in the last 7 days with ${posts.reduce((sum, post) => sum + post.engagement, 0)} engagement points; ads spent ${money(spend)} for ${plural(results, 'result')}. ${plural(waiting, 'change')} waiting for you.`;
    const blocks = [
      { type: 'callout', tone: waiting ? 'warning' : 'info', title: 'Social media this week.', text: body },
      { type: 'paragraph', text: 'Posts' },
      { type: 'details', rows: byPlatform.map(([platform, count, points]) => [labels[platform], `${plural(count, 'post')}, ${points} engagement points`]) },
      ...(posts.length ? [{ type: 'paragraph', text: 'What earned the most engagement' }, { type: 'details', rows: posts.slice(0, 3).map(post => [`${labels[post.platform]}: ${firstLine(post.text)}`, `${post.engagement} (${post.reactions} reactions, ${post.comments} comments, ${post.shares} shares)`]) }] : []),
      ...(adsets.length ? [{ type: 'paragraph', text: 'Ads, last 7 days' }, { type: 'details', rows: adsets.map(item => [item.name.slice(0, 80), `${money(item.spendCents)} spent, ${item.impressions} impressions, ${(item.ctr * 100).toFixed(1)}% click rate, ${plural(item.results, 'result')}${item.costPerResult !== null ? ` at ${money(item.costPerResult)} each` : ''}, ${plural(item.activeAds, 'active ad')}`]) }] : []),
      { type: 'paragraph', text: 'Engagement points count reactions, comments twice and shares three times. Results are leads and sign-ups as Meta and LinkedIn report them.' },
      ...notes.map(text => ({ type: 'paragraph', text })),
      ...(/^https:\/\//i.test(publicOrigin ?? '') && waiting ? [{ type: 'button', label: 'Open the AI team', url: `${publicOrigin.replace(/\/+$/, '')}/admin/team` }] : []),
    ];
    const sent = await notifier.send({ severity: 'info', subject: `Social media weekly: ${plural(posts.length, 'post')}, ${money(spend)} ad spend`, body, blocks,
      dedupeKey: asked ? `social:report:run:${task.id}` : `social:report:${week}`, agentKey: task.agentKey, taskId: task.id });
    if (!asked && sent.every(item => item.delivery === 'duplicate')) return { result: { skipped: sent.some(delivered) ? 'already_sent' : 'earlier_attempt_unconfirmed', week } };
    await recordRun({ store, log }, task, { promptVersion: 'social-report.2', summary: `Sent the weekly social report: ${body}` });
    return { result: { week, posts: posts.length, spendCents: spend, results, waiting } };
  }

  return { 'social.plan': plan, 'social.inbox': inbox, 'social.interaction': interaction, 'social.ads': ads, 'social.report': report };
}

/**
 * When a post in the plan should publish: its day of the week at the platform's slot (10:30 Eastern on Facebook, 12:15 on Instagram,
 * 8:45 on LinkedIn),
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
