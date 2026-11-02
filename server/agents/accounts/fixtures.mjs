// Synthetic accounts for the Account Manager's tests: invented names, one Monday as "now", nothing real.
export const now = new Date('2026-11-02T12:00:00Z');
export const iso = days => new Date(now.getTime() + days * 86_400_000).toISOString();

export const item = (over = {}) => ({ product: 'prod_core', quantity: 1, unit_amount: 4900, currency: 'usd', interval: 'month', interval_count: 1, kind: 'plan', product_name: 'Core', ...over });
export const subscription = (over = {}) => ({
  app: 'carebase', status: 'active', collection_method: 'charge_automatically', cancel_at_period_end: false, cancel_at: null, canceled_at: null, ended_at: null,
  current_period_start: iso(-10), current_period_end: iso(20), trial_start: null, trial_end: null, discounts: [], created: iso(-120), items: [item()], ...over,
});
export const account = (over = {}) => ({
  slug: 'maple-grove', name: 'Maple Grove', status: 'active', createdAt: iso(-200), products: [{ slug: 'carebase', planCode: 'core', status: 'active' }],
  customer: { delinquent: false, balanceCents: 0, hasEmail: true }, subscriptions: [subscription()],
  invoices: { open: 0, overdue: 0, remainingCents: 0, oldestOverdueDue: null, latestPaidAt: iso(-5) },
  usage: [], cases: { waitingOnYou: 0, highOrUrgent: 0, waitingOnCustomer: 0, oldestOpenAt: null }, ...over,
});
export const snapshot = (accounts, over = {}) => ({ generatedAt: now.toISOString(), mode: 'live', total: accounts.length, truncated: false, coupons: [], accounts, ...over });
