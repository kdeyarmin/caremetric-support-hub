import { billingApplyRequestSchema, billingCommandSchema, billingIntentSchema, billingPreviewRequestSchema, verifyBillingOutcome } from "../../supabase/functions/_shared/billingCommandProtocol";
import type { BillingApplyRequest, BillingIntent, BillingPreview, BillingPreviewRequest, BillingResult } from "../../supabase/functions/_shared/billingCommandProtocol";
import { requestAdmin } from "./transport";

export interface BillingCommandClient {
  resume(targetId: string, signal: AbortSignal): Promise<BillingIntent | null>;
  preview(request: BillingPreviewRequest, signal: AbortSignal): Promise<BillingIntent>;
  apply(request: BillingApplyRequest, preview: BillingPreview, signal: AbortSignal): Promise<BillingResult>;
  discard(requestId: string, signal: AbortSignal): Promise<void>;
}
export const billingCommandClient: BillingCommandClient = {
  resume: async(targetId, signal)=>{
    const result = await requestAdmin("billing-command", billingCommandSchema.parse({ operation: "resume", targetId }), signal);
    if (result === null) return null;
    const intent = billingIntentSchema.parse(result);
    if (intent.request.targetId !== targetId.toLowerCase()) throw new Error("Unbound billing review");
    return intent;
  },
  preview: async(request, signal)=>{
    const parsed = billingPreviewRequestSchema.parse(request);
    const intent = billingIntentSchema.parse(await requestAdmin("billing-command", parsed, signal));
    if (JSON.stringify(intent.request) !== JSON.stringify(parsed)) throw new Error("Unbound billing preview");
    return intent;
  },
  apply: async(request, preview, signal)=>verifyBillingOutcome(await requestAdmin("billing-command", billingApplyRequestSchema.parse(request), signal), preview),
  discard: async(requestId, signal)=>{
    const result = await requestAdmin("billing-command", billingCommandSchema.parse({ operation: "discard", requestId }), signal);
    if (!result || typeof result !== "object" || Object.keys(result).length !== 1 || !("discarded" in result) || result.discarded !== true) throw new Error("Invalid billing discard result");
  },
};
