/** The go-live readiness report served by the Hub server at view time. The
 * Anthropic key is represented by presence only; no part of the key ever
 * crosses this protocol. */
export interface ReadinessMigration {
  version: string;
  name: string;
  applied: boolean;
}

export interface GoLiveReadinessReport {
  checkedAt: string;
  migrations: { complete: boolean; items: ReadinessMigration[] };
  anthropicKey: { present: boolean };
  aiAutomation: { enabled: boolean };
  helpDomain: { hostname: string; resolves: boolean; targets: string[] };
}

const check = (valid: unknown) => { if (!valid) throw new Error("Go-live readiness response mismatch."); };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export function parseReadinessReport(value: unknown): GoLiveReadinessReport {
  check(isRecord(value));
  const report = value as Record<string, unknown>;
  check(isString(report.checkedAt) && !Number.isNaN(Date.parse(report.checkedAt as string)));

  check(isRecord(report.migrations));
  const migrations = report.migrations as Record<string, unknown>;
  check(isBoolean(migrations.complete) && Array.isArray(migrations.items) && migrations.items.length > 0);
  for (const item of migrations.items as unknown[]) {
    check(isRecord(item));
    const migration = item as Record<string, unknown>;
    check(isString(migration.version) && isString(migration.name) && isBoolean(migration.applied));
  }
  check(migrations.complete === (migrations.items as ReadinessMigration[]).every(item => item.applied));

  check(isRecord(report.anthropicKey) && isBoolean((report.anthropicKey as Record<string, unknown>).present));
  check(Object.keys(report.anthropicKey as Record<string, unknown>).length === 1);
  check(isRecord(report.aiAutomation) && isBoolean((report.aiAutomation as Record<string, unknown>).enabled));

  check(isRecord(report.helpDomain));
  const helpDomain = report.helpDomain as Record<string, unknown>;
  check(isString(helpDomain.hostname) && isBoolean(helpDomain.resolves)
    && Array.isArray(helpDomain.targets) && helpDomain.targets.every(isString));
  check(helpDomain.resolves === (helpDomain.targets as string[]).length > 0);

  return value as GoLiveReadinessReport;
}
