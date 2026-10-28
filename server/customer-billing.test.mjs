import { describe, expect, it, vi } from 'vitest';
import { customerBillingService, sameBillingLines, subscriptionItemPatch } from './customer-billing.mjs';

const connection = '95000000-0000-4000-8000-000000000001', actor = '95000000-0000-4000-8000-000000000002';
const price = (id, key, amount, kind = 'plan') => ({ id, product: `prod_${id}`, name: key, description: '', kind, key, features: [key], allows_addons: kind === 'plan', active: true, amount, currency: 'usd', interval: 'month', interval_count: 1, model: 'per_unit', unit_label: 'facility' });
function fixture({ payment = 'paid', denied = false } = {}) {
  const quotes = new Map(), events = [];
  const purchases = new Map();
  let currentTime = Date.parse('2026-01-02T00:00:00Z');
  let invoice = { id: 'in_purchase', customer: 'cus_test', subscription: 'sub_test', status: payment === 'paid' ? 'paid' : 'open', hosted_invoice_url: 'https://invoice.stripe.com/synthetic' };
  const workspace = { connection_id: connection, tenant_id: '95000000-0000-4000-8000-000000000003', app: 'carebase', role: 'organization_admin', mode: 'legacy', configuration_version: 0, can_activate: false,
    facilities: [{ id: 'site-a', name: 'Site A', permissions: ['billing.manage'] }], allocations: [{ facility_id: 'site-a', facility_name: 'Site A', plan: 'price_core', addons: [], version: 0 }],
    catalog: [price('price_core', 'core', 1000), price('price_train', 'train', 500, 'addon')], customer: 'cus_test', loaded_at: '2026-01-01T00:00:00Z',
    subscription: { id: 'sub_test', version: 1, status: 'active', current_period_end: '2026-02-01T00:00:00Z', currency: 'usd', interval: 'month', items: [{ id: 'si_core', price: 'price_core', quantity: 1 }] } };
  let sub = { id: 'sub_test', customer: 'cus_test', metadata: { app: 'carebase' }, status: 'active', latest_invoice: { id: 'in_test', status: 'paid' }, items: { data: [{ id: 'si_core', price: { id: 'price_core' }, quantity: 1, current_period_start: 1767225600, current_period_end: 1769904000 }] } };
  let schedule = { id: 'sub_sched', subscription: sub.id, status: 'active', metadata: {}, current_phase: { start_date: 1767225600 }, phases: [{ start_date: 1767225600, end_date: 1769904000, items: [{ price: 'price_core', quantity: 1 }] }] };
  const query = vi.fn(async (sql, args = []) => {
    if (sql.startsWith('select s.id,s.user_id')) return { rows: [{ id: '95000000-0000-4000-8000-000000000004', user_id: actor }] };
    let result;
    if (sql.includes('private.customer_billing_context')) result = structuredClone(workspace);
    if (sql.includes('private.save_customer_billing_quote')) { const [id, connection_id, , , quote, execution] = args; quotes.set(id, { id, connection_id, quote: JSON.parse(quote), execution: JSON.parse(execution), state: 'preview', subscription: sub.id }); result = JSON.parse(quote); events.push('saved'); }
    if (sql.includes('private.claim_customer_billing_quote')) { const q = quotes.get(args[0]); if (args[1] && q.state === 'preview') { q.state = 'confirming'; q.confirmed_at = new Date(currentTime).toISOString(); events.push('reserved'); } result = structuredClone(q); }
    if (sql.includes('private.record_customer_payment_invoice')) quotes.get(args[0]).payment_invoice = args[1];
    if (sql.includes('private.mark_customer_purchase_started')) quotes.get(args[0]).payment_request_started_at = new Date(currentTime).toISOString();
    if (sql.includes('private.settle_customer_billing_quote')) { quotes.get(args[0]).state = args[1]; events.push(args[1]); }
    if (sql.includes('private.customer_quotes_for_subscription')) result = [...quotes.values()].filter(q => ['confirming', 'pending_payment', 'scheduled'].includes(q.state));
    return { rows: [{ result }] };
  });
  const pool = { connect: async () => ({ query, release() {} }) };
  const live = { get: vi.fn(async path => structuredClone(path.startsWith('/v1/invoices/') ? invoice : path.startsWith('/v1/subscription_schedules/') ? schedule : sub)), post: vi.fn(async (path, params, options) => {
    if (path === '/v1/invoices/create_preview') return { amount_due: 250, currency: 'usd' };
    if (path === '/v1/subscriptions/sub_test') {
      const prior = purchases.get(options.idempotencyKey);
      if (prior) { expect(params).toEqual(prior.params); return structuredClone(prior.response); }
      expect(events).toContain('reserved'); events.push('provider_purchase');
      if (payment === 'paid') sub = { ...sub, latest_invoice: structuredClone(invoice), items: { data: params.items.filter(item => !item.deleted).map((item, i) => ({ ...item, id: item.id ?? `si_new${i}`, price: { id: item.price }, current_period_start: 1767225600, current_period_end: 1769904000 })) } };
      else sub = { ...sub, pending_update: { expires_at: 1767312000 }, latest_invoice: structuredClone(invoice) };
      purchases.set(options.idempotencyKey, { params: structuredClone(params), response: structuredClone(sub) });
      return structuredClone(sub);
    }
    if (path === '/v1/subscription_schedules') { sub.schedule = schedule.id; return structuredClone(schedule); }
    if (path === '/v1/subscription_schedules/sub_sched/release') { sub.schedule = null; schedule = { ...schedule, status: 'released', subscription: null, released_subscription: sub.id }; return structuredClone(schedule); }
    if (path === '/v1/subscription_schedules/sub_sched') { schedule = { ...schedule, ...params }; return structuredClone(schedule); }
    throw new Error(`Unexpected provider operation ${path}`);
  }) };
  const authorize = vi.fn(async () => { if (denied) throw Object.assign(new Error('Native authority revoked'), { status: 403 }); return { authorized: true }; });
  const service = customerBillingService({ pool, stripe: async () => live, mirrorSubscription: async () => {}, authorize, now: () => currentTime, purchasingEnabled: true });
  const preview = (addons = ['price_train'], plan = 'price_core') => service.handle('session', { action: 'quote', connection_id: connection, facility_id: null, plan, addons, request_id: crypto.randomUUID() });
  return { service, preview, live, quotes, events, authorize, query, workspace,
    mutateSubscription: changes => { sub = { ...sub, ...changes }; }, mutateInvoice: changes => { invoice = { ...invoice, ...changes }; },
    mutateSchedule: changes => { schedule = { ...schedule, ...changes }; },
    advance: milliseconds => { currentTime += milliseconds; } };
}
describe('customer purchases', () => {
  it('preserves flat organization pricing without requiring a native facility', async () => {
    const test = fixture(); test.workspace.facilities = []; test.workspace.allocations = [];
    test.workspace.catalog = test.workspace.catalog.map(price => ({ ...price, model: 'flat', unit_label: 'organization' }));
    const workspace = await test.service.handle('session', { action: 'workspace', connection_id: connection });
    expect(workspace.facilities).toEqual([]);
    expect(workspace.allocations).toMatchObject([{ facility_id: 'organization', plan: 'price_core' }]);
    const quote = await test.preview();
    expect(quote.facility_name).toBe('Organization subscription');
    expect(quote.summary.every(line => line.quantity === 1)).toBe(true);
  });
  it('refuses quantity-based purchases without an app-owned usage adapter', async () => {
    const test = fixture(); test.workspace.facilities = []; test.workspace.allocations = [];
    await expect(test.preview()).rejects.toMatchObject({ status: 409 });
    expect(test.events).not.toContain('provider_purchase');
  });
  it.each(['canceled', 'incomplete_expired'])('releases an unresolved purchase when the subscription is terminal: %s', async status => {
    const test = fixture({ payment: 'challenge' }), quote = await test.preview();
    await test.service.handle('session', { action: 'confirm', quote_id: quote.id, confirmed: true });
    test.mutateSubscription({ status, pending_update: null });
    await test.service.reconcileSubscription({ id: 'sub_test', metadata: { app: 'carebase' } });
    expect(test.quotes.get(quote.id).state).toBe('failed'); expect(test.events).not.toContain('applied');
  });
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
  it.each([{ customer: 'cus_other' }, { metadata: { app: 'breathe' } }])('refuses a changed provider account before mutation: %j', async changes => {
    const test = fixture(), quote = await test.preview(); test.mutateSubscription(changes);
    await expect(test.service.handle('session', { action: 'confirm', quote_id: quote.id, confirmed: true })).rejects.toMatchObject({ status: 409 });
    expect(test.events).not.toContain('provider_purchase'); expect(test.quotes.get(quote.id).state).toBe('failed');
  });
  it('does not activate a purchase from an unrelated paid invoice', async () => {
    const test = fixture({ payment: 'challenge' }), quote = await test.preview();
    await test.service.handle('session', { action: 'confirm', quote_id: quote.id, confirmed: true });
    test.mutateSubscription({ pending_update: null, latest_invoice: { id: 'in_other', status: 'paid' }, items: { data: [{ id: 'si_core', price: { id: 'price_core' }, quantity: 1 }, { id: 'si_new', price: { id: 'price_train' }, quantity: 1 }] } });
    await test.service.reconcileSubscription({ id: 'sub_test', metadata: { app: 'carebase' } });
    expect(test.events).not.toContain('applied'); expect(test.quotes.get(quote.id).state).toBe('pending_payment');
    test.mutateInvoice({ status: 'paid' });
    await test.service.reconcileSubscription({ id: 'sub_test', metadata: { app: 'carebase' } });
    expect(test.quotes.get(quote.id).state).toBe('applied');
  });
  it('releases a failed purchase after its exact invoice is voided and the pending update is gone', async () => {
    const test = fixture({ payment: 'challenge' }), quote = await test.preview();
    await test.service.handle('session', { action: 'confirm', quote_id: quote.id, confirmed: true });
    test.mutateSubscription({ pending_update: null }); test.mutateInvoice({ status: 'void' });
    await test.service.reconcileSubscription({ id: 'sub_test', metadata: { app: 'carebase' } });
    expect(test.quotes.get(quote.id).state).toBe('failed'); expect(test.events).not.toContain('applied');
  });
  it('recovers a lost receipt with unchanged provider parameters and one charge', async () => {
    const test = fixture(), quote = await test.preview();
    const provider = test.live.post.getMockImplementation(); let lost = false;
    test.live.post.mockImplementation(async (...args) => { const response = await provider(...args); if (args[0] === '/v1/subscriptions/sub_test' && !lost) { lost = true; throw new Error('Lost provider response'); } return response; });
    const confirm = () => test.service.handle('session', { action: 'confirm', quote_id: quote.id, confirmed: true });
    await expect(confirm()).rejects.toThrow('Lost provider response'); await expect(confirm()).resolves.toEqual({ state: 'applied' });
    expect(test.events.filter(event => event === 'provider_purchase')).toHaveLength(1);
    expect(test.live.post.mock.calls.filter(([path]) => path === '/v1/invoices/create_preview')).toHaveLength(2);
  });
  it('keeps retries outside the provider idempotency window from making a new charge', async () => {
    const test = fixture(), quote = await test.preview();
    test.quotes.get(quote.id).state = 'confirming'; test.quotes.get(quote.id).confirmed_at = '2026-01-01T00:00:00Z';
    await expect(test.service.handle('session', { action: 'confirm', quote_id: quote.id, confirmed: true })).rejects.toThrow(/reconciliation/);
    expect(test.events).not.toContain('provider_purchase');
  });
  it('does not adopt a schedule attached after preview', async () => {
    const test = fixture(), quote = await test.preview([], null);
    test.mutateSubscription({ schedule: 'sub_sched_external' });
    const provider = test.live.post.getMockImplementation();
    test.live.post.mockImplementation(async (...args) => { if (args[0] === '/v1/subscription_schedules') throw new Error('Subscription already has a schedule'); return provider(...args); });
    await expect(test.service.handle('session', { action: 'confirm', quote_id: quote.id, confirmed: true })).rejects.toThrow(/already has/);
    expect(test.live.post.mock.calls.some(([path]) => path === '/v1/subscription_schedules/sub_sched_external')).toBe(false);
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
  it.each([null, 'sub_sched_replacement'])('retires pending allocations after a schedule is removed or replaced: %s', async schedule => {
    const test = fixture(), quote = await test.preview([], null);
    await test.service.handle('session', { action: 'confirm', quote_id: quote.id, confirmed: true });
    test.quotes.get(quote.id).schedule = 'sub_sched';
    test.mutateSubscription({ schedule });
    await test.service.reconcileSubscription({ id: 'sub_test', metadata: { app: 'carebase' } });
    expect(test.quotes.get(quote.id).state).toBe('superseded');
    const before = test.live.post.mock.calls.length;
    await expect(test.service.handle('session', { action: 'confirm', quote_id: quote.id, confirmed: true })).resolves.toEqual({ state: 'superseded' });
    expect(test.live.post.mock.calls.length).toBe(before);
  });
  it('undoes a scheduled cancellation with a confirmed, idempotent release', async () => {
    const test = fixture(), cancellation = await test.preview([], null);
    await test.service.handle('session', { action: 'confirm', quote_id: cancellation.id, confirmed: true });
    const keep = await test.preview([]);
    expect(keep.cancels_scheduled_change).toBe(true); expect(keep.due_now).toBe(0);
    await expect(test.service.handle('session', { action: 'confirm', quote_id: keep.id, confirmed: true })).resolves.toEqual({ state: 'applied' });
    expect(test.live.post.mock.calls.find(([path]) => path.endsWith('/release'))).toMatchObject(['/v1/subscription_schedules/sub_sched/release', { preserve_cancel_date: false }, { idempotencyKey: `hub-customer-${keep.id}-release` }]);
  });
  it('recovers an uncertain release without creating or releasing a second schedule', async () => {
    const test = fixture(), cancellation = await test.preview([], null);
    await test.service.handle('session', { action: 'confirm', quote_id: cancellation.id, confirmed: true });
    const keep = await test.preview([]), provider = test.live.post.getMockImplementation(); let lost = false;
    test.live.post.mockImplementation(async (...args) => { const result = await provider(...args); if (args[0].endsWith('/release') && !lost) { lost = true; throw new Error('Synthetic lost response'); } return result; });
    await expect(test.service.handle('session', { action: 'confirm', quote_id: keep.id, confirmed: true })).rejects.toThrow(/lost response/);
    await expect(test.service.handle('session', { action: 'confirm', quote_id: keep.id, confirmed: true })).resolves.toEqual({ state: 'applied' });
    expect(test.live.post.mock.calls.filter(([path]) => path.endsWith('/release'))).toHaveLength(1);
  });
  it('refuses a schedule edited after the customer reviewed it', async () => {
    const test = fixture(), cancellation = await test.preview([], null);
    await test.service.handle('session', { action: 'confirm', quote_id: cancellation.id, confirmed: true });
    const keep = await test.preview([]); test.mutateSchedule({ end_behavior: 'release', metadata: { hub_self_service: 'true', owner_note: 'Changed externally' } });
    const before = test.live.post.mock.calls.length;
    await expect(test.service.handle('session', { action: 'confirm', quote_id: keep.id, confirmed: true })).rejects.toMatchObject({ status: 409 });
    expect(test.live.post.mock.calls.length).toBe(before);
  });
});
