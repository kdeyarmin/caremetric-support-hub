import { describe, expect, it } from 'vitest';
import { growthSettings, localMinutes, quietUntil } from './settings.mjs';

const defaults = { followupMinutes: [60, 1440], quietHours: { start: '21:00', end: '07:00', timezone: 'America/New_York' } };
const eastern = defaults.quietHours;

describe('the Growth Manager\'s settings', () => {
  it('falls back to reminders after an hour and a day, quiet from 21:00 to 07:00 Eastern', () => {
    for (const config of [undefined, null, {}, [], 'x', { followup_minutes: 'often', quiet_hours: 'never' }]) expect(growthSettings(config), JSON.stringify(config)).toEqual(defaults);
  });

  it('keeps the steps it can use, once each and in order, at most five', () => {
    expect(growthSettings({ followup_minutes: [1440, 60, 60, 240] }).followupMinutes).toEqual([60, 240, 1440]);
    expect(growthSettings({ followup_minutes: [0, -5, 1.5, '60', 43_201, 30] }).followupMinutes).toEqual([30]);
    expect(growthSettings({ followup_minutes: [1, 2, 3, 4, 5, 6, 7] }).followupMinutes).toEqual([1, 2, 3, 4, 5]);
    expect(growthSettings({ followup_minutes: [0, 'x'] }).followupMinutes).toEqual([60, 1440]);
    expect(growthSettings({ followup_minutes: [] }).followupMinutes).toEqual([60, 1440]);
  });

  it('takes each part of the quiet hours on its own, and refuses a time or zone it cannot read', () => {
    expect(growthSettings({ quiet_hours: { start: '22:30', end: '06:15', timezone: 'America/Chicago' } }).quietHours).toEqual({ start: '22:30', end: '06:15', timezone: 'America/Chicago' });
    expect(growthSettings({ quiet_hours: { start: '24:00', end: '7:00', timezone: 'Mars/Olympus' } }).quietHours).toEqual(eastern);
    expect(growthSettings({ quiet_hours: { start: '20:00' } }).quietHours).toEqual({ ...eastern, start: '20:00' });
  });
});

describe('quiet hours', () => {
  it('reads the local clock of the zone', () => {
    expect(localMinutes(new Date('2026-11-03T02:30:00Z'), 'America/New_York')).toBe(21 * 60 + 30);
    expect(localMinutes(new Date('2026-11-03T05:00:00Z'), 'America/New_York')).toBe(0);
    expect(localMinutes(new Date('2026-07-01T04:00:00Z'), 'America/New_York')).toBe(0);
  });

  it('holds a reminder from the start until the end, and lets one through outside them', () => {
    expect(quietUntil(new Date('2026-11-03T02:30:00Z'), eastern)?.toISOString()).toBe('2026-11-03T12:00:00.000Z');
    expect(quietUntil(new Date('2026-11-03T02:00:00Z'), eastern)?.toISOString()).toBe('2026-11-03T12:00:00.000Z');
    expect(quietUntil(new Date('2026-11-03T11:59:30Z'), eastern)?.toISOString()).toBe('2026-11-03T12:00:00.000Z');
    expect(quietUntil(new Date('2026-11-03T12:00:00Z'), eastern)).toBeNull();
    expect(quietUntil(new Date('2026-11-03T17:00:00Z'), eastern)).toBeNull();
    expect(quietUntil(new Date('2026-11-03T01:59:00Z'), eastern)).toBeNull();
  });

  it('allows for the clocks changing overnight', () => {
    // The clocks go back at 2 a.m. on Sunday, Nov 1, 2026: 07:00 that morning is 12:00 UTC, not 11:00.
    expect(quietUntil(new Date('2026-11-01T01:30:00Z'), eastern)?.toISOString()).toBe('2026-11-01T12:00:00.000Z');
    // They go forward on Sunday, Mar 14, 2027: 07:00 that morning is 11:00 UTC.
    expect(quietUntil(new Date('2027-03-14T03:00:00Z'), eastern)?.toISOString()).toBe('2027-03-14T11:00:00.000Z');
  });

  it('keeps a window inside one day, another zone, and none at all when the start is the end', () => {
    const lunch = { start: '12:00', end: '13:00', timezone: 'America/New_York' };
    expect(quietUntil(new Date('2026-11-03T17:30:00Z'), lunch)?.toISOString()).toBe('2026-11-03T18:00:00.000Z');
    expect(quietUntil(new Date('2026-11-03T18:30:00Z'), lunch)).toBeNull();
    expect(quietUntil(new Date('2026-11-03T06:00:00Z'), { start: '21:00', end: '07:00', timezone: 'America/Los_Angeles' })?.toISOString()).toBe('2026-11-03T15:00:00.000Z');
    expect(quietUntil(new Date('2026-11-03T02:30:00Z'), { start: '21:00', end: '21:00', timezone: 'America/New_York' })).toBeNull();
  });
});
