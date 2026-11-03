/**
 * Two of the company's hosts serving the same page split what search engines and AI assistants credit to it, and the two compete
 * for the same searches. The crawl finds that three ways, without Search Console:
 *
 * - two sites that are both home pages for one product (CareBase's own site and its Framer home page), both answering as home pages;
 * - a canonical link on one host that names another of the company's hosts (the page itself says it is a copy);
 * - the same title on pages of two hosts.
 *
 * Each pair of hosts is reported once, as "pick one canonical home page", with an address on each: choose one, and redirect the
 * other to it permanently. A site that already redirects to another of the company's sites has no pages of its own and never
 * appears here. A page marked noindex is not in search results, so its title competes with nothing.
 */
import { addressKey } from './audit.mjs';

const hostOf = address => { try { return new URL(address).host.toLowerCase(); } catch { return ''; } };

/**
 * `audits` are the weekly audits (each with `pages`); `sites` the site list. Returns
 * [{ hosts: [a, b], urls: [onA, onB], product (a label, when both are home pages for one product), reasons, sharedTitles }],
 * in a fixed order, where reasons are drawn from same_product, canonical and same_title.
 */
export function crossHostDuplicates(audits, sites) {
  const siteByKey = new Map(sites.map(site => [site.key, site]));
  const ownerHosts = new Set(sites.flatMap(site => [site.origin, ...(site.variants ?? [])]).map(hostOf));
  const productLabel = product => (sites.find(site => site.key === product) ?? sites.find(site => site.product === product))?.label ?? product;
  const usable = audits.filter(audit => !audit.failed && !audit.redirectsTo && siteByKey.has(audit.key));
  const found = new Map();
  const note = (one, other, reason, product = null) => {
    const [first, second] = [one, other].sort((a, b) => a.host.localeCompare(b.host));
    const key = `${first.host} ${second.host}`;
    const entry = found.get(key) ?? { hosts: [first.host, second.host], urls: [first.url, second.url], product: null, reasons: [], sharedTitles: 0 };
    if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
    if (reason === 'same_title') entry.sharedTitles += 1;
    if (product) entry.product = product;
    found.set(key, entry);
  };

  // Two home pages for one product. Their addresses lead the entry, because the home page is the one to choose.
  const homes = usable.flatMap(audit => {
    const site = siteByKey.get(audit.key);
    const home = (audit.pages ?? []).find(page => addressKey(page.url) === addressKey(`${site.origin}/`));
    return home && !home.noindex ? [{ site, home }] : [];
  });
  for (let i = 0; i < homes.length; i += 1) {
    for (let j = i + 1; j < homes.length; j += 1) {
      const [a, b] = [homes[i], homes[j]];
      if (a.site.product && a.site.product === b.site.product && hostOf(a.site.origin) !== hostOf(b.site.origin)) {
        note({ host: hostOf(a.home.url), url: a.home.url }, { host: hostOf(b.home.url), url: b.home.url }, 'same_product', productLabel(a.site.product));
      }
    }
  }

  const pages = usable.flatMap(audit => (audit.pages ?? []).map(page => ({ ...page, host: hostOf(page.url) })));
  // A canonical link that names another of the company's hosts.
  for (const page of pages) {
    const target = page.canonical ? hostOf(page.canonical) : '';
    if (target && target !== page.host && ownerHosts.has(target)) note({ host: page.host, url: page.url }, { host: target, url: page.canonical }, 'canonical');
  }
  // The same title on two hosts (case and spacing aside), once per title and pair of hosts.
  const byTitle = new Map();
  for (const page of pages) {
    if (!page.title || page.noindex) continue;
    const key = page.title.replace(/\s+/g, ' ').trim().toLowerCase();
    if (key) byTitle.set(key, [...(byTitle.get(key) ?? []), page]);
  }
  for (const group of byTitle.values()) {
    const firstOnHost = new Map();
    for (const page of group) if (!firstOnHost.has(page.host)) firstOnHost.set(page.host, page);
    const each = [...firstOnHost.values()];
    for (let i = 0; i < each.length; i += 1) for (let j = i + 1; j < each.length; j += 1) note(each[i], each[j], 'same_title');
  }

  return [...found.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, entry]) => entry);
}
