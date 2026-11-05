import { describe, expect, it, vi } from 'vitest';
import { chooseOffers, offerHandlers, offersFeature } from './offers.mjs';

const features = new Set([offersFeature]);
const offer = (over = {}) => ({ key: 'trial_extension_14', label: '14 more trial days', kind: 'trial_extension', trialDays: 14, couponId: null, remaining: 10, ...over });
const candidate = (tenant, over = {}) => ({ offer: 'trial_extension_14', tenant, tenantName: `${tenant} name`, product: 'carebase', productName: 'CareMetric CareBase',
  subscription: `sub_${tenant.replace(/-/g, '')}`, trialEnd: '2026-11-10T17:00:00Z', ...over });
const task = (autonomy = 'propose') => ({ id: '22222222-2222-4222-8222-222222222222', agentKey: 'account_manager', kind: 'accounts.offers', agent: { autonomy } });

const fixture = (snapshot, propose = async () => ({ id: 'a', status: 'proposed', created: true })) => {
  const store = {
    offerCandidates: vi.fn(async () => snapshot), proposeAction: vi.fn(propose),
    startRun: vi.fn(async () => ({ id: '33333333-3333-4333-8333-333333333333' })), finishRun: vi.fn(async () => true),
  };
  const run = offerHandlers({ store, features, log: () => {} })['accounts.offers'];
  return { store, run };
};

describe('choosing offers', () => {
  it('keeps within each offer\'s remaining room and makes one offer per account', () => {
    const snapshot = { offers: [offer({ remaining: 1 }), offer({ key: 'coupon_a', kind: 'coupon', couponId: 'SPRING20', remaining: 5 })],
      candidates: [candidate('a'), candidate('b'), candidate('a', { offer: 'coupon_a' }), candidate('c', { offer: 'coupon_a' })] };
    const { chosen, deferred } = chooseOffers(snapshot);
    expect(chosen.map(({ candidate: c, offer: o }) => `${o.key}:${c.tenant}`)).toEqual(['trial_extension_14:a', 'coupon_a:c']);
    expect(deferred).toBe(2);
  });
});

describe('the daily offer run', () => {
  it('proposes each chosen offer with what it changes, and counts what the database recorded', async () => {
    const { run, store } = fixture({ mode: 'live', offers: [offer()], candidates: [candidate('maple-grove'), candidate('oak-hill')], truncated: false },
      async ({ targetId }) => ({ id: targetId, status: targetId === 'oak-hill' ? 'auto_approved' : 'proposed', created: true }));
    const { result } = await run(task('act'));
    expect(result).toMatchObject({ outcome: 'proposed', proposed: 2, autoApproved: 1, byOffer: { trial_extension_14: 2 } });
    expect(store.proposeAction).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'offer.apply', targetKind: 'billing_account', targetId: 'maple-grove',
      input: { offer: 'trial_extension_14', tenant: 'maple-grove', product: 'carebase', subscription: 'sub_maplegrove' },
      preview: expect.stringMatching(/^Offer "14 more trial days": extend maple-grove name's CareMetric CareBase trial by 14 days/),
    }));
    // The run row carries counts, never an account name.
    expect(JSON.stringify(store.finishRun.mock.calls)).not.toMatch(/maple|oak/);
  });

  it('proposes nothing in Observe, with nothing switched on, or with nobody qualifying', async () => {
    const watching = fixture({ mode: 'live', offers: [offer()], candidates: [candidate('maple-grove')] });
    expect((await watching.run(task('observe'))).result).toMatchObject({ outcome: 'observe_only', proposed: 0 });
    expect(watching.store.proposeAction).not.toHaveBeenCalled();
    const none = fixture({ mode: 'live', offers: [], candidates: [] });
    expect((await none.run(task())).result).toMatchObject({ outcome: 'no_offers', proposed: 0 });
    const nobody = fixture({ mode: 'live', offers: [offer()], candidates: [] });
    expect((await nobody.run(task())).result).toMatchObject({ outcome: 'nothing_due', proposed: 0 });
  });

  it('stops proposing when the agent is switched to Observe mid-run, and counts a proposal another run made first', async () => {
    let calls = 0;
    const { run } = fixture({ mode: 'live', offers: [offer()], candidates: [candidate('a'), candidate('b'), candidate('c')] }, async () => {
      calls += 1;
      if (calls === 1) return { id: 'x', status: 'proposed', created: false };
      throw Object.assign(new Error('observe'), { code: '42501' });
    });
    expect((await run(task())).result).toMatchObject({ proposed: 0, alreadyProposed: 1 });
    expect(calls).toBe(2);
  });

  it('registers only when the database declares offers', () => {
    expect(offerHandlers({ store: { offerCandidates: vi.fn() }, features: new Set() })).toEqual({});
    expect(Object.keys(offerHandlers({ store: { offerCandidates: vi.fn() }, features }))).toEqual(['accounts.offers']);
  });
});
