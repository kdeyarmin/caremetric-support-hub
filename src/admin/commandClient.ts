import { parseCommandEnvelope, parsePortfolioCommand } from "../../supabase/functions/_shared/adminCommandProtocol";
import type { CommandApplyRequest, CommandPreview, CommandPreviewRequest, CommandResult } from "../../supabase/functions/_shared/adminCommandProtocol";
import { AdminApiError, requestAdmin } from "./transport";

export interface CommandClient {
  preview(command: CommandPreviewRequest, signal: AbortSignal): Promise<CommandPreview>;
  apply(command: CommandApplyRequest, preview: CommandPreview, signal: AbortSignal): Promise<CommandResult>;
}
async function invoke(command: CommandPreviewRequest | CommandApplyRequest, signal: AbortSignal) {
  let request;
  try { request = parsePortfolioCommand({ product: "carebase", ...command }); }
  catch { throw new AdminApiError("invalid_request"); }
  return parseCommandEnvelope(await requestAdmin("platform-command", { product: request.product, ...request.command }, signal), request).data;
}
export const commandClient: CommandClient = {
  preview: async (command, signal) => await invoke(command, signal) as CommandPreview,
  apply: async (command, preview, signal) => {
    const result = await invoke(command, signal) as CommandResult;
    if (result.commandId !== preview.commandId || result.action !== preview.action || result.targetId !== preview.targetId || JSON.stringify(result.changes) !== JSON.stringify(preview.changes)) throw new AdminApiError("upstream");
    return result;
  },
};
