import { parseAppCommand, parseCommandEnvelope } from "../../supabase/functions/_shared/adminCommandProtocol";
import type { AppCommandProduct, CommandApplyRequest, CommandPreview, CommandPreviewRequest, CommandResult } from "../../supabase/functions/_shared/adminCommandProtocol";
import { AdminApiError, requestAdmin } from "./transport";

export interface CommandClient {
  preview(command: CommandPreviewRequest, signal: AbortSignal, product?: AppCommandProduct): Promise<CommandPreview>;
  apply(command: CommandApplyRequest, preview: CommandPreview, signal: AbortSignal, product?: AppCommandProduct): Promise<CommandResult>;
}
async function invoke(command: CommandPreviewRequest | CommandApplyRequest, signal: AbortSignal, product: AppCommandProduct) {
  let request;
  try { request = parseAppCommand({ product, ...command }); }
  catch { throw new AdminApiError("invalid_request"); }
  return parseCommandEnvelope(await requestAdmin("platform-command", { product: request.product, ...request.command }, signal), request).data;
}
/** Access changes for CareBase and CareMetric Intel, each sent to its own application through the Hub server. */
export const commandClient: CommandClient = {
  preview: async (command, signal, product = "carebase") => await invoke(command, signal, product) as CommandPreview,
  apply: async (command, preview, signal, product = "carebase") => {
    const result = await invoke(command, signal, product) as CommandResult;
    if (result.commandId !== preview.commandId || result.action !== preview.action || result.targetId !== preview.targetId || JSON.stringify(result.changes) !== JSON.stringify(preview.changes)) throw new AdminApiError("upstream");
    return result;
  },
};
