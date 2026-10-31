import { requestAdmin } from "./transport";
import { parseAdvisorCommand, parseAdvisorCommandResult, type AdvisorCommand, type AdvisorCommandResult } from "../../supabase/functions/_shared/advisorsCommands";

/** Sends one change to a Healthcare Advisors consultation request and checks Advisors' answer against it. */
export async function changeAdvisorRequest(command: AdvisorCommand, signal: AbortSignal): Promise<AdvisorCommandResult> {
  const checked = parseAdvisorCommand(command);
  return parseAdvisorCommandResult(await requestAdmin("advisors-command", checked, signal), checked);
}
