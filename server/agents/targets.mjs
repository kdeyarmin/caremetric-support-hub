/**
 * The only addresses the on-call agent ever contacts: a fixed list of public health endpoints,
 * https only, one pinned host each. Nothing in a task, a message or the database names a URL, so
 * there is no path from customer text to an outbound request.
 *
 * Each address was checked against the live product. Intel's uptime route answers 200 only when
 * its database does, and its apex domain redirects to www, which a probe never follows. Breathe
 * has no confirmed health route yet, so it is not listed.
 */
const products = Object.freeze([
  Object.freeze({ key: 'carebase', label: 'CareBase', url: 'https://cmcarebase.com/health' }),
  Object.freeze({ key: 'intel', label: 'CareMetric Intel', url: 'https://www.caremetricintel.com/api/ready' }),
  Object.freeze({ key: 'advisors', label: 'Healthcare Advisors', url: 'https://caremetricadvisors.com/health' }),
]);

/** The Hub checks its own public address, so DNS, TLS and the edge are part of what is measured. */
function hubTarget(publicOrigin) {
  let origin;
  try { origin = new URL(publicOrigin); } catch { return null; }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.port
    || origin.pathname !== '/' || origin.search || origin.hash) return null;
  return Object.freeze({ key: 'hub', label: 'Support Hub', url: new URL('/api/health', origin).toString() });
}

export function probeTargets({ publicOrigin } = {}) {
  const hub = hubTarget(publicOrigin);
  return Object.freeze([...(hub ? [hub] : []), ...products]);
}
