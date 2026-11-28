// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StateLaunchesPanel } from './StateLaunches';
const settings = vi.hoisted(() => ({ demoMode: false }));
vi.mock('../lib/config', () => ({ config: settings }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const services = { declared: true, instantly: true, hunter: true, feed: true, senders: 4, webhook: true, subscribed: true };
const states = [{ code: 'OH', name: 'Ohio' }, { code: 'PA', name: 'Pennsylvania' }];
const ready = { id: 'l-1', state: 'OH', status: 'ready', stage: 'done', progress: { looked: 120, found: 80, hunterSearches: 150 },
  summary: { leads: 78, pendingLeft: true }, error: null, createdAt: '2026-11-28T10:00:00Z', readyAt: '2026-11-28T14:00:00Z', launchedAt: null,
  campaigns: { agency: { id: '01a22025-ddd5-70e2-97ec-decc9bca9484', name: 'Ohio – Home health & hospice owners', leads: 50 },
    snf: { id: '01a22041-dcaa-750b-a51e-3c80d6742fbf', name: 'Ohio – Skilled nursing administrators', leads: 28 } }, counts: { added: 78, held: 40 } };
const facilities = [
  { id: 't-1', ccn: '367001', setting: 'hospice', name: 'Valley Hospice', city: 'Akron', county: 'Summit', segment: 'agency', status: 'added', note: null, chainName: null,
    personName: 'Mary Smith', title: 'Owner', email: 'mary@valleyhospice.com', domain: 'valleyhospice.com' },
  { id: 't-2', ccn: '365003', setting: 'nursing_home', name: 'General Hospital TCU', city: 'Akron', county: 'Summit', segment: 'snf', status: 'held', note: 'hospital_based',
    chainName: null, personName: null, title: null, email: null, domain: null },
];

function api(answers: Record<string, unknown>) {
  const calls: { operation: string; data: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { operation: string; data: Record<string, unknown> };
    calls.push(body);
    return new Response(JSON.stringify(answers[body.operation] ?? {}));
  }));
  return calls;
}

it('queues the state the owner chooses, and says what is missing first', async () => {
  const calls = api({ launches: { enabled: false, launches: [], services: { ...services, instantly: false }, states }, launchRequest: { id: 'l-2' } });
  render(<StateLaunchesPanel revision={0} />);
  const missing = await screen.findByText(/Before a state can be built/);
  expect(missing.textContent).toContain('Build state launches in Instantly');
  expect(missing.textContent).toContain('INSTANTLY_API_KEY');
  expect(screen.getByText(/Pennsylvania was built by hand/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Next state'), { target: { value: 'OH' } });
  fireEvent.click(screen.getByRole('button', { name: 'Build this state' }));
  await waitFor(() => expect(calls.some(c => c.operation === 'launchRequest')).toBe(true));
  expect(calls.find(c => c.operation === 'launchRequest')?.data).toEqual({ state: 'OH' });
  expect(await screen.findByText(/Ohio is queued/)).toBeTruthy();
});

it('launches a ready state with one click, and shows who is in it', async () => {
  const calls = api({ launches: { enabled: true, launches: [ready], services, states }, launch: facilities, launchApprove: { id: 'l-1', status: 'launching' } });
  render(<StateLaunchesPanel revision={0} />);
  expect(await screen.findByText(/Ready: 78 people in draft campaigns. Nothing is sent until you click Launch./)).toBeTruthy();
  expect(screen.getByText('Ohio – Home health & hospice owners: 50 people')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Find more people' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Facilities' }));
  expect(await screen.findByText('Mary Smith')).toBeTruthy();
  expect(screen.queryByText('General Hospital TCU')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Show all 2 facilities' }));
  expect(await screen.findByText('In a hospital')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Launch Ohio' }));
  await waitFor(() => expect(calls.find(c => c.operation === 'launchApprove')?.data).toEqual({ id: 'l-1' }));
  expect(await screen.findByText(/Ohio is starting/)).toBeTruthy();
});
