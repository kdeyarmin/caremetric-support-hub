import { describe, expect, it } from 'vitest';
import { easternDate, easternMidnight, weekStart } from './week.mjs';

const at = text => new Date(text);

describe('the owner\'s week', () => {
  it('starts on the Monday of the Eastern calendar date', () => {
    expect(weekStart(at('2026-11-02T12:00:00Z'))).toBe('2026-11-02');
    expect(weekStart(at('2026-11-04T03:00:00Z'))).toBe('2026-11-02');
    expect(weekStart(at('2026-11-08T22:00:00Z'))).toBe('2026-11-02');
    expect(weekStart(at('2026-11-09T05:00:00Z'))).toBe('2026-11-09');
  });

  it('follows the clock on the night Eastern time falls back, not 24-hour arithmetic', () => {
    // 2026-11-01 is the Sunday the clocks change; midnight Monday is 05:00 UTC afterwards.
    expect(easternDate(at('2026-11-02T04:30:00Z'))).toBe('2026-11-01');
    expect(weekStart(at('2026-11-02T04:30:00Z'))).toBe('2026-10-26');
    expect(weekStart(at('2026-11-02T05:30:00Z'))).toBe('2026-11-02');
  });

  it('follows the clock on the night it springs forward', () => {
    // 2027-03-14 is the Sunday the clocks change; Monday 2027-03-15 begins at 04:00 UTC.
    expect(weekStart(at('2027-03-15T03:30:00Z'))).toBe('2027-03-08');
    expect(weekStart(at('2027-03-15T04:30:00Z'))).toBe('2027-03-15');
    expect(weekStart(at('2026-03-09T04:30:00Z'))).toBe('2026-03-09');
    expect(weekStart(at('2026-03-09T03:30:00Z'))).toBe('2026-03-02');
  });

  it('crosses the end of a year', () => {
    expect(weekStart(at('2026-12-31T17:00:00Z'))).toBe('2026-12-28');
    expect(weekStart(at('2027-01-01T17:00:00Z'))).toBe('2026-12-28');
    expect(weekStart(at('2027-01-04T17:00:00Z'))).toBe('2027-01-04');
  });

  it('finds the instant an Eastern day begins, in summer and in winter time', () => {
    expect(easternMidnight('2026-11-02').toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(easternMidnight('2026-10-26').toISOString()).toBe('2026-10-26T04:00:00.000Z');
    expect(easternMidnight('2027-03-15').toISOString()).toBe('2027-03-15T04:00:00.000Z');
    expect(easternMidnight('2027-03-08').toISOString()).toBe('2027-03-08T05:00:00.000Z');
    expect(easternMidnight('2026-11-01').toISOString()).toBe('2026-11-01T04:00:00.000Z');
    for (const day of ['2026-01-01', '2026-06-30', '2026-12-31']) expect(easternDate(easternMidnight(day))).toBe(day);
  });

  it('refuses what is not a date', () => {
    for (const bad of ['', 'tomorrow', '2026-13-45', '2026-11-2']) expect(() => easternMidnight(bad), bad).toThrow(/Eastern calendar date|Invalid/);
  });
});
