import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../sms-auth.mjs';
import { StripeError } from '../../stripe.mjs';
import { offerExecutor, offerExecutors, offerPreview, offersFeature, parseOfferInput } from './offers.mjs';

const input = { offer: 'trial_extension_14', tenant: 'maple-grove', product: 'carebase', subscription: 'sub_123' };
const execution = (over = {}) => ({
  id: '11111111-1111-4111-8111-111111111111', agentKey: 'account_manager', taskId: '22222222-2222-4222-8222-222222222222', kind: 'offer.apply',
  targetKind: 'billing_account', targetId: 'maple-grove', input, requestKey: '44444444-4444-4444-8444-444444444444', autoApproved: true, execution: 1, ...over,
});
const trialEnd = Math.floor(Date.parse('2026-11-24T12:00:00Z') / 1000);
const ready = (over = {}) => ({ state: 'ready', status: 'applying', offer: 'trial_extension_14', kind: 'trial_extension', subscription: 'sub_123', coupon: null,
  trialEndBefore: trialEnd - 14 * 86_400, trialEndAfter: trialEnd, ...over });

const fixture = ({ begun = ready(), apply = async () => ({ applied: true }), settle = async () => true } = {}) => {
  const logs = [];
  const store = { offerBegin: vi.fn(async () => begun), offerSettle: vi.fn(settle) };
  const billing = { agentOffer: vi.fn(apply) };
  const notifier = { send: vi.fn(async () => [{ channel: 'email', delivery: 'sent' }]) };
  const make = offerExecutor({ store, billing, notifier, log: line => logs.push(line) });
  return { store, billing, notifier, logs, make };
};
const refusal = code => error => { expect(error.code).toBe(code); return true; };

describe('making an approved offer', () => {
  it('asks Stripe once for what the database recorded, with an idempotency key from the action, then records it applied', async () => {
    const { make, store, billing } = fixture();
    expect(await make(execution())).toEqual({ outcome: 'applied', offer: 'trial_extension_14', kind: 'trial_extension' });
    expect(store.offerBegin).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', 1);
    expect(billing.agentOffer).toHaveBeenCalledWith({ subscription: 'sub_123', trialEnd, idempotencyKey: 'hub-agent-offer-44444444-4444-4444-8444-444444444444' });
    expect(store.offerSettle).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', 'applied');
  });

  it('applies a coupon offer by its coupon, and repeats the same request for a use an earlier attempt never settled', async () => {
    const coupon = fixture({ begun: ready({ state: 'replay', kind: 'coupon', coupon: 'SPRING20', trialEndBefore: null, trialEndAfter: null }) });
    expect(await coupon.make(execution())).toMatchObject({ outcome: 'applied', kind: 'coupon' });
    expect(coupon.billing.agentOffer).toHaveBeenCalledWith({ subscription: 'sub_123', coupon: 'SPRING20', idempotencyKey: 'hub-agent-offer-44444444-4444-4444-8444-444444444444',
      discounts: null, recordDiscounts: null });
  });

  it('sends a coupon request an earlier attempt recorded verbatim, and records a first attempt\'s request before it is sent', async () => {
    const recorded = [{ discount: 'di_1' }, { coupon: 'SPRING20' }];
    const replay = fixture({ begun: ready({ state: 'replay', kind: 'coupon', coupon: 'SPRING20', trialEndBefore: null, trialEndAfter: null, discounts: recorded }) });
    await replay.make(execution());
    expect(replay.billing.agentOffer.mock.calls[0][0].discounts).toEqual(recorded);

    const first = fixture({ begun: ready({ kind: 'coupon', coupon: 'SPRING20', trialEndBefore: null, trialEndAfter: null, discounts: null }) });
    first.store.offerRequest = vi.fn(async (_id, _execution, request) => request);
    await first.make(execution());
    const { discounts, recordDiscounts } = first.billing.agentOffer.mock.calls[0][0];
    expect(discounts).toBeNull();
    expect(await recordDiscounts([{ coupon: 'SPRING20' }])).toEqual([{ coupon: 'SPRING20' }]);
    expect(first.store.offerRequest).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', 1, [{ coupon: 'SPRING20' }]);
  });

  it('settles a use an earlier attempt recorded without asking Stripe again', async () => {
    const applied = fixture({ begun: ready({ state: 'recorded', status: 'applied' }) });
    expect(await applied.make(execution())).toEqual({ outcome: 'applied', offer: 'trial_extension_14', kind: 'trial_extension', replay: true });
    for (const [status, code] of [['refused', 'offer_refused'], ['unconfirmed', 'offer_unconfirmed']]) {
      const earlier = fixture({ begun: ready({ state: 'recorded', status }) });
      await expect(earlier.make(execution())).rejects.toSatisfy(refusal(code));
      expect(earlier.billing.agentOffer).not.toHaveBeenCalled();
      expect(earlier.store.offerSettle).not.toHaveBeenCalled();
      // An unconfirmed outcome recorded by an attempt that stopped before telling the owner is told now, under the same key.
      if (status === 'unconfirmed') {
        expect(earlier.notifier.send).toHaveBeenCalledWith(expect.objectContaining({ severity: 'warning', dedupeKey: 'offers:unconfirmed:11111111-1111-4111-8111-111111111111' }));
      } else {
        expect(earlier.notifier.send).not.toHaveBeenCalled();
      }
    }
  });

  it('passes on the database\'s refusals, and asks Stripe nothing', async () => {
    for (const code of ['offers_off', 'offer_disabled', 'not_eligible', 'already_offered', 'cap_reached']) {
      const { make, billing } = fixture({ begun: { state: 'refused', code } });
      await expect(make(execution())).rejects.toSatisfy(refusal(code));
      expect(billing.agentOffer).not.toHaveBeenCalled();
    }
    const odd = fixture({ begun: { state: 'refused', code: 'something_new' } });
    await expect(odd.make(execution())).rejects.toSatisfy(refusal('not_eligible'));
  });

  it('gives the place back when Stripe or the Hub refused, and keeps it, warning the owner, when the outcome is unknown', async () => {
    const said = fixture({ apply: async () => { throw new StripeError(400, 'invalid_request_error', 'resource_missing', 'No such subscription'); } });
    await expect(said.make(execution())).rejects.toSatisfy(refusal('offer_refused'));
    expect(said.store.offerSettle).toHaveBeenCalledWith(expect.any(String), 'refused');
    expect(said.notifier.send).not.toHaveBeenCalled();

    const off = fixture({ apply: async () => { throw new HttpError(503, 'Stripe is not configured.'); } });
    await expect(off.make(execution())).rejects.toSatisfy(refusal('billing_unavailable'));
    expect(off.store.offerSettle).toHaveBeenCalledWith(expect.any(String), 'refused');

    // An idempotency error says a request under this key was already made with other parameters: it may have been applied.
    for (const error of [new StripeError(500, 'api_error', null, 'boom'), new StripeError(429, 'rate_limit', null, 'slow'), new TypeError('fetch failed'),
      new StripeError(400, 'idempotency_error', null, 'Keys for idempotent requests can only be used with the same parameters')]) {
      const unknown = fixture({ apply: async () => { throw error; } });
      await expect(unknown.make(execution())).rejects.toSatisfy(refusal('offer_unconfirmed'));
      expect(unknown.store.offerSettle).toHaveBeenCalledWith(expect.any(String), 'unconfirmed');
      expect(unknown.notifier.send).toHaveBeenCalledWith(expect.objectContaining({ severity: 'warning', dedupeKey: 'offers:unconfirmed:11111111-1111-4111-8111-111111111111' }));
    }
  });

  it('refuses an offer whose facts are not the database\'s shape before asking anything', async () => {
    for (const bad of [{ ...input, extra: 1 }, { ...input, subscription: 'cus_1' }, { ...input, tenant: 'Maple Grove' }, null]) {
      const { make, store } = fixture();
      await expect(make(execution({ input: bad }))).rejects.toSatisfy(refusal('invalid_offer'));
      expect(store.offerBegin).not.toHaveBeenCalled();
    }
    expect(parseOfferInput(input)).toEqual(input);
  });

  it('logs, without failing the offer, a settle that could not be recorded (the next attempt replays the same request)', async () => {
    const { make, logs } = fixture({ settle: async () => { throw new Error('connection reset'); } });
    expect(await make(execution())).toMatchObject({ outcome: 'applied' });
    expect(logs.join('\n')).toMatch(/hub_agent_offer_unsettled/);
    expect(logs.join('\n')).not.toMatch(/maple-grove|sub_123/);
  });

  it('refuses before Stripe when this server has no billing, and gives the place back', async () => {
    const store = { offerBegin: vi.fn(async () => ready()), offerSettle: vi.fn(async () => true) };
    await expect(offerExecutor({ store, billing: null })(execution())).rejects.toSatisfy(refusal('billing_unavailable'));
    expect(store.offerSettle).toHaveBeenCalledWith(expect.any(String), 'refused');
  });

  it('registers only when the database declares offers', () => {
    expect(offerExecutors({ store: {}, features: new Set() })).toEqual({});
    expect(Object.keys(offerExecutors({ store: {}, features: new Set([offersFeature]) }))).toEqual(['offer.apply']);
  });

  it('says on the approval card exactly what changes', () => {
    const candidate = { tenant: 'maple-grove', tenantName: 'Maple Grove', product: 'carebase', productName: 'CareMetric CareBase', trialEnd: '2026-11-10T17:00:00Z' };
    expect(offerPreview(candidate, { label: '14 more trial days', kind: 'trial_extension', trialDays: 14 }))
      .toBe('Offer "14 more trial days": extend Maple Grove\'s CareMetric CareBase trial by 14 days, from Nov 10, 2026 to Nov 24, 2026. Nothing is charged; the trial simply ends later.');
    expect(offerPreview(candidate, { label: '20% off', kind: 'coupon', couponId: 'SPRING20' })).toMatch(/apply your Stripe coupon SPRING20 to Maple Grove's CareMetric CareBase trial, which ends Nov 10, 2026/);
  });
});
