// The account report's revenue figures come from the same functions as the Billing screen (src/billing/billingMath.ts), loaded
// straight from the TypeScript file by Node. The Dockerfile copies that file into the image.
export { itemMonthlyCents, monthlyTotals, revenueStatuses, subscriptionMonthlyCents } from '../../../src/billing/billingMath.ts';
