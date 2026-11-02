import { describe, expect, it } from "vitest";
import { actionLabel, cadenceLabel, centsLabel, outcomeLabel, statusLabel, taskLabel } from "./teamProtocol";

describe("AI team display", () => {
  it("shows money in whole cents", () => {
    expect(centsLabel(0)).toBe("$0.00");
    expect(centsLabel(50)).toBe("$0.50");
    expect(centsLabel(52.5)).toBe("$0.53");
    expect(centsLabel(100000)).toBe("$1000.00");
  });

  it("describes a schedule the way a person would say it", () => {
    const zone = "America/New_York";
    expect(cadenceLabel({ cadence: "daily", everySeconds: null, atLocal: "07:00:00", timezone: zone })).toBe("Daily at 7:00 AM Eastern");
    expect(cadenceLabel({ cadence: "daily", everySeconds: null, atLocal: "13:05:00", timezone: zone })).toBe("Daily at 1:05 PM Eastern");
    expect(cadenceLabel({ cadence: "daily", everySeconds: null, atLocal: "00:00:00", timezone: "UTC" })).toBe("Daily at 12:00 AM UTC");
    expect(cadenceLabel({ cadence: "daily", everySeconds: null, atLocal: "12:30:00", timezone: zone })).toBe("Daily at 12:30 PM Eastern");
    expect(cadenceLabel({ cadence: "interval", everySeconds: 300, atLocal: null, timezone: zone })).toBe("Every 5 minutes");
    expect(cadenceLabel({ cadence: "interval", everySeconds: 60, atLocal: null, timezone: zone })).toBe("Every minute");
    expect(cadenceLabel({ cadence: "interval", everySeconds: 1800, atLocal: null, timezone: zone })).toBe("Every 30 minutes");
    expect(cadenceLabel({ cadence: "interval", everySeconds: 3600, atLocal: null, timezone: zone })).toBe("Every hour");
    expect(cadenceLabel({ cadence: "interval", everySeconds: 7200, atLocal: null, timezone: zone })).toBe("Every 2 hours");
    expect(cadenceLabel({ cadence: "interval", everySeconds: 90, atLocal: null, timezone: zone })).toBe("Every 90 seconds");
  });

  it("names the work, the actions and the states in plain words, and falls back to the raw name", () => {
    expect(taskLabel("probe.sweep")).toBe("Health check");
    expect(taskLabel("seo.weekly")).toBe("Weekly SEO check");
    expect(taskLabel("some.new.kind")).toBe("some.new.kind");
    expect(actionLabel("communication.reply")).toBe("Reply to a customer");
    expect(actionLabel("future.action")).toBe("future.action");
    expect(statusLabel("awaiting_approval")).toBe("Waiting for approval");
    expect(statusLabel("proposed")).toBe("Waiting for approval");
    expect(statusLabel("suppressed")).toBe("Not sent (channel unavailable)");
    expect(statusLabel("surprise")).toBe("surprise");
    expect(outcomeLabel(null)).toBe("Running");
    expect(outcomeLabel("budget_exhausted")).toBe("Stopped at the daily budget");
    expect(outcomeLabel("new_outcome")).toBe("new_outcome");
  });
});
