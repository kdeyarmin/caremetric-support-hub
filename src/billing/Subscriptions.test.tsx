// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Subscriptions } from './Subscriptions';

const methods = vi.hoisted(() => ({ workspace: vi.fn(), request: vi.fn() }));
vi.mock('../lib/config', () => ({ config: { demoMode: false } }));
vi.mock('../self-service/client', () => ({ selfServiceClient: { workspace: methods.workspace } }));
vi.mock('../lib/appSession', () => ({ appRequest: methods.request }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const connection = '97000000-0000-4000-8000-000000000021', quoteId = '97000000-0000-4000-8000-000000000022';
function show({ pending = false, enabled = true, url = 'https://checkout.stripe.com/c/pay/cs_test_synthetic' } = {}) {
  const workspace = { connection_id: connection, tenant_id: '97000000-0000-4000-8000-000000000023', app: 'carebase', role: 'organization_admin',
    mode: 'legacy', configuration_version: 0, can_activate: false, purchasing_enabled: enabled, facilities: [], allocations: [], subscription: null,
    customer: null, loaded_at: new Date().toISOString(),
    pending_checkout: pending ? { id: quoteId, state: 'pending_payment', due_now: 1000, currency: 'usd' } : null,
    catalog: [{ id: 'price_core', product: 'prod_core', name: 'Core', description: 'Organization plan', kind: 'plan', key: 'core', features: [],
      allows_addons: true, active: true, amount: 1000, currency: 'usd', interval: 'month', interval_count: 1, model: 'flat', unit_label: 'organization' }] };
  methods.workspace.mockResolvedValue({ connections: [{ id: connection, name: 'CareBase', role: 'organization_admin' }] });
  methods.request.mockImplementation(async (_path, input) => {
    if (input.action === 'workspace') return workspace;
    if (input.action === 'quote') return { id: quoteId, kind: 'checkout', facility_name: 'Organization subscription', due_now: 1000, currency: 'usd',
      recurring_subtotal: 1000, effective_at: null, expires_at: new Date(Date.now() + 300000).toISOString(), has_immediate_change: true,
      has_scheduled_change: false, summary: [{ name: 'Core', quantity: 1, amount: 1000 }] };
    if (input.action === 'checkout_cancel') { workspace.pending_checkout = null; return { state: 'failed' }; }
    workspace.pending_checkout = { id: quoteId, state: 'pending_payment', due_now: 1000, currency: 'usd' };
    return { state: 'pending_payment', url };
  });
  render(<MemoryRouter initialEntries={['/subscriptions?checkout=returned']}><Subscriptions /></MemoryRouter>);
}
async function chooseApp() {
  await screen.findByRole('option', { name: 'CareBase' });
  fireEvent.change(screen.getByLabelText('Application'), { target: { value: connection } });
  await screen.findByText('Subscription: Not set up');
}
describe('first subscription payment', () => {
  it('reviews and confirms a new subscription and treats the return URL as navigation only', async () => {
    show(); await chooseApp();
    expect(methods.request.mock.calls.every(([, input]) => input.action === 'workspace')).toBe(true);
    fireEvent.change(screen.getByLabelText('Base plan'), { target: { value: 'price_core' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review subscription' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and open payment' }));
    const link = await screen.findByRole('link', { name: 'Continue to secure payment' });
    expect(link.getAttribute('href')).toBe('https://checkout.stripe.com/c/pay/cs_test_synthetic');
    expect(screen.getByRole('status').textContent).toMatch(/Access begins after payment is verified/);
    expect(methods.request).toHaveBeenCalledWith('billing/customer', { action: 'confirm', quote_id: quoteId, confirmed: true });
  });
  it('keeps existing checkout recovery available when new purchases are disabled', async () => {
    show({ pending: true, enabled: false }); await chooseApp();
    fireEvent.click(screen.getByRole('button', { name: 'Check payment status / resume checkout' }));
    await screen.findByRole('link', { name: 'Continue to secure payment' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm cancel pending checkout' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancel pending checkout' }));
    await screen.findByText('Checkout is closed. You can review a new plan selection.');
    expect(methods.request).toHaveBeenCalledWith('billing/customer', { action: 'checkout_cancel', connection_id: connection, quote_id: quoteId, confirmed: true });
    expect(screen.queryByRole('link', { name: 'Continue to secure payment' })).toBeNull();
  });
  it('refuses an untrusted payment destination', async () => {
    show({ pending: true, url: 'https://checkout.stripe.com.evil.invalid/pay' }); await chooseApp();
    fireEvent.click(screen.getByRole('button', { name: 'Check payment status / resume checkout' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be verified/);
    expect(screen.queryByRole('link', { name: 'Continue to secure payment' })).toBeNull();
  });
});
