import { describe, expect, it } from 'vitest';
import { unixEndOfDay } from './billing.mjs';

describe('billing calendar days', () => {
  it('ends a chosen day at 23:59:59 America/New_York, including across daylight saving', () => {
    expect(unixEndOfDay('2026-01-15')).toBe(Math.floor(Date.parse('2026-01-16T04:59:59Z') / 1000));
    expect(unixEndOfDay('2026-07-15')).toBe(Math.floor(Date.parse('2026-07-16T03:59:59Z') / 1000));
    expect(unixEndOfDay('2026-11-01')).toBe(Math.floor(Date.parse('2026-11-02T04:59:59Z') / 1000));
  });
});
