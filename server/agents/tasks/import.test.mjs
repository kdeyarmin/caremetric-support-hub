import { describe, expect, it, vi } from 'vitest';
import { importHandlers } from './import.mjs';
import { HttpError } from '../../sms-auth.mjs';

const sessionToken = 'S'.repeat(43);
const page = (overrides = {}) => ({ source: 'x', read: 200, created: 0, skipped: 200, nextOffset: null, ...overrides });
const run = (kind, sync, context = { sessionToken }) => importHandlers({ communications: { sync } })[kind]({ id: 't1' }, context);

describe('importing other applications\' messages', () => {
  it('registers nothing unless the inbox service is available', () => {
    expect(importHandlers({})).toEqual({});
    expect(importHandlers({ communications: {} })).toEqual({});
    expect(Object.keys(importHandlers({ communications: { sync: vi.fn() } })).sort()).toEqual(['import.advisors', 'import.breathe']);
  });

  it('waits for the owner\'s session instead of reading without one', async () => {
    const sync = vi.fn();
    expect(await run('import.advisors', sync, {})).toEqual({ status: 'awaiting_session', errorCode: 'session_required' });
    expect(await run('import.breathe', sync, { sessionToken: '' })).toEqual({ status: 'awaiting_session', errorCode: 'session_required' });
    expect(sync).not.toHaveBeenCalled();
  });

  it('copies each source from its own list and reports what it did', async () => {
    const sync = vi.fn(async () => page({ source: 'advisors.web', read: 12, created: 12, skipped: 0 }));
    expect(await run('import.advisors', sync)).toEqual({ result: { source: 'advisors.web', read: 12, created: 12, skipped: 0, calls: 1, complete: true, nextOffset: null } });
    expect(sync).toHaveBeenCalledWith(sessionToken, { source: 'advisors.web', offset: 0 });
    const phone = vi.fn(async () => page({ read: 3, created: 1, skipped: 2 }));
    expect((await run('import.breathe', phone)).result).toMatchObject({ source: 'breathe.phone', created: 1, skipped: 2, complete: true });
    expect(phone).toHaveBeenCalledWith(sessionToken, { source: 'breathe.phone', offset: 0 });
  });

  it('does not take a first window with nothing new for "caught up": an earlier run may have been cut off after copying it', async () => {
    // The newest 200 were copied by a run that then lost its session; the 200 behind them were never read.
    const sync = vi.fn()
      .mockResolvedValueOnce(page({ created: 0, skipped: 200, nextOffset: 200 }))
      .mockResolvedValueOnce(page({ created: 40, skipped: 160, nextOffset: 400 }))
      .mockResolvedValueOnce(page({ created: 0, skipped: 200, nextOffset: null }));
    expect(await run('import.advisors', sync)).toEqual({ result: { source: 'advisors.web', read: 600, created: 40, skipped: 560, calls: 3, complete: true, nextOffset: null } });
    expect(sync.mock.calls.map(call => call[1].offset)).toEqual([0, 200, 400]);
  });

  it('reads up to three calls, resuming where each stopped, and is complete only at the end of the list', async () => {
    const sync = vi.fn()
      .mockResolvedValueOnce(page({ created: 200, skipped: 0, nextOffset: 200 }))
      .mockResolvedValueOnce(page({ created: 7, skipped: 193, nextOffset: 400 }))
      .mockResolvedValueOnce(page({ created: 0, skipped: 200, nextOffset: 600 }));
    expect(await run('import.advisors', sync)).toEqual({ result: { source: 'advisors.web', read: 600, created: 207, skipped: 393, calls: 3, complete: false, nextOffset: 600 } });
    expect(sync.mock.calls.map(call => call[1].offset)).toEqual([0, 200, 400]);
    const short = vi.fn(async () => page({ created: 3, skipped: 0, nextOffset: null }));
    expect(await run('import.advisors', short)).toEqual({ result: { source: 'advisors.web', read: 200, created: 3, skipped: 0, calls: 1, complete: true, nextOffset: null } });
  });

  it('reads a source whose order is unknown through its whole window and says how far it got', async () => {
    const sync = vi.fn(async () => page({ created: 0, skipped: 200, nextOffset: 800 }));
    sync.mockResolvedValueOnce(page({ created: 0, skipped: 200, nextOffset: 200 })).mockResolvedValueOnce(page({ created: 0, skipped: 200, nextOffset: 400 })).mockResolvedValueOnce(page({ created: 0, skipped: 200, nextOffset: 600 }));
    expect(await run('import.breathe', sync)).toEqual({ result: { source: 'breathe.phone', read: 600, created: 0, skipped: 600, calls: 3, complete: false, nextOffset: 600 } });
    expect(sync).toHaveBeenCalledTimes(3);
  });

  it('turns a failed read into the right outcome and keeps what was already copied', async () => {
    const outcome = async (error, kind = 'import.advisors') => {
      const sync = vi.fn().mockResolvedValueOnce(page({ read: 50, created: 50, skipped: 0, nextOffset: 50 })).mockRejectedValue(error);
      return run(kind, sync);
    };
    // The summary names where the next read would resume, so a half-finished run is not mistaken for a complete one.
    const partial = { source: 'advisors.web', read: 50, created: 50, skipped: 0, calls: 1, complete: false, nextOffset: 50 };
    expect(await outcome(new HttpError(401, 'Sign in with an SMS code to continue.'))).toEqual({ status: 'awaiting_session', errorCode: 'session_required', result: partial });
    expect(await outcome(Object.assign(new Error('x'), { status: 401 }))).toMatchObject({ status: 'awaiting_session' });
    expect(await outcome(new HttpError(503, 'This application has not connected its administrator session.', 'unconfigured'))).toEqual({ status: 'done', result: { ...partial, skipped: 'not_connected' } });
    expect(await outcome(new HttpError(503, 'Administrator connection is unavailable.', 'upstream'))).toEqual({ status: 'queued', errorCode: 'bridge_unavailable', result: partial });
    expect(await outcome(new HttpError(429, 'Slow down.'))).toEqual({ status: 'queued', errorCode: 'rate_limited', result: partial });
    expect(await outcome(new HttpError(403, 'Administrator access could not be verified.'))).toEqual({ status: 'failed', errorCode: 'not_permitted', result: partial });
    for (const status of [400, 404, 409]) expect(await outcome(new HttpError(status, 'No.'))).toEqual({ status: 'failed', errorCode: 'request_rejected', result: partial });
  });

  it('leaves an error it cannot classify to the scheduler\'s retry policy', async () => {
    const boom = new Error('connection reset');
    await expect(run('import.advisors', vi.fn().mockRejectedValue(boom))).rejects.toBe(boom);
    await expect(run('import.breathe', vi.fn().mockRejectedValue(Object.assign(new Error('db'), { code: '57014' })))).rejects.toThrow('db');
  });

  it('stops reading once the scheduler has given up on the task', async () => {
    const controller = new AbortController();
    const sync = vi.fn(async () => { controller.abort(); return page({ created: 5, skipped: 0, nextOffset: 200 }); });
    const outcome = await run('import.breathe', sync, { sessionToken, signal: controller.signal });
    expect(sync).toHaveBeenCalledTimes(1);
    expect(outcome.result).toMatchObject({ calls: 1, complete: false, nextOffset: 200 });
  });

  it('never puts the session token in a result, whatever the source returns', async () => {
    const sync = vi.fn(async () => ({ ...page({ created: 1, skipped: 0 }), token: sessionToken, note: `Bearer ${sessionToken}` }));
    expect(JSON.stringify(await run('import.advisors', sync))).not.toContain(sessionToken);
    const failing = vi.fn().mockRejectedValue(new HttpError(503, `Unavailable for ${sessionToken}`, 'upstream'));
    expect(JSON.stringify(await run('import.breathe', failing))).not.toContain(sessionToken);
  });

  it('counts only whole numbers from the inbox service', async () => {
    const sync = vi.fn(async () => ({ read: '12', created: -3, skipped: 1.5, nextOffset: 'later' }));
    expect((await run('import.advisors', sync)).result).toMatchObject({ read: 0, created: 0, skipped: 0, complete: true });
  });
});
