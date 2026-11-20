// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureWorkspace } from './billingFixtures';
import { InvitationsTab } from './Invitations';
import { invitablePrices } from './invitationPrices';
import type { InvitationClient } from './invitationClient';
import type { Invitation } from './invitationProtocol';

vi.hoisted(() => { vi.stubEnv('VITE_DEMO_MODE', 'true'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const invitation = (overrides: Partial<Invitation> = {}): Invitation => ({
  id: '00000000-0000-4000-8000-0000000000c1', app: 'carebase', contact_name: 'Jane Doe', contact_email: 'jane@maple.test', organization_name: 'Maple Grove',
  price: 'price_core_monthly', plan_name: 'Core', unit_label: 'facility', pricing_model: 'per_unit', quantity: 3, unit_amount: 19900, currency: 'usd',
  interval: 'month', interval_count: 1, discount_percent: 50, discount_duration: 'repeating', discount_months: 12, note: '', status: 'pending',
  expires_at: '2026-12-19T00:00:00Z', tenant_id: null, subscription: null, pending_account_hint: null, pending_account_at: null, account_hint: null,
  claim_method: null, claimed_at: null, email_status: 'sent', email_sent_at: '2026-11-19T00:00:00Z', send_count: 1, accepted_at: null, activated_at: null,
  revoked_at: null, created_at: '2026-11-19T00:00:00Z', version: 2, ...overrides,
});
const client = (overrides: Partial<InvitationClient> = {}): InvitationClient => ({
  list: vi.fn(async () => [invitation(), invitation({ id: '00000000-0000-4000-8000-0000000000c2', app: 'breathe', organization_name: 'Keystone Sleep', status: 'active',
    pricing_model: 'flat', quantity: 1, unit_label: '', plan_name: 'Launch', unit_amount: 79900, discount_percent: 100, discount_duration: 'forever', discount_months: null,
    pending_account_hint: 'a1b2c3', tenant_id: '00000000-0000-4000-8000-0000000000a2', subscription: 'sub_free' })]),
  preview: vi.fn(async () => ({ subject: 'Your CareMetric CareBase account for Maple Grove', html: '<!DOCTYPE html><p>Preview</p>', text: 'Preview' })),
  create: vi.fn(async record => ({ invitation: invitation({ contact_email: record.contact_email, organization_name: record.organization_name }), delivery: 'sent' as const })),
  change: vi.fn(async () => ({ invitation: invitation(), delivery: 'sent' as const })),
  ...overrides,
});
const fill = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('Billing → Invite a customer', () => {
  it('offers only published, recurring plan prices of the chosen application', () => {
    const data = fixtureWorkspace();
    data.prices.push({ ...data.prices[0], id: 'price_custom', tenant_id: '00000000-0000-4000-8000-0000000000a1' }, { ...data.prices[0], id: 'price_old', active: false });
    expect(invitablePrices(data, 'carebase').map(option => option.price.id)).toEqual(['price_core_monthly']);
    expect(invitablePrices(data, 'breathe').map(option => option.label)).toEqual(['Launch — $799.00 per month']);
    expect(invitablePrices(data, 'caremetric-intel')).toEqual([]);
  });

  it('shows the price the customer will pay, and that a complimentary plan skips Stripe', async () => {
    render(<InvitationsTab data={fixtureWorkspace()} client={client()} />);
    fill('Number of facilities', '3');
    fill('Percent off', '50');
    fill('Lasts', 'repeating');
    fill('Months', '12');
    const summary = document.querySelector('.invite-summary') as HTMLElement;
    expect(within(summary).getByText('$597.00 per month ($199.00 per facility × 3)')).toBeTruthy();
    expect(within(summary).getByText('50% off for your first 12 months')).toBeTruthy();
    expect(within(summary).getByText('$298.50 per month for your first 12 months, then $597.00 per month')).toBeTruthy();
    expect(within(summary).getByText(/They pay in Stripe Checkout/)).toBeTruthy();
    fill('Percent off', '100');
    fill('Lasts', 'forever');
    expect(within(document.querySelector('.invite-summary') as HTMLElement).getByText(/they skip Stripe entirely/)).toBeTruthy();
    await screen.findByText('Maple Grove');
  });

  // Intel can't take a code for an organization that already uses it (that organization is connected to its own customer),
  // so the form says where its price is changed instead.
  it('tells the owner how an organization that already uses Intel gets its price', () => {
    render(<InvitationsTab data={fixtureWorkspace()} client={client({})} />);
    expect(screen.queryByText(/If the organization already uses Intel/)).toBeNull();
    fireEvent.click(screen.getByLabelText('CareMetric Intel'));
    expect(screen.getByText(/If the organization already uses Intel, don't invite it: change its plan, price or discount on its page under Customers/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('CareMetric Breathe'));
    expect(screen.queryByText(/If the organization already uses Intel/)).toBeNull();
  });

  it('previews the email, then sends the invitation once with a stable request key', async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error('Network down')).mockImplementation(async record => ({ invitation: invitation({ contact_email: record.contact_email }), delivery: 'sent' as const }));
    const api = client({ create });
    render(<InvitationsTab data={fixtureWorkspace()} client={api} />);
    fireEvent.click(screen.getByLabelText('CareMetric Breathe'));
    fill('Contact name', 'Sam Lee'); fill('Contact email', 'Sam@Keystone.test'); fill('Organization', 'Keystone Sleep');
    expect(screen.queryByLabelText(/Number of/)).toBeNull();
    fill('Percent off', '100');
    fill(/Personal note/, 'Welcome aboard.');
    fireEvent.click(screen.getByRole('button', { name: 'Preview email' }));
    expect(await screen.findByTitle('Invitation email preview')).toBeTruthy();
    expect(api.preview).toHaveBeenCalledWith({ app: 'breathe', contact_name: 'Sam Lee', contact_email: 'sam@keystone.test', organization_name: 'Keystone Sleep',
      price: 'price_launch', quantity: 1, discount_percent: 100, discount_duration: 'forever', discount_months: null, note: 'Welcome aboard.' });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText('Network down')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText('Invitation emailed to sam@keystone.test.')).toBeTruthy();
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][1]).toBe(create.mock.calls[1][1]);
  });

  it('refuses an incomplete invitation before sending', async () => {
    const api = client();
    render(<InvitationsTab data={fixtureWorkspace()} client={api} />);
    fill('Contact name', 'Jane'); fill('Contact email', 'not-an-email'); fill('Organization', 'Maple');
    fireEvent.submit(screen.getByRole('form', { name: 'New invitation' }));
    expect(await screen.findByText('Enter the contact\'s email address.')).toBeTruthy();
    expect(api.create).not.toHaveBeenCalled();
  });

  it('lists invitations and links an account that signed up without the link', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const api = client();
    render(<InvitationsTab data={fixtureWorkspace()} client={api} />);
    const row = (await screen.findByText('Keystone Sleep')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Active · waiting for sign-up')).toBeTruthy();
    expect(within(row).getByText(/account …a1b2c3/)).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Revoke' })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Link account' }));
    await waitFor(() => expect(api.change).toHaveBeenCalledWith('link', '00000000-0000-4000-8000-0000000000c2', 2));
    const pending = screen.getByText('Maple Grove').closest('tr') as HTMLElement;
    expect(within(pending).getByText('Invited')).toBeTruthy();
    fireEvent.click(within(pending).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(api.change).toHaveBeenCalledWith('revoke', '00000000-0000-4000-8000-0000000000c1', 2));
  });
});
