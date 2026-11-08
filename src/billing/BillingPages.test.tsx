// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { BillingClient, CustomerBillingClient, MyBilling as MyBillingData } from './billingClient';
import { BillingWorkspace } from './BillingWorkspace';
import { CustomerBilling } from './CustomerBilling';
import { MyBilling } from './MyBilling';
import { fixtureCustomer, fixtureTenantId, fixtureWorkspace } from './billingFixtures';

vi.hoisted(() => { vi.stubEnv('VITE_DEMO_MODE', 'true'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const adminClient = (overrides: Partial<BillingClient> = {}): BillingClient => ({
  workspace: vi.fn(async () => fixtureWorkspace()),
  customer: vi.fn(async () => fixtureCustomer()),
  command: vi.fn(async () => ({ ok: true as const, id: 'ok' })),
  createTenant: vi.fn(async () => ({ id: fixtureTenantId })),
  saveTenant: vi.fn(async () => ({ id: fixtureTenantId, updated_at: '2026-10-27T00:00:00Z' })),
  ...overrides,
});

describe('Billing workspace', () => {
  it('totals subscriptions across applications and filters by application', async () => {
    render(<MemoryRouter initialEntries={['/admin/billing']}><BillingWorkspace client={adminClient()} demo={false} /></MemoryRouter>);
    const totals = await screen.findByLabelText('Subscription totals');
    expect(within(totals).getByText('$597.00')).toBeTruthy();
    expect(within(totals).getByText('$7,164.00')).toBeTruthy();
    expect(screen.getByText(/Test mode — no real charges/)).toBeTruthy();
    expect(screen.getAllByRole('article')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Application'), { target: { value: 'breathe' } });
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.getByText('Synthetic Home Medical')).toBeTruthy();
  });

  it('lists and offers only current coupons, but counts a deleted coupon still on a subscription', async () => {
    const workspace = fixtureWorkspace();
    workspace.coupons.push({ ...workspace.coupons[0], id: 'co_retired', name: 'Retired partner', valid: false, deleted: true });
    workspace.subscriptions[0] = { ...workspace.subscriptions[0], discounts: [{ id: 'di_retired', coupon: 'co_retired', promotion_code: null }] };
    render(<MemoryRouter initialEntries={['/admin/billing']}><BillingWorkspace client={adminClient({ workspace: vi.fn(async () => workspace) })} demo={false} /></MemoryRouter>);
    // 25% off the $597.00 subscription: Stripe still applies a coupon deleted after it was given.
    expect(within(await screen.findByLabelText('Subscription totals')).getByText('$447.75')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Billing sections' })).getByRole('button', { name: 'Discounts' }));
    expect(await screen.findByText('Founding agency')).toBeTruthy();
    expect(screen.queryByText('Retired partner')).toBeNull();
  });
  it('opens on the application named in the link', async () => {
    render(<MemoryRouter initialEntries={['/admin/billing?app=carebase']}><BillingWorkspace client={adminClient()} demo={false} /></MemoryRouter>);
    await screen.findByLabelText('Subscription totals');
    expect(screen.getAllByRole('article')).toHaveLength(1);
  });

  it('changes a price and moves current subscribers only when asked', async () => {
    const client = adminClient({ command: vi.fn(async () => ({ ok: true as const, id: 'price_new', migrated: 2, failed: 0 })) });
    render(<MemoryRouter initialEntries={['/admin/billing?tab=catalog']}><BillingWorkspace client={client} demo={false} /></MemoryRouter>);
    const core = await screen.findByText('$199.00 per facility per month', { exact: false });
    fireEvent.click(within(core.closest('li')!).getByRole('button', { name: /change price/i }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('New amount (USD)'), { target: { value: '249' } });
    fireEvent.click(within(dialog).getByLabelText('Move them now, with proration'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change price' }));
    await waitFor(() => expect(client.command).toHaveBeenCalledWith(expect.objectContaining({ action: 'price.change', price: 'price_core_monthly', unit_amount: 24900, migrate: 'prorate', expected_version: 1 })));
    expect(await screen.findByText(/2 subscription item\(s\) moved/)).toBeTruthy();
  });

  it('shows the preview without contacting Stripe', () => {
    const client = adminClient();
    render(<MemoryRouter><BillingWorkspace client={client} demo /></MemoryRouter>);
    expect(screen.getByText(/The preview has no Stripe connection/)).toBeTruthy();
    expect(client.workspace).not.toHaveBeenCalled();
  });
});

describe('Customer billing', () => {
  const renderCustomer = (client: BillingClient) => render(<MemoryRouter initialEntries={[`/admin/billing/customers/${fixtureTenantId}`]}>
    <Routes><Route path="/admin/billing/customers/:tenantId" element={<CustomerBilling client={client} demo={false} />} /></Routes></MemoryRouter>);

  it('schedules a cancellation at period end with the record version', async () => {
    const client = adminClient();
    renderCustomer(client);
    await screen.findByRole('heading', { name: 'Synthetic Senior Living' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(client.command).toHaveBeenCalledWith(expect.objectContaining({ action: 'subscription.cancel', subscription: 'sub_core', when: 'period_end', prorate: false, expected_version: 2 })));
    expect(await screen.findByText('Subscription cancels at the end of its period.')).toBeTruthy();
  });

  it('starts a subscription with an onboarding fee on the first invoice', async () => {
    const workspace = fixtureWorkspace();
    workspace.products.push({ id: 'prod_onboarding', app: 'carebase', name: 'Onboarding', description: '', active: true, kind: 'fee', entitlement_key: '', unit_label: '', created: '2026-10-01T00:00:00Z', version: 1 });
    workspace.prices.push({ id: 'price_onboarding', product: 'prod_onboarding', active: true, currency: 'usd', unit_amount: 50000, pricing_model: 'flat', type: 'one_time', interval: null,
      interval_count: null, lookup_key: null, nickname: '', tenant_id: null, replaces: null, created: '2026-10-01T00:00:00Z', version: 1, subscribers: 0 });
    const client = adminClient({ workspace: vi.fn(async () => workspace) });
    renderCustomer(client);
    fireEvent.click(await screen.findByRole('button', { name: 'New subscription' }));
    const dialog = screen.getByRole('dialog');
    expect(within(within(dialog).getByLabelText('Plan')).queryByText(/Onboarding/)).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Plan'), { target: { value: 'price_core_monthly' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add another add-on or fee' }));
    fireEvent.change(within(dialog).getByLabelText('Add-on or one-time fee'), { target: { value: 'price_onboarding' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create subscription' }));
    await waitFor(() => expect(client.command).toHaveBeenCalledWith(expect.objectContaining({ action: 'subscription.create',
      items: [{ price: 'price_core_monthly', quantity: 1 }, { price: 'price_onboarding', quantity: 1 }] })));
  });

  it('emails an open invoice’s payment link', async () => {
    const client = adminClient({ command: vi.fn(async () => ({ ok: true as const, id: 'emailed', url: 'https://invoice.stripe.com/i/synthetic' })) });
    renderCustomer(client);
    fireEvent.click(await screen.findByRole('button', { name: 'Email payment link' }));
    await waitFor(() => expect(client.command).toHaveBeenCalledWith(expect.objectContaining({ action: 'invoice.send', invoice: 'in_1', expected_version: 1 })));
    expect(await screen.findByText(/Invoice emailed to the billing contact/)).toBeTruthy();
  });

  it('provides the payment link without claiming it was copied when clipboard permission is denied', async () => {
    const customer = fixtureCustomer();
    customer.invoices[0].collection_method = 'charge_automatically';
    const url = 'https://invoice.stripe.com/i/synthetic';
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('Permission denied')) } });
    const client = adminClient({ customer: vi.fn(async () => customer), command: vi.fn(async () => ({ ok: true as const, url })) });
    renderCustomer(client);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy payment link' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(url));
    expect(screen.getByRole('status').textContent).toMatch(/could not.*cop|copy.*manually/i);
    expect(screen.getByRole('status').textContent).not.toContain('Payment link copied');
  });
});

describe('My billing', () => {
  const data: MyBillingData = {
    tenants: [{ id: fixtureTenantId, name: 'Synthetic Senior Living', has_customer: true,
      subscriptions: [{ app: 'carebase', status: 'active', cancel_at_period_end: false, current_period_end: '2026-11-01T00:00:00Z', trial_end: null, paused: false,
        items: [{ name: 'Core', kind: 'plan', quantity: 3, unit_label: 'facility', unit_amount: 19900, currency: 'usd', interval: 'month', interval_count: 1 }] }],
      invoices: [{ id: 'SYN-0001', number: 'SYN-0001', status: 'open', currency: 'usd', total: 59700, amount_remaining: 59700, due_date: '2026-11-01T00:00:00Z',
        created: '2026-10-01T00:00:00Z', hosted_invoice_url: 'https://invoice.stripe.com/i/synthetic', invoice_pdf: null }] }],
    loaded_at: '2026-10-27T00:00:00Z',
  };

  it('shows plans and invoices and opens the Stripe portal for the organization', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const client: CustomerBillingClient = { read: vi.fn(async () => data), portal: vi.fn(async () => 'https://billing.stripe.com/p/session/synthetic') };
    render(<MyBilling client={client} demo={false} />);
    expect(await screen.findByText('Synthetic Senior Living')).toBeTruthy();
    expect(screen.getByText(/Core/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /pay/i }).getAttribute('href')).toBe('https://invoice.stripe.com/i/synthetic');
    fireEvent.click(screen.getByRole('button', { name: /payment method/i }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://billing.stripe.com/p/session/synthetic'));
    expect(client.portal).toHaveBeenCalledWith(fixtureTenantId);
    vi.unstubAllGlobals();
  });

  it('prices each item by its own model, not by whether its product has a unit label', async () => {
    const item = (over: Partial<MyBillingData['tenants'][number]['subscriptions'][number]['items'][number]>) =>
      ({ name: 'Core', kind: 'plan', quantity: 1, unit_label: 'facility', unit_amount: 19900, currency: 'usd', interval: 'month', interval_count: 1, ...over });
    const priced: MyBillingData = { ...data, tenants: [{ ...data.tenants[0], invoices: [], subscriptions: [{ ...data.tenants[0].subscriptions[0], items: [
      item({ name: 'Flat plan', pricing_model: 'flat' }), item({ name: 'Seats', quantity: 3, pricing_model: 'per_unit' }), item({ name: 'Older database', quantity: 2 }),
    ] }] }] };
    render(<MyBilling client={{ read: vi.fn(async () => priced), portal: vi.fn() }} demo={false} />);
    const price = async (name: string) => (await screen.findByText(name)).closest('li')!.textContent;
    expect(await price('Flat plan')).toMatch(/\$199\.00 per month$/);
    expect(await price('Flat plan')).not.toMatch(/×|per facility/);
    expect(await price('Seats')).toMatch(/3 × \$199\.00 per facility per month$/);
    // A database that does not return the model yet keeps the unit-label guess.
    expect(await price('Older database')).toMatch(/2 × \$199\.00 per facility per month$/);
  });

  it('tells a member without billing access whom to ask', async () => {
    render(<MyBilling client={{ read: vi.fn(async () => ({ tenants: [], loaded_at: '2026-10-27T00:00:00Z' })), portal: vi.fn() }} demo={false} />);
    expect(await screen.findByText(/available to your organization's administrators/)).toBeTruthy();
  });

  it('identifies paused collection and never promises renewal of a canceled subscription', async () => {
    const paused = { ...data.tenants[0].subscriptions[0], paused: true };
    const canceled = { ...data.tenants[0].subscriptions[0], status: 'canceled', app: 'Canceled plan' };
    render(<MyBilling client={{ read: vi.fn(async () => ({ ...data, tenants: [{ ...data.tenants[0], subscriptions: [paused, canceled] }] })), portal: vi.fn() }} demo={false} />);
    await screen.findByText('Collection paused');
    const card = screen.getByRole('heading', { name: 'Canceled plan' }).closest('article')!;
    expect(within(card).queryByText(/Renews|Ends/)).toBeNull();
  });
});
