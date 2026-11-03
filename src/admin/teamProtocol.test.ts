import { describe, expect, it } from "vitest";
import { actionLabel, cadenceLabel, centsLabel, decisionSchema, errorLabel, failedActionLabel, outcomeLabel, statusLabel, taskLabel, waitingSchema } from "./teamProtocol";

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
    expect(taskLabel("accounts.weekly")).toBe("Weekly account report");
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

  it("explains why an action could not be carried out, and shows an unknown code as it is", () => {
    expect(errorLabel("thread_changed")).toMatch(/customer wrote again/);
    expect(errorLabel("conversation_closed")).toBe("The conversation was closed, so nothing was sent.");
    expect(errorLabel("session_required")).toMatch(/Run what's waiting/);
    expect(errorLabel("delivery_unknown")).toMatch(/check the thread before sending again/);
    expect(errorLabel("brand_new_code")).toBe("brand_new_code");
    expect(errorLabel(null)).toBe("");
    expect(errorLabel(undefined)).toBe("");
  });

  it("explains a failed action as final: a lapsed sign-in there is not put right by Run what's waiting", () => {
    expect(failedActionLabel("session_required")).toBe("Your sign-in lapsed before the reply was sent, so nothing was sent. Sign in again and answer from the conversation.");
    expect(failedActionLabel("session_required")).not.toMatch(/Run what's waiting/);
    expect(failedActionLabel("thread_changed")).toBe(errorLabel("thread_changed"));
    expect(failedActionLabel("brand_new_code")).toBe("brand_new_code");
    expect(failedActionLabel(null)).toBe("");
  });

  it("accepts a decision with or without a failure code, and a count of both kinds of waiting work", () => {
    const decision = { id: "11111111-1111-4111-8111-111111111111", kind: "communication.reply", status: "failed", decided: true };
    expect(decisionSchema.parse(decision)).toEqual(decision);
    expect(decisionSchema.parse({ ...decision, error: "thread_changed" }).error).toBe("thread_changed");
    expect(decisionSchema.parse({ ...decision, status: "approved", needsSession: true }).needsSession).toBe(true);
    expect(decisionSchema.parse(decision).needsSession).toBeUndefined();
    expect(waitingSchema.parse({ started: 1, actions: 2 })).toEqual({ started: 1, actions: 2 });
    expect(() => waitingSchema.parse({ started: 1 })).toThrow();
  });

  it("names the Content Marketer's work and explains why an article was not published", () => {
    expect(taskLabel("content.weekly")).toBe("Weekly help article");
    expect(taskLabel("content.outreach")).toBe("Monthly outreach drafts");
    expect(actionLabel("content.publish")).toBe("Publish a help article");
    expect(errorLabel("slug_taken")).toMatch(/already uses this address/);
    expect(errorLabel("approval_required")).toMatch(/only with your approval/);
    expect(errorLabel("invalid_article")).toMatch(/content checks/);
    expect(errorLabel("product_unavailable")).toMatch(/retired or closed/);
    for (const code of ["invalid_article", "approval_required", "slug_taken", "product_unavailable", "publish_failed"]) {
      expect(failedActionLabel(code), code).toMatch(/not published|nothing was published|could not be published/);
    }
  });
});
