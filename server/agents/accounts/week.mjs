/**
 * The owner's week for the weekly account report: Monday to Sunday by the Eastern calendar, the same clock the agents' budgets
 * and the daily brief use. Weeks are found from the calendar date and never by subtracting 24 hours, so the two nights a year
 * when Eastern time changes cannot move a report into the wrong week.
 */
const easternDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const easternWeekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' });
const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** The Eastern calendar date of an instant, as YYYY-MM-DD. */
export const easternDate = instant => easternDay.format(instant);

/** The Monday (an Eastern calendar date) that starts the week the instant falls in. */
export function weekStart(instant) {
  const [year, month, day] = easternDate(instant).split('-').map(Number);
  const back = weekdays.indexOf(easternWeekday.format(instant));
  return new Date(Date.UTC(year, month - 1, day - back)).toISOString().slice(0, 10);
}

/** The instant an Eastern calendar day begins, for asking the database what happened "since" then. */
export function easternMidnight(date) {
  // Eastern time is UTC-4 or UTC-5, and the clocks change at 2 a.m., so midnight is never ambiguous: it is one of these two instants.
  for (const hour of ['04', '05']) {
    const candidate = new Date(`${date}T${hour}:00:00Z`);
    if (easternDate(candidate) === date && easternDate(new Date(candidate.getTime() - 3_600_000)) !== date) return candidate;
  }
  throw new RangeError('That is not an Eastern calendar date.');
}
