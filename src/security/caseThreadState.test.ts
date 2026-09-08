import { describe, expect, it, vi } from "vitest";
import type { CaseMessage } from "../domain";
import {
  beginCaseThreadLoad,
  completeCaseThreadLoad,
  emptyCaseThread,
  failCaseThreadLoad,
  readCaseThread,
} from "./caseThreadState";

const message: CaseMessage = {
  id: "message-a",
  caseId: "case-a",
  authorId: "customer-a",
  authorName: "Customer",
  authorRole: "customer",
  visibility: "customer",
  body: "Initial message",
  createdAt: "2026-09-08T00:00:00Z",
};

describe("case thread read state", () => {
  it("surfaces an initial read failure with a retryable empty thread", () => {
    const loading = beginCaseThreadLoad(emptyCaseThread, "case-a");
    const failed = failCaseThreadLoad(loading, "case-a", new Error("Thread unavailable"));

    expect(failed).toMatchObject({
      caseId: "case-a",
      messages: [],
      status: "error",
      error: "Thread unavailable",
      stale: false,
    });
  });

  it("marks existing messages stale when a post-write refresh fails", () => {
    const ready = completeCaseThreadLoad(
      beginCaseThreadLoad(emptyCaseThread, "case-a"),
      "case-a",
      [message],
    );
    const loading = beginCaseThreadLoad(ready, "case-a");
    const failed = failCaseThreadLoad(
      loading,
      "case-a",
      new Error("Refresh failed"),
    );

    expect(loading).toMatchObject({ messages: [message], status: "loading", stale: true });
    expect(failed).toMatchObject({
      messages: [message],
      status: "error",
      stale: true,
    });
  });

  it("the read helper catches an initial rejection without an unhandled promise", async () => {
    const result = await readCaseThread({
      listMessages: vi.fn().mockRejectedValue(new Error("Thread unavailable")),
    }, "case-a");

    expect(result).toMatchObject({ caseId: "case-a", messages: null });
    expect(result.error).toBeInstanceOf(Error);
  });

  it("a retry performs one read and no write", async () => {
    const listMessages = vi.fn().mockResolvedValue([message]);
    const replyToCase = vi.fn();
    const loading = beginCaseThreadLoad(emptyCaseThread, "case-a");
    const result = await readCaseThread({ listMessages }, "case-a");
    const ready = result.messages
      ? completeCaseThreadLoad(loading, "case-a", result.messages)
      : failCaseThreadLoad(loading, "case-a", result.error);

    expect(ready.status).toBe("ready");
    expect(listMessages).toHaveBeenCalledOnce();
    expect(replyToCase).not.toHaveBeenCalled();
  });
});
