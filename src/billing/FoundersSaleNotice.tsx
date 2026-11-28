/** Published campaign terms. Individual quotes show the provider-verified saving. */
export function FoundersSaleNotice({ admin = false }: { admin?: boolean }) {
  return <section className="billing-banner founders-sale-banner" aria-label="Founders Sale terms">
    <h2>Founders Sale: 75% off your first year</h2>
    <p><strong>Applied automatically to eligible subscriptions. No code needed.</strong></p>
    <p>Eligible new CareBase and Train subscriptions receive 75% off the first 12 months of paid service after the free trial. Includes eligible CareBase add-ons. Monthly billing is a quarter of the regular monthly price; annual billing is a quarter of the published annual price, paid upfront. Standard pricing then resumes.</p>
    <p>Existing free trials qualify. One introductory year per organization per product; cancellation and restart do not reset it. No other coupon stacking. Excludes setup, onboarding, taxes, custom contracts, retired plans and Breathe. Existing founding agreements retain their terms. CareMetric Intel offers founding member pricing instead: a new Intel subscription keeps the price it starts with while it stays subscribed, and an Intel subscription already in its Founders year keeps that discount until the year ends.</p>
    {admin && <p>Eligible published plans receive the offer automatically in checkout and when a paid subscription is created. Trial conversions receive it on their first paid invoice. Review the displayed discount and renewal amount; no activation code is required.</p>}
  </section>;
}
