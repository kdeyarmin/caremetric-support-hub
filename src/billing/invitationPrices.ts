import { type BillingWorkspace, priceLabel } from './billingModel';
import type { InvitationApp } from './invitationProtocol';

/** Plan prices an invitation can offer: active, recurring, published (not one customer's own), flat or per unit, of an active plan. */
export function invitablePrices(data: BillingWorkspace, app: InvitationApp) {
  return data.prices.flatMap(price => {
    const product = data.products.find(item => item.id === price.product);
    if (!product || product.app !== app || !product.active || product.kind !== 'plan' || !price.active || price.type !== 'recurring'
      || price.tenant_id !== null || price.unit_amount === null || !['flat', 'per_unit'].includes(price.pricing_model) || !price.interval) return [];
    return [{ price, product, label: `${product.name} — ${priceLabel(price, product.unit_label)}` }];
  }).sort((a, b) => a.label.localeCompare(b.label));
}
