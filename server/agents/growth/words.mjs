/**
 * The words the Growth Manager uses for a lead. Pure: what goes in is what the server-only lead reads return (kinds, products, an
 * organization, a few facts, where the visitor came from and a conversation reference), and nothing a visitor wrote, no contact
 * name, address or phone number ever reaches them.
 */
import { productWord } from '../concierge/policy.mjs';
import { plural, when } from '../tasks/shared.mjs';

const kindWords = {
  demo_request: ['demo request', 'demo requests'], consultation: ['consultation request', 'consultation requests'], contact: ['contact request', 'contact requests'],
  trial_signup: ['trial sign-up', 'trial sign-ups'], newsletter: ['newsletter sign-up', 'newsletter sign-ups'],
  savings_model: ['savings model request', 'savings model requests'], county_report: ['county report request', 'county report requests'],
};
/** Every lead kind, in the order reports list them. */
export const leadKinds = Object.freeze(Object.keys(kindWords));
/** The kinds that open a conversation in Communications: the Support Concierge alerts on those. */
export const conversationKinds = Object.freeze(['demo_request', 'consultation', 'contact']);
/** The kinds that wait for the brief and the weekly report. */
export const digestKinds = Object.freeze(['newsletter', 'savings_model', 'county_report']);

export const kindWord = (kind, count = 1) => (kindWords[kind] ?? [String(kind), `${kind}s`])[count === 1 ? 0 : 1];

// A lead's product, by its registered slug, else by the website it came from.
const sourceProducts = { carebase: 'carebase', intel: 'caremetric-intel', advisors: 'advisors' };
export const leadProduct = ({ productSlug = null, product = null, source = null } = {}) =>
  productWord(productSlug ?? product ?? sourceProducts[source] ?? null) ?? 'a CareMetric product';

export const clip = (value, limit) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
};

/**
 * "45 minutes", "1 hour 35 minutes", "26 hours", "3 days": how long, rounded down, so a reminder never claims more waiting than there was.
 * Under three hours the minutes are kept; days start at two.
 */
export function span(minutes) {
  const value = Math.max(0, Math.floor(Number(minutes) || 0));
  if (value < 60) return plural(Math.max(value, 1), 'minute');
  if (value < 180) return value % 60 ? `${plural(Math.floor(value / 60), 'hour')} ${plural(value % 60, 'minute')}` : plural(value / 60, 'hour');
  if (value < 2880) return plural(Math.floor(value / 60), 'hour');
  return plural(Math.floor(value / 1440), 'day');
}

/** "2 demo requests and 1 contact request", from a { kind: count } object, in the reports' order. Empty when every count is zero. */
export function kindList(byKind = {}) {
  const parts = leadKinds.filter(kind => Number(byKind?.[kind]) > 0).map(kind => `${byKind[kind]} ${kindWord(kind, Number(byKind[kind]))}`);
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

// A detail key as the lead desk labels it: facilityCount is "Facility count".
const label = key => {
  const words = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};
const factValue = value => (typeof value === 'boolean' ? (value ? 'Yes' : 'No') : clip(value, 60));

/** The facts a product forwarded with the lead, as rows, the plan first. Facts only: the intake contract allows nothing else in them. */
export function detailRows(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return [];
  const keys = Object.keys(details).filter(key => ['string', 'number', 'boolean'].includes(typeof details[key])).sort((a, b) => (a === 'plan' ? -1 : b === 'plan' ? 1 : a.localeCompare(b)));
  return keys.slice(0, 6).map(key => [label(key), factValue(details[key])]);
}

/** Where the visitor came from, in a few words: "google (cpc), campaign fall-launch, landing page /pricing", or "a direct visit". */
export function sourceWords(attribution = {}) {
  const source = clip(attribution?.source ?? 'direct', 60) || 'direct';
  const parts = [source === 'direct' ? 'a direct visit' : `${source}${attribution?.medium ? ` (${clip(attribution.medium, 40)})` : ''}`];
  if (attribution?.campaign) parts.push(`campaign ${clip(attribution.campaign, 60)}`);
  if (attribution?.landingPath) parts.push(`landing page ${clip(attribution.landingPath, 80)}`);
  return parts.join(', ');
}

const leadsLink = publicOrigin => (/^https:\/\//i.test(publicOrigin ?? '') ? `${publicOrigin.replace(/\/+$/, '')}/admin/leads` : null);

/** The owner's alert for a new trial: { subject, body, blocks }. The organization is the only name in it. */
export function trialAlert(lead, { publicOrigin } = {}) {
  const product = leadProduct(lead);
  const organization = lead?.organization ? clip(lead.organization, 80) : null;
  const plan = typeof lead?.details?.plan === 'string' && lead.details.plan.trim() ? clip(lead.details.plan, 40) : null;
  const from = sourceWords(lead?.attribution);
  const subject = `New ${product} trial${organization ? `: ${organization}` : ''}`;
  const opening = `${organization ?? 'A new organization'} started a ${product} trial${lead?.receivedAt ? ` (received ${when(lead.receivedAt)})` : ''}.`;
  const body = [
    opening,
    [`Product: ${product}.`, plan ? `Plan: ${plan}.` : null, `Came from ${from}.`].filter(Boolean).join(' '),
    'Nothing has been sent to them. Open Leads for their details and follow up while the trial is fresh.',
  ].join('\n\n');
  const link = leadsLink(publicOrigin);
  return {
    subject, body,
    blocks: [
      { type: 'callout', tone: 'warning', title: 'New trial.', text: opening },
      { type: 'details', rows: [['Product', product], ...(plan ? [['Plan', plan]] : []), ...detailRows(lead?.details).filter(([key]) => key !== 'Plan'), ['Came from', from]] },
      { type: 'paragraph', text: 'Nothing has been sent to them. Open Leads for their details and follow up while the trial is fresh.' },
      ...(link ? [{ type: 'button', label: 'Open Leads', url: link }] : []),
    ],
  };
}

/** The owner's reminder about a lead conversation nobody has answered: { subject, body }. */
export function followupAlert(item, step) {
  const product = leadProduct(item);
  const kind = kindWord(item.kind);
  const subject = `Still unanswered after ${span(step)}: ${kind} ${item.reference}`;
  const body = [
    `A ${product} ${kind} (${item.reference}) has waited ${span(item.minutesWaiting)} for a first reply.`,
    `Open ${item.reference} in Communications to answer it. If you have been in touch another way, set the lead's status on Leads and the reminders stop.`,
    'Nothing has been sent to them.',
  ].join('\n\n');
  return { subject, body };
}
