import { createHash } from 'node:crypto';
import { normalizePrice, normalizeProduct } from './stripe.mjs';
import { maxAmountCents } from '../src/billing/billingProtocol.ts';

/**
 * An application that sets its own plan prices publishes them (CareMetric Intel:
 * GET https://www.caremetricintel.com/api/billing/catalog, contract
 * caremetric.app-catalog.v1, built from Intel's src/lib/planCatalog.ts). The
 * Hub reads that catalog and keeps Stripe in step: a plan price that is missing
 * is created, and a plan price whose amount changed is replaced through the
 * same `price.change` command an administrator uses, grandfathering everyone
 * already subscribed. The application never talks to Stripe.
 *
 * This module only decides; billing.mjs (syncAppCatalog) carries the plan out.
 */
export const APP_CATALOG_CONTRACT = 'caremetric.app-catalog.v1';

/** Where each application that publishes its prices serves them. Only Intel does. */
export const appCatalogSources = Object.freeze({
  'caremetric-intel': 'https://www.caremetricintel.com/api/billing/catalog',
});

/**
 * An automatic change outside this range is held for an administrator instead
 * of applied: a price cut by more than half or more than doubled is far more
 * likely a typo in the catalog than a decision.
 */
export const AUTOMATIC_CHANGE_RANGE = Object.freeze({ min: 0.5, max: 2 });

const isAmount = value => Number.isInteger(value) && value > 0 && value <= maxAmountCents;
const keyPattern = /^[a-z0-9_.-]{1,64}$/;

/** The catalog an application published, or an error naming what is wrong with it. Nothing is trusted unchecked. */
export function parseAppCatalog(body, app) {
  if (!body || typeof body !== 'object') throw new Error('The catalog is not a JSON object.');
  if (body.contract !== APP_CATALOG_CONTRACT) throw new Error(`The catalog contract is ${String(body.contract)}, not ${APP_CATALOG_CONTRACT}.`);
  if (body.app !== app) throw new Error(`The catalog is for ${String(body.app)}, not ${app}.`);
  if (body.currency !== 'usd') throw new Error('The catalog must be priced in usd.');
  if (typeof body.version !== 'string' || !/^[0-9a-f]{8,64}$/.test(body.version)) throw new Error('The catalog has no version.');
  if (!Array.isArray(body.products) || body.products.length > 50) throw new Error('The catalog lists no products.');
  const products = body.products.map((product, index) => {
    if (!product || !keyPattern.test(product.entitlement_key ?? '')) throw new Error(`Product ${index} has no entitlement key.`);
    if (!['plan', 'addon', 'fee'].includes(product.kind)) throw new Error(`${product.entitlement_key} has an unknown kind.`);
    if (!Array.isArray(product.prices) || product.prices.length > 20) throw new Error(`${product.entitlement_key} lists no prices.`);
    const prices = product.prices.map(price => {
      if (!price || !['month', 'year', 'once'].includes(price.interval) || !isAmount(price.unit_amount)) {
        throw new Error(`${product.entitlement_key} has a price that is not a positive amount in cents with an interval.`);
      }
      if (price.plan !== undefined && !keyPattern.test(price.plan)) throw new Error(`${product.entitlement_key} names an unknown plan.`);
      return { interval: price.interval, unit_amount: price.unit_amount, ...(price.plan ? { plan: price.plan } : {}) };
    });
    return { entitlement_key: product.entitlement_key, kind: product.kind, name: String(product.name ?? product.entitlement_key).slice(0, 250), self_serve: product.self_serve === true, prices };
  });
  const trialDays = Number.isInteger(body.trial_days) && body.trial_days >= 1 && body.trial_days <= 90 ? body.trial_days : null;
  return { app, version: body.version, trial_days: trialDays, products };
}

/** A version-4-shaped id derived from its parts, so a retried sync reuses the same Stripe idempotency keys. */
export function deterministicKey(...parts) {
  const hex = createHash('sha256').update(parts.join('\u0000')).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A published price an application's plan is sold at: active, flat, recurring every one interval, not a customer's contract price. */
function publicRecurring(price) {
  const p = normalizePrice(price);
  return p.active && p.type === 'recurring' && p.interval_count === 1 && p.unit_amount !== null && !p.tenant_id
    && ['flat', 'per_unit'].includes(p.pricing_model) && p.currency === 'usd';
}

/**
 * What it takes to make Stripe match the catalog, for the application's plans:
 * - `creates`: a plan with no published price for an interval gets one;
 * - `changes`: a published price at another amount is replaced (grandfathered);
 * - `held`: a change outside AUTOMATIC_CHANGE_RANGE, or a plan with several
 *   published prices for one interval, waits for an administrator;
 * - `missing`: a plan the catalog sells that has no Stripe product yet;
 * - `skipped`: add-ons and fees, which Stripe does not sell for this application.
 * Products and prices are Stripe objects as the API returns them.
 */
export function planCatalogSync(catalog, stripeProducts, stripePrices) {
  const products = stripeProducts.map(product => ({ raw: product, view: normalizeProduct(product) }))
    .filter(({ view }) => view.app === catalog.app && view.active && view.kind === 'plan' && view.entitlement_key);
  const plan = { creates: [], changes: [], held: [], missing: [], skipped: [], unchanged: 0 };
  for (const item of catalog.products) {
    if (item.kind !== 'plan') {
      if (item.prices.length) plan.skipped.push({ entitlement_key: item.entitlement_key, reason: `${item.kind} prices are not sold in Stripe for ${catalog.app}` });
      continue;
    }
    const recurring = item.prices.filter(price => price.interval === 'month' || price.interval === 'year');
    if (!recurring.length) continue;
    const matches = products.filter(({ view }) => view.entitlement_key === item.entitlement_key);
    if (matches.length !== 1) {
      plan[matches.length ? 'held' : 'missing'].push({ entitlement_key: item.entitlement_key,
        reason: matches.length ? `${matches.length} active Stripe products carry this entitlement key` : 'no active Stripe product carries this entitlement key' });
      continue;
    }
    const product = matches[0].raw;
    for (const target of recurring) {
      const current = stripePrices.filter(price => (typeof price.product === 'string' ? price.product : price.product?.id) === product.id
        && publicRecurring(price) && price.recurring.interval === target.interval);
      const entry = { entitlement_key: item.entitlement_key, product: product.id, interval: target.interval, unit_amount: target.unit_amount };
      if (current.some(price => price.unit_amount === target.unit_amount)) {
        if (current.length > 1) plan.held.push({ ...entry, reason: `${current.length} published ${target.interval} prices; one already matches` });
        else plan.unchanged++;
        continue;
      }
      if (!current.length) { plan.creates.push(entry); continue; }
      if (current.length > 1) { plan.held.push({ ...entry, reason: `${current.length} published ${target.interval} prices, none at the catalog amount` }); continue; }
      const from = current[0].unit_amount;
      const ratio = target.unit_amount / from;
      if (ratio < AUTOMATIC_CHANGE_RANGE.min || ratio > AUTOMATIC_CHANGE_RANGE.max) {
        plan.held.push({ ...entry, price: current[0].id, from, reason: `a change from ${from} to ${target.unit_amount} cents is outside the automatic range` });
        continue;
      }
      plan.changes.push({ ...entry, price: current[0].id, from });
    }
  }
  return plan;
}

const dollars = cents => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const escapeRegExp = text => text.replace(/[$.*+?^{}()|[\]\\]/g, '\\$&');

/**
 * The application's plan prices that its AI fact sheet (server/agents/content/facts.mjs,
 * the reviewed copy of docs/GTM_FACTS.md the agents may quote) does not state. The fact
 * sheet stays a reviewed document; a non-empty answer means it needs that review, and
 * syncAppCatalog says so in the log and the audit trail.
 */
export function factSheetDrift(catalog, factLines) {
  const text = factLines.join(' ');
  return catalog.products.filter(product => product.kind === 'plan')
    .flatMap(product => product.prices.filter(price => price.interval !== 'once')
      .map(price => ({ entitlement_key: product.entitlement_key, interval: price.interval, amount: dollars(price.unit_amount) })))
    .filter(entry => !new RegExp(`${escapeRegExp(entry.amount)}(?![\\d,])`).test(text));
}
