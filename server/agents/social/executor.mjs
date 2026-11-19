/**
 * Carries out the Social Media Manager's approved actions on Meta and LinkedIn (an action's `platform` "linkedin" goes to LinkedIn). Each runs once (the database hands an approved action to one
 * caller); none needs the owner's session, so approved and handed-over work runs on the background drain.
 *
 * - social.post: waits for its time slot (an early start is handed back with the same hold), re-checks the words, then publishes.
 * - social.reply: reads the comment or message again first, and refuses if someone already answered it, it was deleted, or (for a
 *   private message) Meta's 24-hour reply window has closed. The reply goes to the person who wrote the latest message.
 * - social.moderate: hides the comment. On LinkedIn, which has no "hide", it deletes it, and because a deletion cannot be undone, only on
 *   the owner's own approval (never an automatic one).
 * - social.ad_pause and social.ad_create: pause an ad, or create a new ad inside an ad set's existing budget.
 * - social.ad_budget: only an owner's approval (never an automatic one), only up to the owner's daily cap and at most 25% above the
 *   budget it was proposed from, and only while the ad set's budget is still that amount.
 *
 * A request Meta or LinkedIn may have received but did not confirm is never retried: it fails as `social_unconfirmed` and the owner
 * is asked to look before trying again.
 */
import { checkSocialText, adCopyFromCreative, adImagePlacements } from './content.mjs';
import { metaId } from './meta.mjs';
import { linkedinComment, linkedinPost } from './linkedin.mjs';
import { publishApprovedVideo } from './video.mjs';

const failure = code => Object.assign(new Error('The social action was not carried out.'), { code });
/**
 * Words that no longer pass the writing check (content.mjs, checkSocialText) when they are about to go out: a rule may have changed since
 * they were approved. The code names the check that refused them (`post_check_long_sentence`, `reply_check_link`), so the owner's
 * screen can say why (src/admin/teamProtocol.ts). `changed`: the words pass, but checking them again would publish different words
 * from the ones approved.
 */
const checkFailure = (what, checked) => failure(`${what}_check_${checked.ok ? 'changed' : /^[a-z][a-z_]{0,40}$/.test(checked.reason ?? '') ? checked.reason : 'refused'}`);
const deferred = () => Object.assign(new Error('The post waits for its time slot.'), { code: 'action_deferred' });
const ctas = new Set(['LEARN_MORE', 'SIGN_UP']);

export function socialExecutors({ meta, linkedin = null, settings = {}, notifier = null, now = () => new Date(), log = line => console.warn(line), creative = null, store = null, publicOrigin = null, handover = false }) {
  // A post or ad made from approved Creative Director creative marks the asset live; a failure to record that never fails the publish.
  const markLive = async (input, id) => {
    if (!creative?.live || !/^[0-9a-f-]{36}$/.test(input?.creativeAssetId ?? '')) return;
    try { await creative.live(input.creativeAssetId, String(id ?? '')); } catch { log(JSON.stringify({ event: 'hub_social_creative_live_unrecorded' })); }
  };
  // LinkedIn is optional: without it, a LinkedIn action is refused as not configured.
  const li = linkedin ?? { configured: { page: false, ads: false } };
  const onLinkedIn = input => input?.platform === 'linkedin';
  async function careful(execution, work) {
    try {
      return await work();
    } catch (error) {
      if (['meta_unconfirmed', 'linkedin_unconfirmed', 'social_unconfirmed'].includes(error?.code)) {
        try {
          await notifier?.send({ severity: 'warning', subject: `Check ${error.code === 'linkedin_unconfirmed' || execution.input?.platform === 'linkedin' ? 'LinkedIn' : 'Meta'} before trying a social action again`,
            body: 'Meta or LinkedIn did not confirm a post, reply or ad change the Social Media Manager made. It may or may not have happened: look at your Page, Instagram, LinkedIn or the ads manager before approving it again.',
            dedupeKey: `social:unconfirmed:${execution.id}`, agentKey: execution.agentKey, taskId: execution.taskId, attention: 'now' });
        } catch { log(JSON.stringify({ event: 'hub_agent_social_warning_unsent', action_id: execution.id })); }
        throw failure('social_unconfirmed');
      }
      throw error;
    }
  }
  const ready = part => { if (!meta?.configured?.[part]) throw failure('meta_not_configured'); };
  const readyLinkedIn = part => { if (!li.configured?.[part]) throw failure('linkedin_not_configured'); };

  return {
    'social.post': async execution => {
      const input = execution.input ?? {};
      if (!['facebook', 'instagram', 'linkedin'].includes(input.platform)) throw failure('invalid_post');
      if (onLinkedIn(input)) readyLinkedIn('page'); else ready(input.platform === 'instagram' ? 'instagram' : 'pages');
      const due = Date.parse(input.scheduledFor ?? '');
      if (Number.isFinite(due) && due - now().getTime() > 2 * 60_000) throw deferred();
      // A story: an approved image alone, no text and no link, on Instagram or the Facebook Page.
      if (input.format === 'story') {
        if (input.platform === 'linkedin' || input.message !== '' || input.link || !/^https:\/\//.test(input.imageUrl ?? '') || typeof meta?.publishStory !== 'function') throw failure('invalid_post');
        const published = await careful(execution, () => meta.publishStory({ platform: input.platform, imageUrl: input.imageUrl }));
        await markLive(input, published.id);
        return { published: true, id: published.id, story: true };
      }
      // A link to one of the product's own published articles is allowed beside the product's pages.
      const extraLinks = input.link ? [input.link] : [];
      const checked = checkSocialText(input.message, { surface: input.platform, product: input.product ?? null, extraLinks });
      if (!checked.ok || checked.text !== input.message) throw checkFailure('post', checked);
      if (input.platform === 'instagram' && !input.videoUrl && !/^https:\/\//.test(input.imageUrl ?? '')) throw failure('image_missing');
      // The link beside a post: one of the product's own pages, as written or with well-formed campaign tags (links.mjs), nothing else.
      if (input.link && (!/^https:\/\//.test(input.link) || !checkSocialText(`Start here: ${input.link}`, { surface: 'facebook', product: input.product ?? null, extraLinks }).ok)) throw failure('post_check_link');
      if (input.imageUrl && !/^https:\/\//.test(input.imageUrl)) throw failure('invalid_post');
      if (input.videoUrl) {
        const published = await careful(execution, () => publishApprovedVideo(execution, { store, publicOrigin, meta, linkedin: li, now }));
        await markLive(input, published.id);
        return { published: true, id: published.id, video: true };
      }
      let published;
      try {
        published = await careful(execution, () => (onLinkedIn(input)
          ? li.publishPost({ message: input.message, link: input.link ?? null, linkTitle: input.linkLabel ?? null, imageUrl: input.imageUrl ?? null })
          : meta.publishPost({ platform: input.platform, message: input.message, link: input.link ?? null, imageUrl: input.imageUrl ?? null })));
      } catch (error) {
        // A LinkedIn post refused for the team's sign-in or permission is not lost (reach, team review 2026-11-17, stage 6): the owner gets
        // it to paste, its link included. It still fails here, with LinkedIn's code, so nothing claims it was published.
        if (settings.reach === true && onLinkedIn(input) && ['linkedin_token_invalid', 'linkedin_permission'].includes(error?.code) && notifier) {
          const text = input.link && !input.message.includes(input.link) ? `${input.message}\n\n${input.link}` : input.message;
          try {
            await notifier.send({ severity: 'warning', subject: 'A LinkedIn post to paste: LinkedIn refused the team',
              body: `LinkedIn refused the team's connection (${error.code.replaceAll('_', ' ')}) when this approved post was due, so here it is to paste on the LinkedIn Page yourself. Reconnect LinkedIn (Settings → Social media) and the next posts go out on their own.`,
              blocks: [{ type: 'paragraph', text: 'Paste this on the LinkedIn Page:' }, { type: 'message', text }],
              dedupeKey: `social:linkedin:paste:${execution.id}`, agentKey: execution.agentKey, taskId: execution.taskId, attention: 'now' });
          } catch { log(JSON.stringify({ event: 'hub_social_linkedin_paste_unsent', action_id: execution.id })); }
        }
        throw error;
      }
      await markLive(input, published.id);
      return { published: true, id: published.id };
    },

    // A post on the founder's own LinkedIn profile: approved by the owner, or approved automatically while the owner has handed founder
    // posts over (the database admits that only while the step is automatic). An automatic approval is checked again just before it publishes.
    'social.founder_post': async execution => {
      const input = execution.input ?? {};
      if (execution.autoApproved === true && !handover) throw failure('approval_required');
      if (!li.configured?.member || typeof li.publishMemberPost !== 'function') throw failure('linkedin_not_configured');
      const due = Date.parse(input.scheduledFor ?? '');
      if (Number.isFinite(due) && due - now().getTime() > 2 * 60_000) throw deferred();
      const extraLinks = String(input.message ?? '').match(/https:\/\/[^\s]+/g) ?? [];
      const checked = checkSocialText(input.message, { surface: 'linkedin', product: input.product ?? null, extraLinks });
      if (!checked.ok || checked.text !== input.message) throw checkFailure('post', checked);
      // Paused, moved off Act or "Keep approving" since it was approved: it no longer goes out on its own.
      if (execution.autoApproved === true && !(typeof store?.actionTrusted === 'function' && await store.actionTrusted(execution.id, execution.execution ?? null) === true)) {
        throw failure('approval_required');
      }
      const published = await careful(execution, () => li.publishMemberPost({ message: input.message }));
      return { published: true, id: published.id, founder: true };
    },

    'social.reply': async execution => {
      const input = execution.input ?? {};
      if (onLinkedIn(input)) readyLinkedIn('page'); else ready(input.platform === 'instagram' ? 'instagram' : 'pages');
      const client = onLinkedIn(input) ? li : meta;
      const surface = input.kind === 'message' ? 'message' : 'comment';
      const checked = checkSocialText(input.message, { surface, product: input.product ?? null });
      if (!checked.ok || checked.text !== input.message) throw checkFailure('reply', checked);
      const read = await client.readItem({ platform: input.platform, kind: input.kind, id: input.id, parentId: input.parentId }, { now: now() });
      if (read.gone) throw failure('item_gone');
      if (read.answered || read.fromPage) throw failure('already_answered');
      if (input.kind === 'message' && (!read.open || !read.recipient)) throw failure('window_closed');
      const sent = await careful(execution, () => client.reply({ platform: input.platform, kind: input.kind, id: input.id, parentId: input.parentId ?? null, recipient: read.recipient ?? null, message: input.message }));
      return { replied: true, id: sent.id };
    },

    'social.moderate': async execution => {
      const input = execution.input ?? {};
      if (onLinkedIn(input)) {
        // LinkedIn has no "hide": the comment is deleted.
        if (input.operation !== 'delete' || input.kind !== 'comment' || !linkedinComment(input.id) || !linkedinPost(input.parentId)) throw failure('invalid_moderation');
        if (execution.autoApproved) throw failure('auto_approved_refused');
        readyLinkedIn('page');
        await careful(execution, () => li.remove({ id: input.id, parentId: input.parentId }));
        return { deleted: true };
      }
      if (input.operation !== 'hide' || input.kind !== 'comment' || !metaId(input.id)) throw failure('invalid_moderation');
      ready(input.platform === 'instagram' ? 'instagram' : 'pages');
      await careful(execution, () => meta.hide({ platform: input.platform, id: input.id }));
      return { hidden: true };
    },

    'social.ad_pause': async execution => {
      const input = execution.input ?? {};
      if (onLinkedIn(input)) {
        readyLinkedIn('ads');
        if (!/^\d{1,30}$/.test(input.adId ?? '') || execution.targetId !== `linkedin:${input.adId}`) throw failure('invalid_ad');
        await careful(execution, () => li.pauseAd(input.adId));
        return { paused: true };
      }
      ready('ads');
      if (!metaId(input.adId) || input.adId !== execution.targetId) throw failure('invalid_ad');
      await careful(execution, () => meta.pauseAd(input.adId));
      return { paused: true };
    },

    'social.ad_create': async execution => {
      const input = execution.input ?? {};
      if (onLinkedIn(input)) readyLinkedIn('ads'); else ready('ads');
      const validSet = onLinkedIn(input) ? /^\d{1,30}$/.test(input.adsetId ?? '') : Boolean(metaId(input.adsetId));
      if (!validSet || !ctas.has(input.callToAction) || !/^https:\/\//.test(input.link ?? '')) throw failure('invalid_ad');
      // The same lengths the ad was proposed under: LinkedIn's for a LinkedIn ad, Meta's otherwise (content.mjs `limits`).
      const adSurfaces = onLinkedIn(input) ? [['message', 'ad_message'], ['headline', 'ad_linkedin_headline'], ['description', 'ad_linkedin_description']]
        : [['message', 'ad_message'], ['headline', 'ad_headline'], ['description', 'ad_description']];
      const parts = adSurfaces.map(([field, surface]) => checkSocialText(input[field], { surface, product: input.product ?? null }));
      if (parts.some(part => !part.ok) || !checkSocialText(`Start here: ${input.link}`, { surface: 'facebook', product: input.product ?? null }).ok) throw failure('invalid_ad');
      // Refreshes need the same last-moment approval check as a campaign's first ad.
      // An unavailable/older snapshot fails closed before any provider write.
      if (input.creativeAssetId) {
        if (typeof store?.creativeLiveAssets !== 'function') throw failure('ad_creative_changed');
        const platform = onLinkedIn(input) ? 'linkedin' : 'meta';
        const asset = ((await store.creativeLiveAssets([input.product])) ?? []).find(item => item.id === input.creativeAssetId);
        const current = asset && adCopyFromCreative(asset, { product: input.product, linkedin: onLinkedIn(input) });
        const origin = /^https:\/\//i.test(publicOrigin ?? '') ? publicOrigin.replace(/\/+$/, '') : null;
        if (!asset || !['approved', 'live'].includes(asset.status) || asset.product !== input.product || asset.platform !== platform
          || asset.kind !== 'static' || !adImagePlacements[platform].includes(asset.placement) || !/^[0-9a-f]{64}$/.test(asset.token ?? '')
          || !current || Object.keys(current).some(key => current[key] !== input[key]) || !origin || input.imageHash
          || input.imageUrl !== `${origin}/api/creative/a/${asset.token}.png`) throw failure('ad_creative_changed');
      }
      const created = await careful(execution, () => (onLinkedIn(input) ? li : meta).createAd({ adsetId: input.adsetId, name: String(input.name ?? 'CareMetric ad'), message: input.message, headline: input.headline,
        description: input.description, link: input.link, imageHash: typeof input.imageHash === 'string' ? input.imageHash : null,
        imageUrl: /^https:\/\//.test(input.imageUrl ?? '') ? input.imageUrl : null, callToAction: input.callToAction }));
      await markLive(input, created.id);
      return { created: true, id: created.id };
    },

    'social.ad_budget': async execution => {
      const input = execution.input ?? {};
      if (onLinkedIn(input)) readyLinkedIn('ads'); else ready('ads');
      const client = onLinkedIn(input) ? li : meta;
      // Money moves only on the owner's own approval. The database refuses an automatic approval of this kind as well.
      if (execution.autoApproved) throw failure('auto_approved_refused');
      const cap = Number(settings.maxDailyBudgetCents ?? 0);
      const from = Number(input.from), to = Number(input.to);
      const validSet = onLinkedIn(input) ? /^\d{1,30}$/.test(input.adsetId ?? '') : Boolean(metaId(input.adsetId));
      if (!validSet || !Number.isInteger(from) || !Number.isInteger(to) || from <= 0 || to <= from) throw failure('invalid_budget');
      if (!(cap > 0) || to > cap) throw failure('over_budget_cap');
      if (to > Math.round(from * 1.25)) throw failure('budget_step_too_large');
      const current = await client.readAdset(input.adsetId);
      if (current.dailyBudget !== from) throw failure('budget_changed');
      await careful(execution, () => client.setDailyBudget(input.adsetId, to, { currency: current.currency ?? 'USD' }));
      return { dailyBudget: to };
    },
  };
}
