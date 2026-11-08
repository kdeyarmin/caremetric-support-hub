/** Informational campaign notice. It never changes a quote, invoice or subscription. */
export function FoundersSaleNotice({ admin = false }: { admin?: boolean }) {
  return <section className="billing-banner" aria-label="Founders Sale terms">
    <h2>Founders Sale: 50% off your first year</h2>
    <p>Eligible new CareBase, Train and Intel Starter, Growth or Pro subscriptions receive 50% off the first 12 months of paid service after the free trial. Includes eligible CareBase add-ons. Monthly billing is half the regular monthly price; annual billing is half the published annual price, paid upfront. Standard pricing then resumes.</p>
    <p>Ask CareMetric for <strong>FOUNDERS50</strong> before payment. CareMetric confirms eligibility and the discounted invoice; the sale is not automatically included in self-service quotes or checkout. Existing free trials qualify. One introductory year per organization per product; cancellation and restart do not reset it. No other coupon stacking. Excludes setup, onboarding, Intel extra seats/branches/states, taxes, custom contracts, retired plans and Breathe. Existing founding agreements retain their terms.</p>
    {admin ? <p><strong>Assisted activation:</strong> verify paid history and prior redemptions for this product. Apply the 50%, repeating, 12-month coupon at paid service start, after the trial. The first-time promotion code can reject trial conversions; use the underlying Founders Sale coupon after review. Verify eligible items, invoice amount and expiry. Preserve the billing cycle through the introductory year; review cadence changes to prevent a second discounted annual invoice.</p> : <a href="mailto:hello@caremetric.ai?subject=FOUNDERS50%20activation">Contact CareMetric to activate FOUNDERS50</a>}
  </section>;
}
