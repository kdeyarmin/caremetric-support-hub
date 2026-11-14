const idOf = value => typeof value === 'string' ? value : value?.id;

/** Verify a usable card for automatic collection, never a browser's return URL. */
export async function trialCardOnFile(live, entitlement) {
  if (!entitlement.entitled || entitlement.status !== 'trialing') return false;
  const ids = [...new Set(entitlement.products.filter(p => p.kind === 'plan' && p.status === 'trialing').map(p => p.subscription))];
  if (!ids.length || ids.some(id => typeof id !== 'string' || !/^sub_[A-Za-z0-9]+$/.test(id))) return false;
  for (const id of ids) {
    const subscription = await live.get(`/v1/subscriptions/${id}`);
    if (subscription.status !== 'trialing' || subscription.collection_method !== 'charge_automatically'
      || subscription.metadata?.app !== entitlement.app) return false;
    const customerId = idOf(subscription.customer);
    if (!/^cus_[A-Za-z0-9]+$/.test(customerId ?? '')) return false;
    const customer = await live.get(`/v1/customers/${customerId}`);
    if (customer.deleted || customer.metadata?.hub_tenant_id !== entitlement.tenant_id) return false;
    const methodId = idOf(subscription.default_payment_method) || idOf(customer.invoice_settings?.default_payment_method);
    if (!/^pm_[A-Za-z0-9]+$/.test(methodId ?? '')) return false;
    const method = await live.get(`/v1/payment_methods/${methodId}`);
    if (method.type !== 'card' || idOf(method.customer) !== customerId) return false;
  }
  return true;
}
