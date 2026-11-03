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

/**
 * The lead forms the Platform Engineer checks end to end every six hours (task `probe.forms`; docs/LEAD_INTAKE.md, "Probe mode"): one
 * fixed, https address per product, the endpoint behind that product's main lead form. Like the health addresses, nothing in a task, a
 * message or the database names one. A probe is signed with the product's lead secret, so the endpoint forwards a test lead to the Hub
 * and stores, emails and alerts nothing. The body is the endpoint's own JSON shape with plain, obviously invented values (a `.invalid`
 * address can never receive mail): an endpoint that does not recognise the probe treats it as an ordinary submission, and its message
 * then says why it arrived.
 */
const probeNote = 'Automated end-to-end check of this form from the CareMetric Support Hub. If it arrived as a real request, this form\'s HUB_LEAD_SECRET does not match the Hub\'s.';
const formProducts = [
  { key: 'carebase_forms', source: 'carebase', label: 'CareBase lead form', url: 'https://xsqobvvreaovwibxwyvv.supabase.co/functions/v1/request-demo',
    body: { name: 'CareMetric Form Check', email: 'probe@caremetric.invalid', organization: 'CareMetric Form Check', facility_count: 1, message: probeNote, source_path: '/' } },
  { key: 'intel_forms', source: 'intel', label: 'Intel lead form', url: 'https://www.caremetricintel.com/api/public/demo-request',
    body: { name: 'CareMetric Form Check', email: 'probe@caremetric.invalid', organization: 'CareMetric Form Check', territory: 'Allegheny County, PA', message: probeNote } },
  { key: 'advisors_forms', source: 'advisors', label: 'Advisors consultation form', url: 'https://caremetricadvisors.com/api/inquiries',
    body: { name: 'CareMetric Form Check', organization: 'CareMetric Form Check', email: 'probe@caremetric.invalid', phone: '', service: 'not-sure', message: probeNote, consent: true } },
];
const deepFreeze = value => {
  if (value && typeof value === 'object') for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
};

/**
 * The form targets: `{ key, source, label, url, body, form: true, every, staleMs, timeoutSeconds }`. A form answers only after it has
 * forwarded its test lead (up to two five-second tries), so it is given 20 seconds; `every` and `staleMs` let an incident say how often it
 * is checked and when a report is late.
 */
export const formTargets = deepFreeze(formProducts.map(target => ({ ...target, form: true, every: 'every six hours', staleMs: 7 * 60 * 60 * 1000, timeoutSeconds: 20 })));
