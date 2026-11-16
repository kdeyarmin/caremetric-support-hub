import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { platformBilling } from './billing.mjs';
import { STRIPE_ACCOUNT_ID } from './stripe.mjs';

/**
 * Stripe's webhook records an event, then brings the customer quotes it touches up to date. That second step must fail the event only
 * when trying again can help: a quote that can never finish used to fail every event Stripe sent about it, until Stripe gave up on the
 * endpoint and stopped all billing sync.
 */
const secret = 'whsec_synthetic';
const clock = Date.parse('2026-11-16T12:00:00Z');
const signed = body => {
  const stamp = Math.floor(clock / 1000);
  return { raw: Buffer.from(body), header: `t=${stamp},v1=${createHmac('sha256', secret).update(`${stamp}.${body}`).digest('hex')}` };
};

function hub({ session }) {
  const recorded = [];
  const quote = { id: '96000000-0000-4000-8000-000000000001', checkout: 'cs_test', state: 'pending_payment', tenant_id: '96000000-0000-4000-8000-000000000002',
    execution: { kind: 'checkout', customer: 'cus_test', app: 'carebase', currency: 'usd', maximumDue: 1000, lines: [] } };
  const query = vi.fn(async (sql, params = []) => {
    if (sql.includes('billing_event_seen')) return { rows: [{ seen: false }] };
    if (sql.includes('billing_record_event')) { recorded.push(params[0]); return { rows: [] }; }
    if (sql.includes('customer_checkout_for_session')) return { rows: [{ result: [quote] }] };
    return { rows: [] };
  });
  const fetchImpl = vi.fn(async url => {
    const path = new URL(url).pathname;
    if (path === '/v1/account') return new Response(JSON.stringify({ id: STRIPE_ACCOUNT_ID }));
    if (path === '/v1/checkout/sessions/cs_test') return session();
    throw new Error(`Unexpected provider request ${path}`);
  });
  const log = { warn: vi.fn(), info: vi.fn() };
  const billing = platformBilling({ pool: { connect: async () => ({ query, release() {} }) }, secretKey: 'sk_test_synthetic', webhookSecrets: [secret],
    publicOrigin: 'https://hub.test', fetchImpl, now: () => clock, log });
  const event = JSON.stringify({ id: 'evt_checkoutTest', object: 'event', type: 'checkout.session.completed', created: Math.floor(clock / 1000), livemode: false,
    data: { object: { id: 'cs_test', object: 'checkout.session' } } });
  const deliver = () => { const { raw, header } = signed(event); return billing.webhook(raw, header); };
  return { deliver, recorded, log };
}

describe('Stripe events that touch a customer quote', () => {
  it('records the event and acknowledges it when its quote can never finish, and says so for billing support', async () => {
    // A paid checkout whose receipt does not match the quote it was started for: no retry of the event can change that.
    const h = hub({ session: () => new Response(JSON.stringify({ id: 'cs_test', mode: 'subscription', customer: 'cus_someone_else', client_reference_id: 'other',
      metadata: {}, status: 'complete' })) });
    await expect(h.deliver()).resolves.toEqual({ received: true });
    expect(h.recorded).toEqual(['evt_checkoutTest']);
    expect(h.log.warn).toHaveBeenCalledWith(expect.stringContaining('needs billing support'));
  });

  it('still fails the event while Stripe cannot be read, so Stripe sends it again', async () => {
    const h = hub({ session: () => new Response(JSON.stringify({ error: { type: 'api_error', message: 'Stripe is down.' } }), { status: 503 }) });
    await expect(h.deliver()).rejects.toMatchObject({ status: 503 });
    expect(h.recorded).toEqual(['evt_checkoutTest']);
  });
});
