import { isUuid } from "./adminProtocol.ts";

/** Operational metadata only. These operations never authorize a native mutation. */
export const operationalReadOperations = ["operations.jobs.list", "operations.releases.list", "operations.audit.list"] as const;
export type OperationalReadName = typeof operationalReadOperations[number];
export interface OperationalReadOperation { operation: OperationalReadName; search: string; limit: number; offset: number; }
export interface OperationalPage<T> { items: T[]; total: number; limit: number; offset: number; }
export interface OperationalJob {
  jobKey: string; displayName: string; description: string; schedule: string | null;
  executionKind: "sql_cron" | "edge_cron" | "worker" | "external"; isCritical: boolean;
  retryMode: "automatic" | "manual" | "none";
  lastStatus: "never" | "queued" | "starting" | "sending" | "connecting" | "running" | "succeeded" | "partial" | "failed" | "cancelled";
  lastAttemptAt: string | null; lastSuccessAt: string | null; nextExpectedAt: string | null;
  lastDurationMs: string | null; attemptedCount: string | null; succeededCount: string | null; failedCount: string | null;
  hasError: boolean; isStale: boolean | null; killSwitchEnabled: boolean; killSwitchCanStop: boolean;
}
export interface OperationalRelease {
  featureKey: string; displayName: string; description: string; isActive: boolean;
  rolloutMode: "off" | "cohort" | "global" | "unconfigured"; isEnabled: boolean | null;
  owner: string | null; expiresAt: string | null; updatedAt: string | null;
  globalKillSwitch: boolean; organizationKillSwitchCount: string;
}
export interface OperationalAudit {
  id: string; action: string; entityType: string; entityId: string | null;
  organizationId: string | null; actorProfileId: string | null; actorSubjectId: string | null; createdAt: string;
}
export type OperationalRow = OperationalJob | OperationalRelease | OperationalAudit;
const invalid = (): never => { throw new Error("Invalid operational read contract"); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function keys(row: Record<string, unknown>, names: string[]) {
  if (Object.keys(row).length !== names.length || names.some(name => !Object.hasOwn(row, name))) invalid();
}
const text = (value: unknown, max: number): string => typeof value === "string" && value.length <= max ? value : invalid();
const nullableText = (value: unknown, max: number) => value === null ? null : text(value, max);
const boolean = (value: unknown): boolean => typeof value === "boolean" ? value : invalid();
const nullableBoolean = (value: unknown) => value === null ? null : boolean(value);
const id = (value: unknown): string => isUuid(value) ? value.toLowerCase() : invalid();
const nullableId = (value: unknown) => value === null ? null : id(value);
/** Never convert native bigint text to Number. Preserve the producer's exact decimal contract. */
const decimal = (value: unknown): string => typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) ? value : invalid();
const nullableDecimal = (value: unknown) => value === null ? null : decimal(value);
function timestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 100 || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) return invalid();
  return new Date(value).toISOString();
}
const nullableTimestamp = (value: unknown) => value === null ? null : timestamp(value);
function member<T extends string>(value: unknown, values: readonly T[]): T {
  return values.includes(value as T) ? value as T : invalid();
}
export const isOperationalRead = (value: unknown): value is OperationalReadName => operationalReadOperations.includes(value as OperationalReadName);
export function parseOperationalRead(input: unknown): OperationalReadOperation {
  const row = object(input);
  if (!isOperationalRead(row.operation) || Object.keys(row).some(key => !["operation", "limit", "offset", "search"].includes(key))) return invalid();
  const { limit = 25, offset = 0, search = "" } = row;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 50
    || typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000
    || typeof search !== "string" || search.length > 100 || [...search].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === "*")) return invalid();
  return { operation: row.operation, limit, offset, search: search.trim() };
}
function job(value: unknown): OperationalJob {
  const row = object(value);
  keys(row, ["jobKey", "displayName", "description", "schedule", "executionKind", "isCritical", "retryMode", "lastStatus", "lastAttemptAt", "lastSuccessAt", "nextExpectedAt", "lastDurationMs", "attemptedCount", "succeededCount", "failedCount", "hasError", "isStale", "killSwitchEnabled", "killSwitchCanStop"]);
  return { jobKey: text(row.jobKey, 200), displayName: text(row.displayName, 500), description: text(row.description, 10000), schedule: nullableText(row.schedule, 200),
    executionKind: member(row.executionKind, ["sql_cron", "edge_cron", "worker", "external"]), isCritical: boolean(row.isCritical),
    retryMode: member(row.retryMode, ["automatic", "manual", "none"]), lastStatus: member(row.lastStatus, ["never", "queued", "starting", "sending", "connecting", "running", "succeeded", "partial", "failed", "cancelled"]),
    lastAttemptAt: nullableTimestamp(row.lastAttemptAt), lastSuccessAt: nullableTimestamp(row.lastSuccessAt), nextExpectedAt: nullableTimestamp(row.nextExpectedAt),
    lastDurationMs: nullableDecimal(row.lastDurationMs), attemptedCount: nullableDecimal(row.attemptedCount), succeededCount: nullableDecimal(row.succeededCount), failedCount: nullableDecimal(row.failedCount),
    hasError: boolean(row.hasError), isStale: nullableBoolean(row.isStale), killSwitchEnabled: boolean(row.killSwitchEnabled), killSwitchCanStop: boolean(row.killSwitchCanStop) };
}
function release(value: unknown): OperationalRelease {
  const row = object(value);
  keys(row, ["featureKey", "displayName", "description", "isActive", "rolloutMode", "isEnabled", "owner", "expiresAt", "updatedAt", "globalKillSwitch", "organizationKillSwitchCount"]);
  const mode = member(row.rolloutMode, ["off", "cohort", "global", "unconfigured"]);
  if (mode === "unconfigured" ? [row.isEnabled, row.owner, row.expiresAt, row.updatedAt].some(value => value !== null) : row.isEnabled === null) invalid();
  return { featureKey: text(row.featureKey, 100), displayName: text(row.displayName, 120), description: text(row.description, 10000), isActive: boolean(row.isActive),
    rolloutMode: mode, isEnabled: nullableBoolean(row.isEnabled), owner: nullableText(row.owner, 500), expiresAt: nullableTimestamp(row.expiresAt), updatedAt: nullableTimestamp(row.updatedAt),
    globalKillSwitch: boolean(row.globalKillSwitch), organizationKillSwitchCount: decimal(row.organizationKillSwitchCount) };
}
function audit(value: unknown): OperationalAudit {
  const row = object(value);
  keys(row, ["id", "action", "entityType", "entityId", "organizationId", "actorProfileId", "actorSubjectId", "createdAt"]);
  return { id: id(row.id), action: text(row.action, 300), entityType: text(row.entityType, 300), entityId: nullableText(row.entityId, 500),
    organizationId: nullableId(row.organizationId), actorProfileId: nullableId(row.actorProfileId), actorSubjectId: nullableText(row.actorSubjectId, 500), createdAt: timestamp(row.createdAt) };
}
export function parseOperationalPage(input: unknown, operation: OperationalReadOperation): OperationalPage<OperationalRow> {
  const row = object(input);
  keys(row, ["items", "total", "limit", "offset"]);
  if (!Array.isArray(row.items) || row.items.length > operation.limit || row.limit !== operation.limit || row.offset !== operation.offset
    || typeof row.total !== "number" || !Number.isSafeInteger(row.total) || row.total < 0 || row.items.length > Math.max(0, row.total - operation.offset)) return invalid();
  const project = operation.operation === "operations.jobs.list" ? job : operation.operation === "operations.releases.list" ? release : operation.operation === "operations.audit.list" ? audit : invalid();
  const items: OperationalRow[] = row.items.map(value => project(value));
  const ids = items.map(item => "jobKey" in item ? item.jobKey : "featureKey" in item ? item.featureKey : item.id);
  if (new Set(ids).size !== items.length) invalid();
  return { items, total: row.total, limit: operation.limit, offset: operation.offset };
}
