/** Active Hub integrations. Historical product identifiers remain readable. */
export const centralHubApps = ['carebase', 'breathe', 'caremetric-intel'] as const;
export const centralHubPortfolioApps = ['carebase', 'breathe', 'intel'] as const;
export function isCentralHubApp(value: string): boolean {
  return (centralHubApps as readonly string[]).includes(value);
}
