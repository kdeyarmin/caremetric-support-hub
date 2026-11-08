/**
 * Carries out the Social Media Manager's approved actions on Meta. Each runs once (the database hands an approved action to one
 * caller); none needs the owner's session, so approved and handed-over work runs on the background drain.
 *
 * - social.post: waits for its time slot (an early start is handed back with the same hold), re-checks the words, then publishes.
 * - social.reply: reads the comment or message again first, and refuses if someone already answered it, it was deleted, or (for a
 *   private message) Meta's 24-hour reply window has closed. The reply goes to the person who wrote the latest message.
 * - social.moderate: hides the comment.
 * - social.ad_pause and social.ad_create: pause an ad, or create a new ad inside an ad set's existing budget.
 * - social.ad_budget: only an owner's approval (never an automatic one), only up to the owner's daily cap and at most 25% above the
 *   budget it was proposed from, and only while the ad set's budget is still that amount.
 *
 * A request Meta may have received but did not confirm is never retried: it fails as `social_unconfirmed` and the owner is asked to
 * look before trying again.
 */
import { checkSocialText } from './content.mjs';
import { metaId } from './meta.mjs';

const failure = code => Object.assign(new Error('The social action was not carried out.'), { code });
const deferred = () => Object.assign(new Error('The post waits for its time slot.'), { code: 'action_deferred' });
const ctas = new Set(['LEARN_MORE', 'SIGN_UP']);

export function socialExecutors({ meta, settings = {}, notifier = null, now = () => new Date(), log = line => console.warn(line) }) {
  async function careful(execution, work) {
    try {
      return await work();
    } catch (error) {
      if (error?.code === 'meta_unconfirmed') {
        try {
          await notifier?.send({ severity: 'warning', subject: 'Check Meta before trying a social action again',
            body: 'Meta did not confirm a post, reply or ad change the Social Media Manager made. It may or may not have happened: look at your Page, Instagram or Ads Manager before approving it again.',
            dedupeKey: `social:unconfirmed:${execution.id}`, agentKey: execution.agentKey, taskId: execution.taskId });
        } catch { log(JSON.stringify({ event: 'hub_agent_social_warning_unsent', action_id: execution.id })); }
        throw failure('social_unconfirmed');
      }
      throw error;
    }
  }
  const ready = part => { if (!meta?.configured?.[part]) throw failure('meta_not_configured'); };

  return {
    'social.post': async execution => {
      const input = execution.input ?? {};
      if (!['facebook', 'instagram'].includes(input.platform)) throw failure('invalid_post');
      ready(input.platform === 'instagram' ? 'instagram' : 'pages');
      const due = Date.parse(input.scheduledFor ?? '');
      if (Number.isFinite(due) && due - now().getTime() > 2 * 60_000) throw deferred();
      const checked = checkSocialText(input.message, { surface: input.platform, product: input.product ?? null });
      if (!checked.ok || checked.text !== input.message) throw failure('invalid_post');
      if (input.platform === 'instagram' && !/^https:\/\//.test(input.imageUrl ?? '')) throw failure('image_missing');
      if (input.link && input.platform === 'facebook' && !/^https:\/\//.test(input.link)) throw failure('invalid_post');
      const published = await careful(execution, () => meta.publishPost({ platform: input.platform, message: input.message, link: input.link ?? null, imageUrl: input.imageUrl ?? null }));
      return { published: true, id: published.id };
    },

    'social.reply': async execution => {
      const input = execution.input ?? {};
      ready(input.platform === 'instagram' ? 'instagram' : 'pages');
      const surface = input.kind === 'message' ? 'message' : 'comment';
      const checked = checkSocialText(input.message, { surface, product: input.product ?? null });
      if (!checked.ok || checked.text !== input.message) throw failure('invalid_reply');
      const read = await meta.readItem({ platform: input.platform, kind: input.kind, id: input.id, parentId: input.parentId }, { now: now() });
      if (read.gone) throw failure('item_gone');
      if (read.answered || read.fromPage) throw failure('already_answered');
      if (input.kind === 'message' && (!read.open || !read.recipient)) throw failure('window_closed');
      const sent = await careful(execution, () => meta.reply({ platform: input.platform, kind: input.kind, id: input.id, recipient: read.recipient ?? null, message: input.message }));
      return { replied: true, id: sent.id };
    },

    'social.moderate': async execution => {
      const input = execution.input ?? {};
      if (input.operation !== 'hide' || input.kind !== 'comment' || !metaId(input.id)) throw failure('invalid_moderation');
      ready(input.platform === 'instagram' ? 'instagram' : 'pages');
      await careful(execution, () => meta.hide({ platform: input.platform, id: input.id }));
      return { hidden: true };
    },

    'social.ad_pause': async execution => {
      const input = execution.input ?? {};
      ready('ads');
      if (!metaId(input.adId) || input.adId !== execution.targetId) throw failure('invalid_ad');
      await careful(execution, () => meta.pauseAd(input.adId));
      return { paused: true };
    },

    'social.ad_create': async execution => {
      const input = execution.input ?? {};
      ready('ads');
      if (!metaId(input.adsetId) || !ctas.has(input.callToAction) || !/^https:\/\//.test(input.link ?? '')) throw failure('invalid_ad');
      const parts = [['message', 'ad_message'], ['headline', 'ad_headline'], ['description', 'ad_description']].map(([field, surface]) => checkSocialText(input[field], { surface, product: input.product ?? null }));
      if (parts.some(part => !part.ok) || !checkSocialText(`Start here: ${input.link}`, { surface: 'facebook', product: input.product ?? null }).ok) throw failure('invalid_ad');
      const created = await careful(execution, () => meta.createAd({ adsetId: input.adsetId, name: String(input.name ?? 'CareMetric ad'), message: input.message, headline: input.headline,
        description: input.description, link: input.link, imageHash: typeof input.imageHash === 'string' ? input.imageHash : null, callToAction: input.callToAction }));
      return { created: true, id: created.id };
    },

    'social.ad_budget': async execution => {
      const input = execution.input ?? {};
      ready('ads');
      // Money moves only on the owner's own approval. The database refuses an automatic approval of this kind as well.
      if (execution.autoApproved) throw failure('auto_approved_refused');
      const cap = Number(settings.maxDailyBudgetCents ?? 0);
      const from = Number(input.from), to = Number(input.to);
      if (!metaId(input.adsetId) || !Number.isInteger(from) || !Number.isInteger(to) || from <= 0 || to <= from) throw failure('invalid_budget');
      if (!(cap > 0) || to > cap) throw failure('over_budget_cap');
      if (to > Math.round(from * 1.25)) throw failure('budget_step_too_large');
      const current = await meta.readAdset(input.adsetId);
      if (current.dailyBudget !== from) throw failure('budget_changed');
      await careful(execution, () => meta.setDailyBudget(input.adsetId, to));
      return { dailyBudget: to };
    },
  };
}
