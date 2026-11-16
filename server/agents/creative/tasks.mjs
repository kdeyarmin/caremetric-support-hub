/**
 * The Creative Director's work. Nothing here publishes, posts or spends: every handler drafts, renders, checks and proposes, and the owner
 * (or, once a kind of work is handed over after its supervised week, the agent it is trusted to) approves. Times are Eastern.
 *
 * - `creative.plan` (08:30 each morning, and as soon as the Social Media Manager's weekly plan is written): turns marketing plan output
 *   with no creative yet (this week's social posts, the Marketing Manager's approved content briefs) into briefs, one per product and
 *   pillar, and queues a `creative.request` for each.
 * - `creative.request` (one per brief: the plan's, the owner's New brief form, a winner's refresh, or a rejection note's revision):
 *   writes the concept and final copy on the quality tier and two to four more variants on the draft tier, checks every word, and stores
 *   the drafts, one per variant and placement.
 * - `creative.render` (every 10 minutes): proposes rendered assets, collects finished HeyGen renders, and renders drafts (static images and
 *   videos), at most Settings → Creative → "Most renders a day" (default 40), each in its product's brand theme (themes.mjs) with the owner's brand
 *   kit on top. Each finished asset is checked in full (compliance.mjs, specs.mjs), its colors against the brand among the rest: a blocked one
 *   is never shown to the owner; one that passes is proposed for approval, with its warnings if it has any.
 * - `creative.refresh` (09:30, once a week, after the Social Media Manager's report): reads the ad results, joined to assets by
 *   utm_content, proposes retiring tired creative and queues new variants of the winners.
 * - `creative.report` (09:45, once a week): the scorecard by asset (ad results and website leads by utm_content), the learnings it supports
 *   (saved for future briefs and the morning brief), emailed to the owner.
 *
 * Only products the team markets (marketing.mjs) get creative. Nothing another person wrote reaches the model or a stored record.
 */
import { weekStart, easternDate, easternMidnight } from '../accounts/week.mjs';
import { marketedNow, markets } from '../marketing.mjs';
import { delivered } from '../notify.mjs';
import { live } from '../../live.mjs';
import { reviewImage } from './vision.mjs';
import { dueMoment, permanent, plural, recordRun } from '../tasks/shared.mjs';
import { catalogBlocks, focusFor } from '../content/features.mjs';
import { badgeText, checkCopy, checkData, checkPlatform, checkText, checkVideo, checkVisual, verdictOf, withoutFigure } from './compliance.mjs';
import { countyBrief, countySnapshot, settingFor, withFacts } from './data.mjs';
import {
  audienceFor, namedSegment, segmentFor,
  briefUserMessage, chooseVariants, conceptPromptVersion, conceptSchema, conceptSystem, landingFor, normalizeVariant, planPlacements, variantsPromptVersion,
  variantsSchema, variantsSystem,
} from './copy.mjs';
import { heygenScript } from './heygen.mjs';
import { productNames } from './layouts.mjs';
import { offerFor } from './offers.mjs';
import { fatigueReason, joinResults, learningsFrom, refreshPlan, scorecard } from './performance.mjs';
import { renderStatic } from './render.mjs';
import { placements, videoLengths } from './specs.mjs';
import { captionsVtt, mp4Info, renderVideo } from './video.mjs';
import { effectiveKit } from './themes.mjs';

export const creativeProducts = Object.freeze(['carebase', 'caremetric-intel']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const day = 86_400_000;
const modelAttempts = 3;
const platformNames = { meta: 'Meta', linkedin: 'LinkedIn', google: 'Google display', youtube: 'YouTube' };
const goals = {
  tip: 'Earn attention with a practical tip and send people to the product page', capability: 'Show one capability and drive free-trial starts',
  engagement: 'Build familiarity with the product among the people it is for', offer: 'Drive paid activations with the Founders Sale',
  resource: 'Send people to a useful resource page',
  data: 'Share one piece of public Medicare data news and send people to the free market report for their agency',
};
const socialPlatform = { facebook: 'meta', instagram: 'meta', linkedin: 'linkedin' };
// A used-up budget waits for the next Eastern day, which is when the budget starts again.
const nextBudgetDay = (task, moment) => {
  const start = new Date(task.budget?.dayStart ?? NaN);
  return Number.isNaN(start.getTime()) ? new Date(moment.getTime() + day) : new Date(start.getTime() + day + 5 * 60_000);
};
const aborted = () => Object.assign(new Error('The agent task is no longer running.'), { code: 'task_cancelled' });

/**
 * @param {object} options
 * @param {object} options.settings { dailyRenderCap, videoProvider: 'internal' | 'heygen' }
 * @param {object} [options.heygen] heygen.mjs client (used only when the provider is heygen and it is configured)
 * @param {object} [options.meta] @param {object} [options.linkedin] the Social Media Manager's clients, read for ad results
 */
export function creativeHandlers({ store, notifier, model = null, meta = null, linkedin = null, heygen = null, settings = {}, publicOrigin = null, marketed = null,
  feed = null, states = null, renderBudgetMs = 150_000, log = line => console.warn(line) }) {
  // The roster's states (Settings → Customer growth), read on each run: the county snapshots picture every county of them.
  const rosterStates = () => { const value = live(states); return Array.isArray(value) ? value.filter(state => /^[A-Z]{2}$/.test(state)).slice(0, 60) : []; };
  // County snapshots a week (Settings → Creative), from Intel's marketing feed (`feed`, growth/intel-feed.mjs); 0 or no feed, none.
  const snapshotsNow = () => (Number.isInteger(settings.countySnapshotsPerWeek) && settings.countySnapshotsPerWeek >= 0 ? Math.min(settings.countySnapshotsPerWeek, 7) : 0);
  // Read on each run: the cap and the video provider are Hub settings (Settings → Creative) that change without a restart.
  const capNow = () => (Number.isInteger(settings.dailyRenderCap) && settings.dailyRenderCap >= 0 ? settings.dailyRenderCap : 40);
  // Settings → Creative: the vision review and the least score it lets through without a warning. On without a model, an image is shown
  // with a warning that it was not reviewed, never passed unseen (so it is never approved on its own).
  const visionNow = () => settings.visionReview === true;
  const visionMinScore = () => (Number.isInteger(settings.visionMinScore) && settings.visionMinScore >= 1 && settings.visionMinScore <= 5 ? settings.visionMinScore : 3);
  const offeredNow = async () => { const list = await marketedNow(marketed); return creativeProducts.filter(product => markets(list, product)); };
  const effort = task => (['low', 'medium', 'high'].includes(task.agent?.config?.effort) ? task.agent.config.effort : 'medium');
  const origin = /^https:\/\//i.test(publicOrigin ?? '') ? publicOrigin.replace(/\/+$/, '') : null;
  const useHeygen = kit => settings.videoProvider === 'heygen' && heygen?.configured === true && Boolean(kit?.videoAvatarId) && Boolean(kit?.videoVoiceId);

  async function runModel(task, request, signal) {
    try {
      return await model.run(task, request, { signal });
    } catch (error) {
      if (signal?.aborted || (error?.transient === true && (task.attempts ?? 1) < modelAttempts)) throw error;
      return { outcome: 'unavailable', code: /^[a-z][a-z_]{0,59}$/.test(error?.code ?? '') ? error.code : 'ai_error' };
    }
  }

  async function propose(task, asset, verdict) {
    const spec = placements[asset.placement];
    const lines = [
      `${platformNames[asset.platform]} ${spec?.label ?? asset.placement} for ${productNames[asset.product]} (${asset.width} x ${asset.height}${asset.kind === 'video' ? `, ${Number(asset.durationSeconds ?? 0).toFixed(1)}-second video` : ''}), variant ${asset.variantLabel}, ${asset.hookType} hook.`,
      `Compliance: ${badgeText(verdict)}.${verdict.reasons.length ? ` ${verdict.reasons.map(reason => reason.message).join(' ')}` : ''}`,
      '', `Headline: ${asset.headline}`, `Primary text: ${asset.primaryText}`, ...(asset.description ? [`Description: ${asset.description}`] : []), `Call to action: ${asset.cta}`,
      ...(asset.landingUrl ? [`Landing page: ${asset.landingUrl}`] : []),
      ...(origin ? ['', `See it on the Creative screen: ${origin}/admin/creative?asset=${asset.id}`] : []),
      '', 'Approving hands it to the Social Media Manager. Rejecting with a note asks for a revision.',
    ];
    try {
      const proposal = await store.proposeAction({ taskId: task.id, kind: verdict.verdict === 'pass' ? 'creative.asset' : 'creative.asset_review', targetKind: 'creative_asset',
        targetId: asset.id, preview: lines.join('\n').slice(0, 6000),
        input: { assetId: asset.id, product: asset.product, platform: asset.platform, placement: asset.placement, kind: asset.kind, compliance: verdict.verdict, headline: String(asset.headline).slice(0, 200) } });
      if (!proposal) return false;
      await store.creativeAssetProposed(asset.id, proposal.id);
      return true;
    } catch (error) {
      // An observe-only agent cannot propose: the asset waits, rendered, until the owner lets it.
      if (error?.code === '42501') return false;
      throw error;
    }
  }

  // ---- Plan: marketing plan output becomes briefs -----------------------------------------------------------------------------------
  async function plan(task, { now = () => new Date() } = {}) {
    if (!model?.configured) return { result: { skipped: 'model_not_configured' } };
    if (task.agent?.autonomy === 'observe') return { result: { skipped: 'observe_only' } };
    const offered = await offeredNow();
    if (!offered.length) return { result: { skipped: 'no_marketed_product' } };
    const week = weekStart(dueMoment(task) ?? now());
    // A story post reuses an approved story image: it is no plan for new creative.
    const inputs = (await store.creativePlanInputs(7)).filter(item => offered.includes(item.product) && item.pillar !== 'story');
    const groups = new Map();
    for (const item of inputs) {
      const key = item.source === 'social.plan' ? `social:${item.product}:${item.pillar ?? 'tip'}:${week}` : `growth:${item.ref}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    let created = 0;
    // Intel's briefs take turns across the kinds of organization it is for (a plan item that names one keeps it): the turn starts from the
    // week, so successive weeks begin with a different one.
    const chosen = [...groups].slice(0, 4);
    const textOf = items => items.map(item => item.text).join(' ');
    let turn = Math.floor(Date.parse(week) / (7 * day));
    // The segments plan items name are taken first, so a brief that takes its turn does not repeat one.
    const used = new Set(chosen.map(([, items]) => namedSegment(items[0].product, textOf(items))).filter(Boolean));
    // Each brief also leads with one part of what its product does (the site's "why it matters" pillars): the one its plan text is about,
    // else the next in turn, so the week's briefs show different features rather than territory analysis every time.
    const focused = new Set();
    let focusTurn = turn;
    for (const [key, items] of chosen) {
      const first = items[0];
      const pillar = goals[first.pillar] ? first.pillar : 'tip';
      const platforms = [...new Set(items.map(item => socialPlatform[item.platform]).filter(Boolean))];
      const segment = segmentFor(first.product, textOf(items), turn, used);
      if (segment) { used.add(segment); turn += 1; }
      const focus = focusFor(first.product, textOf(items), focusTurn, focused);
      if (focus) { focused.add(focus.title); focusTurn += 1; }
      const brief = {
        product: first.product, goal: goals[pillar], audience: audienceFor(first.product, segment), offerCode: pillar === 'offer' && offerFor('FOUNDERS50')?.products.includes(first.product) ? 'FOUNDERS50' : null,
        platforms: platforms.length ? platforms : ['meta', 'linkedin'], formats: ['capability', 'offer'].includes(pillar) ? ['static', 'video'] : ['static'], videoLengths: ['15s'],
        angle: `${focus ? `Feature focus: ${focus.title} (${focus.area}). ` : ''}From the ${first.source === 'social.plan' ? `week's ${pillar} posts` : 'approved content brief'}: ${items.map(item => item.text).join(' / ')}`.slice(0, 500),
        source: first.source === 'social.plan' ? 'social.plan' : 'growth.plan', planRef: first.ref, requestKey: `plan:${key}`,
      };
      const saved = await store.creativeBriefCreate(brief);
      if (saved?.created) {
        created += 1;
        await store.enqueue(task.agentKey, 'creative.request', `creative:brief:${saved.id}`, { payload: { briefId: saved.id }, priority: 5, sourceKind: 'agent', sourceRef: 'creative.plan' });
      }
    }
    const snapshots = offered.includes('caremetric-intel') ? await countySnapshots(task, week) : { opened: 0, skipped: 'intel_not_marketed' };
    await recordRun({ store, log }, task, { promptVersion: 'creative-plan.1', summary: `Read ${plural(inputs.length, 'plan item')} and opened ${plural(created, 'creative brief')}${snapshots.opened ? ` and ${plural(snapshots.opened, 'county snapshot')}` : ''}.` });
    // Why no county snapshot was opened, in the run's result, so a quiet week can be told from a broken one.
    return { result: { week, inputs: inputs.length, briefs: created, ...(snapshots.opened ? { snapshots: snapshots.opened } : {}), ...(snapshots.skipped ? { snapshotsSkipped: snapshots.skipped } : {}) } };
  }

  const codeOf = error => (/^[a-z][a-z_]{0,59}$/.test(error?.code ?? '') ? error.code : 'feed_error');

  /**
   * County snapshots (data.mjs): up to the week's number, each one public figure about one care setting for one county of the roster's
   * states, the least recently pictured first, the figure in turn by week. Returns how many were opened, or why none could be.
   * A feed that cannot answer leaves the week without them; the next day's plan tries again.
   */
  async function countySnapshots(task, week) {
    const perWeek = snapshotsNow();
    if (!perWeek) return { opened: 0, skipped: 'off' };
    if (!feed?.configured || typeof feed.countyFigures !== 'function') return { opened: 0, skipped: 'feed_not_configured' };
    if (typeof store.creativeDataCountiesAll !== 'function' && typeof store.creativeDataCounties !== 'function') return { opened: 0, skipped: 'database_not_ready' };
    const weekStart = easternMidnight(week).toISOString();
    // Every county of the roster's states (Intel's geography), so a county with no agency located in it is pictured too. Without the list
    // (an older Intel, or the database without the newer county choice), the roster's own counties, as before.
    let all = null;
    const states = rosterStates();
    if (states.length && typeof feed.counties === 'function' && typeof store.creativeDataCountiesAll === 'function') {
      try { all = ((await feed.counties({ states }))?.counties ?? []).map(county => ({ countyFips: county.county_fips, state: county.state })); }
      catch (error) { log(JSON.stringify({ event: 'hub_creative_county_list_unread', code: codeOf(error) })); }
    }
    const counties = typeof store.creativeDataCountiesAll === 'function' ? await store.creativeDataCountiesAll(perWeek, weekStart, all) : await store.creativeDataCounties(perWeek, weekStart);
    if (!Array.isArray(counties) || !counties.length) return { opened: 0, skipped: 'no_county_due' };
    let answer;
    try { answer = await feed.countyFigures({ countyFips: counties.map(county => county.countyFips) }); }
    catch (error) { log(JSON.stringify({ event: 'hub_creative_county_unread', code: codeOf(error) })); return { opened: 0, skipped: codeOf(error) }; }
    const turn = Math.floor(Date.parse(week) / (7 * day));
    const chosen = new Map(counties.map(county => [county.countyFips, county]));
    let opened = 0;
    for (const [index, county] of (answer?.counties ?? []).entries()) {
      const snapshot = countySnapshot(county, turn + index, settingFor(chosen.get(county.county_fips), turn + index));
      if (!snapshot) continue;
      const saved = await store.creativeBriefCreate(countyBrief(snapshot, week));
      if (!saved?.created) continue;
      opened += 1;
      await store.enqueue(task.agentKey, 'creative.request', `creative:brief:${saved.id}`, { payload: { briefId: saved.id }, priority: 5, sourceKind: 'agent', sourceRef: 'creative.plan' });
    }
    return opened ? { opened } : { opened: 0, skipped: 'no_figure_fits' };
  }

  // ---- Request: one brief becomes checked drafts -------------------------------------------------------------------------------------
  async function request(task, { now = () => new Date(), signal } = {}) {
    const briefId = task.payload?.briefId;
    if (typeof briefId !== 'string' || !uuid.test(briefId)) throw permanent('invalid_payload');
    const context = await store.creativeBriefContext(briefId);
    if (!context) return { result: { skipped: 'brief_missing' } };
    const brief = context.brief;
    if (['done', 'cancelled', 'skipped'].includes(brief.status)) return { result: { skipped: 'already_drafted', briefId } };
    if (!model?.configured) return { result: { skipped: 'model_not_configured', briefId } };
    if (task.agent?.autonomy === 'observe') return { result: { skipped: 'observe_only', briefId } };
    if (!(await offeredNow()).includes(brief.product)) {
      await store.creativeBriefFinish(briefId, 'skipped', { reason: 'product_not_marketed' });
      return { result: { skipped: 'product_not_marketed', briefId } };
    }
    const offer = brief.offerCode ? offerFor(brief.offerCode) : null;
    if (brief.offerCode && (!offer || !offer.products.includes(brief.product))) {
      await store.creativeBriefFinish(briefId, 'skipped', { reason: 'offer_not_live' });
      return { result: { skipped: 'offer_not_live', briefId } };
    }
    await store.creativeBriefFinish(briefId, 'drafting', null);
    const kit = context.brandKit ?? {};
    const screenshots = Array.isArray(kit.screenshots) ? kit.screenshots : [];
    const user = briefUserMessage(context, { screenshots });
    const moment = now();
    // The product's own catalog follows the prompt as its own cached block.
    const system = [{ text: conceptSystem, cache: true }, ...catalogBlocks([brief.product])];
    const concept = await runModel(task, { promptVersion: conceptPromptVersion, tier: 'quality', system, user, schema: conceptSchema,
      maxTokens: 4000, effort: effort(task), describe: output => `Wrote a ${output.hero.hook} concept (${output.hero.layout} layout) for a ${productNames[brief.product]} brief.` }, signal);
    if (concept.outcome === 'budget_exhausted') { await store.creativeBriefFinish(briefId, 'open', null); return { status: 'queued', retryAt: nextBudgetDay(task, moment), result: { deferred: 'budget', briefId } }; }
    if (concept.outcome !== 'completed') { await store.creativeBriefFinish(briefId, 'open', null); return { result: { skipped: concept.code ?? concept.outcome, briefId } }; }
    if (signal?.aborted) throw aborted();
    // A county snapshot is drawn as its figure, whatever layout the model chose (data.mjs).
    const facts = brief.facts?.stat ? brief.facts : null;
    const hero = withFacts({ ...normalizeVariant(concept.output.hero, { screenshots, offer }), concept: String(concept.output.concept.bigIdea ?? '').slice(0, 500) }, facts);
    const more = await runModel(task, { promptVersion: variantsPromptVersion, tier: 'draft', system: [{ text: variantsSystem, cache: true }, ...catalogBlocks([brief.product])], schema: variantsSchema, maxTokens: 5000, effort: effort(task),
      user: JSON.stringify({ ...JSON.parse(user), concept: concept.output.concept, hero: concept.output.hero, variantsWanted: 4 }),
      describe: output => `Wrote ${plural(output.variants.length, 'variant')} of the concept.` }, signal);
    if (more.outcome === 'budget_exhausted') { await store.creativeBriefFinish(briefId, 'open', null); return { status: 'queued', retryAt: nextBudgetDay(task, moment), result: { deferred: 'budget', briefId } }; }
    if (signal?.aborted) throw aborted();
    const others = more.outcome === 'completed' ? (more.output.variants ?? []).map(raw => withFacts({ ...normalizeVariant(raw, { screenshots, offer }), concept: hero.concept }, facts)) : [];
    const chosen = chooseVariants(hero, others);
    const provider = brief.formats.includes('video') && useHeygen(kit) ? 'heygen' : 'internal';
    // A county snapshot goes to the page its facts name (the free market report for the reader's agency); other briefs to the concept's choice.
    const rows = planPlacements({ brief, variants: chosen, landingBase: landingFor(brief.product, facts?.landing ?? concept.output.concept.landingPageId), provider }).map(row => {
      const copy = { layout: row.layout, headline: row.headline, primaryText: row.primaryText, description: row.description, cta: row.cta, altText: row.altText, overlay: row.overlay };
      // A snapshot's figure is the data's, checked against it; the copy rules read the words around it.
      const findings = facts ? [...checkCopy({ product: brief.product, platform: row.platform, copy: withoutFigure(copy), offerCode: brief.offerCode, brandKit: kit }), ...checkData({ copy, facts })]
        : checkCopy({ product: brief.product, platform: row.platform, copy, offerCode: brief.offerCode, brandKit: kit });
      return { ...row, compliance: verdictOf([...findings, ...checkText(row.platform, copy)]) };
    });
    const saved = rows.length ? await store.creativeDraftsSave(briefId, task.id, rows) : [];
    const blocked = rows.filter(row => row.compliance.verdict === 'block').length;
    await store.creativeBriefFinish(briefId, 'done', { variants: chosen.length, drafts: rows.length - blocked, blocked });
    if (rows.length > blocked) await store.enqueue(task.agentKey, 'creative.render', `creative:render:${briefId}`, { priority: 4, sourceKind: 'agent', sourceRef: 'creative.request' });
    return { result: { briefId, variants: chosen.length, drafts: rows.length - blocked, blocked, saved: saved.length, provider } };
  }

  // ---- Render ----------------------------------------------------------------------------------------------------------------------
  async function brandFiles(asset, kit) {
    const files = {};
    if (kit.logoFileId) {
      const bytes = await store.creativeBrandFile(kit.logoFileId);
      if (bytes) files.logo = { bytes, type: 'image/png' };
    }
    const shots = Array.isArray(kit.screenshots) ? kit.screenshots : [];
    const wanted = asset.overlay?.screenshotId || (asset.kind === 'video' && asset.hookType === 'demo' ? shots[0]?.id : null);
    const shot = shots.find(item => item.id === wanted);
    if (shot) {
      const bytes = await store.creativeBrandFile(shot.id);
      // Only a screenshot the owner attested is kept on the brand kit at all (the database refuses any other).
      if (bytes) files.screenshots = { [shot.id]: { bytes, type: shot.contentType ?? 'image/png', attested: true } };
    }
    return files;
  }
  const contentOf = asset => ({ headline: asset.headline, primaryText: asset.primaryText, description: asset.description, cta: asset.cta, altText: asset.altText, overlay: asset.overlay ?? {} });

  async function renderOne(task, asset, signal) {
    const kit = asset.brandKit ?? {};
    const content = contentOf(asset);
    const findings = checkCopy({ product: asset.product, platform: asset.platform, copy: content, offerCode: asset.offerCode, brandKit: kit });
    if (findings.some(item => item.level === 'block')) {
      await store.creativeRenderFinish(asset.id, 'blocked', null, null, verdictOf(findings), {});
      return 'blocked';
    }
    let file;
    let type;
    const meta = { provider: 'internal' };
    try {
      const files = await brandFiles(asset, kit);
      if (asset.kind === 'static') {
        const out = await renderStatic({ layout: asset.layout, width: asset.width, height: asset.height, product: asset.product, content, kit, files });
        findings.push(...checkVisual(out.report), ...checkPlatform({ placement: asset.placement, width: out.width, height: out.height, bytes: out.png.length, contentType: 'image/png', copy: content }));
        file = out.png; type = 'image/png';
      } else if (useHeygen(kit)) {
        const seconds = videoLengths[asset.lengthKey]?.target ?? 15;
        const job = await heygen.submit({ script: heygenScript(content, seconds), avatarId: kit.videoAvatarId, voiceId: kit.videoVoiceId, width: asset.width, height: asset.height,
          background: effectiveKit(asset.product, kit).colors.background, title: `${productNames[asset.product]} ${asset.variantLabel}` }, { signal });
        await store.creativeRenderJob(asset.id, { provider: 'heygen', videoId: job.videoId, submittedAt: new Date().toISOString() });
        return 'submitted';
      } else {
        const out = await renderVideo({ id: asset.id, width: asset.width, height: asset.height, product: asset.product, content, kit, files, lengthKey: asset.lengthKey,
          captions: kit.captionsDefault !== false, signal });
        findings.push(...checkVisual(out.report), ...checkVideo({ burned: out.burned, cues: out.cues }),
          ...checkPlatform({ placement: asset.placement, width: out.width, height: out.height, bytes: out.mp4.length, contentType: 'video/mp4', durationSeconds: out.durationSeconds,
            lengthKey: asset.lengthKey, captions: out.burned, copy: content }));
        file = out.mp4; type = 'video/mp4';
        Object.assign(meta, { durationSeconds: Number(out.durationSeconds.toFixed(2)), captions: out.captions });
      }
    } catch (error) {
      if (signal?.aborted) { await store.creativeRenderFinish(asset.id, 'retry', null, null, null, { error: 'render_aborted' }).catch(() => {}); throw aborted(); }
      const code = /^[a-z][a-z_]{0,59}$/.test(error?.code ?? '') ? error.code : 'render_failed';
      log(JSON.stringify({ event: 'hub_creative_render_error', asset: asset.id, code }));
      await store.creativeRenderFinish(asset.id, error?.transient || ['renderer_unavailable', 'video_unavailable', 'heygen_unavailable'].includes(code) ? 'retry' : 'failed', null, null, null, { error: code });
      return 'failed';
    }
    let verdict = verdictOf(findings);
    // The vision review (vision.mjs), while it is on: a model looks at a finished image that passed every coded check, before the owner does.
    if (verdict.verdict !== 'block' && asset.kind === 'static' && visionNow()) {
      if (signal?.aborted) throw aborted();
      // Never retried here: an image the model could not look at is shown with a warning that it was not reviewed.
      const run = async request => {
        if (!model?.configured) return { outcome: 'unavailable', code: 'model_not_configured' };
        try { return await model.run(task, request, { signal }); }
        catch (error) { if (signal?.aborted) throw aborted(); return { outcome: 'unavailable', code: /^[a-z][a-z_]{0,59}$/.test(error?.code ?? '') ? error.code : 'ai_error' }; }
      };
      const reviewed = await reviewImage({ run, asset, png: file, minScore: visionMinScore() });
      verdict = { ...verdictOf([...findings, ...reviewed.findings]), review: reviewed.review };
      if (verdict.verdict === 'block') log(JSON.stringify({ event: 'hub_creative_vision_blocked', asset: asset.id, layout: asset.layout, placement: asset.placement,
        defects: (reviewed.review.defects ?? []).map(item => item.kind) }));
    }
    if (verdict.verdict === 'block') {
      await store.creativeRenderFinish(asset.id, 'blocked', null, null, verdict, {});
      return 'blocked';
    }
    await store.creativeRenderFinish(asset.id, 'ready', file, type, verdict, meta);
    if (signal?.aborted) throw aborted();
    return (await propose(task, { ...asset, durationSeconds: meta.durationSeconds ?? null }, verdict)) ? 'proposed' : 'ready';
  }

  async function collectJobs(task, counts, signal) {
    if (!heygen?.configured) return;
    for (const asset of await store.creativeRenderJobs(5)) {
      signal?.throwIfAborted();
      const job = asset.renderJob ?? {};
      let state;
      try { state = await heygen.status(job.videoId, { signal }); }
      catch (error) { if (error?.transient) continue; await store.creativeRenderFinish(asset.id, 'failed', null, null, null, { error: error?.code ?? 'heygen_failed' }); counts.failed += 1; continue; }
      if (state.state === 'working') {
        if (Date.now() - (Date.parse(job.submittedAt ?? '') || Date.now()) > 3 * 3_600_000) { await store.creativeRenderFinish(asset.id, 'failed', null, null, null, { error: 'heygen_timeout' }); counts.failed += 1; }
        continue;
      }
      if (state.state === 'failed' || !state.url) { await store.creativeRenderFinish(asset.id, 'failed', null, null, null, { error: 'heygen_failed' }); counts.failed += 1; continue; }
      let bytes;
      try { bytes = await heygen.download(state.url, { signal }); }
      catch (error) { if (error?.transient) continue; await store.creativeRenderFinish(asset.id, 'failed', null, null, null, { error: error?.code ?? 'heygen_failed' }); counts.failed += 1; continue; }
      const info = mp4Info(bytes) ?? {};
      const content = contentOf(asset);
      const script = heygenScript(content, videoLengths[asset.lengthKey]?.target ?? 15);
      const verdict = verdictOf([...checkCopy({ product: asset.product, platform: asset.platform, copy: { ...content, overlay: { ...content.overlay, beats: [script] } }, brandKit: asset.brandKit ?? {} }),
        ...checkVideo({ burned: state.captioned, cues: state.captioned ? 1 : 0 }),
        ...checkPlatform({ placement: asset.placement, width: info.width, height: info.height, bytes: bytes.length, contentType: 'video/mp4', durationSeconds: info.durationSeconds ?? state.durationSeconds, lengthKey: null, captions: state.captioned, copy: content })]);
      if (verdict.verdict === 'block') { await store.creativeRenderFinish(asset.id, 'blocked', null, null, verdict, {}); counts.blocked += 1; continue; }
      const durationSeconds = Number((info.durationSeconds ?? state.durationSeconds ?? 0).toFixed(2));
      await store.creativeRenderFinish(asset.id, 'ready', bytes, 'video/mp4', verdict, { provider: 'heygen', durationSeconds,
        captions: captionsVtt({ scenes: [{ text: script, start: 0, end: durationSeconds }] }) });
      if (await propose(task, { ...asset, durationSeconds }, verdict)) counts.proposed += 1;
    }
  }

  async function render(task, { now = () => new Date(), signal } = {}) {
    if (task.agent?.autonomy === 'observe') return { result: { skipped: 'observe_only' } };
    const started = Date.now();
    const offered = await offeredNow();
    const counts = { rendered: 0, proposed: 0, blocked: 0, failed: 0, submitted: 0 };
    const cap = capNow();
    await collectJobs(task, counts, signal);
    // Rendered before, not yet proposed (the agent was observing, or proposing failed).
    for (const asset of await store.creativeReady(10, offered)) {
      signal?.throwIfAborted();
      if (await propose(task, asset, asset.compliance?.verdict ? asset.compliance : verdictOf([]))) counts.proposed += 1;
    }
    // Every product has its theme, so nothing waits for the owner's brand kit: a blank field uses the theme.
    const ready = offered;
    let renderedToday = 0;
    while (ready.length && Date.now() - started < renderBudgetMs) {
      signal?.throwIfAborted();
      const claim = await store.creativeRenderClaim(1, cap, ready);
      renderedToday = claim.renderedToday;
      const asset = claim.claimed?.[0];
      if (!asset) break;
      const outcome = await renderOne(task, asset, signal);
      if (outcome === 'proposed') { counts.rendered += 1; counts.proposed += 1; }
      else if (outcome === 'ready') counts.rendered += 1;
      else if (outcome === 'submitted') counts.submitted += 1;
      else counts[outcome] = (counts[outcome] ?? 0) + 1;
    }
    if (counts.proposed && notifier) {
      const sent = await notifier.send({ severity: 'info', subject: 'New creative is waiting for your approval',
        body: `The Creative Director finished new ads that passed the compliance checks. Review, approve or ask for changes on the Creative screen${origin ? `: ${origin}/admin/creative` : ''}. Anything that failed a check was blocked and is not shown.`,
        dedupeKey: `creative:ready:${easternDate(now())}`, agentKey: task.agentKey, taskId: task.id });
      if (!sent.some(delivered) && !sent.some(item => item.delivery === 'duplicate')) log(JSON.stringify({ event: 'hub_creative_ready_unsent' }));
    }
    if (Object.values(counts).some(Boolean)) {
      await recordRun({ store, log }, task, { promptVersion: 'creative-render.1', summary: `Rendered ${plural(counts.rendered, 'asset')}, proposed ${counts.proposed}, blocked ${counts.blocked}, failed ${counts.failed}${counts.submitted ? `, ${counts.submitted} sent to HeyGen` : ''}; ${renderedToday} of ${cap} renders today.` });
    }
    return { result: { ...counts, renderedToday, cap } };
  }

  // ---- Weekly refresh and report ----------------------------------------------------------------------------------------------------
  const adSources = () => [
    { platform: 'meta', client: meta, on: Boolean(meta?.configured?.ads) },
    { platform: 'linkedin', client: linkedin, on: Boolean(linkedin?.configured?.ads) },
  ].filter(source => source.on);

  async function readResults(signal, moment) {
    const overviews = [];
    const notes = [];
    for (const source of adSources()) {
      try { overviews.push({ platform: source.platform, overview: await source.client.adsOverview({ signal, now: moment }) }); }
      catch (error) { if (signal?.aborted || error?.transient) throw error; notes.push(`${platformNames[source.platform]} ads could not be read (${String(error?.code ?? 'social_error').replaceAll('_', ' ')}).`); }
    }
    return { results: joinResults(overviews), notes, sources: overviews.length };
  }

  async function weeklyGate(task, key) {
    if (task.sourceKind === 'owner') return false;
    return await store.notificationCount({ prefix: key, channel: 'email', since: new Date(0) }) > 0;
  }

  async function refresh(task, { now = () => new Date(), signal } = {}) {
    if (task.agent?.autonomy === 'observe') return { result: { skipped: 'observe_only' } };
    const moment = now();
    const week = weekStart(dueMoment(task) ?? moment);
    const key = `creative:refresh:${week}`;
    if (await weeklyGate(task, key)) return { result: { skipped: 'already_refreshed', week } };
    const offered = await offeredNow();
    const assets = await store.creativeLiveAssets(offered);
    const { results, notes, sources } = await readResults(signal, moment);
    if (!sources) return { result: { skipped: 'ads_not_configured', week } };
    const rows = scorecard(assets, results);
    const { retire, winners } = refreshPlan(rows);
    const open = new Set(await store.creativeOpenTargets());
    let retired = 0;
    for (const row of retire) {
      signal?.throwIfAborted();
      if (open.has(`creative.retire:${row.id}`)) continue;
      try {
        const proposal = await store.proposeAction({ taskId: task.id, kind: 'creative.retire', targetKind: 'creative_asset', targetId: row.id,
          preview: `Retire ${productNames[row.product]} ${platformNames[row.platform]} variant ${row.variantLabel} ("${row.headline.slice(0, 80)}"): it is tired (${fatigueReason(row.signals)}). Retiring stops the Social Media Manager from using it; the Social Media Manager's daily ad review pauses the ad itself.`,
          input: { assetId: row.id, signals: row.signals } });
        if (proposal) retired += 1;
      } catch (error) { if (error?.code !== '42501') throw error; }
    }
    let refreshed = 0;
    for (const row of winners) {
      const asset = assets.find(item => item.id === row.id);
      const brief = await store.creativeBriefCreate({ product: row.product, goal: 'Make new variants of creative that is winning', audience: audienceFor(row.product), offerCode: null,
        platforms: [row.platform], formats: [row.kind], videoLengths: row.kind === 'video' ? [row.lengthKey ?? '15s'] : [], angle: `Keep what works in "${row.headline.slice(0, 120)}" (${row.hookType} hook, ${row.layout} layout) and try new hooks.`,
        source: 'refresh', planRef: `asset:${row.id}`, requestKey: `refresh:${row.id}:${week}`, parentAssetId: asset?.id ?? row.id,
        revisionNote: `This variant won: ${(row.ctr * 100).toFixed(2)}% click-through rate on ${row.impressions} impressions${row.leads ? ` and ${plural(row.leads, 'lead')}` : ''}. Write new variants that keep its strength.` });
      if (brief?.created) {
        refreshed += 1;
        await store.enqueue(task.agentKey, 'creative.request', `creative:brief:${brief.id}`, { payload: { briefId: brief.id }, priority: 5, sourceKind: 'agent', sourceRef: 'creative.refresh' });
      }
    }
    await store.creativePerformanceSave(rows.map(row => ({ id: row.id, performance: { week, impressions: row.impressions, clicks: row.clicks, ctr: row.ctr, cpmCents: row.cpmCents, frequency: Number(row.frequency.toFixed(2)), spendCents: row.spendCents, fatigued: row.fatigued, signals: row.signals } })));
    const body = `${plural(rows.length, 'live asset')} read: ${plural(retired, 'retirement')} proposed for tired creative and ${plural(refreshed, 'new brief')} for variants of the winners.${notes.length ? ` ${notes.join(' ')}` : ''}`;
    await notifier.send({ severity: 'info', subject: `Creative refresh: ${plural(retired, 'asset')} to retire, ${plural(refreshed, 'winner')} to build on`, body,
      dedupeKey: task.sourceKind === 'owner' ? `creative:refresh:run:${task.id}` : key, agentKey: task.agentKey, taskId: task.id });
    await recordRun({ store, log }, task, { promptVersion: 'creative-refresh.1', summary: body });
    return { result: { week, assets: rows.length, retired, refreshed } };
  }

  async function report(task, { now = () => new Date(), signal } = {}) {
    const moment = now();
    const week = weekStart(dueMoment(task) ?? moment);
    const key = `creative:report:${week}`;
    if (await weeklyGate(task, key)) return { result: { skipped: 'already_sent', week } };
    const offered = await offeredNow();
    const assets = await store.creativeLiveAssets(offered);
    const { results, notes } = await readResults(signal, moment);
    const until = new Date(moment.getTime());
    const leads = await store.creativeLeads(new Date(until.getTime() - 7 * day), until);
    const rows = scorecard(assets, results, leads);
    const learned = learningsFrom(rows);
    if (learned.length) await store.creativeLearningsSave(learned);
    if (rows.length) await store.creativePerformanceSave(rows.map(row => ({ id: row.id, performance: { week, impressions: row.impressions, clicks: row.clicks, ctr: row.ctr, cpmCents: row.cpmCents, frequency: Number(row.frequency.toFixed(2)), spendCents: row.spendCents, leads: row.leads, trials: row.trials, fatigued: row.fatigued, signals: row.signals } })));
    const facts = await store.creativeBriefFacts();
    const top = [...rows].sort((a, b) => b.leads - a.leads || b.ctr - a.ctr).slice(0, 8);
    const wins = learned.filter(item => item.verdict === 'win').slice(0, 5);
    const losses = learned.filter(item => item.verdict === 'lose').slice(0, 5);
    const totals = rows.reduce((sum, row) => ({ impressions: sum.impressions + row.impressions, clicks: sum.clicks + row.clicks, leads: sum.leads + row.leads }), { impressions: 0, clicks: 0, leads: 0 });
    const body = `${plural(rows.length, 'live asset')}: ${totals.impressions} impressions, ${totals.clicks} clicks and ${plural(totals.leads, 'website lead')} this week. ${plural(Number(facts.waiting ?? 0), 'asset')} waiting for your approval. ${plural(wins.length, 'pattern')} winning, ${losses.length} losing.`;
    const blocks = [
      { type: 'callout', tone: 'info', title: 'Creative this week.', text: body },
      ...(top.length ? [{ type: 'paragraph', text: 'Scorecard (by leads, then click-through rate)' }, { type: 'details', rows: top.map(row => [`${productNames[row.product]}, ${platformNames[row.platform]}, ${row.variantLabel} (${row.hookType}, ${row.layout})`, `${row.impressions} impressions, ${(row.ctr * 100).toFixed(2)}% CTR, ${plural(row.leads, 'lead')}${row.fatigued ? ', tired' : ''}`]) }] : []),
      ...(wins.length ? [{ type: 'paragraph', text: 'What is working' }, { type: 'details', rows: wins.map(item => [`${productNames[item.product]}, ${platformNames[item.platform]}: ${item.kind} ${item.value}`, `${Math.round(item.score * 100)}% better than average, ${plural(item.samples, 'asset')}`]) }] : []),
      ...(losses.length ? [{ type: 'paragraph', text: 'What is not' }, { type: 'details', rows: losses.map(item => [`${productNames[item.product]}, ${platformNames[item.platform]}: ${item.kind} ${item.value}`, `${Math.round(-item.score * 100)}% worse than average, ${plural(item.samples, 'asset')}`]) }] : []),
      { type: 'paragraph', text: 'Results are joined to each asset by utm_content (the asset\'s id in its landing address). Learnings feed the next briefs and the morning brief.' },
      ...notes.map(text => ({ type: 'paragraph', text })),
      ...(origin ? [{ type: 'button', label: 'Open the Creative screen', url: `${origin}/admin/creative` }] : []),
    ];
    const sent = await notifier.send({ severity: 'info', subject: `Creative weekly: ${plural(rows.length, 'live asset')}, ${plural(totals.leads, 'lead')}`, body, blocks,
      dedupeKey: task.sourceKind === 'owner' ? `creative:report:run:${task.id}` : key, agentKey: task.agentKey, taskId: task.id });
    if (task.sourceKind !== 'owner' && sent.every(item => item.delivery === 'duplicate')) return { result: { skipped: sent.some(delivered) ? 'already_sent' : 'earlier_attempt_unconfirmed', week } };
    await recordRun({ store, log }, task, { promptVersion: 'creative-report.1', summary: `Sent the weekly creative report: ${body}` });
    return { result: { week, assets: rows.length, learnings: learned.length, leads: totals.leads } };
  }

  return { 'creative.plan': plan, 'creative.request': request, 'creative.render': render, 'creative.refresh': refresh, 'creative.report': report };
}
