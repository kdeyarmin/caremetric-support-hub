import { isUuid } from "./adminProtocol.ts";

export const commandActions = ["users.setActive", "organizations.setSuspension"] as const;
export type CommandAction = typeof commandActions[number];
export type CommandParameters = { active: boolean } | { suspended: boolean };
export interface CommandPreviewRequest { operation: "preview"; requestId: string; action: CommandAction; targetId: string; parameters: CommandParameters; reason: string; }
export interface CommandApplyRequest { operation: "apply"; commandId: string; expectedDigest: string; }
export type CommandRequest = CommandPreviewRequest | CommandApplyRequest;
export interface PortfolioCommandRequest { product: "carebase"; command: CommandRequest; }
/** Applications whose access the Hub can change. Each has its own native command endpoint and capability audience (server/delegations.mjs). */
export const appCommandProducts = ["carebase", "intel"] as const;
export type AppCommandProduct = typeof appCommandProducts[number];
export interface AppCommandRequest { product: AppCommandProduct; command: CommandRequest; }
/** What each application accepts: CareBase changes profiles and organizations by UUID; Intel changes accounts, named by 24-hex ids. */
const appCommandRules: Record<AppCommandProduct, { actions: readonly CommandAction[]; targetId: (value: unknown) => string }> = {
  carebase: { actions: commandActions, targetId: value => id(value) },
  intel: { actions: ["users.setActive"], targetId: value => { if (typeof value !== "string" || !/^[0-9a-f]{24}$/.test(value)) throw new Error("Invalid command identifier"); return value; } },
};
export interface CommandChange { field: "active" | "status" | "billingState" | "stateSource" | "compedUntil"; before: string | null; after: string | null; }
export interface CommandPreview { commandId: string; action: CommandAction; targetId: string; reason: string; expiresAt: string; previewDigest: string; changes: CommandChange[]; }
export interface CommandResult { commandId: string; action: CommandAction; targetId: string; appliedAt: string; replayed: boolean; changes: CommandChange[]; }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid command contract");
  return value as Record<string, unknown>;
}
function closed(row: Record<string, unknown>, fields: string[]) {
  if (Object.keys(row).some(field => !fields.includes(field))) throw new Error("Unsupported command parameter");
}
function id(value: unknown): string { if (!isUuid(value)) throw new Error("Invalid command identifier"); return value.toLowerCase(); }
function digest(value: unknown): string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid command digest"); return value; }
function text(value: unknown, max = 500): string { if (typeof value !== "string" || value.length > max) throw new Error("Invalid command field"); return value; }
function timestamp(value: unknown): string { const result = text(value, 100); if (!Number.isFinite(Date.parse(result))) throw new Error("Invalid command time"); return result; }
function boolean(value: unknown): boolean { if (typeof value !== "boolean") throw new Error("Invalid command value"); return value; }
function action(value: unknown): CommandAction { if (!commandActions.includes(value as CommandAction)) throw new Error("Unsupported command"); return value as CommandAction; }

export function parsePortfolioCommand(input: unknown): PortfolioCommandRequest {
  // CareBase only: the platform-command Edge function sends whatever this accepts to CareBase's command endpoint.
  const row = object(input);
  if ((row.product ?? "carebase") !== "carebase") throw new Error("Unsupported application command");
  return parseAppCommand(row) as PortfolioCommandRequest;
}

/** A change to one application's access, for the Hub server's own route. */
export function parseAppCommand(input: unknown): AppCommandRequest {
  const row = object(input);
  const { product = "carebase", ...command } = row;
  if (!appCommandProducts.includes(product as AppCommandProduct)) throw new Error("Unsupported application command");
  const rules = appCommandRules[product as AppCommandProduct];
  if (command.operation === "apply") {
    closed(command, ["operation", "commandId", "expectedDigest"]);
    return { product: product as AppCommandProduct, command: { operation: "apply", commandId: id(command.commandId), expectedDigest: digest(command.expectedDigest) } };
  }
  if (command.operation !== "preview") throw new Error("Unsupported command operation");
  closed(command, ["operation", "requestId", "action", "targetId", "parameters", "reason"]);
  const commandAction = action(command.action);
  if (!rules.actions.includes(commandAction)) throw new Error("Unsupported command");
  const rawReason = text(command.reason);
  const reason = rawReason.trim();
  if (reason.length < 10 || Array.from(rawReason).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error("Provide a concise reason between 10 and 500 characters");
  const parameters = object(command.parameters);
  let parsedParameters: CommandParameters;
  if (commandAction === "users.setActive") { closed(parameters, ["active"]); parsedParameters = { active: boolean(parameters.active) }; }
  else { closed(parameters, ["suspended"]); parsedParameters = { suspended: boolean(parameters.suspended) }; }
  return { product: product as AppCommandProduct, command: { operation: "preview", requestId: id(command.requestId), action: commandAction, targetId: rules.targetId(command.targetId), parameters: parsedParameters, reason } };
}

function changes(value: unknown): CommandChange[] {
  const fields = ["active", "status", "billingState", "stateSource", "compedUntil"];
  if (!Array.isArray(value) || value.length > fields.length) throw new Error("Invalid command changes");
  const projected = value.map(item => {
    const row = object(item);
    if (!fields.includes(String(row.field))) throw new Error("Unreviewed command field");
    return { field: row.field as CommandChange["field"], before: row.before === null ? null : text(row.before), after: row.after === null ? null : text(row.after) };
  });
  if (new Set(projected.map(value => value.field)).size !== projected.length) throw new Error("Duplicate command field");
  return projected;
}

export function parseCommandEnvelope(input: unknown, request: AppCommandRequest) {
  const envelope = object(input);
  const { command } = request;
  if (envelope.contractVersion !== 1 || envelope.product !== request.product || envelope.operation !== command.operation) throw new Error("Mismatched command response");
  const generatedAt = timestamp(envelope.generatedAt);
  const row = object(envelope.data);
  const common = { commandId: id(row.commandId), action: action(row.action), targetId: appCommandRules[request.product].targetId(row.targetId), changes: changes(row.changes) };
  let data: CommandPreview | CommandResult;
  if (command.operation === "preview") {
    if (common.action !== command.action || common.targetId !== command.targetId || row.reason !== command.reason) throw new Error("Mismatched command preview");
    const expiresAt = timestamp(row.expiresAt);
    if (Date.parse(expiresAt) <= Date.parse(generatedAt) || Date.parse(expiresAt) > Date.parse(generatedAt) + 301000) throw new Error("Invalid preview lifetime");
    data = { ...common, reason: text(row.reason), expiresAt, previewDigest: digest(row.previewDigest) };
  } else {
    if (common.commandId !== command.commandId) throw new Error("Mismatched applied command");
    data = { ...common, appliedAt: timestamp(row.appliedAt), replayed: boolean(row.replayed) };
  }
  return { contractVersion: 1 as const, product: request.product, operation: command.operation, generatedAt, data };
}
