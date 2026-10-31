/** Active Hub integrations. Historical product identifiers remain readable. */
export const centralHubApps = ['carebase', 'breathe', 'caremetric-intel'] as const;
export function isCentralHubApp(value: string): boolean {
  return (centralHubApps as readonly string[]).includes(value);
}
/**
 * Applications the owner administers from the Hub: the central apps, plus Healthcare Advisors, whose consultation
 * requests are managed here. Advisors has no software customers, so it stays out of billing, self-service and support intake.
 */
export const hubAdminApps = [...centralHubApps, 'advisors'] as const;
export const centralHubPortfolioApps = ['carebase', 'breathe', 'intel', 'advisors'] as const;
export function isHubAdminApp(value: string): boolean {
  return (hubAdminApps as readonly string[]).includes(value);
}
