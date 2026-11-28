/**
 * Where a state launch sends from and when: each state's sending time zone, as Instantly names it (its schedule accepts only its own list:
 * US Eastern is "America/Detroit", as Pennsylvania's campaigns use). A state split between two zones sends on the time of most of its people.
 */
import { stateNames } from '../growth/roster.mjs';

export { stateNames };

const zones = {
  'America/Detroit': ['CT', 'DE', 'DC', 'FL', 'GA', 'IN', 'KY', 'ME', 'MD', 'MA', 'MI', 'NH', 'NJ', 'NY', 'NC', 'OH', 'PA', 'RI', 'SC', 'VT', 'VA', 'WV'],
  'America/Chicago': ['AL', 'AR', 'IL', 'IA', 'KS', 'LA', 'MN', 'MS', 'MO', 'NE', 'ND', 'OK', 'SD', 'TN', 'TX', 'WI'],
  'America/Boise': ['CO', 'ID', 'MT', 'NM', 'UT', 'WY'],
  // Arizona keeps standard time all year.
  'America/Creston': ['AZ'],
  // Instantly's Pacific time zone.
  'America/Dawson': ['CA', 'NV', 'OR', 'WA'],
  'America/Anchorage': ['AK'],
  'Etc/GMT+10': ['HI'],
};
const byState = new Map(Object.entries(zones).flatMap(([zone, states]) => states.map(state => [state, zone])));

/** The Instantly time zone a state's campaigns send on; Eastern when the state is unknown. */
export const sendingZone = state => byState.get(String(state ?? '').toUpperCase()) ?? 'America/Detroit';

/** True for a two-letter code of a state or the District of Columbia. */
export const isState = state => typeof state === 'string' && Object.hasOwn(stateNames, state) && byState.has(state);
