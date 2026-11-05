/**
 * Offers from the owner's menu (supabase/migrations/20261105140000_agent_offers.sql): the Account Manager may offer only what the owner put
 * on the menu (a trial extension of a set number of days, or one of the owner's own Stripe coupons), to accounts that qualify, at most once
 * per account for each offer and at most the offer's monthly cap. Until the "offers" autonomy step's supervised week ends the owner
 * approves each one; after it they are made without asking.
 *
 * `offerExecutor` makes one approved offer. It needs no owner session. The database decides first, in one transaction
 * (private.agent_offer_begin): the agent's trust when nobody approved it, the offer switched on, the cap, once per account, and that the
 * subscription still qualifies. It records the use before Stripe is asked, so neither a retry nor a second server can make the offer twice.
 * Stripe is then asked once, with an idempotency key derived from the action, and the answer is recorded (private.agent_offer_settle):
 *   - applied      Stripe changed the subscription;
 *   - refused      Stripe said no (a 4xx), or billing is not set up on this server: nothing changed, the place under the cap is given back;
 *   - unconfirmed  no answer (a timeout, a 429 or a 5xx): it may have been applied, so it keeps its place, is never tried again on its own,
 *                  and the owner is told to check the subscription in Stripe.
 * A use an earlier attempt recorded is settled from that record first. Nothing here is retried.
 */
import { HttpError } from '../../sms-auth.mjs';

export const offersFeature = 'platform.agents.offers.v1';
export const offerCodes = Object.freeze(['offers_off', 'offer_disabled', 'not_eligible', 'already_offered', 'cap_reached']);

const failure = code => Object.assign(new Error('The offer was not made.'), { code });
const slug = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const offerKey = /^[a-z][a-z0-9_]{2,39}$/;
const subscriptionId = /^sub_[A-Za-z0-9]{1,250}$/;
const requestKey = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The facts an offer action carries, or null when they are not the shape the database also checks. */
export function parseOfferInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const keys = Object.keys(input);
  if (keys.length !== 4 || !['offer', 'tenant', 'product', 'subscription'].every(key => keys.includes(key))) return null;
  const { offer, tenant, product, subscription } = input;
  if (typeof offer !== 'string' || !offerKey.test(offer) || typeof tenant !== 'string' || !slug.test(tenant)
    || typeof product !== 'string' || !slug.test(product) || typeof subscription !== 'string' || !subscriptionId.test(subscription)) return null;
  return { offer, tenant, product, subscription };
}

const dateWords = value => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });

/** The approval card's text: exactly what the offer changes, in the owner's words. */
export function offerPreview(candidate, offer) {
  const who = `${candidate.tenantName ?? candidate.tenant}'s ${candidate.productName ?? candidate.product} trial`;
  if (offer.kind === 'trial_extension') {
    const after = new Date(Date.parse(candidate.trialEnd) + offer.trialDays * 86_400_000).toISOString();
    return `Offer "${offer.label}": extend ${who} by ${offer.trialDays} days, from ${dateWords(candidate.trialEnd)} to ${dateWords(after)}. Nothing is charged; the trial simply ends later.`;
  }
  return `Offer "${offer.label}": apply your Stripe coupon ${offer.couponId} to ${who}, which ends ${dateWords(candidate.trialEnd)}. The coupon's own terms apply when the trial converts.`;
}

// What an earlier attempt recorded: applied stays applied; refused stays refused; anything else may have been applied and is never retried.
function settled(record) {
  if (record.status === 'applied') return { outcome: 'applied', offer: record.offer, kind: record.kind, replay: true };
  throw failure(record.status === 'refused' ? 'offer_refused' : 'offer_unconfirmed');
}

export function offerExecutor({ store, billing, notifier = null, log = line => console.warn(line) }) {
  async function warn(execution, input) {
    if (!notifier) return;
    try {
      await notifier.send({
        severity: 'warning', subject: `Check ${input.tenant}'s subscription in Stripe`,
        body: `An offer from your menu ("${input.offer}") for ${input.tenant} may or may not have been applied: Stripe did not answer. It will not be tried again on its own.\n\nOpen the subscription in Stripe (or the Billing page) and look before you offer anything else to this account.`,
        dedupeKey: `offers:unconfirmed:${execution.id}`, agentKey: execution.agentKey, taskId: execution.taskId,
      });
    } catch {
      log(JSON.stringify({ event: 'hub_agent_offer_warning_unsent', action_id: execution.id }));
    }
  }
  const settle = async (actionId, status) => {
    try { await store.offerSettle(actionId, status); } catch {
      // The use stays 'applying', which a later attempt reads as a replay of the same Stripe request (the same idempotency key).
      log(JSON.stringify({ event: 'hub_agent_offer_unsettled', action_id: actionId, status }));
    }
  };

  return async function makeOffer(execution) {
    const input = parseOfferInput(execution?.input);
    if (!input || typeof execution.requestKey !== 'string' || !requestKey.test(execution.requestKey)) throw failure('invalid_offer');
    const executionNumber = Number.isInteger(execution.execution) ? execution.execution : null;
    const begun = await store.offerBegin(execution.id, executionNumber);
    if (begun?.state === 'refused') throw failure(offerCodes.includes(begun.code) ? begun.code : 'not_eligible');
    if (begun?.state === 'recorded') return settled(begun);
    if (begun?.state !== 'ready' && begun?.state !== 'replay') throw failure('executor_error');

    // Billing that is not set up on this server never reached Stripe: the place is given back and the offer can be proposed again.
    if (typeof billing?.agentOffer !== 'function') { await settle(execution.id, 'refused'); throw failure('billing_unavailable'); }
    const request = begun.kind === 'trial_extension'
      ? { subscription: begun.subscription, trialEnd: Number(begun.trialEndAfter), idempotencyKey: `hub-agent-offer-${execution.requestKey}` }
      : { subscription: begun.subscription, coupon: begun.coupon, idempotencyKey: `hub-agent-offer-${execution.requestKey}` };
    try {
      await billing.agentOffer(request);
    } catch (error) {
      const status = Number(error?.status);
      // The Hub refused before Stripe was asked (not configured, not verified, the subscription not in the mirror): nothing changed.
      if (error instanceof HttpError) {
        await settle(execution.id, 'refused');
        throw failure(status === 503 ? 'billing_unavailable' : 'offer_refused');
      }
      // Stripe said no: nothing changed.
      if (status >= 400 && status < 500 && status !== 429) { await settle(execution.id, 'refused'); throw failure('offer_refused'); }
      // No answer, too many requests or a Stripe outage: it may have been applied.
      await settle(execution.id, 'unconfirmed');
      await warn(execution, input);
      throw failure('offer_unconfirmed');
    }
    await settle(execution.id, 'applied');
    return { outcome: 'applied', offer: begun.offer, kind: begun.kind };
  };
}

const declared = features => (features instanceof Set ? features.has(offersFeature) : Array.isArray(features) && features.includes(offersFeature));

/** The Account Manager's offer action, registered only when the database declares the feature (its operations exist only then). */
export function offerExecutors({ store, features = null, billing = null, notifier = null, log }) {
  if (!declared(features)) return {};
  return { 'offer.apply': offerExecutor({ store, billing, notifier, log }) };
}
