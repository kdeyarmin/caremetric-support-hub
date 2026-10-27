import { describe, expect, it, vi } from 'vitest';
import { customerBillingService, sameBillingLines, subscriptionItemPatch } from './customer-billing.mjs';

const connection = '95000000-0000-4000-8000-000000000001', actor = '95000000-0000-4000-8000-000000000002';
const price = (id, key, amount, kind = 'plan') => ({ id, product: `prod_${id}`, name: key, description: '', kind, key, features: [key], allows_addons: kind === 'plan', active: true, amount, currency: 'usd', interval: 'month', interval_count: 1, model: 'per_unit', unit_label: 'facility' });
function fixture({ payment = 'paid', denied = false } = {}) {
  const quotes = new Map(), events = [];
  const workspace = { connection_id: connection, tenant_id: '95000000-0000-4000-8000-000000000003', app: 'carebase', role: 'organization_admin', mode: 'legacy', configuration_version: 0, can_activate: false,
    facilities: [{ id: 'site-a', name: 'Site A', permissions: ['billing.manage'] }], allocations: [{ facility_id: 'site-a', facility_name: 'Site A', plan: 'price_core', addons: [], version: 0 }],
    catalog: [price('price_core', 'core', 1000), price('price_train', 'train', 500, 'addon')], customer: 'cus_test', loaded_at: '2026-01-01T00:00:00Z',
    subscription: { id: 'sub_test', version: 1, status: 'active', current_period_end: '2026-02-01T00:00:00Z', currency: 'usd', interval: 'month', items: [{ id: 'si_core', price: 'price_core', quantity: 1 }] } };
  let sub = { id: 'sub_test', customer: 'cus_test', metadata: { app: 'carebase' }, status: 'active', latest_invoice: { id: 'in_test', status: 'paid' }, items: { data: [{ id: 'si_core', price: { id: 'price_core' }, quantity: 1, current_period_start: 1767225600, current_period_end: 1769904000 }] } };
  const query = vi.fn(async (sql, args = []) => {
    if (sql.startsWith('select s.id,s.user_id')) return { rows: [{ id: '95000000-0000-4000-8000-000000000004', user_id: actor }] };
    let result;
    if (sql.includes('private.customer_billing_context')) result = structuredClone(workspace);
    if (sql.includes('private.save_customer_billing_quote')) { const [id, connection_id, , , quote, execution] = args; quotes.set(id, { id, connection_id, quote: JSON.parse(quote), execution: JSON.parse(execution), state: 'preview', subscription: sub.id }); result = JSON.parse(quote); events.push('saved'); }
    if (sql.includes('private.claim_customer_billing_quote')) { const q = quotes.get(args[0]); if (args[1]) { q.state = 'confirming'; events.push('reserved'); } result = structuredClone(q); }
    if (sql.includes('private.settle_customer_billing_quote')) { quotes.get(args[0]).state = args[1]; events.push(args[1]); }
    if (sql.includes('private.customer_quotes_for_subscription')) result = [...quotes.values()].filter(q => ['confirming', 'pending_payment', 'scheduled'].includes(q.state));
    return { rows: [{ result }] };
  });
  const pool = { connect: async () => ({ query, release() {} }) };
  const live = { get: vi.fn(async () => structuredClone(sub)), post: vi.fn(async (path, params) => {
    if (path === '/v1/invoices/create_preview') return { amount_due: 250, currency: 'usd' };
    if (path === '/v1/subscriptions/sub_test') {
      expect(events).toContain('reserved'); events.push('provider_purchase');
      if (payment === 'paid') sub = { ...sub, latest_invoice: { status: 'paid' }, items: { data: params.items.filter(item => !item.deleted).map((item, i) => ({ ...item, id: item.id ?? `si_new${i}`, price: { id: item.price }, current_period_start: 1767225600, current_period_end: 1769904000 })) } };
      else sub = { ...sub, pending_update: { expires_at: 1767312000 }, latest_invoice: { status: 'open', hosted_invoice_url: 'https://invoice.stripe.com/synthetic' } };
      return structuredClone(sub);
    }
    if (path === '/v1/subscription_schedules') return { id: 'sub_sched', current_phase: { start_date: 1767225600 }, phases: [{ start_date: 1767225600, end_date: 1769904000 }] };
    if (path === '/v1/subscription_schedules/sub_sched') return { id: 'sub_sched', ...params };
    throw new Error(`Unexpected provider operation ${path}`);
  }) };
  const authorize = vi.fn(async () => { if (denied) throw Object.assign(new Error('Native authority revoked'), { status: 403 }); return { authorized: true }; });
  const service = customerBillingService({ pool, stripe: async () => live, mirrorSubscription: async () => {}, authorize, now: () => Date.parse('2026-01-02T00:00:00Z'), purchasingEnabled: true });
  const preview = (addons = ['price_train'], plan = 'price_core') => service.handle('session', { action: 'quote', connection_id: connection, facility_id: null, plan, addons, request_id: crypto.randomUUID() });
  return { service, preview, live, quotes, events, authorize };
}
describe('customer purchases', () => {
  it('rechecks native authority before provider preview or mutation', async () => {
    const test = fixture({ denied: true }); await expect(test.preview()).rejects.toThrow(/revoked/); expect(test.live.post).not.toHaveBeenCalled();
  });
  it('rejects an injected facility scope for an organization-wide plan', async () => {
    const test = fixture(); await expect(test.service.handle('session', { action: 'quote', connection_id: connection, facility_id: 'another-facility', plan: 'price_core', addons: [], request_id: crypto.randomUUID() })).rejects.toMatchObject({ status: 403 }); expect(test.live.post).not.toHaveBeenCalled();
  });
  it('reserves before charging and applies access only after paid receipt', async () => {
    const test = fixture(), quote = await test.preview(); expect(test.events).toEqual(['saved']);
    await expect(test.service.handle('session', { action: 'confirm', quote_id: quote.id, confirmed: true })).resolves.toEqual({ state: 'applied' });
    expect(test.events.indexOf('reserved')).toBeLessThan(test.events.indexOf('provider_purchase'));
    expect(test.live.post.mock.calls.find(([path]) => path === '/v1/subscriptions/sub_test')[1]).toMatchObject({ payment_behavior: 'pending_if_incomplete', proration_behavior: 'always_invoice' });
  });
  it('keeps an authentication challenge pending without applying purchased access', async () => {
    const test = fixture({ payment: 'challenge' }), quote = await test.preview();
    await expect(test.service.handle('session', { action: 'confirm', quote_id: quote.id, confirmed: true })).resolves.toMatchObject({ state: 'pending_payment' });
    expect(test.events).not.toContain('applied'); expect(test.quotes.get(quote.id).state).toBe('pending_payment');
  });
  it('requires an explicit confirmation literal', async () => {
    const test = fixture(), quote = await test.preview(); await expect(test.service.handle('session', { action: 'confirm', quote_id: quote.id, confirmed: false })).rejects.toMatchObject({ status: 400 }); expect(test.events).toEqual(['saved']);
  });
  it('schedules cancellation at renewal without deleting current items', async () => {
    const test = fixture(), quote = await test.preview([], null);
    expect(quote.due_now).toBe(0); expect(quote.effective_at).toBe('2026-02-01T00:00:00.000Z');
    await expect(test.service.handle('session', { action: 'confirm', quote_id: quote.id, confirmed: true })).resolves.toMatchObject({ state: 'scheduled' });
    expect(test.live.post.mock.calls.some(([path]) => path === '/v1/subscriptions/sub_test')).toBe(false);
    expect(test.live.post.mock.calls.find(([path]) => path === '/v1/subscription_schedules/sub_sched')[1]).toMatchObject({ end_behavior: 'cancel', phases: [{ items: [{ price: 'price_core', quantity: 1 }] }] });
  });
  it('preserves provider item identity and removes obsolete lines in a single change', () => {
    const sub = { items: { data: [{ id: 'si_a', price: { id: 'price_a' } }, { id: 'si_b', price: { id: 'price_b' } }] } };
    expect(subscriptionItemPatch(sub, [{ price: 'price_a', quantity: 2 }, { price: 'price_c', quantity: 1 }])).toEqual([{ id: 'si_a', price: 'price_a', quantity: 2 }, { id: 'si_b', deleted: true }, { price: 'price_c', quantity: 1 }]);
    expect(sameBillingLines([{ price: 'b', quantity: 1 }, { price: 'a', quantity: 2 }], [{ price: 'a', quantity: 2 }, { price: 'b', quantity: 1 }])).toBe(true);
  });
});
