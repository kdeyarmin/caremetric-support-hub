import { describe, expect, it, vi } from 'vitest';
import { FOUNDERS_COUPON, FOUNDERS_OFFER, applyFoundersToInvoice, foundersAmounts, foundersEligibility, foundersWindow } from './founders-sale.mjs';
import { foundersCatalog } from './founders-catalog.mjs';

const price = 'price_1UUyUyB06O2UFlNzdfXwJUXW';
const coupon = { valid: true, percent_off: 50, duration: 'repeating', duration_in_months: 12,
  applies_to: { products: [...new Set(Object.values(foundersCatalog).map(value => value.product))] } };
const saleDiscount = { id: 'di_sale', coupon: { id: FOUNDERS_COUPON } };
const start = Date.parse('2026-12-08T12:00:00Z') / 1000;
function fixture() {
  const sub = { id: 'sub_trial', customer: 'cus_owner', status: 'active', trial_end: start, metadata: { app: 'carebase', hub_tenant_id: 'tenant' },
    discounts: [], items: { data: [{ price: { id: price }, quantity: 1 }] } };
  const invoice = { id: 'in_first', subscription: sub.id, status: 'draft', subtotal: 19900, total: 19900, billing_reason: 'subscription_cycle', discounts: [] };
  let history = [sub], paid = [], invoiceLines = [{ price: { id: price }, amount: 19900, period: { start, end: start + 31 * 86400 } }];
  const live = {
    get: vi.fn(async path => structuredClone(path.includes('/coupons/') ? coupon : path.includes('/customers/') ? { id: 'cus_owner' } : path.includes('/invoices/') ? invoice : sub)),
    list: vi.fn(async path => path.endsWith('/lines') ? invoiceLines : path === '/v1/invoices' ? paid : history),
    post: vi.fn(async (path, body) => {
      const target = path.includes('/subscriptions/') ? sub : invoice;
      if (body.metadata) target.metadata = { ...target.metadata, ...body.metadata };
      if (body.discounts) target.discounts = body.discounts.map(item => item.coupon ? saleDiscount : item);
      return structuredClone(target);
    }),
  };
  return { live, sub, invoice, lines: [{ price, quantity: 1 }],
    history: rows => { history = rows; }, paid: rows => { paid = rows; }, invoiceLines: rows => { invoiceLines = rows; } };
}
describe('automatic Founders Sale', () => {
  it('preserves the original paid year if an administrator later adds a trial, including leap-day anniversaries', () => {
    const paid = Date.parse('2028-02-29T12:00:00Z') / 1000;
    expect(foundersWindow({ start_date: paid, trial_end: paid + 30 * 86400, metadata: { hub_founders_sale: FOUNDERS_OFFER, hub_founders_origin: 'paid' } }))
      .toEqual({ start: paid, end: Date.parse('2029-02-28T12:00:00Z') / 1000 });
  });
  it('uses exact published cents and quantity, excluding private and retired prices', async () => {
    expect(foundersAmounts([{ price, quantity: 3 }])).toMatchObject({ standard_recurring_subtotal: 59700, recurring_subtotal: 29850, founders_sale: { savings: 29850 } });
    const t = fixture();
    expect(await foundersEligibility(t.live, { app: 'carebase', customer: null, lines: t.lines })).toBe(true);
    expect(await foundersEligibility(t.live, { app: 'carebase', customer: null, lines: [{ price: 'price_custom', quantity: 1 }] })).toBe(false);
  });
  it('does not reset the year after cancellation or discount redemption, but an unpaid expired trial qualifies', async () => {
    const t = fixture(), input = { app: 'carebase', customer: 'cus_owner', lines: t.lines };
    t.history([{ ...t.sub, status: 'canceled' }]);
    expect(await foundersEligibility(t.live, input)).toBe(true);
    t.paid([{ id: 'in_old', subscription: t.sub.id, total: 19900 }]);
    expect(await foundersEligibility(t.live, input)).toBe(false);
    t.paid([{ id: 'in_old', subscription: t.sub.id, subtotal: 19900, total: 0 }]);
    expect(await foundersEligibility(t.live, input)).toBe(false);
    t.paid([]); t.history([{ ...t.sub, status: 'canceled', metadata: { app: 'carebase', hub_founders_sale: FOUNDERS_OFFER } }]);
    expect(await foundersEligibility(t.live, input)).toBe(false);
  });
  it('fails closed on truncated history and changed coupon terms', async () => {
    const t = fixture(); t.history(Object.assign([], { truncated: true }));
    await expect(foundersEligibility(t.live, { app: 'carebase', customer: 'cus_owner', lines: t.lines })).rejects.toMatchObject({ status: 409 });
    t.live.get.mockResolvedValue({ ...coupon, percent_off: 25 });
    await expect(foundersEligibility(t.live, { app: 'carebase', customer: null, lines: t.lines })).rejects.toMatchObject({ status: 503 });
  });
  it.each([['ownQuote', 'hub_checkout_quote'], ['ownRequest', 'hub_creation_request']])('keeps %s retries identical after their own purchase succeeds', async (field, metadata) => {
    const t = fixture(); t.sub.metadata[metadata] = 'original-purchase'; t.sub.metadata.hub_founders_sale = FOUNDERS_OFFER;
    t.paid([{ id: 'in_completed', subscription: t.sub.id, total: 9950 }]);
    const input = { app: 'carebase', customer: 'cus_owner', lines: t.lines, [field]: 'original-purchase' };
    expect(await foundersEligibility(t.live, input)).toBe(true);
    expect(await foundersEligibility(t.live, { ...input, [field]: 'different-purchase' })).toBe(false);
  });
  it('starts the year after the trial and applies to the first draft invoice and future renewals without a code', async () => {
    const t = fixture();
    await applyFoundersToInvoice(t.live, t.invoice.id);
    expect(t.sub.metadata.hub_founders_start).toBe(String(start));
    expect(t.sub.discounts).toEqual([saleDiscount]); expect(t.invoice.discounts).toEqual([saleDiscount]);
    expect(foundersWindow(t.sub)).toEqual({ start, end: Date.parse('2027-12-08T12:00:00Z') / 1000 });
    await applyFoundersToInvoice(t.live, t.invoice.id);
    expect(t.live.post).toHaveBeenCalledTimes(2);
  });
  it('recovers when the subscription update succeeds but the invoice update fails', async () => {
    const t = fixture(), original = t.live.post.getMockImplementation(); let failed = false;
    t.live.post.mockImplementation(async (...args) => { if (args[0].includes('/invoices/') && !failed) { failed = true; throw new Error('timeout'); } return original(...args); });
    await expect(applyFoundersToInvoice(t.live, t.invoice.id)).rejects.toThrow('timeout');
    await applyFoundersToInvoice(t.live, t.invoice.id);
    expect(t.invoice.discounts).toEqual([saleDiscount]);
    expect(t.live.post.mock.calls.filter(([path]) => path.includes('/subscriptions/'))).toHaveLength(1);
  });
  it('does not consume the sale during a free trial or replace another agreement', async () => {
    const t = fixture(); t.sub.status = 'trialing'; t.invoice.subtotal = 0;
    await applyFoundersToInvoice(t.live, t.invoice.id); expect(t.live.post).not.toHaveBeenCalled();
    t.sub.status = 'active'; t.invoice.subtotal = 19900; t.sub.discounts = [{ id: 'di_contract', coupon: { id: 'legacy' } }];
    await applyFoundersToInvoice(t.live, t.invoice.id); expect(t.live.post).not.toHaveBeenCalled();
  });
  it.each(['month', 'year'])('discounts exactly the first year of %s service and restores standard renewal', async cadence => {
    const t = fixture(); t.sub.metadata = { ...t.sub.metadata, hub_founders_sale: FOUNDERS_OFFER };
    const end = foundersWindow(t.sub).end;
    for (let n = 0; n < (cadence === 'month' ? 12 : 1); n++) {
      const date = new Date(start * 1000); date.setUTCMonth(date.getUTCMonth() + n);
      const next = new Date(date); next.setUTCMonth(next.getUTCMonth() + (cadence === 'month' ? 1 : 12));
      t.invoice.discounts = []; t.invoice.id = `in_${n}`;
      t.invoiceLines([{ pricing: { price_details: { price } }, amount: 19900, period: { start: date.getTime() / 1000, end: next.getTime() / 1000 } }]);
      await applyFoundersToInvoice(t.live, t.invoice.id); expect(t.invoice.discounts).toEqual([saleDiscount]);
    }
    t.invoice.id = 'in_renewal'; t.invoiceLines([{ price: { id: price }, amount: 19900, period: { start: end, end: end + 31 * 86400 } }]);
    await applyFoundersToInvoice(t.live, t.invoice.id);
    expect(t.invoice.discounts).toEqual([]); expect(t.sub.discounts).toEqual([]);
  });
  it('holds mixed service dates instead of discounting a second annual period', async () => {
    const t = fixture(); t.sub.metadata.hub_founders_sale = FOUNDERS_OFFER;
    t.invoiceLines([{ price: { id: price }, amount: 19900, period: { start: start + 86400, end: foundersWindow(t.sub).end + 86400 } }]);
    await expect(applyFoundersToInvoice(t.live, t.invoice.id)).rejects.toMatchObject({ status: 409 });
    expect(t.live.post).toHaveBeenCalledWith('/v1/invoices/in_first', { auto_advance: false }, { idempotencyKey: 'hub-founders-hold-in_first' });
  });
  it('holds a change to private contract pricing instead of silently discounting it', async () => {
    const t = fixture(); t.sub.metadata.hub_founders_sale = FOUNDERS_OFFER;
    t.sub.items.data[0].price.id = 'price_private_contract';
    await expect(applyFoundersToInvoice(t.live, t.invoice.id)).rejects.toMatchObject({ status: 409 });
    expect(t.live.post).toHaveBeenCalledWith('/v1/invoices/in_first', { auto_advance: false }, { idempotencyKey: 'hub-founders-hold-in_first' });
    expect(t.sub.discounts).toEqual([]);
  });
  it.each(['expired', 'removed'])('leaves an %s offer out of later ordinary contract pricing', async reason => {
    const t = fixture(); t.sub.metadata = { ...t.sub.metadata, hub_founders_sale: FOUNDERS_OFFER, hub_founders_start: String(start) };
    t.sub.items.data[0].price.id = 'price_private_contract';
    t.invoice.created = reason === 'expired' ? foundersWindow(t.sub).end : start + 86400;
    await applyFoundersToInvoice(t.live, t.invoice.id);
    expect(t.live.post).not.toHaveBeenCalled(); expect(t.live.list).not.toHaveBeenCalled();
  });
  it('does not put a removed subscription discount back when its earlier draft invoice still has it', async () => {
    const t = fixture(); t.sub.metadata = { ...t.sub.metadata, hub_founders_sale: FOUNDERS_OFFER, hub_founders_start: String(start) };
    t.invoice.discounts = [saleDiscount];
    await applyFoundersToInvoice(t.live, t.invoice.id);
    expect(t.live.post).not.toHaveBeenCalled();
  });
  it('leaves an explicit replacement agreement and its private pricing unchanged', async () => {
    const t = fixture(), replacement = { id: 'di_contract', coupon: { id: 'contract' } };
    t.sub.metadata = { ...t.sub.metadata, hub_founders_sale: FOUNDERS_OFFER, hub_founders_start: String(start) };
    t.sub.discounts = [replacement]; t.invoice.discounts = [replacement];
    t.sub.items.data[0].price.id = 'price_private_contract';
    await applyFoundersToInvoice(t.live, t.invoice.id);
    expect(t.live.post).not.toHaveBeenCalled();
    expect(t.sub.discounts).toEqual([replacement]); expect(t.invoice.discounts).toEqual([replacement]);
    expect(t.live.list).not.toHaveBeenCalled();
  });
  it.each([price, 'price_private_contract'])('removes an expired invoice offer without changing the replacement agreement on %s', async renewalPrice => {
    const t = fixture(), replacement = { id: 'di_contract', coupon: { id: 'contract' } };
    t.sub.metadata = { ...t.sub.metadata, hub_founders_sale: FOUNDERS_OFFER, hub_founders_start: String(start) };
    t.sub.discounts = [replacement]; t.invoice.discounts = [saleDiscount, replacement];
    t.sub.items.data[0].price.id = renewalPrice;
    const end = foundersWindow(t.sub).end;
    t.invoiceLines([{ price: { id: renewalPrice }, amount: 19900, period: { start: end, end: end + 31 * 86400 } }]);
    await applyFoundersToInvoice(t.live, t.invoice.id);
    expect(t.live.post).toHaveBeenCalledTimes(1);
    expect(t.live.post).toHaveBeenCalledWith('/v1/invoices/in_first', { discounts: [{ discount: 'di_contract' }] }, { idempotencyKey: 'hub-founders-expire-invoice-in_first' });
    expect(t.sub.discounts).toEqual([replacement]);
  });
  it('removes only the expired subscription offer when a replacement agreement is also present', async () => {
    const t = fixture(), replacement = { id: 'di_contract', coupon: { id: 'contract' } };
    t.sub.metadata = { ...t.sub.metadata, hub_founders_sale: FOUNDERS_OFFER, hub_founders_start: String(start) };
    t.sub.discounts = [saleDiscount, replacement]; t.invoice.discounts = [replacement];
    const end = foundersWindow(t.sub).end;
    t.invoiceLines([{ price: { id: price }, amount: 19900, period: { start: end, end: end + 31 * 86400 } }]);
    await applyFoundersToInvoice(t.live, t.invoice.id);
    expect(t.live.post).toHaveBeenCalledTimes(1);
    expect(t.live.post).toHaveBeenCalledWith('/v1/subscriptions/sub_trial', { discounts: [{ discount: 'di_contract' }], proration_behavior: 'none' }, { idempotencyKey: 'hub-founders-expire-subscription-sub_trial' });
    expect(t.invoice.discounts).toEqual([replacement]);
  });
  it('keeps an earlier valid sale invoice when the subscription has a replacement agreement', async () => {
    const t = fixture();
    t.sub.metadata = { ...t.sub.metadata, hub_founders_sale: FOUNDERS_OFFER, hub_founders_start: String(start) };
    t.sub.discounts = [{ id: 'di_contract', coupon: { id: 'contract' } }]; t.invoice.discounts = [saleDiscount];
    await applyFoundersToInvoice(t.live, t.invoice.id);
    expect(t.live.post).not.toHaveBeenCalled();
  });
});
