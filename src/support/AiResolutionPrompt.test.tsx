// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubRepository } from "../domain";
import { AiResolutionPrompt } from "./AiResolutionPrompt";

afterEach(cleanup);

const caseId = "44444444-4444-4444-8444-444444444444";

function fakeRepo(stage: string): HubRepository {
  return {
    respondToAiResolution: vi.fn(async () => ({ stage })),
  } as unknown as HubRepository;
}

describe("AiResolutionPrompt", () => {
  it("records a fixed answer with an idempotency key and confirms resolution", async () => {
    const repo = fakeRepo("resolved");
    const onChanged = vi.fn();
    render(<AiResolutionPrompt caseId={caseId} repo={repo} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: /That fixed it/ }));
    await waitFor(() => expect(screen.getByText(/now resolved/)).toBeTruthy());
    const call = (repo.respondToAiResolution as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe(caseId);
    expect(call[1]).toBe(true);
    expect(call[2]).toMatch(/^[0-9a-f-]{36}$/);
    expect(onChanged).toHaveBeenCalled();
  });

  it("records a not-fixed answer and keeps the case with support", async () => {
    const repo = fakeRepo("attempt_due");
    render(<AiResolutionPrompt caseId={caseId} repo={repo} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Still not fixed/ }));
    await waitFor(() => expect(screen.getByText(/keep working on it/)).toBeTruthy());
    const call = (repo.respondToAiResolution as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]).toBe(false);
  });
});
