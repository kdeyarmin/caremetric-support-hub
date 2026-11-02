import { describe, expect, it } from 'vitest';
import { dueMoment, mustHaveReached } from './shared.mjs';

describe('when a scheduled task was due', () => {
  const schedule = '6c1d0000-0000-4000-8000-000000000001';

  it('reads the due time from the request key a schedule gives its task', () => {
    expect(dueMoment({ requestKey: `schedule:${schedule}:20261102T120000Z` })?.toISOString()).toBe('2026-11-02T12:00:00.000Z');
    expect(dueMoment({ requestKey: `schedule:${schedule}:20270309T110500Z` })?.toISOString()).toBe('2027-03-09T11:05:00.000Z');
  });

  it('knows nothing about any other task', () => {
    for (const task of [null, undefined, {}, { requestKey: 'owner:abc' }, { requestKey: `schedule:${schedule}:soon` }, { requestKey: `schedule:nope:20261102T120000Z` }, { requestKey: `schedule:${schedule}:20261102T120000Z:extra` }]) {
      expect(dueMoment(task), JSON.stringify(task)).toBeNull();
    }
  });
});

describe('a message the owner must get', () => {
  it('is retried when a provider refused it, and only then', () => {
    expect(() => mustHaveReached([{ channel: 'sms', delivery: 'failed' }, { channel: 'email', delivery: 'sent' }])).toThrow(expect.objectContaining({ code: 'notification_failed', transient: true }));
    for (const delivery of ['sent', 'unknown', 'suppressed', 'duplicate']) expect(() => mustHaveReached([{ channel: 'email', delivery }]), delivery).not.toThrow();
    expect(() => mustHaveReached([])).not.toThrow();
  });
});
