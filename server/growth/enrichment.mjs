import { markets } from '../agents/marketing.mjs';
import { products } from './policy.mjs';

/** Three extra provider calls per discovery run, never on the fifteen-minute pipeline sweep. */
export const evidenceSearchLimit = 3;
const easternDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const domainShape = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const domainOf = value => typeof value === 'string' && value.length <= 253 && domainShape.test(value) ? value.replace(/^www\./, '') : null;
const contactReady = item => item.eligibility === 'permitted' && Number.isFinite(Date.parse(item.verified_at));

/**
 * Evidence is most useful where fit is uncertain. Customers, opted-out contacts, clear non-fits and already qualified prospects
 * stay out. Rotate both pools independently so having many contact-ready prospects cannot starve the other organizations.
 */
export function evidenceTargets(items, marketed, moment) {
  const eligible = items.filter(item => item.owner_agent === 'marketing_manager' && !item.internal && !item.tenant_id
    && ['identified', 'researched'].includes(item.stage) && products.includes(item.product) && markets(marketed, item.product)
    && item.eligibility !== 'opted_out' && (item.fit == null || (item.fit >= 30 && item.fit < 75)) && domainOf(item.domain));
  const unique = [...new Map(eligible.map(item => [`${item.product}:${domainOf(item.domain)}`, item])).values()];
  const day = Math.floor(Date.parse(`${easternDay.format(moment)}T00:00:00Z`) / 86_400_000);
  const rotate = list => {
    const sorted = list.sort((a, b) => `${a.product}:${a.domain}`.localeCompare(`${b.product}:${b.domain}`));
    const start = day % (sorted.length || 1);
    return [...sorted.slice(start), ...sorted.slice(0, start)];
  };
  const ready = rotate(unique.filter(contactReady));
  const other = rotate(unique.filter(item => !contactReady(item)));
  return [...ready.slice(0, 2), ...other.slice(0, 1), ...ready.slice(2), ...other.slice(1)]
    .slice(0, evidenceSearchLimit).map(item => ({ product: item.product, domain: item.domain }));
}

/** Reuse the existing dated-evidence insert; duplicate URL/claim pairs stay unchanged and do not buy a new model assessment. */
export async function enrichProspects({ growth, marketed, moment, signal }) {
  if (typeof growth.store.snapshot !== 'function') return null;
  const items = [];
  let offset = 0;
  let total = 1;
  while (offset < total) {
    signal?.throwIfAborted();
    const page = await growth.store.snapshot(offset);
    signal?.throwIfAborted();
    if (!page.items.length) break;
    items.push(...page.items);
    offset += page.items.length;
    total = page.total;
  }
  const counts = { searched: 0, evidenceRows: 0 };
  for (const target of evidenceTargets(items, marketed, moment)) {
    signal?.throwIfAborted();
    const searchDomain = domainOf(target.domain);
    const rows = await growth.research.search(target.product, { domain: searchDomain, signal });
    signal?.throwIfAborted();
    counts.searched++;
    // The provider adapter already pins the domain. Check again before the generic discovery insert, which can create organizations.
    const ownRows = rows.filter(row => {
      try {
        const url = new URL(row.url);
        return domainOf(row.domain) === searchDomain && url.protocol === 'https:' && !url.username && !url.password && !url.port
          && domainOf(url.hostname) === searchDomain;
      } catch { return false; }
    }).slice(0, 10).map(row => ({ ...row, domain: target.domain }));
    if (ownRows.length) counts.evidenceRows += await growth.store.discover(target.product, ownRows);
  }
  return counts;
}
