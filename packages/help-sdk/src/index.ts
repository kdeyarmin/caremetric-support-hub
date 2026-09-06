export interface HelpContext {
  product: string;
  route?: string;
  feature?: string;
  appVersion?: string;
  locale?: string;
  environment?: "production" | "staging" | "development";
}

export interface BuildHelpUrlOptions {
  baseUrl: string;
  context: HelpContext;
}

const safeValue = (value: string, maximum: number) => value.trim().slice(0, maximum);

/**
 * Builds a context-only link to the Support Hub. It intentionally accepts no
 * user, tenant, patient, ticket, or free-text fields. Authenticated identity is
 * exchanged separately with a short-lived server-signed token.
 */
export function buildHelpUrl({ baseUrl, context }: BuildHelpUrlOptions): string {
  const url = new URL("/help", baseUrl);
  url.searchParams.set("product", safeValue(context.product, 64));
  if (context.route) url.searchParams.set("route", safeValue(context.route, 256));
  if (context.feature) url.searchParams.set("feature", safeValue(context.feature, 96));
  if (context.appVersion) url.searchParams.set("app_version", safeValue(context.appVersion, 48));
  if (context.locale) url.searchParams.set("locale", safeValue(context.locale, 16));
  if (context.environment) url.searchParams.set("environment", context.environment);
  return url.toString();
}

export interface HelpLauncherOptions extends BuildHelpUrlOptions {
  target?: "_self" | "_blank";
}

export function openHelp(options: HelpLauncherOptions): void {
  const target = options.target ?? "_blank";
  window.open(buildHelpUrl(options), target, target === "_blank" ? "noopener,noreferrer" : undefined);
}
