import type { FacilityAllocation, SellablePrice } from './customerBillingProtocol';

export interface BillingLine { price: string; quantity: number }
const selectedPrices = (row: FacilityAllocation) => [row.plan, ...row.addons].filter((value): value is string => value !== null);
export function effectiveFeatures(price: SellablePrice): ReadonlySet<string> {
  if (price.features.length) return new Set(price.features);
  if (['complete', 'carebase', 'portfolio'].includes(price.key)) return new Set(['care', 'emar', 'train', 'workforce', 'compliance', 'billing']);
  const key = price.key === 'core' ? 'care' : price.key;
  return new Set([key]);
}
export function aggregateFacilityLines(rows: FacilityAllocation[], catalog: ReadonlyMap<string, SellablePrice>): BillingLine[] {
  const counts = new Map<string, number>();
  for (const row of rows) for (const id of selectedPrices(row)) {
    const price = catalog.get(id); if (!price) throw new Error('A current price is unavailable. Refresh billing before changing a plan.');
    counts.set(id, price.model === 'flat' ? 1 : (counts.get(id) ?? 0) + 1);
  }
  if (counts.size > 20) throw new Error('This selection exceeds the number of prices supported on a consolidated subscription.');
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([price, quantity]) => ({ price, quantity }));
}
export function recurringSubtotal(rows: FacilityAllocation[], catalog: ReadonlyMap<string, SellablePrice>): number {
  return aggregateFacilityLines(rows, catalog).reduce((total, line) => total + catalog.get(line.price)!.amount * line.quantity, 0);
}
function features(row: FacilityAllocation, catalog: ReadonlyMap<string, SellablePrice>) {
  return new Set(selectedPrices(row).flatMap(id => [...effectiveFeatures(catalog.get(id)!)]));
}
function validateSelection(row: FacilityAllocation, prior: FacilityAllocation, catalog: ReadonlyMap<string, SellablePrice>, cadence: { interval: string; currency: string }) {
  if (new Set(selectedPrices(row)).size !== selectedPrices(row).length) throw new Error('Choose each plan and add-on once.');
  if (!row.plan && row.addons.length) throw new Error('Add-ons require a base plan.');
  const base = row.plan ? catalog.get(row.plan) : null;
  if (row.plan && (!base || base.kind !== 'plan')) throw new Error('Choose an available base plan.');
  if (row.addons.some(id => !prior.addons.includes(id)) && !base?.allows_addons) throw new Error('This plan already includes its modules or does not accept add-ons.');
  for (const id of selectedPrices(row)) {
    const price = catalog.get(id);
    if (!price || (!price.active && !selectedPrices(prior).includes(id)) || price.interval !== cadence.interval || price.currency !== cadence.currency || price.interval_count !== 1) throw new Error('Choose an active price matching the organization’s billing cycle and currency.');
    if (id !== row.plan && price.kind !== 'addon') throw new Error('Choose an add-on from this application.');
  }
}

/** Additions take effect now; removals retain their existing access and charges until renewal. */
export function planFacilityChange(current: FacilityAllocation[], target: FacilityAllocation, prices: SellablePrice[], cadence: { interval: string; currency: string }) {
  const catalog = new Map(prices.map(price => [price.id, price]));
  const prior = current.find(row => row.facility_id === target.facility_id);
  if (!prior) throw new Error('Choose a registered facility.');
  validateSelection(target, prior, catalog, cadence);
  const next = current.map(row => row.facility_id === target.facility_id ? target : row.pending_at ? { ...row, plan: row.pending_plan ?? null, addons: row.pending_addons ?? [] } : row);
  const candidateFeatures = features(target, catalog), priorFeatures = features(prior, catalog);
  const replacementIsUpgrade = target.plan !== null && target.plan !== prior.plan && [...priorFeatures].every(feature => candidateFeatures.has(feature))
    && recurringSubtotal([target], catalog) >= recurringSubtotal([prior], catalog);
  let immediateTarget = prior;
  if (target.plan === prior.plan) immediateTarget = { ...prior, addons: [...new Set([...prior.addons, ...target.addons])] };
  else if (replacementIsUpgrade) {
    const included = effectiveFeatures(catalog.get(target.plan!)!);
    const retained = prior.addons.filter(id => ![...effectiveFeatures(catalog.get(id)!)].every(feature => included.has(feature)));
    immediateTarget = { ...target, addons: [...new Set([...target.addons, ...retained])] };
  }
  const immediate = current.map(row => row.facility_id === target.facility_id ? immediateTarget : row);
  const immediateLines = aggregateFacilityLines(immediate, catalog), nextLines = aggregateFacilityLines(next, catalog), currentLines = aggregateFacilityLines(current, catalog);
  const same = (left: BillingLine[], right: BillingLine[]) => JSON.stringify(left) === JSON.stringify(right);
  return { immediate, next, immediateLines, nextLines, currentLines, hasImmediateChange: !same(immediateLines, currentLines), hasScheduledChange: !same(immediateLines, nextLines), recurringSubtotal: recurringSubtotal(next, catalog) };
}
