import { isUuid } from "./adminProtocol.ts";
import { parseMinorAmount } from "./billingProtocol.ts";

export const checkoutMetrics = ["flat", "active_learner", "active_user", "active_resident", "facility"] as const;
export const checkoutPricingModels = ["flat", "per_unit", "graduated", "volume", "flat_plus_overage", "custom"] as const;
export type BillingCatalogOperation = { operation: "billing.packages.list"; search?: string; limit: number; offset: number };
export interface BillingPackageChoice {
  id: string; packageId: string; name: string; description: string; status: "active";
  availability: "mapped" | "unmapped"; providerPriceId: string | null;
  billingInterval: "month" | "year"; intervalCount: number;
  billingMetric: typeof checkoutMetrics[number]; pricingModel: typeof checkoutPricingModels[number];
  currency: string; baseAmountMinor: string; unitAmountMinor: string | null;
  includedQuantity: number; minimumQuantity: number; maximumQuantity: number | null; trialDays: number;
}
export interface BillingPackagePage {
  source: "application_database"; providerAvailability: "not_checked";
  items: BillingPackageChoice[]; total: number; limit: number; offset: number;
}
function closed(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) throw new Error("Invalid checkout catalog");
  return input as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max) throw new Error("Invalid checkout catalog");
  return value;
}
function id(value: unknown): string {
  if (!isUuid(value)) throw new Error("Invalid checkout catalog identity");
  return value.toLowerCase();
}
function count(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error("Invalid checkout catalog count");
  return value;
}
function oneOf<T extends string>(value: unknown, choices: readonly T[]): T {
  if (!choices.includes(value as T)) throw new Error("Invalid checkout catalog option");
  return value as T;
}
export function parseCheckoutCatalog(input: unknown, operation: BillingCatalogOperation): BillingPackagePage {
  const page = closed(input, ["source", "providerAvailability", "items", "total", "limit", "offset"]);
  if (page.source !== "application_database" || page.providerAvailability !== "not_checked" || !Array.isArray(page.items)
    || page.items.length > operation.limit || page.limit !== operation.limit || page.offset !== operation.offset) throw new Error("Invalid checkout catalog page");
  const items = page.items.map(input => {
    const row = closed(input, ["id", "packageId", "name", "description", "status", "availability", "providerPriceId",
      "billingInterval", "intervalCount", "billingMetric", "pricingModel", "currency", "baseAmountMinor", "unitAmountMinor",
      "includedQuantity", "minimumQuantity", "maximumQuantity", "trialDays"]);
    const availability = oneOf(row.availability, ["mapped", "unmapped"] as const);
    const providerPriceId = row.providerPriceId === null ? null : text(row.providerPriceId, 255);
    if (availability === "mapped" ? !providerPriceId || !/^price_[A-Za-z0-9]+$/.test(providerPriceId) : providerPriceId !== null) throw new Error("Invalid checkout mapping");
    const currency = text(row.currency, 3);
    if (!/^[a-z]{3}$/.test(currency)) throw new Error("Invalid checkout currency");
    const minimumQuantity = count(row.minimumQuantity, 1);
    return { id: id(row.id), packageId: id(row.packageId), name: text(row.name, 500), description: text(row.description, 4000),
      status: oneOf(row.status, ["active"] as const), availability, providerPriceId,
      billingInterval: oneOf(row.billingInterval, ["month", "year"] as const), intervalCount: count(row.intervalCount, 1, 36),
      billingMetric: oneOf(row.billingMetric, checkoutMetrics), pricingModel: oneOf(row.pricingModel, checkoutPricingModels),
      currency, baseAmountMinor: parseMinorAmount(row.baseAmountMinor), unitAmountMinor: row.unitAmountMinor === null ? null : parseMinorAmount(row.unitAmountMinor),
      includedQuantity: count(row.includedQuantity), minimumQuantity,
      maximumQuantity: row.maximumQuantity === null ? null : count(row.maximumQuantity, minimumQuantity), trialDays: count(row.trialDays, 0, 90) };
  });
  if (new Set(items.map(row => row.id)).size !== items.length) throw new Error("Duplicate checkout choice");
  return { source: "application_database", providerAvailability: "not_checked", items, total: count(page.total), limit: operation.limit, offset: operation.offset };
}
