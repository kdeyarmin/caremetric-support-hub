import { checkoutApplyRequestSchema, checkoutCheckRequestSchema, checkoutCommandSchema, checkoutIntentSchema, checkoutPreviewRequestSchema, checkoutRecoverRequestSchema, verifyCheckoutOutcome } from "../../supabase/functions/_shared/checkoutCommandProtocol";
import type { CheckoutApplyRequest, CheckoutCheckRequest, CheckoutIntent, CheckoutPreview, CheckoutPreviewRequest, CheckoutRecoverRequest, CheckoutResult } from "../../supabase/functions/_shared/checkoutCommandProtocol";
import { parseCheckoutCatalog } from "../../supabase/functions/_shared/checkoutCatalogProtocol";
import type { BillingPackagePage } from "../../supabase/functions/_shared/checkoutCatalogProtocol";
import { readPortfolio } from "./portfolioClient";
import { requestAdmin } from "./transport";

export interface CheckoutCommandClient {
  packages(search: string, offset: number, signal: AbortSignal): Promise<BillingPackagePage>;
  resume(targetId: string, signal: AbortSignal): Promise<CheckoutIntent | null>;
  preview(request: CheckoutPreviewRequest, signal: AbortSignal): Promise<CheckoutIntent>;
  recover(request: CheckoutRecoverRequest, signal: AbortSignal): Promise<CheckoutIntent>;
  apply(request: CheckoutApplyRequest, preview: CheckoutPreview, signal: AbortSignal): Promise<CheckoutResult>;
  check(request: CheckoutCheckRequest, preview: CheckoutPreview, signal: AbortSignal): Promise<CheckoutResult>;
  discard(requestId: string, signal: AbortSignal): Promise<void>;
}
export const checkoutCommandClient: CheckoutCommandClient = {
  packages: async(search, offset, signal)=>{
    const operation = { operation: "billing.packages.list" as const, search, offset, limit: 20 };
    return parseCheckoutCatalog(await readPortfolio("carebase", operation, signal), operation);
  },
  resume: async(targetId, signal)=>{
    const result = await requestAdmin("checkout-command", checkoutCommandSchema.parse({ operation: "resume", targetId }), signal);
    if (result === null) return null;
    const intent = checkoutIntentSchema.parse(result);
    if (intent.request.targetId !== targetId.toLowerCase()) throw new Error("Unbound checkout review");
    return intent;
  },
  preview: async(request, signal)=>{
    const parsed = checkoutPreviewRequestSchema.parse(request);
    const intent = checkoutIntentSchema.parse(await requestAdmin("checkout-command", parsed, signal));
    if (JSON.stringify(intent.request) !== JSON.stringify(parsed)) throw new Error("Unbound checkout preview");
    return intent;
  },
  apply: async(request, preview, signal)=>verifyCheckoutOutcome(await requestAdmin("checkout-command", checkoutApplyRequestSchema.parse(request), signal), preview),
  recover: async(request, signal)=>{
    const parsed = checkoutRecoverRequestSchema.parse(request);
    const intent = checkoutIntentSchema.parse(await requestAdmin("checkout-command", parsed, signal));
    if (JSON.stringify(intent.request) !== JSON.stringify(parsed)) throw new Error("Unbound organization recovery");
    return intent;
  },
  check: async(request, preview, signal)=>verifyCheckoutOutcome(await requestAdmin("checkout-command", checkoutCheckRequestSchema.parse(request), signal), preview),
  discard: async(requestId, signal)=>{
    const result = await requestAdmin("checkout-command", checkoutCommandSchema.parse({ operation: "discard", requestId }), signal);
    if (!result || typeof result !== "object" || Object.keys(result).length !== 1 || !("discarded" in result) || result.discarded !== true) throw new Error("Invalid checkout discard result");
  },
};
