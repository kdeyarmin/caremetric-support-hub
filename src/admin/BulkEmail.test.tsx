// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Product } from '../domain';
import { BulkEmail } from './BulkEmail';
import { bulkEmailClient, plainBody, sameSelection, valueLabel, type BulkEmailClient, type Campaign } from './bulkEmailClient';

const product = (id: string, slug: string, name: string): Product => ({ id, slug, name, description: '', status: 'active', color: '#0a7369' });
const carebase = product('00000000-0000-4000-8000-000000000001', 'carebase', 'CareMetric CareBase');
const go = product('00000000-0000-4000-8000-000000000005', 'caremetric-go', 'CareMetric Go');
const advisors = product('00000000-0000-4000-8000-000000000007', 'advisors', 'CareMetric Healthcare Advisors');
const campaignId = '11111111-1111-4111-8111-111111111111';
const source = (overrides: Partial<Campaign['sources'][number]> = {}): Campaign['sources'][number] => ({
  productId: carebase.id, productName: carebase.name, productSlug: 'carebase', total: 620, read: 620, nextOffset: 620, loaded: true, truncated: false,
  roles: ['employee', 'org_admin'], statuses: ['active'],
  roleCounts: [{ value: 'employee', users: 400, withEmail: 380 }, { value: 'org_admin', users: 220, withEmail: 200 }],
  statusCounts: [{ value: 'active', users: 560, withEmail: 520 }, { value: 'disabled', users: 60, withEmail: 60 }], ...overrides,
});
const campaign = (overrides: Partial<Campaign> = {}): Campaign => ({
  id: campaignId, status: 'ready', subject: '', body: '', version: 2, createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T00:00:00Z',
  queuedAt: null, completedAt: null, recipientCount: 0, sources: [source()],
  audience: { selectedUsers: 560, withoutEmail: 40, unsubscribed: 3, recipients: 517 },
  delivery: { queued: 0, sending: 0, sent: 0, failed: 0, unknown: 0, cancelled: 0 }, unsubscribed: 0, ...overrides,
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const setup = (overrides: Partial<Record<keyof BulkEmailClient, unknown>> = {}) => {
  const client = {
    list: vi.fn(async () => ({ campaigns: [], loadedAt: '2026-10-21T00:00:00Z' })),
    get: vi.fn(async () => campaign()), create: vi.fn(async () => campaign({ status: 'loading', version: 1, audience: null, sources: [source({ read: 0, loaded: false, roles: [], statuses: [], roleCounts: [], statusCounts: [] })] })),
    load: vi.fn(async () => campaign()), save: vi.fn(async () => campaign()), test: vi.fn(async () => ({ delivery: 'sent' as const })),
    send: vi.fn(async () => campaign({ status: 'sending', version: 4, queuedAt: '2026-10-21T01:00:00Z', recipientCount: 517, audience: null, delivery: { queued: 517, sending: 0, sent: 0, failed: 0, unknown: 0, cancelled: 0 } })),
    cancel: vi.fn(async () => campaign({ status: 'cancelled', completedAt: '2026-10-21T01:00:00Z', audience: null })),
    ...overrides,
  } as unknown as BulkEmailClient & Record<string, ReturnType<typeof vi.fn>>;
  render(<BulkEmail products={[carebase, go, advisors]} client={client} demo={false} pollMs={20} />);
  return client;
};
const openDraft = async (client: ReturnType<typeof setup>, title = 'New email') => {
  await screen.findByText('No emails yet. Choose New email to write one.');
  (client.list as ReturnType<typeof vi.fn>).mockResolvedValue({ campaigns: [{ id: campaignId, status: 'ready', subject: '', recipientCount: 0, createdAt: '2026-10-21T00:00:00Z', queuedAt: null, completedAt: null, applications: ['CareMetric CareBase'], delivery: { outstanding: 0, sent: 0, failed: 0, unknown: 0, cancelled: 0 }, unsubscribed: 0 }], loadedAt: '' });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Open untitled draft' }));
  return within(await screen.findByRole('region', { name: title }));
};

describe('bulk email workspace', () => {
  it('starts an email for the chosen applications only, never Healthcare Advisors', async () => {
    const client = setup();
    fireEvent.click(await screen.findByRole('button', { name: 'New email' }));
    const panel = within(screen.getByRole('region', { name: 'Who should receive it?' }));
    expect(panel.queryByLabelText('CareMetric Healthcare Advisors')).toBeNull();
    fireEvent.click(panel.getByRole('button', { name: 'Read users' }));
    expect((await panel.findByRole('alert')).textContent).toBe('Choose at least one application.');
    fireEvent.click(panel.getByLabelText('CareMetric CareBase'));
    fireEvent.click(panel.getByLabelText('CareMetric Go'));
    fireEvent.click(panel.getByRole('button', { name: 'Read users' }));
    await waitFor(() => expect(client.create).toHaveBeenCalledWith([carebase.id, go.id]));
    // Reading continues page after page until the directory is loaded, then every role is shown with counts.
    await waitFor(() => expect(client.load).toHaveBeenCalled());
    const editor = within(await screen.findByRole('region', { name: 'New email' }));
    expect((editor.getByRole('checkbox', { name: /Org admin/ }) as HTMLInputElement).checked).toBe(true);
    expect((editor.getByRole('checkbox', { name: /Disabled/ }) as HTMLInputElement).checked).toBe(false);
    expect(editor.getByText('517')).toBeTruthy();
  });
  it('shows reading progress and lets the administrator retry a stopped read', async () => {
    const loading = campaign({ status: 'loading', audience: null, sources: [source({ read: 150, total: 620, loaded: false })] });
    const load = vi.fn().mockResolvedValueOnce(loading).mockRejectedValueOnce(new Error('CareBase did not answer.')).mockResolvedValue(campaign());
    const client = setup({ get: vi.fn(async () => loading), load });
    const panel = await openDraft(client);
    expect(await panel.findByText('150 of 620 users read')).toBeTruthy();
    expect((await panel.findByRole('alert')).textContent).toBe('CareBase did not answer.');
    fireEvent.click(panel.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(panel.getByRole('checkbox', { name: /Employee/ })).toBeTruthy());
  });
  it('narrows by role, needs a save to refresh the count, and sends exactly the reviewed count', async () => {
    const narrowed = campaign({ version: 3, subject: 'Maintenance', body: 'Down Saturday.', sources: [source({ roles: ['org_admin'] })], audience: { selectedUsers: 200, withoutEmail: 10, unsubscribed: 1, recipients: 189 } });
    const client = setup({ save: vi.fn(async () => narrowed) });
    const editor = await openDraft(client);
    fireEvent.click(editor.getByRole('checkbox', { name: /Employee/ }));
    expect(editor.getByText('Save the draft to update the recipient count.')).toBeTruthy();
    fireEvent.change(editor.getByLabelText('Subject'), { target: { value: 'Maintenance' } });
    fireEvent.change(editor.getByLabelText(/^Message/), { target: { value: 'Down Saturday.' } });
    expect((editor.getByRole('button', { name: /^Send to/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(editor.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(client.save).toHaveBeenCalledWith(expect.objectContaining({ id: campaignId, version: 2 }), 'Maintenance', 'Down Saturday.', { [carebase.id]: { roles: ['org_admin'], statuses: ['active'] } }));
    await editor.findByText('189');
    const send = editor.getByRole('button', { name: 'Send to 189 recipients' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(editor.getByRole('checkbox', { name: /I reviewed the audience and message/ }));
    fireEvent.click(send);
    await waitFor(() => expect(client.send).toHaveBeenCalledWith(narrowed, 189));
    await editor.findByText('Sending started. You can leave this page; delivery continues on the Hub.');
    expect(editor.getByText('Refused by SendGrid')).toBeTruthy();
  });
  it('sends a test only after the draft is saved', async () => {
    const client = setup({ get: vi.fn(async () => campaign({ subject: 'Hello', body: 'World' })) });
    const editor = await openDraft(client, 'Hello');
    fireEvent.change(editor.getByLabelText('Send a test to'), { target: { value: 'me@caremetric.ai' } });
    fireEvent.change(editor.getByLabelText('Subject'), { target: { value: 'Hello again' } });
    expect((editor.getByRole('button', { name: 'Send test' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(editor.getByLabelText('Subject'), { target: { value: 'Hello' } });
    fireEvent.click(editor.getByRole('button', { name: 'Send test' }));
    await waitFor(() => expect(client.test).toHaveBeenCalledWith(expect.objectContaining({ id: campaignId }), 'me@caremetric.ai'));
    await editor.findByText('Test sent to me@caremetric.ai.');
  });
  it('refuses a message with control characters before saving', async () => {
    const client = setup();
    const editor = await openDraft(client);
    fireEvent.change(editor.getByLabelText(/^Message/), { target: { value: 'Bad \u0007 bell' } });
    fireEvent.click(editor.getByRole('button', { name: 'Save draft' }));
    expect((await editor.findByRole('alert')).textContent).toMatch(/plain-text message/);
    expect(client.save).not.toHaveBeenCalled();
  });
  it('shows the server reason when a send is refused and keeps the draft', async () => {
    const client = setup({ get: vi.fn(async () => campaign({ subject: 'S', body: 'B' })), send: vi.fn(async () => { throw new Error('The audience is now 516 recipients. Review it again before sending.'); }) });
    const editor = await openDraft(client, 'S');
    fireEvent.click(editor.getByRole('checkbox', { name: /I reviewed/ }));
    fireEvent.click(editor.getByRole('button', { name: 'Send to 517 recipients' }));
    expect((await editor.findByRole('alert')).textContent).toBe('The audience is now 516 recipients. Review it again before sending.');
    expect(editor.getByText('Draft')).toBeTruthy();
  });
  it('follows delivery while sending and can stop the rest', async () => {
    const sending = campaign({ status: 'sending', subject: 'Update', body: 'Text', queuedAt: '2026-10-21T01:00:00Z', recipientCount: 10, audience: null, delivery: { queued: 6, sending: 1, sent: 3, failed: 0, unknown: 0, cancelled: 0 } });
    const later = { ...sending, delivery: { queued: 2, sending: 0, sent: 7, failed: 1, unknown: 0, cancelled: 0 } };
    const get = vi.fn().mockResolvedValueOnce(sending).mockResolvedValue(later);
    const client = setup({ get });
    const editor = await openDraft(client, 'Update');
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(1));
    await waitFor(() => expect(editor.getByText('Sent').nextSibling?.textContent).toBe('7'));
    fireEvent.click(editor.getByRole('button', { name: 'Stop sending…' }));
    fireEvent.click(editor.getByRole('button', { name: 'Stop sending' }));
    await waitFor(() => expect(client.cancel).toHaveBeenCalled());
    await editor.findByText('Cancelled');
  });
  it('lists earlier emails with honest delivery counts', async () => {
    setup({ list: vi.fn(async () => ({ campaigns: [{ id: campaignId, status: 'sent', subject: 'October update', recipientCount: 812, createdAt: '2026-10-01T00:00:00Z', queuedAt: '2026-10-01T01:00:00Z', completedAt: '2026-10-01T01:20:00Z', applications: ['CareMetric CareBase', 'PennSync'], delivery: { outstanding: 0, sent: 809, failed: 2, unknown: 1, cancelled: 0 }, unsubscribed: 4 }], loadedAt: '' })) });
    expect(await screen.findByText('October update')).toBeTruthy();
    expect(screen.getByText('812 recipients · 809 sent · 2 failed · 1 unconfirmed · 4 unsubscribed')).toBeTruthy();
    expect(screen.getByText('CareMetric CareBase, PennSync')).toBeTruthy();
  });
  it('does not request private records in demo mode', () => {
    const client = { list: vi.fn() } as unknown as BulkEmailClient;
    render(<BulkEmail products={[carebase]} client={client} demo />);
    expect(client.list).not.toHaveBeenCalled();
    expect(screen.getByText(/Demo mode does not contain your users/)).toBeTruthy();
  });
});

describe('bulk email helpers and transport', () => {
  it('labels raw role values, compares selections and accepts plain text only', () => {
    expect(valueLabel('org_admin')).toBe('Org admin');
    expect(valueLabel('facility-manager')).toBe('Facility manager');
    expect(sameSelection({ a: { roles: ['x', 'y'], statuses: ['s'] } }, { a: { roles: ['y', 'x'], statuses: ['s'] } })).toBe(true);
    expect(sameSelection({ a: { roles: ['x'], statuses: ['s'] } }, { a: { roles: ['x'], statuses: [] } })).toBe(false);
    expect(plainBody('Line one\r\n\tLine two')).toBe(true);
    expect(plainBody('Bell \u0007')).toBe(false);
  });
  it('sends the reviewed count and version to the same-origin bulk email API', async () => {
    const reviewed = campaign({ version: 7 });
    const fetcher = vi.fn(async () => Response.json(campaign({ status: 'sending', queuedAt: '2026-10-21T01:00:00Z', audience: null })));
    vi.stubGlobal('fetch', fetcher);
    await bulkEmailClient.send(reviewed, 517);
    expect(fetcher).toHaveBeenCalledWith('/api/admin/bulk-email/send', expect.objectContaining({ method: 'POST', credentials: 'same-origin', body: JSON.stringify({ id: campaignId, version: 7, recipients: 517 }) }));
  });
});
