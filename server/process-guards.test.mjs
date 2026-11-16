import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { guardProcess } from './process-guards.mjs';

const guarded = () => {
  const target = new EventEmitter();
  const lines = [];
  guardProcess({ target, log: { error: line => lines.push(JSON.parse(line)) } });
  return { target, lines };
};
const failure = () => Object.assign(new Error('Could not reach jane.doe@example.org at 555-0100'), { code: 'ECONNRESET' });

describe('errors nothing else caught', () => {
  it('logs a stray rejection as one searchable line, without its message, and keeps the Hub running', () => {
    const { target, lines } = guarded();
    // A listener means Node neither prints the rejection nor stops the process.
    expect(target.listenerCount('unhandledRejection')).toBe(1);
    target.emit('unhandledRejection', failure(), Promise.resolve());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: 'hub_unhandled_rejection', name: 'Error', code: 'ECONNRESET' });
    expect(lines[0].at.length).toBeGreaterThan(0);
    expect(lines[0].at.every(frame => frame.startsWith('at '))).toBe(true);
    expect(JSON.stringify(lines)).not.toMatch(/jane|555-0100/);
  });

  it('logs a rejection that is not an Error', () => {
    const { target, lines } = guarded();
    target.emit('unhandledRejection', 'plain text with a secret', Promise.resolve());
    expect(lines).toEqual([{ event: 'hub_unhandled_rejection', name: 'string', at: [] }]);
  });

  it('logs an uncaught exception as one line but leaves it fatal: only the monitor listens, so the process still exits', () => {
    const { target, lines } = guarded();
    expect(target.listenerCount('uncaughtException')).toBe(0);
    target.emit('uncaughtExceptionMonitor', failure(), 'uncaughtException');
    expect(lines[0]).toMatchObject({ event: 'hub_uncaught_exception', name: 'Error', code: 'ECONNRESET' });
    expect(JSON.stringify(lines)).not.toMatch(/jane|555-0100/);
  });
});
