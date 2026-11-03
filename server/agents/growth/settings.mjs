/**
 * What the Growth Manager chases and when it keeps quiet, read from the agent's own settings (private.agents.config). The owner
 * changes them with SQL only: the Team screen has no settings editor. A missing or unusable value falls back to the default, so a
 * typo can never switch the reminders off or move them into the night.
 *
 * - followup_minutes: how long a lead conversation may wait for a first answer before the owner is reminded, once per step
 *   (default 60 and 1440: after an hour, then after a day). At most five steps, each between 1 minute and 30 days.
 * - quiet_hours: { start, end, timezone } on a 24-hour clock (default 21:00 to 07:00 America/New_York). No reminder is sent in
 *   between; the first run after `end` sends what waited. A start equal to the end means no quiet hours at all.
 */
const clockTime = /^([01]\d|2[0-3]):[0-5]\d$/;
const defaults = Object.freeze({ followupMinutes: Object.freeze([60, 1440]), quietHours: Object.freeze({ start: '21:00', end: '07:00', timezone: 'America/New_York' }) });

const knownZone = zone => {
  if (typeof zone !== 'string' || zone.length === 0 || zone.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
};

export function growthSettings(config) {
  const source = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const steps = Array.isArray(source.followup_minutes)
    ? [...new Set(source.followup_minutes.filter(value => Number.isInteger(value) && value >= 1 && value <= 43_200))].sort((a, b) => a - b).slice(0, 5)
    : [];
  const quiet = source.quiet_hours && typeof source.quiet_hours === 'object' && !Array.isArray(source.quiet_hours) ? source.quiet_hours : {};
  return {
    followupMinutes: steps.length ? steps : [...defaults.followupMinutes],
    quietHours: {
      start: clockTime.test(quiet.start ?? '') ? quiet.start : defaults.quietHours.start,
      end: clockTime.test(quiet.end ?? '') ? quiet.end : defaults.quietHours.end,
      timezone: knownZone(quiet.timezone) ? quiet.timezone : defaults.quietHours.timezone,
    },
  };
}

const minutesOf = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** Minutes since local midnight in `zone` at `instant`. */
export function localMinutes(instant, zone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  const part = type => Number(parts.find(item => item.type === type)?.value ?? 0);
  return (part('hour') % 24) * 60 + part('minute');
}

/**
 * When the quiet hours that `instant` falls in end, or null when it is not in them. The end is the first whole minute at which the local
 * clock reads `end`; a clock change in between (an hour either way) is allowed for.
 */
export function quietUntil(instant, { start, end, timezone }) {
  const from = minutesOf(start), to = minutesOf(end);
  if (from === to) return null;
  const local = localMinutes(instant, timezone);
  const quiet = from < to ? local >= from && local < to : local >= from || local < to;
  if (!quiet) return null;
  const wait = (to - local + 1440) % 1440;
  const guess = Math.floor(instant.getTime() / 60_000) * 60_000 + wait * 60_000;
  for (const shift of [0, -60, 60]) {
    const candidate = new Date(guess + shift * 60_000);
    if (localMinutes(candidate, timezone) === to && candidate > instant) return candidate;
  }
  return new Date(guess);
}
