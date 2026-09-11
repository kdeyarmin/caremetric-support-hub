import type { OperationalAudit, OperationalJob, OperationalRelease } from "../../../supabase/functions/_shared/operationsProtocol";
export const job: OperationalJob = {
  jobKey: "fixture.job", displayName: "Fixture worker", description: "Synthetic worker for the test suite", schedule: null,
  executionKind: "worker", isCritical: false, retryMode: "manual", lastStatus: "never", lastAttemptAt: null, lastSuccessAt: null, nextExpectedAt: null,
  lastDurationMs: null, attemptedCount: null, succeededCount: null, failedCount: null, hasError: false, isStale: null, killSwitchEnabled: true, killSwitchCanStop: false,
};
export const release: OperationalRelease = {
  featureKey: "fixture.feature", displayName: "Fixture feature", description: "Synthetic definition", isActive: true,
  rolloutMode: "unconfigured", isEnabled: null, owner: null, expiresAt: null, updatedAt: null, globalKillSwitch: false, organizationKillSwitchCount: "0",
};
export const audit: OperationalAudit = {
  id: "a1000000-0000-4000-8000-000000000001", action: "fixture.read", entityType: "organization", entityId: null, organizationId: null,
  actorProfileId: null, actorSubjectId: null, createdAt: "2026-09-11T12:00:00.000Z",
};
