import { createHash } from 'node:crypto';
import { normalizePrice, normalizeProduct } from './stripe.mjs';
import { maxAmountCents } from '../src/billing/billingProtocol.ts';

/**
 * An application that sets its own prices publishes them (CareMetric Intel:
 * GET https://www.caremetricintel.com/api/billing/catalog, contract
 * caremetric.app-catalog.v1, built from Intel's src/lib/planCatalog.ts). The
 * Hub reads that catalog and keeps Stripe in step: a plan or add-on price that
 * is missing is created (an add-on's product too), and a price whose amount
 * changed is replaced through the same `price.change` command an administrator
 * uses: a lower price reaches everyone already subscribed at their next invoice,
 * and a higher one never does (they are grandfathered: Intel's founding member
 * pricing promises a subscriber's price never goes up), and a product's description
 * follows the catalog's (its name and unit label are left as they are). The
 * application never talks to Stripe. The same catalog feeds the AI team's fact sheet
 * (server/agents/content/facts.mjs, useAppCatalogFacts).
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

/**
 * Price moves outside AUTOMATIC_CHANGE_RANGE that the owner reviewed: a held change is applied when the catalog's new
 * amount is listed here for that entitlement key, plan and interval. The pull request that adds an entry is the review.
 * Intel, 2026-11-28 (owner decision): plans repriced to a base plus each additional marketer (Starter, now Local, $349
 * to $99; Growth, now Team, $899 to $199; Pro, now Multi-state, $1,999 to $499), Local's additional marketer $59 to $29,
 * and extra locations and states halved.
 */
export const REVIEWED_PRICE_MOVES = Object.freeze({
  'caremetric-intel': Object.freeze([
    { entitlement_key: 'starter', interval: 'month', unit_amount: 9900 },
    { entitlement_key: 'starter', interval: 'year', unit_amount: 99000 },
    { entitlement_key: 'growth', interval: 'month', unit_amount: 19900 },
    { entitlement_key: 'growth', interval: 'year', unit_amount: 199000 },
    { entitlement_key: 'pro', interval: 'month', unit_amount: 49900 },
    { entitlement_key: 'pro', interval: 'year', unit_amount: 499000 },
    { entitlement_key: 'extra_seat', plan: 'starter', interval: 'month', unit_amount: 2900 },
    { entitlement_key: 'extra_seat', plan: 'starter', interval: 'year', unit_amount: 29000 },
    { entitlement_key: 'extra_branch', interval: 'month', unit_amount: 4900 },
    { entitlement_key: 'extra_branch', interval: 'year', unit_amount: 49000 },
    { entitlement_key: 'extra_state', interval: 'month', unit_amount: 9900 },
    { entitlement_key: 'extra_state', interval: 'year', unit_amount: 99000 },
  ]),
});

/** Whether a move outside the automatic range is one the owner reviewed (REVIEWED_PRICE_MOVES). */
export function reviewedMove(app, entry, reviewed = REVIEWED_PRICE_MOVES) {
  return (reviewed[app] ?? []).some(move => move.entitlement_key === entry.entitlement_key && (move.plan ?? '') === (entry.plan ?? '')
    && move.interval === entry.interval && move.unit_amount === entry.unit_amount);
}

/**
 * How a replaced price treats the people already on it: a lower price reaches them at their next invoice, with no
 * proration of the period they paid for; a higher one never does (grandfathered).
 */
export const migrationFor = (from, to) => (to < from ? 'no_proration' : 'grandfather');

/** The Stripe product metadata naming the plan an add-on product is priced for (Intel's extra seat costs more on Starter). */
export const FOR_PLAN_KEY = 'hub_for_plan';

const isAmount = value => Number.isInteger(value) && value > 0 && value <= maxAmountCents;
const keyPattern = /^[a-z0-9_.-]{1,64}$/;
/** Words the catalog may carry into the fact sheet and Stripe: printable text, no markup, bounded. */
const words = (value, max) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f<>`{}]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

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
    if (product.from_unit_amount !== undefined && !isAmount(product.from_unit_amount)) throw new Error(`${product.entitlement_key} has an invalid "from" price.`);
    return {
      entitlement_key: product.entitlement_key, kind: product.kind,
      name: words(product.name, 120) || product.entitlement_key, description: words(product.description, 400),
      unit_label: /^[a-z]{1,12}$/.test(product.unit_label ?? '') ? product.unit_label : '',
      self_serve: product.self_serve === true, prices,
      ...(product.from_unit_amount !== undefined ? { from_unit_amount: product.from_unit_amount } : {}),
    };
  });
  const trialDays = Number.isInteger(body.trial_days) && body.trial_days >= 1 && body.trial_days <= 90 ? body.trial_days : null;
  // The application's founding offer (Intel: a price lock), optional: plan keys and its terms in words.
  const offer = body.founding_offer && typeof body.founding_offer === 'object' && body.founding_offer.kind === 'price_lock'
    ? { kind: 'price_lock', plans: (Array.isArray(body.founding_offer.plans) ? body.founding_offer.plans : []).filter(key => keyPattern.test(String(key))).slice(0, 10),
        terms: words(body.founding_offer.terms, 1200) }
    : null;
  const saving = Number.isInteger(body.annual_saving_percent) && body.annual_saving_percent > 0 && body.annual_saving_percent < 100 ? body.annual_saving_percent : null;
  return {
    app, version: body.version, trial_days: trialDays, trial_includes: words(body.trial?.includes, 200),
    annual_saving_percent: saving, free_onboarding: body.free_onboarding === true, founding_offer: offer, products,
  };
}

/** A version-4-shaped id derived from its parts, so a retried sync reuses the same Stripe idempotency keys. */
export function deterministicKey(...parts) {
  const hex = createHash('sha256').update(parts.join('\u0000')).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A published price a plan or add-on is sold at: active, flat or per unit, recurring every one interval, not a customer's contract price. */
function publicRecurring(price) {
  const p = normalizePrice(price);
  return p.active && p.type === 'recurring' && p.interval_count === 1 && p.unit_amount !== null && !p.tenant_id
    && ['flat', 'per_unit'].includes(p.pricing_model) && p.currency === 'usd';
}

const productOf = price => (typeof price.product === 'string' ? price.product : price.product?.id);
/** Whether Stripe's description already says what the catalog's does, spacing aside. */
const sameDescription = (stripe, catalog) => stripe.replace(/\s+/g, ' ').trim() === catalog;

/**
 * What it takes to make Stripe match the catalog:
 * - `productCreates`: an add-on (per plan, when its price depends on the plan) with no Stripe product yet;
 * - `creates`: a plan or add-on product with no published price for an interval gets one;
 * - `changes`: a published price at another amount is replaced; `migrate` says whether the people on it move to the
 *   new amount (a lower price, `no_proration`) or keep theirs (a higher one, `grandfather`);
 * - `descriptions`: a plan or add-on product whose description differs from the
 *   catalog's gets the catalog's; a catalog item with no description clears
 *   nothing, and names and unit labels are never changed;
 * - `held`: a change outside AUTOMATIC_CHANGE_RANGE that REVIEWED_PRICE_MOVES doesn't list, or a product with several
 *   published prices for one interval, waits for an administrator;
 * - `missing`: a plan the catalog sells that has no Stripe product (plans are
 *   created by an administrator, because they decide entitlements and offers);
 * - `skipped`: one-time fees, which the Hub adds to a first invoice by hand.
 * Products and prices are Stripe objects as the API returns them.
 */
export function planCatalogSync(catalog, stripeProducts, stripePrices, reviewed = REVIEWED_PRICE_MOVES) {
  const products = stripeProducts.map(product => ({ raw: product, view: normalizeProduct(product) }))
    .filter(({ view }) => view.app === catalog.app && view.active && view.entitlement_key);
  const planNames = new Map(catalog.products.filter(item => item.kind === 'plan').map(item => [item.entitlement_key, item.name]));
  const plan = { productCreates: [], creates: [], changes: [], descriptions: [], held: [], missing: [], skipped: [], unchanged: 0 };
  const syncPrices = (item, product, forPlan, targets) => {
    for (const target of targets) {
      const current = stripePrices.filter(price => productOf(price) === product.id && publicRecurring(price) && price.recurring.interval === target.interval);
      const entry = { entitlement_key: item.entitlement_key, kind: item.kind, ...(forPlan ? { plan: forPlan } : {}), product: product.id, interval: target.interval, unit_amount: target.unit_amount };
      if (current.some(price => price.unit_amount === target.unit_amount)) {
        if (current.length > 1) plan.held.push({ ...entry, reason: `${current.length} published ${target.interval} prices; one already matches` });
        else plan.unchanged++;
        continue;
      }
      if (!current.length) { plan.creates.push(entry); continue; }
      if (current.length > 1) { plan.held.push({ ...entry, reason: `${current.length} published ${target.interval} prices, none at the catalog amount` }); continue; }
      const from = current[0].unit_amount;
      const ratio = target.unit_amount / from;
      const outside = ratio < AUTOMATIC_CHANGE_RANGE.min || ratio > AUTOMATIC_CHANGE_RANGE.max;
      if (outside && !reviewedMove(catalog.app, entry, reviewed)) {
        plan.held.push({ ...entry, price: current[0].id, from, reason: `a change from ${from} to ${target.unit_amount} cents is outside the automatic range` });
        continue;
      }
      plan.changes.push({ ...entry, price: current[0].id, from, migrate: migrationFor(from, target.unit_amount), ...(outside ? { reviewed: true } : {}) });
    }
  };
  for (const item of catalog.products) {
    const recurring = item.prices.filter(price => price.interval === 'month' || price.interval === 'year');
    if (item.kind === 'fee') {
      if (item.prices.length) plan.skipped.push({ entitlement_key: item.entitlement_key, reason: 'one-time fees are added to a first invoice by an administrator' });
      continue;
    }
    if (!recurring.length) continue;
    const groups = new Map();
    for (const price of recurring) groups.set(price.plan ?? '', [...(groups.get(price.plan ?? '') ?? []), price]);
    for (const [forPlan, targets] of groups) {
      const matches = products.filter(({ view }) => view.kind === item.kind && view.entitlement_key === item.entitlement_key
        && (item.kind === 'plan' || (view.metadata[FOR_PLAN_KEY] ?? '') === forPlan));
      if (matches.length > 1) {
        plan.held.push({ entitlement_key: item.entitlement_key, ...(forPlan ? { plan: forPlan } : {}), reason: `${matches.length} active Stripe products carry this entitlement key` });
        continue;
      }
      if (!matches.length) {
        if (item.kind === 'plan') {
          plan.missing.push({ entitlement_key: item.entitlement_key, reason: 'no active Stripe product carries this entitlement key' });
        } else {
          const name = forPlan ? `${item.name} (${planNames.get(forPlan) ?? forPlan})` : item.name;
          plan.productCreates.push({ entitlement_key: item.entitlement_key, kind: item.kind, ...(forPlan ? { plan: forPlan } : {}),
            name, description: item.description, unit_label: item.unit_label, prices: targets });
        }
        continue;
      }
      const { view } = matches[0];
      if (item.description && !sameDescription(view.description, item.description)) {
        plan.descriptions.push({ entitlement_key: item.entitlement_key, kind: item.kind, ...(forPlan ? { plan: forPlan } : {}), product: view.id,
          from: view.description, description: item.description });
      }
      syncPrices(item, matches[0].raw, forPlan, targets);
    }
  }
  return plan;
}
