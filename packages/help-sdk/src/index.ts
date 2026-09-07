export const CAREMETRIC_PRODUCT_SLUGS = [
  "breathe",
  "carebase",
  "caremetric-emr",
  "caremetric-go",
  "caremetric-intel",
  "pennsync",
] as const;

export type CareMetricProduct = (typeof CAREMETRIC_PRODUCT_SLUGS)[number];

export interface HelpContext {
  product: CareMetricProduct;
  route?: string;
  feature?: string;
  appVersion?: string;
  locale?: string;
  environment?: "production" | "staging" | "development";
}

export interface BuildHelpUrlOptions {
  /**
   * Override the Support Hub origin for an explicitly configured staging or
   * development environment. Production callers should omit this value so a
   * local application URL cannot accidentally become the support destination.
   */
  baseUrl?: string;
  /**
   * Compile-time route registry for the calling application. Route context is
   * omitted unless it exactly matches one of these canonical templates.
   */
  routeAllowlist?: readonly string[];
  /**
   * Compile-time feature registry for the calling application. Feature context
   * is omitted unless it exactly matches one of these non-user-authored keys.
   */
  featureAllowlist?: readonly string[];
  context: HelpContext;
}

export const DEFAULT_HELP_BASE_URL = "https://support-hub-web-production.up.railway.app";

const safeValue = (value: string, maximum: number) => value.trim().slice(0, maximum);
const supportedEnvironments = new Set(["production", "staging", "development"]);
const supportedProducts = new Set<CareMetricProduct>(CAREMETRIC_PRODUCT_SLUGS);
const contextTokenPattern = /^[A-Za-z0-9._:+-]+$/;
const localePattern = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const routePattern = /^\/[A-Za-z0-9_/:.*-]*$/;
const uuidSegmentPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const versionPattern = /^v?\d{1,4}(?:\.\d{1,4}){0,3}(?:[-+][A-Za-z0-9.-]{1,24})?$/;

const safeRoute = (value: string) => {
  const routeOnly = safeValue(value.split(/[?#]/, 1)[0] ?? "", 256);
  if (!routePattern.test(routeOnly) || routeOnly.startsWith("//")) return "";
  const containsIdentifier = routeOnly.split("/").some((segment) =>
    /^\d+$/.test(segment) || uuidSegmentPattern.test(segment));
  return containsIdentifier ? "" : routeOnly;
};

const resolveBaseUrl = (baseUrl: string) => {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "https:") {
    throw new TypeError("Help baseUrl must use https.");
  }
  if (parsed.username || parsed.password) {
    throw new TypeError("Help baseUrl must not include credentials.");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "::1" ||
    /^::ffff:7f[0-9a-f]{2}:/i.test(hostname) ||
    hostname === "0.0.0.0" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  ) {
    throw new TypeError("Help baseUrl must not use a loopback host.");
  }
  return parsed.origin;
};

/**
 * Builds a context-only link to the Support Hub. It intentionally accepts no
 * user, tenant, patient, ticket, or free-text fields. Authenticated identity is
 * exchanged separately with a short-lived server-signed token.
 */
export function buildHelpUrl({
  baseUrl = DEFAULT_HELP_BASE_URL,
  routeAllowlist = [],
  featureAllowlist = [],
  context,
}: BuildHelpUrlOptions): string {
  const product = safeValue(context.product, 64);
  if (!supportedProducts.has(product as CareMetricProduct)) {
    throw new TypeError("Help context requires a valid product slug.");
  }

  const url = new URL("/help", resolveBaseUrl(baseUrl));
  url.searchParams.set("product", product);
  if (context.route) {
    const route = safeRoute(context.route);
    const allowedRoutes = new Set(routeAllowlist.map(safeRoute).filter(Boolean));
    if (route && allowedRoutes.has(route)) url.searchParams.set("route", route);
  }
  if (context.feature) {
    const feature = safeValue(context.feature, 96);
    const allowedFeatures = new Set(featureAllowlist
      .map((value) => safeValue(value, 96))
      .filter((value) => contextTokenPattern.test(value)));
    if (allowedFeatures.has(feature)) url.searchParams.set("feature", feature);
  }
  if (context.appVersion) {
    const appVersion = safeValue(context.appVersion, 48);
    if (versionPattern.test(appVersion)) url.searchParams.set("app_version", appVersion);
  }
  if (context.locale) {
    const locale = safeValue(context.locale, 16);
    if (localePattern.test(locale)) url.searchParams.set("locale", locale);
  }
  if (context.environment && supportedEnvironments.has(context.environment)) {
    url.searchParams.set("environment", context.environment);
  }
  return url.toString();
}

export interface HelpLauncherOptions extends BuildHelpUrlOptions {
  target?: "_self" | "_blank";
}

export function openHelp(options: HelpLauncherOptions): void {
  if (typeof window === "undefined") {
    throw new Error("openHelp can only be called in a browser. Use buildHelpUrl during server rendering.");
  }
  const target = options.target ?? "_blank";
  const opened = window.open(
    buildHelpUrl(options),
    target,
    target === "_blank" ? "noopener,noreferrer" : undefined,
  );
  if (opened && target === "_blank") opened.opener = null;
}
