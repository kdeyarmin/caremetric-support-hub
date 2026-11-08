import { afterEach, expect, it, vi } from 'vitest';
import { dayAfter } from './billingActions';

afterEach(() => vi.unstubAllEnvs());

it('advances calendar days across the autumn daylight-saving transition', () => {
  vi.stubEnv('TZ', 'America/New_York');
  const start = new Date(2026, 10, 1, 0, 30);
  expect(dayAfter(1, start)).toBe('2026-11-02');
  expect(dayAfter(14, start)).toBe('2026-11-15');
  expect(start.getDate()).toBe(1);
});

it('advances calendar days across the spring daylight-saving transition', () => {
  vi.stubEnv('TZ', 'America/New_York');
  expect(dayAfter(1, new Date(2026, 2, 7, 23, 30))).toBe('2026-03-08');
});
