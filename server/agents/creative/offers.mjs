/**
 * The offers creative may name, read from the billing code itself (server/founders-sale.mjs), so an ad can never state an offer the
 * billing system does not apply. The Founders Sale is CareMetric's only live offer: promotion code FOUNDERS75 in Stripe, applied
 * automatically when paid service starts (customers never enter the code; docs/GTM_FACTS.md), to CareBase, Train and Intel plans only.
 * Its percentage and length are read from the live coupon's id ("..._75_12m_..."), so a new coupon changes what the checks accept.
 */
import { FOUNDERS_COUPON, FOUNDERS_OFFER } from '../../founders-sale.mjs';

const coupon = /_(\d{1,3})_(\d{1,2})m_/.exec(FOUNDERS_COUPON);

export const liveOffers = Object.freeze({
  FOUNDERS75: Object.freeze({
    code: 'FOUNDERS75', name: 'Founders Sale', coupon: FOUNDERS_COUPON, offer: FOUNDERS_OFFER,
    percentOff: coupon ? Number(coupon[1]) : null, months: coupon ? Number(coupon[2]) : null,
    products: Object.freeze(['carebase', 'caremetric-intel']), automatic: true,
    terms: 'Founders Sale: 75% off eligible subscription charges for the first 12 months of paid service, applied automatically when paid service starts. No code needed. Standard pricing resumes after the introductory year.',
  }),
});

export const offerCodes = Object.freeze(Object.keys(liveOffers));
export const offerFor = code => (typeof code === 'string' ? liveOffers[code.trim().toUpperCase()] ?? null : null);
