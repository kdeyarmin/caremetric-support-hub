import { requestAdmin } from "./transport";
import { parseAdvisorChangeResult, parseAdvisorCommand, type AdvisorCommand, type AdvisorCommandResult } from "../../supabase/functions/_shared/advisorsCommands";

/** Sends one change to a Healthcare Advisors consultation request and checks the Hub's answer against it. */
export async function changeAdvisorRequest(command: AdvisorCommand, signal: AbortSignal): Promise<AdvisorCommandResult> {
  const checked = parseAdvisorCommand(command);
  return parseAdvisorChangeResult(await requestAdmin("advisors-command", checked, signal), checked);
}
