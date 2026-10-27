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
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

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

  it('emails an open invoice’s payment link', async () => {
    const client = adminClient({ command: vi.fn(async () => ({ ok: true as const, id: 'emailed', url: 'https://invoice.stripe.com/i/synthetic' })) });
    renderCustomer(client);
    fireEvent.click(await screen.findByRole('button', { name: 'Email payment link' }));
    await waitFor(() => expect(client.command).toHaveBeenCalledWith(expect.objectContaining({ action: 'invoice.send', invoice: 'in_1', expected_version: 1 })));
    expect(await screen.findByText(/Invoice emailed to the billing contact/)).toBeTruthy();
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

  it('tells a member without billing access whom to ask', async () => {
    render(<MyBilling client={{ read: vi.fn(async () => ({ tenants: [], loaded_at: '2026-10-27T00:00:00Z' })), portal: vi.fn() }} demo={false} />);
    expect(await screen.findByText(/available to your organization's administrators/)).toBeTruthy();
  });
});
