import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { prepareMutationRequest } from "./mutationRequestKey";

const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

describe("mutation request keys", () => {
  it("reuses one key when an unchanged payload is retried", () => {
    const createRequestKey = vi.fn()
      .mockReturnValueOnce("10000000-0000-4000-8000-000000000001");
    const payload = ["create-case", "tenant-1", "product-1", "Cannot sign in", false] as const;

    const firstAttempt = prepareMutationRequest(null, payload, createRequestKey);
    const retry = prepareMutationRequest(firstAttempt, [...payload], createRequestKey);

    expect(retry).toBe(firstAttempt);
    expect(retry.requestKey).toBe("10000000-0000-4000-8000-000000000001");
    expect(createRequestKey).toHaveBeenCalledOnce();
  });

  it("rotates the key when any exact payload value changes", () => {
    const createRequestKey = vi.fn()
      .mockReturnValueOnce("10000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("10000000-0000-4000-8000-000000000002");
    const firstAttempt = prepareMutationRequest(
      null,
      ["reply-to-case", "case-1", "Please try again", "customer"],
      createRequestKey,
    );

    const changed = prepareMutationRequest(
      firstAttempt,
      ["reply-to-case", "case-1", "Please try again.", "customer"],
      createRequestKey,
    );

    expect(changed.requestKey).toBe("10000000-0000-4000-8000-000000000002");
    expect(changed).not.toBe(firstAttempt);
    expect(createRequestKey).toHaveBeenCalledTimes(2);
  });

  it("creates a fresh key for the same payload after success clears pending state", () => {
    const createRequestKey = vi.fn()
      .mockReturnValueOnce("10000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("10000000-0000-4000-8000-000000000002");
    const payload = ["reply-to-case", "case-1", "Resolved", "customer"] as const;
    const firstAction = prepareMutationRequest(null, payload, createRequestKey);

    const nextAction = prepareMutationRequest(null, payload, createRequestKey);

    expect(nextAction.requestKey).not.toBe(firstAction.requestKey);
    expect(createRequestKey).toHaveBeenCalledTimes(2);
  });

  it("distinguishes primitive types and whitespace exactly", () => {
    const createRequestKey = vi.fn()
      .mockReturnValueOnce("10000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("10000000-0000-4000-8000-000000000002")
      .mockReturnValueOnce("10000000-0000-4000-8000-000000000003");
    const first = prepareMutationRequest(null, ["action", "false"], createRequestKey);
    const typedChange = prepareMutationRequest(first, ["action", false], createRequestKey);
    const whitespaceChange = prepareMutationRequest(typedChange, ["action", " false"], createRequestKey);

    expect(new Set([first.requestKey, typedChange.requestKey, whitespaceChange.requestKey]).size).toBe(3);
  });

  it("distinguishes negative zero from zero", () => {
    const createRequestKey = vi.fn()
      .mockReturnValueOnce("10000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("10000000-0000-4000-8000-000000000002");
    const negativeZero = prepareMutationRequest(null, ["numeric", -0], createRequestKey);
    const zero = prepareMutationRequest(negativeZero, ["numeric", 0], createRequestKey);

    expect(zero).not.toBe(negativeZero);
    expect(zero.requestKey).not.toBe(negativeZero.requestKey);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite numeric payload part %s",
    (value) => {
      expect(() => prepareMutationRequest(null, ["numeric", value])).toThrow(
        /numbers must be finite/,
      );
    },
  );

  it("remounts the reply form when the selected case changes", () => {
    expect(appSource).toMatch(/<CaseDetail\s+key=\{selected\.id\}\s+supportCase=\{selected\}/);
    expect(appSource).toContain("thread={thread.caseId === selected.id ? thread.messages : []}");
  });

  it("catches case-thread read failures and exposes a read-only retry", () => {
    expect(appSource).toContain("readCaseThread(repository, selectedId)");
    expect(appSource).toContain("failCaseThreadLoad(beginCaseThreadLoad(current, result.caseId)");
    expect(appSource).toContain('role="alert"');
    expect(appSource).toMatch(/onRetryThread=\{\(\) => \{[\s\S]*?beginCaseThreadLoad[\s\S]*?setRefresh/);
    expect(appSource).toMatch(/onChanged=\{\(\) => \{[\s\S]*?beginCaseThreadLoad[\s\S]*?reloadCases/);
    expect(appSource).toContain("requestId !== caseListRequest.current");
    expect(appSource).toContain("setSelectedId((currentId) => reconcileCaseSelection");
  });
});
