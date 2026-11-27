// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OwnerSequencesPanel } from './OwnerSequences';
const settings = vi.hoisted(() => ({ demoMode: false }));
vi.mock('../lib/config', () => ({ config: settings }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const services = { declared: true, enabled: false, mail: true, feed: true, reports: true, signing: true };
const templates = [{ id: 'intel-pa-cold-2026-11', label: 'CareMetric Intel, Pennsylvania cold email (November 27, 2026 copy)', steps: 3 }];
const summary = { id: 'seq-1', name: 'Pennsylvania cold email, batch 1', template: 'intel-pa-cold-2026-11', campaign: 'pa-cold-email', sendDates: ['2026-12-01', '2026-12-04', '2026-12-09'],
  status: 'draft', version: 1, dailyLimit: 8, windowStart: '09:00:00', windowEnd: '11:00:00', created_at: '2026-11-27T18:00:00Z', approvedAt: null, stoppedAt: null,
  people: 2, stopped: 0, replied: 0, opened: 0, sent: 0, scheduled: 6 };
const message = (step: number, subject: string, body: string) => ({ id: `m-${step}`, step, sendOn: summary.sendDates[step - 1], subject, body, status: 'scheduled', attemptedAt: null, deliveredAt: null });
const detail = { ...summary, sender: { fromName: 'Kevin Deyarmin' }, createdAt: summary.created_at, finishedAt: null, people: [
  { id: 'r-1', ref: 'pa-b1-01', email: 'jane@valleyhh.example', firstName: 'Jane', agency: 'Valley Home Health', county: 'Erie', setting: 'hha', ccn: '397001',
    reportUrl: 'https://www.caremetricintel.com/report/abc.def/view', notes: { listCounty: 'Crawford' }, status: 'active', stopReason: null, repliedAt: null, stoppedAt: null, openedAt: null, blocked: null,
    messages: [message(1, 'Valley Home Health in Erie County', 'Hi Jane,\n\nI ran Valley Home Health through it.'), message(2, 'When a referral source goes quiet', 'Hi Jane,\n\nTwo.'), message(3, 'Last note on Erie County', 'Hi Jane,\n\nThree.')] },
  { id: 'r-2', ref: 'pa-b1-03', email: 'info@ridge.example', firstName: null, agency: 'Ridge Hospice', county: 'Crawford', setting: 'hospice', ccn: null, reportUrl: null,
    notes: { noMatch: 'no_match' }, status: 'active', stopReason: null, repliedAt: null, stoppedAt: null, openedAt: null, blocked: null,
    messages: [message(1, 'Which hospitals Crawford County residents use most', 'Hi there,\n\nOne.'), message(2, 'When a referral source goes quiet', 'Hi there,\n\nTwo.'), message(3, 'Last note on Crawford County', 'Hi there,\n\nThree.')] },
] };

function api(answers: Record<string, unknown>) {
  const calls: { operation: string; data: Record<string, unknown> }[] = [];
  const request = vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { operation: string; data: Record<string, unknown> };
    calls.push(body);
    return new Response(JSON.stringify(answers[body.operation] ?? {}));
  });
  vi.stubGlobal('fetch', request);
  return calls;
}

it('shows every email word for word and approves only once the owner says they read them', async () => {
  const calls = api({ sequences: { sequences: [summary], templates, services }, sequence: detail, sequenceApprove: { id: 'seq-1', version: 2 } });
  render(<OwnerSequencesPanel revision={0} />);
  expect((await screen.findByText(/Before anything is sent/)).textContent).toContain('Send your own email sequences');
  fireEvent.click(await screen.findByRole('button', { name: 'Pennsylvania cold email, batch 1' }));
  expect(await screen.findByText(/from Kevin Deyarmin, replies to the support inbox/)).toBeTruthy();
  expect(screen.getByText('(no first name: "Hi there,")')).toBeTruthy();
  expect(screen.getByText(/The report's county is used \(the list said Crawford\)/)).toBeTruthy();
  expect(screen.getByText(/No confident CMS match/)).toBeTruthy();
  expect(screen.getByText('Subject: Valley Home Health in Erie County', { exact: false })).toBeTruthy();
  expect(screen.getByText((_, node) => node?.tagName === 'PRE' && node.textContent === 'Hi Jane,\n\nI ran Valley Home Health through it.')).toBeTruthy();
  const approve = screen.getByRole('button', { name: 'Approve and schedule' }) as HTMLButtonElement;
  expect(approve.disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: /I read every email above/ }));
  fireEvent.click(approve);
  await waitFor(() => expect(calls.some(call => call.operation === 'sequenceApprove')).toBe(true));
  expect(calls.find(call => call.operation === 'sequenceApprove')?.data).toEqual({ id: 'seq-1', version: 1 });
  expect(await screen.findByText(/Approved. The first emails go out/)).toBeTruthy();
});

it('prepares a send list and says why each left-out row was left out', async () => {
  const calls = api({ sequences: { sequences: [], templates, services: { ...services, enabled: true } },
    sequencePrepare: { saved: null, problems: [{ row: 4, ref: 'pa-b1-09', agency: 'Hill Home Health', reason: 'home_area' }, { row: null, ref: 'pa-b1-07', agency: 'Old Agency', reason: 'do_not_contact' }] } });
  render(<OwnerSequencesPanel revision={0} />);
  fireEvent.click(await screen.findByText('Prepare a sequence from a send list'));
  fireEvent.change(screen.getByLabelText('Email 1 date'), { target: { value: '2026-12-01' } });
  fireEvent.change(screen.getByLabelText('Email 2 date'), { target: { value: '2026-12-04' } });
  fireEvent.change(screen.getByLabelText('Email 3 date'), { target: { value: '2026-12-09' } });
  fireEvent.change(screen.getByLabelText('Or paste it'), { target: { value: 'ref,email\npa-b1-09,a@b.example' } });
  fireEvent.click(screen.getByRole('button', { name: 'Prepare the emails' }));
  expect(await screen.findByText(/Hill Home Health: In Cambria County or a county bordering it/)).toBeTruthy();
  expect(screen.getByText(/Old Agency: Said no before: on the do-not-contact list/)).toBeTruthy();
  expect(calls.find(call => call.operation === 'sequencePrepare')?.data).toEqual({ name: 'Pennsylvania cold email, batch 1', csv: 'ref,email\npa-b1-09,a@b.example',
    template: 'intel-pa-cold-2026-11', campaign: 'pa-cold-email', sendDates: ['2026-12-01', '2026-12-04', '2026-12-09'], dailyLimit: 8 });
  expect(screen.queryByText(/Before anything is sent/)).toBeNull();
});
