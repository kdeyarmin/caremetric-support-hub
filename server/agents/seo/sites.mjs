/**
 * The public websites the SEO Analyst checks: a fixed list, https only, one pinned host each. Nothing in a
 * task, a message or the database can add a site, and the crawl never leaves a site's own host, so there is
 * no path from customer text to an outbound request.
 *
 * `variants` are other addresses that should reach the same site. The check expects each to redirect to the
 * site's own address (or, for an alias domain, to carry a canonical link that points there), because two
 * addresses serving the same page split the credit between them.
 *
 * `product` groups the sites that are home pages for the same product. CareBase has two today: the app's own
 * site and a home page built in Framer, which compete for the same searches until one of them is chosen as
 * the canonical home page and the other redirects to it.
 */
import { searchConsoleHosts } from './search-console.mjs';

export const sites = Object.freeze([
  Object.freeze({
    key: 'advisors', label: 'Healthcare Advisors', product: 'advisors', origin: 'https://caremetricadvisors.com',
    variants: Object.freeze(['https://www.caremetricadvisors.com']),
  }),
  Object.freeze({
    key: 'carebase', label: 'CareBase', product: 'carebase', origin: 'https://cmcarebase.com',
    variants: Object.freeze(['https://caremetrictrain.com']),
  }),
  Object.freeze({
    key: 'intel', label: 'CareMetric Intel', product: 'intel', origin: 'https://www.caremetricintel.com',
    variants: Object.freeze(['https://caremetricintel.com']),
  }),
  Object.freeze({
    key: 'help', label: 'Help center', product: 'help', origin: 'https://help.caremetric.ai',
    variants: Object.freeze([]),
  }),
  Object.freeze({
    key: 'carebase_home', label: 'CareBase home (Framer)', product: 'carebase', origin: 'https://home.cmcarebase.com',
    variants: Object.freeze([]),
  }),
]);

const hostOf = address => new URL(address).host;

/** Every host the SEO Analyst may contact: the sites, their other addresses, and Google's sign-in and Search Console endpoints. */
export const outboundHosts = Object.freeze([...new Set([...sites.flatMap(site => [site.origin, ...site.variants]).map(hostOf), ...searchConsoleHosts])]);
