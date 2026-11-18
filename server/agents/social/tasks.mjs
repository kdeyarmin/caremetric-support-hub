/**
 * The Social Media Manager's work. Every task reads Meta and LinkedIn live and proposes actions the owner approves (or, once a kind of
 * work is handed over after its supervised week, that the agent is trusted with); nothing here posts, replies or changes an ad by itself.
 *
 * - `social.plan` (each morning, once a week): drafts the week's posts for Facebook, Instagram and LinkedIn from the fact sheet, the
 *   sales playbook and what earned engagement in the last four weeks; checks every word; proposes each post held for its time slot; and
 *   emails the owner the plan. Without a LinkedIn connection the LinkedIn posts are in that email, ready to paste.
 * - `social.inbox` (every 15 minutes): finds new comments and messages from other people and gives each its own task. On LinkedIn's
 *   Development tier (Settings → Social media → LinkedIn API tier) LinkedIn is read at one run every two hours (`linkedinDue`).
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
import { catalogBlocks } from '../content/features.mjs';
import { articleHomeUrl } from '../content/facts.mjs';
import { screenIdentifiers } from '../concierge/screen.mjs';
import { dueMoment, heldForScorecard, heldResult, permanent, plural, recordRun, when } from '../tasks/shared.mjs';
import { playbookFor } from '../../growth/playbook.mjs';
import {
  adCopyFromCreative, adImagePlacements, adPromptVersion, adSchema, adSystem, checkSocialText, planPromptVersion, planSchema, planSystem, replyPromptVersion, replySchema, replySystem,
  replyUserMessage, socialLinks, socialProducts, tagSocialLink, tagSocialText, withHashtags,
} from './content.mjs';
import { trustedWith } from '../handover.mjs';
import { evaluateAds, rankPosts, rulesVersion } from './rules.mjs';
import { marketedNow, markets } from '../marketing.mjs';
import { untaggedUrl, validTagValue } from '../links.mjs';
import { live } from '../../live.mjs';
import { failingPlatforms } from '../ads/index.mjs';

/**
 * A post's own utm_content (team review 2026-11-17, stage 6), so a lead can be traced to the post that brought it: the approved creative's
 * id when the post uses one (the Creative Director counts website leads by it), else `post-<week>-<platform>-<n>`. Before, every post
 * carried `post`.
 */
export const postContent = ({ week, platform, index, assetId = null }) => {
  if (typeof assetId === 'string' && validTagValue(assetId.toLowerCase())) return assetId.toLowerCase();
  const value = `post-${String(week).replaceAll('-', '')}-${platform}-${index}`;
  return validTagValue(value) ? value : 'post';
};
/** The intents a reply reading records as interest (the owner is told, and the weekly report counts them). */
export const interestIntents = Object.freeze(['interested', 'pricing']);

const day = 86_400_000;
const labels = { facebook: 'Facebook', instagram: 'Instagram', messenger: 'Messenger', linkedin: 'LinkedIn' };

/**
 * Whether this inbox run reads LinkedIn. On the Standard tier, every run. On the Development tier (100 calls a day for the Page's
 * token), only the scheduled run due in the first quarter hour of an even UTC hour, one in eight of the 15-minute runs (a schedule's
 * runs keep to one grid: agent_schedule_next), and any run the owner starts. The inbox looks back 48 hours, so a comment waits up to
 * two hours, and is never missed.
 */
export function linkedinDue(task, tier) {
  if (tier !== 'development') return true;
  const due = dueMoment(task);
  return !due || (due.getUTCHours() % 2 === 0 && due.getUTCMinutes() < 15);
}
const productNames = { carebase: 'CareBase', 'caremetric-intel': 'CareMetric Intel' };
// Posts per platform per week. Four on the two pages buyers read at work, three on Instagram (each needs an image).
const weekly = { facebook: 4, instagram: 3, linkedin: 4 };
const slots = { facebook: [10, 30], instagram: [12, 15], linkedin: [8, 45], founder: [7, 50] };
const modelAttempts = 3;
const money = cents => `$${(cents / 100).toFixed(2)}`;
const firstLine = text => String(text ?? '').split('\n')[0].slice(0, 90);
// Each product's sites, subdomains included (home.cmcarebase.com is CareBase's marketing site, caremetrictrain.com its older domain).
const productHosts = { carebase: ['cmcarebase.com', 'caremetrictrain.com'], 'caremetric-intel': ['caremetricintel.com'] };
const hostOf = url => { try { return new URL(url).hostname.toLowerCase(); } catch { return null; } };
const productOf = url => { const host = hostOf(url); return host === null ? null : Object.keys(productHosts).find(product => productHosts[product].some(site => host === site || host.endsWith(`.${site}`))) ?? null; };
// An ad whose link is readable and does not lead to a product the team is marketing (another product's site, or a site that is no product's).
const leadsElsewhere = (url, marketedList) => hostOf(url) !== null && !(productOf(url) && markets(marketedList, productOf(url)));

// Story images (the Creative Director's 1080×1920 meta.story placement) proposed a week, at most, across Instagram and Facebook.
export const storiesPerWeek = 2;

/** One skipped ad recommendation, counted in all and by its reason. */
const skip = (counts, reason) => { counts.skipped += 1; counts.skips[reason] = (counts.skips[reason] ?? 0) + 1; };

export function socialHandlers({ store, notifier, model = null, meta, linkedin = null, settings = {}, imageUrls: imageUrlsOption = [], customerTextToAi = false, publicOrigin = null, marketed = null, log = line => console.warn(line), creative = null, feed = null }) {
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
  // Approved Creative Director images and videos, served from the Hub under each asset's public token (only while it is approved or live), so Meta and
  // LinkedIn can fetch them. Without the Creative Director, or without an https public origin, nothing changes.
  const assetOrigin = /^https:\/\//i.test(publicOrigin ?? '') ? publicOrigin.replace(/\/+$/, '') : null;
  const imagePlacements = adImagePlacements;
  const videosOn = typeof store.socialVideoStage === 'function';
  // 16:9 comes only from the owner's own finished videos (Creative → Add a finished video); Instagram takes Reels, so vertical only.
  const videoPlacements = { facebook: ['meta.video_square', 'meta.video_portrait', 'meta.video_vertical', 'meta.video_landscape'], instagram: ['meta.video_vertical'],
    linkedin: ['linkedin.video_square', 'linkedin.video_portrait', 'linkedin.video_vertical', 'linkedin.video_landscape'] };
  async function approvedImages(product, platform, withVideos = false) {
    if (!creative?.approved || !assetOrigin) return [];
    try {
      return (await creative.approved({ product, platform, limit: 20 })).filter(asset => /^[0-9a-f]{64}$/.test(asset.token ?? '') &&
        ((asset.kind === 'static' && imagePlacements[platform].includes(asset.placement)) ||
          (withVideos && videosOn && asset.kind === 'video' && asset.contentType === 'video/mp4' && (platform === 'meta' ? videoPlacements.facebook : videoPlacements.linkedin).includes(asset.placement))))
        .map(asset => ({ ...asset, url: `${assetOrigin}/api/creative/a/${asset.token}.${asset.kind === 'video' ? 'mp4' : 'png'}` }));
    } catch (error) {
      if (error?.transient) throw error;
      log(JSON.stringify({ event: 'hub_social_creative_unread', code: /^[a-z][a-z_]{0,59}$/.test(error?.code ?? '') ? error.code : 'creative_error' }));
      return [];
    }
  }

  // Approved story images, per product: shown for a day on Instagram or the Facebook Page, never in the feed.
  async function storyImages(product) {
    if (!creative?.approved || !assetOrigin) return [];
    try {
      return (await creative.approved({ product, platform: 'meta', limit: 20 })).filter(asset => asset.kind === 'static' && asset.placement === 'meta.story' && /^[0-9a-f]{64}$/.test(asset.token ?? ''))
        .map(asset => ({ ...asset, url: `${assetOrigin}/api/creative/a/${asset.token}.png` }));
    } catch (error) {
      if (error?.transient) throw error;
      return [];
    }
  }

  // Articles the team published lately, linkable from that product's posts by id "article-<slug>".
  async function recentArticles(offered) {
    const byProduct = {};
    if (typeof store.socialRecentArticles !== 'function') return byProduct;
    try {
      for (const item of (await store.socialRecentArticles(45)) ?? []) {
        if (!offered.includes(item.product) || !/^[a-z0-9-]{1,120}$/.test(item.slug ?? '')) continue;
        (byProduct[item.product] ??= []).push({ id: `article-${item.slug}`, label: String(item.title ?? '').slice(0, 200), url: articleHomeUrl(item.product, item.slug) });
      }
    } catch (error) {
      if (error?.transient) throw error;
    }
    return byProduct;
  }

  // Settings → Social media → Post about new CMS data and observances: what Intel loaded in the last two weeks and what starts in three.
  async function upcomingEvents(signal) {
    if (settings.eventPosts !== true || !feed?.configured || typeof feed.releases !== 'function') return null;
    const [releases, observances] = await Promise.all([feed.releases({ sinceDays: 14, signal }).catch(() => null), feed.observances({ days: 21, signal }).catch(() => null)]);
    signal?.throwIfAborted();
    const events = {
      releases: (releases?.releases ?? []).slice(0, 5).map(item => ({ title: item.title, dataYear: item.data_year, published: item.published ?? item.loaded })),
      observances: (observances?.observances ?? []).slice(0, 6).map(item => ({ name: item.name, honors: item.audience, start: item.start, end: item.end })),
    };
    return events.releases.length || events.observances.length ? events : null;
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
    for (const product of offered) for (const platform of ['meta', 'linkedin']) creativeImages[`${product}:${platform}`] = await approvedImages(product, platform, true);
    const anyMetaCreative = offered.some(product => creativeImages[`${product}:meta`].some(asset => asset.kind === 'static' || videoPlacements.instagram.includes(asset.placement)));
    const counts = { facebook: meta.configured.pages ? weekly.facebook : 0, instagram: meta.configured.instagram && (images().length || anyMetaCreative) ? weekly.instagram : 0, linkedin: weekly.linkedin,
      // Settings → Social media → Write posts for my LinkedIn profile: the founder's own posts, each approved by the owner until the owner hands
      // founder posts over on the AI team page (then the database approves them on its own and they publish at their slot).
      ...(settings.founderPosts === true && settings.founderPostsPerWeek > 0 ? { founder: Math.min(settings.founderPostsPerWeek, 5) } : {}) };
    let posts = [];
    let performance = metaPosts() || li.configured.page ? 'read' : 'not_connected';
    for (const [on, client] of [[metaPosts(), meta], [li.configured.page, li]]) {
      if (!on) continue;
      try { posts = posts.concat(await client.recentPosts({ signal })); }
      catch (error) { if (signal?.aborted || error?.transient) throw error; performance = error?.code ?? 'social_error'; }
    }
    const ranked = rankPosts(posts, { now: moment });
    // Reach (team review 2026-11-17, stage 6): while LinkedIn refuses the team (the ads planner's own reading of the refusals), its posts
    // are emailed to paste instead of being queued to fail; and the leads each recent post brought feed the plan.
    const reach = settings.reach === true;
    let linkedinRefused = false;
    if (reach && li.configured.page && typeof store.adsPlatformRefusals === 'function') {
      try { linkedinRefused = failingPlatforms(await store.adsPlatformRefusals()).has('linkedin'); }
      catch (error) { if (error?.transient) throw error; }
    }
    let leadsByPost = [];
    if (reach && typeof store.socialPostLeads === 'function') {
      try {
        leadsByPost = ((await store.socialPostLeads(new Date(moment.getTime() - 28 * day).toISOString()))?.posts ?? [])
          .filter(post => post.platform && Number(post.leads) > 0).slice(0, 5)
          .map(post => ({ platform: post.platform, pillar: post.pillar ?? null, leads: Number(post.leads), text: String(post.firstLine ?? '').slice(0, 160) }));
      } catch (error) { if (error?.transient) throw error; }
    }
    const articles = await recentArticles(offered);
    const linkable = product => [...socialLinks(product), ...(articles[product] ?? [])];
    const articleUrls = product => (articles[product] ?? []).map(item => item.url);
    const links = Object.fromEntries(offered.map(product => [product, linkable(product).map(({ id, label }) => ({ id, label }))]));
    const events = await upcomingEvents(signal);
    const user = JSON.stringify({
      weekStarting: week, products: offered, postsToWrite: counts, links, ...(events ? { events } : {}),
      bestRecent: ranked.slice(0, 3).map(post => ({ platform: post.platform, engagement: post.engagement, text: post.text.slice(0, 240) })),
      weakestRecent: ranked.length > 3 ? ranked.slice(-2).map(post => ({ platform: post.platform, engagement: post.engagement, text: post.text.slice(0, 160) })) : [],
      recentOpenings: posts.slice(0, 12).map(post => firstLine(post.text)),
      // Leads count for more than engagement: write more like the posts that brought people to the website.
      ...(leadsByPost.length ? { postsThatBroughtLeads: leadsByPost } : {}),
    });
    const result = await runModel(task, { promptVersion: planPromptVersion, system: [{ text: planSystem, cache: true }, ...catalogBlocks(offered)], user, schema: planSchema, maxTokens: 8000, effort: effort(task),
      describe: output => `Planned ${plural(output.posts.length, 'social post')} for the week of ${week}.` }, signal);
    if (result.outcome !== 'completed') return { result: { skipped: result.outcome, week, ...(result.code ? { code: result.code } : {}) } };

    const targets = await open();
    const used = { facebook: 0, instagram: 0, linkedin: 0 };
    const rejected = {};
    const linkedin = [];
    const founder = [];
    // Founder posts handed over (the owner's "Founder posts" step): they publish at their slot without waiting. Wording only; the database decides.
    const founderOnItsOwn = trustedWith(task.agent, 'social.founder_post');
    let proposed = 0, dataPosts = 0, founderPosts = 0;
    for (const draft of result.output.posts ?? []) {
      signal?.throwIfAborted();
      if (socialProducts.includes(draft.product) && !offered.includes(draft.product)) { rejected.not_marketed = (rejected.not_marketed ?? 0) + 1; continue; }
      if (draft.platform === 'founder') {
        if (!counts.founder || founderPosts >= counts.founder || !offered.includes(draft.product)) continue;
        const founderPage = draft.linkId ? linkable(draft.product).find(link => link.id === draft.linkId) : null;
        if (draft.linkId && !founderPage) { rejected.link = (rejected.link ?? 0) + 1; continue; }
        const founderContent = reach ? postContent({ week, platform: 'founder', index: founderPosts + 1 }) : 'post';
        const founderLink = tagSocialLink(founderPage?.url ?? null, { platform: 'linkedin', product: draft.product, content: founderContent });
        const founderText = tagSocialText(withHashtags(founderLink ? `${draft.text.trim()}\n\n${founderLink}` : draft.text, draft.hashtags), { platform: 'linkedin', product: draft.product, content: founderContent });
        const founderChecked = checkSocialText(founderText, { surface: 'linkedin', product: draft.product, extraLinks: articleUrls(draft.product) });
        if (!founderChecked.ok) { rejected[founderChecked.reason] = (rejected[founderChecked.reason] ?? 0) + 1; continue; }
        founderPosts += 1;
        // Without the founder's own token the post is emailed to copy and post by hand.
        if (!li.configured.member) { founder.push({ product: draft.product, text: founderChecked.text }); continue; }
        const founderSlot = slotFor({ week, day: draft.day, platform: 'founder', index: founderPosts, now: moment });
        const founderTarget = `founder:${week}:${founderPosts}`;
        if (targets.has(`social.founder_post:${founderTarget}`)) continue;
        const founderProposal = await propose(task, { kind: 'social.founder_post', targetKind: 'social_item', targetId: founderTarget,
          preview: `Post for your own LinkedIn profile (${productNames[draft.product]}), to publish ${when(founderSlot)} ${founderOnItsOwn ? 'on its own (you handed founder posts over)' : 'once you approve it'}:\n\n${founderChecked.text}`,
          input: { product: draft.product, pillar: draft.pillar, message: founderChecked.text, scheduledFor: founderSlot, ...(reach ? { utmContent: founderContent } : {}) } });
        if (!founderProposal) break;
        if (founderProposal.created !== false) { await store.socialSchedule(founderProposal.id, null); proposed += 1; }
        continue;
      }
      if (!offered.includes(draft.product) || used[draft.platform] === undefined || used[draft.platform] >= counts[draft.platform]) continue;
      const page = draft.linkId ? linkable(draft.product).find(link => link.id === draft.linkId) : null;
      if (draft.linkId && !page) { rejected.link = (rejected.link ?? 0) + 1; continue; }
      // The data pillar is for an event the request named, once a week.
      if (draft.pillar === 'data' && (!events || dataPosts >= 1)) { rejected.data_pillar = (rejected.data_pillar ?? 0) + 1; continue; }
      // A Facebook or connected LinkedIn link travels beside the text (it renders as a card); LinkedIn copy pasted by hand carries it. While
      // LinkedIn refuses the team (reach), its posts are pasted by hand too, rather than queued to fail at publish.
      const pasted = draft.platform === 'linkedin' && (!li.configured.page || linkedinRefused);
      // Compatible approved videos come first. Other Instagram posts need an image; LinkedIn image posts attach a link thumbnail; with reach
      // a Facebook post is a photo post with its link in the text (Facebook posts were bare links, so approved creative reached only stories).
      // Approved creative images precede the brand image list (Settings → Social media).
      const pictured = ['instagram', 'linkedin', ...(reach ? ['facebook'] : [])].includes(draft.platform);
      const assetKey = `${draft.product}:${draft.platform === 'linkedin' ? 'linkedin' : 'meta'}`;
      const availableAssets = pasted ? [] : creativeImages[assetKey] ?? [];
      const approvedAsset = availableAssets.find(asset => asset.kind === 'video' && videoPlacements[draft.platform].includes(asset.placement))
        ?? (pictured ? availableAssets.find(asset => asset.kind === 'static') ?? null : null);
      // The page's address with campaign tags for this platform (links.mjs): social-<product>, and with reach the post's own utm_content.
      const content = reach ? postContent({ week, platform: draft.platform, index: used[draft.platform] + 1, assetId: approvedAsset?.id ?? null }) : 'post';
      const link = draft.platform === 'instagram' ? null : tagSocialLink(page?.url ?? null, { platform: draft.platform, product: draft.product, content });
      // A product link the model wrote into the text gets the same tags as the one beside it.
      const text = tagSocialText(withHashtags(pasted && link ? `${draft.text.trim()}\n\n${link}` : draft.text, draft.hashtags), { platform: draft.platform, product: draft.product, content });
      const checked = checkSocialText(text, { surface: draft.platform, product: draft.product, extraLinks: articleUrls(draft.product) });
      if (!checked.ok) { rejected[checked.reason] = (rejected[checked.reason] ?? 0) + 1; continue; }
      used[draft.platform] += 1;
      if (draft.pillar === 'data') dataPosts += 1;
      if (pasted) { linkedin.push({ product: draft.product, pillar: draft.pillar, text: checked.text }); continue; }
      const scheduledFor = slotFor({ week, day: draft.day, platform: draft.platform, index: used[draft.platform], now: moment });
      const targetId = `${draft.platform}:${week}:${used[draft.platform]}`;
      if (targets.has(`social.post:${targetId}`)) continue;
      const brandImages = images();
      if (draft.platform === 'instagram' && !approvedAsset && !brandImages.length) continue;
      const videoUrl = approvedAsset?.kind === 'video' ? approvedAsset.url : null;
      const imageUrl = videoUrl ? null : approvedAsset?.url ?? (pictured && brandImages.length ? brandImages[(Number(week.replaceAll('-', '')) + used[draft.platform]) % brandImages.length] : null);
      // Video posts, and Facebook photo posts, have no separate link card: put the reviewed destination in their caption.
      const captioned = videoUrl || (draft.platform === 'facebook' && imageUrl);
      const message = captioned && link && !checked.text.includes(link) ? `${checked.text}\n\n${link}` : checked.text;
      if (!checkSocialText(message, { surface: draft.platform, product: draft.product, extraLinks: articleUrls(draft.product) }).ok) { rejected.video_caption = (rejected.video_caption ?? 0) + 1; continue; }
      const proposal = await propose(task, {
        kind: 'social.post', targetKind: 'social_post', targetId,
        preview: `${labels[draft.platform]} post about ${productNames[draft.product]} (${draft.pillar}), to publish ${when(scheduledFor)}:\n\n${message}${link ? `\n\nLink: ${link}` : ''}${imageUrl ? `\n\nImage: ${approvedAsset ? `approved creative ${approvedAsset.id} (${imageUrl})` : imageUrl}` : ''}${videoUrl ? `\n\nVideo: approved creative ${approvedAsset.id} (${videoUrl})` : ''}`,
        input: { platform: draft.platform, product: draft.product, pillar: draft.pillar, message, link, imageUrl, scheduledFor, ...(videoUrl ? { videoUrl } : {}),
          ...(draft.platform === 'linkedin' && link ? { linkLabel: page.label } : {}), ...(approvedAsset ? { creativeAssetId: approvedAsset.id } : {}),
          ...(reach ? { utmContent: content } : {}) },
      });
      if (!proposal) break;
      if (approvedAsset) creativeImages[assetKey] = availableAssets.filter(asset => asset.id !== approvedAsset.id);
      if (proposal.created !== false) { await store.socialSchedule(proposal.id, null); proposed += 1; }
    }

    // Approved story images: up to two a week, Instagram first, each its own post to approve. A story shows for 24 hours.
    let stories = 0;
    const storyPlatforms = [meta.configured.instagram ? 'instagram' : null, meta.configured.pages ? 'facebook' : null].filter(Boolean);
    if (storyPlatforms.length && typeof meta.publishStory === 'function') {
      const pool = (await Promise.all(offered.map(async product => (await storyImages(product)).map(asset => ({ ...asset, product }))))).flat();
      for (let n = 1; n <= storiesPerWeek && pool.length; n += 1) {
        signal?.throwIfAborted();
        const platform = storyPlatforms[(n - 1) % storyPlatforms.length];
        const targetId = `${platform}:${week}:story${n}`;
        if (targets.has(`social.post:${targetId}`)) continue;
        const asset = pool.shift();
        const scheduledFor = slotFor({ week, day: n === 1 ? 3 : 5, platform, index: n, now: moment });
        const proposal = await propose(task, {
          kind: 'social.post', targetKind: 'social_post', targetId,
          preview: `${labels[platform]} story about ${productNames[asset.product] ?? 'CareMetric'}, to publish ${when(scheduledFor)}. A story shows for 24 hours.\n\nImage: approved creative ${asset.id} (${asset.url})`,
          input: { platform, product: asset.product, pillar: 'story', format: 'story', message: '', link: null, imageUrl: asset.url, scheduledFor, creativeAssetId: asset.id },
        });
        if (!proposal) break;
        if (proposal.created !== false) { await store.socialSchedule(proposal.id, null); proposed += 1; stories += 1; }
      }
    }

    const body = `${plural(proposed, 'post')} proposed${stories ? ` (${stories === 1 ? '1 story' : `${stories} stories`})` : ''}${linkedin.length ? `, ${plural(linkedin.length, 'LinkedIn post')} to paste` : ''}${founder.length ? `, ${plural(founder.length, 'post')} for your profile to copy` : ''}.${Object.keys(rejected).length ? ` ${Object.values(rejected).reduce((a, b) => a + b, 0)} drafts failed the checks and were dropped.` : ''}`;
    const blocks = [
      { type: 'callout', tone: 'info', title: `Social plan for the week of ${week}.`, text: body },
      { type: 'paragraph', text: proposed ? 'Approve each post in the AI team. An approved post waits for its time slot.' : 'No post is waiting: the accounts are not connected, or no draft passed the checks.' },
      ...(performance === 'read' ? [] : [{ type: 'paragraph', text: performance === 'not_connected' ? 'No social account is connected, so this plan could not learn from past posts.' : `Some past posts could not be read (${performance.replaceAll('_', ' ')}).` }]),
      ...(linkedinRefused && linkedin.length ? [{ type: 'paragraph', text: 'LinkedIn is refusing the team\'s connection, so this week\'s LinkedIn posts are here to paste instead of waiting to fail. Reconnect LinkedIn (Settings → Social media) and next week\'s go out on their own again.' }] : []),
      ...linkedin.flatMap((post, index) => [{ type: 'paragraph', text: `LinkedIn post ${index + 1} (${productNames[post.product]}, ${post.pillar})` }, { type: 'message', text: post.text }]),
      ...(founder.length ? [{ type: 'paragraph', text: `Posts for your own LinkedIn profile, to copy and post yourself (save your personal LinkedIn token on the connection card and they ${founderOnItsOwn ? 'publish at their time slots on their own instead' : 'wait for your approval instead'}):` }] : []),
      ...founder.flatMap((post, index) => [{ type: 'paragraph', text: `Your post ${index + 1} (${productNames[post.product]})` }, { type: 'message', text: post.text }]),
      ...(/^https:\/\//i.test(publicOrigin ?? '') && proposed ? [{ type: 'button', label: 'Open the AI team', url: `${publicOrigin.replace(/\/+$/, '')}/admin/team` }] : []),
    ];
    // Posts to paste or copy by hand travel only in this email, so it goes now; posts waiting for approval wait on the Team screen.
    const attention = asked || linkedin.length || founder.length ? 'now' : proposed ? 'decision' : 'update';
    const results = await notifier.send({ severity: 'info', subject: `Social plan: ${plural(proposed, 'post')} to approve`, body, blocks, dedupeKey: asked ? `social:plan:run:${task.id}` : key, agentKey: task.agentKey, taskId: task.id, attention });
    // The Creative Director turns the week's plan into ad creative (when it is switched on); a failure here never fails the plan.
    if (creative?.planned) {
      try { await creative.planned(week); } catch { log(JSON.stringify({ event: 'hub_social_creative_plan_unqueued', week })); }
    }
    return { status: proposed ? 'awaiting_approval' : 'done', result: { week, proposed, ...(stories ? { stories } : {}), ...(events ? { events: events.releases.length + events.observances.length } : {}),
      linkedin: linkedin.length, ...(linkedinRefused ? { linkedinRefused: true } : {}), ...(leadsByPost.length ? { postsWithLeads: leadsByPost.length } : {}),
      ...(founderPosts ? { founder: founderPosts } : {}), rejected, performance, delivery: results.map(item => `${item.channel}:${item.delivery}`) } };
  }

  // ---- The inbox ----------------------------------------------------------------------------------------------------------------------
  async function inbox(task, { now = () => new Date(), signal } = {}) {
    if (!metaPosts() && !li.configured.page) return { result: { skipped: 'meta_not_configured' } };
    if (task.agent?.autonomy === 'observe') return { result: { skipped: 'observe_only' } };
    const linkedinNow = li.configured.page && linkedinDue(task, li.tier);
    if (!metaPosts() && !linkedinNow) return { result: { skipped: 'linkedin_not_due' } };
    let items = [];
    const refused = [];
    let reached = 0;
    // Settings → Social media → "Read and answer comments on ads" (reach): comments on running Meta ads too. LinkedIn's sponsored posts are
    // not read (its post finder leaves them out, and the Development tier's daily calls are few).
    const adComments = settings.reach === true && settings.adComments === true;
    for (const [on, client] of [[metaPosts(), meta], [linkedinNow, li]]) {
      if (!on) continue;
      try { items = items.concat(await client.recentInbox({ signal, now: now(), ...(client === meta && adComments ? { adComments: true } : {}) })); reached += 1; }
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
        payload: { platform: item.platform, kind: item.kind, id: item.id, parentId: item.parentId, url: item.url ?? null, ...(item.ad === true ? { ad: true } : {}) }, priority: 4, sourceKind: 'agent', sourceRef: `${item.platform}:${item.kind}`,
      });
      if (id) fresh[item.kind] += 1;
    }
    const total = fresh.comment + fresh.message;
    if (total && notifier) {
      await notifier.send({
        severity: 'info', subject: `${total} new social ${total === 1 ? 'comment or message' : 'comments and messages'}`,
        body: `${plural(fresh.comment, 'comment')} and ${plural(fresh.message, 'private message')} arrived on Facebook, Instagram or LinkedIn.\n\n${draftingOn() ? 'Drafted replies wait for you in the AI team; anything that needs you personally is left for you.' : 'Answer them on the platforms. Turning on customer text to AI lets the team draft replies for you to approve.'}`,
        dedupeKey: `social:inbox:${task.id}`, agentKey: task.agentKey, taskId: task.id, attention: 'decision',
      });
    }
    return { result: { seen: items.length, enqueued: total, comments: fresh.comment, messages: fresh.message, ...(refused.length ? { refused } : {}) } };
  }

  async function tellAboutAccess(task, code, moment) {
    if (!notifier || !['meta_token_invalid', 'meta_permission', 'linkedin_token_invalid', 'linkedin_permission'].includes(code)) return;
    const onLinkedIn = code.startsWith('linkedin_');
    await notifier.send({ severity: 'warning', subject: `The Social Media Manager cannot reach ${onLinkedIn ? 'LinkedIn' : 'Meta'}`,
      body: onLinkedIn
        ? `LinkedIn refused the Social Media Manager's token (${code.replaceAll('_', ' ')}). Renew the token or its permissions in LinkedIn, then open Settings → Social media → LinkedIn and Save and check the updated credentials; until then LinkedIn is not read.`
        : `Meta refused the Social Media Manager's token (${code.replaceAll('_', ' ')}). Renew the system user token or its permissions in Meta, then open Settings → Social media → Meta and Save and check the updated credentials; until then no comment or message is read.`,
      dedupeKey: `social:access:${code}:${easternDate(moment)}`, agentKey: task.agentKey, taskId: task.id, attention: 'now' });
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
        dedupeKey: `social:phi:${item.platform}:${item.id}`, agentKey: task.agentKey, taskId: task.id, attention: 'now' });
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
      promptVersion: replyPromptVersion, system: [{ text: replySystem, cache: true }, ...catalogBlocks(offered)], schema: replySchema, maxTokens: 2000, effort: effort(task),
      user: replyUserMessage({ platform: labels[item.platform], kind: item.kind, words: item.kind === 'message' ? 100 : 50, links: offered.flatMap(product => socialLinks(product)), text, history }),
      describe: output => `Read a ${where}: ${output.intent}${output.needsOwner ? ', needs the owner' : ''}${output.hide ? ', hide' : ''}.`,
    }, signal);
    if (result.outcome !== 'completed') return { result: { outcome: 'left_for_owner', reason: result.code ?? result.outcome, platform: item.platform, kind: item.kind } };
    const reading = result.output;
    if (reading.possiblePhi) return personal();
    // Interest (reach, team review 2026-11-17, stage 6): an interested or pricing comment or message is recorded once and the owner is told,
    // with the link, whatever happens to the reply. It had only a reply draft and a count in an email. Nothing the person wrote is kept.
    if (settings.reach === true && interestIntents.includes(reading.intent) && !reading.hide && typeof store.socialInterestRecord === 'function') {
      const product = socialProducts.includes(reading.product) ? reading.product : null;
      let fresh = false;
      try {
        fresh = await store.socialInterestRecord({ platform: item.platform, itemId: item.id, url: /^https:\/\/[^\s"<>]+$/.test(item.url ?? '') ? item.url.slice(0, 500) : null,
          product, intent: reading.intent, ad: item.ad === true }) === true;
      } catch (error) { if (signal?.aborted || error?.transient) throw error; }
      if (fresh && notifier) {
        await notifier.send({ severity: 'info', subject: `${reading.intent === 'pricing' ? 'A price question' : 'Interest'} on ${labels[item.platform]}${item.ad === true ? ' (on an ad)' : ''}`,
          body: `A ${where}${item.ad === true ? ' on one of your ads' : ''} reads as ${reading.intent === 'pricing' ? 'a question about price' : 'interest'}${product ? ` in ${productNames[product]}` : ''}. ${draftingOn() ? 'A reply waits for you in the AI team unless it needs you personally.' : 'Answer it on the platform.'} It has no email address, so it is not on the lead desk: the reply is how they hear back.${item.url ? `\n\nOpen it: ${item.url}` : ''}`,
          dedupeKey: `social:interest:${item.platform}:${item.id}`.slice(0, 200), agentKey: task.agentKey, taskId: task.id, attention: 'now' });
      }
    }
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
    // Why each recommendation was skipped is counted by reason (review 2026-11-17: 18 of 18 were skipped daily and nothing said why), and
    // the access error each platform answered is kept by platform, for the flight planner (ads/index.mjs) and the watchdog.
    const counts = { pause: 0, budget: 0, create: 0, skipped: 0, rejected: 0, skips: {} };
    let adsetCount = 0;
    let recommendationCount = 0;
    const refused = [];
    const refusedBy = {};
    for (const source of sources) {
      let overview;
      try { overview = await source.client.adsOverview({ signal, now: moment }); }
      catch (error) {
        if (signal?.aborted || error?.transient) throw error;
        refused.push(error?.code ?? 'social_error');
        refusedBy[source.platform] = /^[a-z][a-z_]{0,59}$/.test(error?.code ?? '') ? error.code : 'social_error';
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
          if (targets.has(`social.ad_pause:${source.key(rec.adId)}`)) { skip(counts, 'already_proposed'); continue; }
          if (await propose(task, { kind: 'social.ad_pause', targetKind: 'social_ad', targetId: source.key(rec.adId),
            preview: `Pause the ${source.name} ad "${rec.adName}" in the ${where} "${rec.adsetName}": it ${rec.reason}.`, input: { adId: rec.adId, adsetId: rec.adsetId, reason: rec.reason, ...platform } })) counts.pause += 1;
        } else if (rec.kind === 'budget') {
          if (targets.has(`social.ad_budget:${source.key(rec.adsetId)}`)) { skip(counts, 'already_proposed'); continue; }
          // No more money for an ad set that sends people to a product the team is not marketing.
          if (overview.ads.some(ad => ad.adsetId === rec.adsetId && leadsElsewhere(ad.copy?.link, marketedList))) { skip(counts, 'leads_elsewhere'); continue; }
          if (await propose(task, { kind: 'social.ad_budget', targetKind: 'social_adset', targetId: source.key(rec.adsetId),
            preview: `Raise the daily budget of the ${source.name} ${where} "${rec.adsetName}" from ${money(rec.from)} to ${money(rec.to)}: ${rec.reason}. Your cap is ${money(settings.maxDailyBudgetCents)} a day. Only you can approve a budget change.`,
            input: { adsetId: rec.adsetId, from: rec.from, to: rec.to, reason: rec.reason, ...platform } })) counts.budget += 1;
        } else if (rec.kind === 'refresh') {
          if ([...targets].some(value => value.startsWith(`social.ad_create:${source.key(rec.adsetId)}:`))) { skip(counts, 'already_proposed'); continue; }
          counts.create += await refresh(task, rec, overview, today, signal, counts, source, marketedList);
        }
      }
    }
    if (!adsetCount && refused.length === sources.length) return { result: { skipped: refused[0], refusedBy } };
    const proposed = counts.pause + counts.budget + counts.create;
    if (proposed && notifier) {
      await notifier.send({ severity: 'info', subject: `Ad review: ${plural(proposed, 'change')} to approve`,
        body: `${plural(counts.pause, 'ad')} to pause, ${plural(counts.create, 'new ad')} to start and ${plural(counts.budget, 'budget change')}, from the last seven days' results (rules ${rulesVersion}). Open the AI team to review them.`,
        dedupeKey: task.sourceKind === 'owner' ? `social:ads:run:${task.id}` : `social:ads:${today}`, agentKey: task.agentKey, taskId: task.id,
        attention: task.sourceKind === 'owner' ? 'now' : 'decision' });
    }
    await recordRun({ store, log }, task, { promptVersion: rulesVersion, summary: `Reviewed ${plural(adsetCount, 'ad set')}: ${plural(recommendationCount, 'recommendation')}, ${plural(proposed, 'change')} proposed.` });
    // The review finishes once it has proposed: its proposals wait on the Team screen, and tomorrow's review is not held back by them.
    // A budget change is never approved on its own, so a task that waited for it would stop the daily review, and with it the pausing
    // of ads that are losing money, for up to seven days. What is already proposed is skipped above (`targets`), never proposed twice.
    return { status: 'done', result: { adsets: adsetCount, recommendations: recommendationCount, ...counts, ...(refused.length ? { refused, refusedBy } : {}) } };
  }

  async function refresh(task, rec, overview, today, signal, counts, source, marketedList) {
    const base = overview.ads.find(ad => ad.id === rec.basedOn);
    const product = productOf(base?.copy?.link);
    if (!base) { skip(counts, 'no_base_ad'); return 0; }
    // An ad that links to no CareMetric product page (an ad the Hub did not make, a lead form) or to a product the team is not marketing.
    if (!product) { skip(counts, 'leads_elsewhere'); return 0; }
    if (!markets(marketedList, product)) { skip(counts, 'product_not_marketed'); return 0; }
    // Approved Creative Director creative for this product and platform is used before writing new copy: its words already passed the
    // creative checks, its image is the one the owner approved, and its link carries the asset's id for the weekly report.
    const fromCreative = await creativeAd(task, rec, overview, today, source, product);
    if (fromCreative !== null) return fromCreative;
    // Already approved copy and images need no model. Only the fallback that writes fresh copy needs an AI connection.
    if (!model?.configured) { skip(counts, 'model_not_configured'); return 0; }
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
    const result = await runModel(task, { promptVersion: adPromptVersion, system: [{ text: adSystem, cache: true }, ...catalogBlocks([product])], user, schema: adSchema, maxTokens: 3000, effort: effort(task),
      describe: output => `Wrote ${plural(output.variants.length, 'ad variant')} for a ${source.name} ad set.` }, signal);
    if (result.outcome !== 'completed') { skip(counts, `model_${/^[a-z_]{1,40}$/.test(result.outcome ?? '') ? result.outcome : 'error'}`); return 0; }
    let made = 0;
    const linkedinAd = source.platform === 'linkedin';
    for (const [index, variant] of (result.output.variants ?? []).slice(0, 2).entries()) {
      const parts = [checkSocialText(variant.message, { surface: 'ad_message', product }),
        checkSocialText(variant.headline, { surface: linkedinAd ? 'ad_linkedin_headline' : 'ad_headline', product }),
        checkSocialText(variant.description, { surface: linkedinAd ? 'ad_linkedin_description' : 'ad_description', product })];
      if (parts.some(part => !part.ok) || parts[0].text.length < 60) { counts.rejected += 1; continue; }
      const [message, headline, description] = parts.map(part => part.text);
      const callToAction = variant.callToAction === 'SIGN_UP' ? 'SIGN_UP' : 'LEARN_MORE';
      const name = `${adset?.name ?? 'Ad set'} · ${String(variant.angle ?? 'variant').slice(0, 30)} · ${today}`;
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
    // An approved asset stays available after publication. Refreshing a tired ad must not publish that same creative again in its
    // ad set, including a variant already tested and paused. Other ad sets may still use it.
    const used = new Set(overview.ads.filter(ad => ad.adsetId === rec.adsetId).flatMap(ad => {
      try { return [new URL(ad.copy?.link).searchParams.get('utm_content')]; } catch { return []; }
    }));
    for (const asset of assets) {
      if (used.has(asset.id)) continue;
      // Each platform's own lengths: LinkedIn creative is written longer than a Meta headline allows (content.mjs adCopyFromCreative).
      const copy = adCopyFromCreative(asset, { product, linkedin: linkedinAd });
      if (!copy) continue;
      const { message, headline, description, callToAction } = copy;
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
    // Reach (team review 2026-11-17, stage 6): what the week's posts brought, not only their likes: website leads by each post's own
    // utm_content, and comments read as interest or a price question.
    let reached = null;
    if (settings.reach === true && typeof store.socialPostLeads === 'function') {
      try { reached = await store.socialPostLeads(new Date(moment.getTime() - 7 * day).toISOString()); }
      catch (error) { if (error?.transient) throw error; notes.push('Leads from posts could not be read.'); }
    }
    const postLeads = (reached?.posts ?? []).reduce((sum, post) => sum + (Number(post.leads) || 0), 0);
    const platforms = ['facebook', 'instagram', ...(li.configured.page ? ['linkedin'] : [])];
    const byPlatform = platforms.map(platform => { const mine = posts.filter(post => post.platform === platform); return [platform, mine.length, mine.reduce((sum, post) => sum + post.engagement, 0)]; });
    const spend = adsets.reduce((sum, item) => sum + item.spendCents, 0);
    const results = adsets.reduce((sum, item) => sum + item.results, 0);
    const interested = Number(reached?.interested) || 0;
    const brought = reached ? ` They brought ${plural(postLeads, 'website lead')}, and ${interested} ${interested === 1 ? 'comment or message' : 'comments or messages'} read as interest or a price question.` : '';
    const body = `${plural(posts.length, 'post')} in the last 7 days with ${posts.reduce((sum, post) => sum + post.engagement, 0)} engagement points; ads spent ${money(spend)} for ${plural(results, 'result')}.${brought} ${plural(waiting, 'change')} waiting for you.`;
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
      dedupeKey: asked ? `social:report:run:${task.id}` : `social:report:${week}`, agentKey: task.agentKey, taskId: task.id, attention: asked ? 'now' : 'update' });
    if (!asked && sent.every(item => item.delivery === 'duplicate')) return { result: { skipped: sent.some(delivered) ? 'already_sent' : 'earlier_attempt_unconfirmed', week } };
    await recordRun({ store, log }, task, { promptVersion: 'social-report.2', summary: `Sent the weekly social report: ${body}` });
    return { result: { week, posts: posts.length, spendCents: spend, results, waiting, ...(reached ? { postLeads, interested } : {}) } };
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
