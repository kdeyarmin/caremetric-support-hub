/**
 * The public websites the SEO Analyst checks: a fixed list, https only, one pinned host each. Nothing in a
 * task, a message or the database can add a site, and the crawl never leaves a site's own host, so there is
 * no path from customer text to an outbound request.
 *
 * `variants` are other addresses that should reach the same site. The check expects each to redirect to the
 * site's own address (or, for an alias domain, to carry a canonical link that points there), because two
 * addresses serving the same page split the credit between them.
 */
export const sites = Object.freeze([
  Object.freeze({
    key: 'advisors', label: 'Healthcare Advisors', origin: 'https://caremetricadvisors.com',
    variants: Object.freeze(['https://www.caremetricadvisors.com']),
  }),
  Object.freeze({
    key: 'carebase', label: 'CareBase', origin: 'https://cmcarebase.com',
    variants: Object.freeze(['https://caremetrictrain.com']),
  }),
  Object.freeze({
    key: 'intel', label: 'CareMetric Intel', origin: 'https://www.caremetricintel.com',
    variants: Object.freeze(['https://caremetricintel.com']),
  }),
]);
