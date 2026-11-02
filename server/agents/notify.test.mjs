import { describe, expect, it, vi } from 'vitest';
import { ownerNotifier, renderOwnerEmail } from './notify.mjs';

const origin = 'https://support-hub-web-production.up.railway.app';
const fixture = ({ duplicate = false, sms = { configured: true }, email = { configured: true }, phone = '+12025550701', ownerEmail = 'owner@example.test' } = {}) => {
  const calls = [];
  const logs = [];
  const store = {
    notifyBegin: vi.fn(async input => { calls.push(`begin ${input.channel}`); return { id: `n-${input.channel}`, duplicate, status: 'pending' }; }),
    notifyFinish: vi.fn(async (id, delivery) => { calls.push(`finish ${id} ${delivery}`); }),
    ownerContact: vi.fn(async () => (phone ? { phone } : null)),
  };
  const senders = {
    sms: { ...sms, send: vi.fn(async () => { calls.push('send sms'); return { delivery: 'sent', id: 'SM1' }; }) },
    email: { ...email, send: vi.fn(async () => { calls.push('send email'); return { delivery: 'sent', id: 'SG1' }; }) },
  };
  return { store, senders, calls, logs, notifier: ownerNotifier({ store, sms: senders.sms, email: senders.email, ownerEmail, publicOrigin: origin, log: line => logs.push(line) }) };
};

describe('owner notifier', () => {
  it('records a message before sending it and the outcome after', async () => {
    const { notifier, calls, senders } = fixture();
    const results = await notifier.send({ severity: 'warning', subject: 'Trial ending', body: 'Two trials end this week.', dedupeKey: 'k1', agentKey: 'chief_of_staff' });
    expect(results).toEqual([{ channel: 'email', delivery: 'sent' }]);
    expect(calls).toEqual(['begin email', 'send email', 'finish n-email sent']);
    expect(senders.email.send).toHaveBeenCalledWith('owner@example.test', 'Trial ending', { text: expect.any(String), html: expect.stringContaining('Trial ending') });
    expect(senders.sms.send).not.toHaveBeenCalled();
  });

  it('sends an urgent item by text and by email', async () => {
    const { notifier, senders, calls } = fixture();
    const results = await notifier.send({ severity: 'urgent', subject: 'Hub is down', body: 'The Hub probe failed twice.\n\nChecked at 07:05.', dedupeKey: 'k2' });
    expect(results).toEqual([{ channel: 'sms', delivery: 'sent' }, { channel: 'email', delivery: 'sent' }]);
    expect(senders.sms.send).toHaveBeenCalledWith('+12025550701', 'CareMetric: Hub is down. The Hub probe failed twice.');
    expect(calls.indexOf('send sms')).toBeGreaterThan(calls.indexOf('begin sms'));
  });

  it('emails the caller\'s own layout when it provides one, and stores the plain body', async () => {
    const { notifier, senders, store } = fixture();
    const blocks = [{ type: 'callout', tone: 'success', title: 'All clear.', text: 'Nothing needs you.' }, { type: 'details', rows: [['Runs', '12']] }];
    await notifier.send({ severity: 'info', subject: 'Brief', body: 'Nothing needs you.\n\nYesterday: 12 runs.', dedupeKey: 'k-blocks', blocks });
    const [, , content] = senders.email.send.mock.calls[0];
    expect(content.html).toContain('All clear.');
    expect(content.html).toContain('Runs');
    expect(content.text).toContain('Runs: 12');
    expect(store.notifyBegin).toHaveBeenCalledWith(expect.objectContaining({ body: 'Nothing needs you.\n\nYesterday: 12 runs.', channel: 'email' }));
  });

  it('refuses blocks that are not a non-empty list', async () => {
    const { notifier } = fixture();
    for (const blocks of [[], 'x', {}, 3]) {
      await expect(notifier.send({ severity: 'info', subject: 'S', body: 'B', dedupeKey: 'k-bad', blocks }), JSON.stringify(blocks)).rejects.toThrow(TypeError);
    }
  });

  it('keeps a text within two segments', async () => {
    const { notifier, senders } = fixture();
    await notifier.send({ severity: 'urgent', subject: 'S'.repeat(100), body: 'B'.repeat(900), dedupeKey: 'k3' });
    const [, text] = senders.sms.send.mock.calls[0];
    expect(text.length).toBeLessThanOrEqual(320);
    expect(text.endsWith('…')).toBe(true);
  });

  it('does not send a duplicate', async () => {
    const { notifier, senders, store } = fixture({ duplicate: true });
    expect(await notifier.send({ severity: 'urgent', subject: 'Hub is down', body: 'Down.', dedupeKey: 'k4' })).toEqual([{ channel: 'sms', delivery: 'duplicate', original: 'pending' }, { channel: 'email', delivery: 'duplicate', original: 'pending' }]);
    expect(senders.sms.send).not.toHaveBeenCalled();
    expect(senders.email.send).not.toHaveBeenCalled();
    expect(store.notifyFinish).not.toHaveBeenCalled();
  });

  it('records a channel it cannot use as suppressed instead of failing', async () => {
    for (const [options, channel] of [
      [{ sms: { configured: false } }, 'sms'], [{ phone: null }, 'sms'], [{ email: { configured: false } }, 'email'], [{ ownerEmail: 'not-an-address' }, 'email'], [{ ownerEmail: null }, 'email'],
    ]) {
      const { notifier, store } = fixture(options);
      const results = await notifier.send({ severity: 'urgent', subject: 'Hub is down', body: 'Down.', dedupeKey: 'k5' });
      expect(results.find(result => result.channel === channel).delivery, JSON.stringify(options)).toBe('suppressed');
      expect(store.notifyFinish).toHaveBeenCalledWith(`n-${channel}`, 'suppressed', null);
    }
  });

  it('records what the provider said, and an exception as an unknown outcome', async () => {
    const failed = fixture();
    failed.senders.email.send.mockResolvedValue({ delivery: 'failed', id: null });
    expect(await failed.notifier.send({ subject: 'S', body: 'B', dedupeKey: 'k6' })).toEqual([{ channel: 'email', delivery: 'failed' }]);
    expect(failed.store.notifyFinish).toHaveBeenCalledWith('n-email', 'failed', null);
    const thrown = fixture();
    thrown.senders.email.send.mockRejectedValue(new Error('socket hang up'));
    expect(await thrown.notifier.send({ subject: 'S', body: 'B', dedupeKey: 'k7' })).toEqual([{ channel: 'email', delivery: 'unknown' }]);
  });

  it('does not fail the task when the outcome cannot be recorded', async () => {
    const { notifier, store, logs } = fixture();
    store.notifyFinish.mockRejectedValue(new Error('db down'));
    expect(await notifier.send({ subject: 'S', body: 'B', dedupeKey: 'k8' })).toEqual([{ channel: 'email', delivery: 'sent' }]);
    expect(JSON.parse(logs[0])).toEqual({ event: 'hub_agent_notification_unsettled', channel: 'email' });
  });

  it('refuses a malformed notification', async () => {
    const { notifier } = fixture();
    await expect(notifier.send({ severity: 'loud', subject: 'S', body: 'B', dedupeKey: 'k' })).rejects.toThrow(/severity/);
    await expect(notifier.send({ subject: 'S', body: 'B' })).rejects.toThrow(/dedupe key/);
    await expect(notifier.send({ subject: '', body: 'B', dedupeKey: 'k' })).rejects.toThrow(/subject/);
  });

  it('clips what it stores', async () => {
    const { notifier, store } = fixture();
    await notifier.send({ subject: 'S'.repeat(300), body: 'B'.repeat(5000), dedupeKey: 'k9' });
    const input = store.notifyBegin.mock.calls[0][0];
    expect(input.subject.length).toBe(200);
    expect(input.body.length).toBe(4000);
  });
});

describe('owner email', () => {
  it('marks what needs attention and links to the Team screen', () => {
    const urgent = renderOwnerEmail({ subject: 'Hub is down', body: 'The Hub probe failed twice.\n\nWe will keep checking.', severity: 'urgent', publicOrigin: origin });
    expect(urgent.html).toContain('Needs your attention');
    expect(urgent.html).toContain(`${origin}/admin/team`);
    expect(urgent.text).toContain('The Hub probe failed twice.');
    expect(urgent.text).toContain('We will keep checking.');
    const info = renderOwnerEmail({ subject: 'Morning brief', body: 'All quiet.', publicOrigin: origin });
    expect(info.html).not.toContain('Needs your attention');
  });

  it('escapes anything that could be markup and drops a link it cannot make safe', () => {
    const email = renderOwnerEmail({ subject: '<script>alert(1)</script>', body: 'Body <b>bold</b>', publicOrigin: 'http://localhost:8080' });
    expect(email.html).not.toContain('<script>alert(1)</script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.html).not.toContain('/admin/team');
  });
});
