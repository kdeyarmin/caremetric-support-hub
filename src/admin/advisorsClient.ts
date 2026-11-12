import { AdminApiError, requestAdmin } from "./transport";
import { parseAdvisorChangeResult, parseAdvisorCommand, type AdvisorCommand, type AdvisorCommandResult } from "../../supabase/functions/_shared/advisorsCommands";

/** Sends one change to a Healthcare Advisors consultation request and checks the Hub's answer against it. */
export async function changeAdvisorRequest(command: AdvisorCommand, signal: AbortSignal): Promise<AdvisorCommandResult> {
  // A change the Hub would refuse is reported as such, not as Advisors failing to answer.
  let checked: AdvisorCommand;
  try { checked = parseAdvisorCommand(command); }
  catch { throw new AdminApiError("invalid_request"); }
  return parseAdvisorChangeResult(await requestAdmin("advisors-command", checked, signal), checked);
}
