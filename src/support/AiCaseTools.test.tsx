// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiNotConfiguredError } from "../data/supabaseRepository";
import type { HubRepository } from "../domain";
import { AiCaseTools } from "./AiCaseTools";

afterEach(cleanup);

const caseId = "44444444-4444-4444-8444-444444444444";

function fakeRepo(overrides: Partial<HubRepository> = {}): HubRepository {
  return {
    summarizeCase: vi.fn(async () => "Customer cannot export; a guide suggests splitting by month."),
    draftCaseReply: vi.fn(async () => "Try splitting the export by month."),
    suggestCaseTriage: vi.fn(async () => ({ category: "technical_issue" as const, priority: "high" as const })),
    ...overrides,
  } as unknown as HubRepository;
}

describe("AiCaseTools", () => {
  it("shows the generated summary", async () => {
    const repo = fakeRepo();
    render(<AiCaseTools caseId={caseId} repo={repo} onDraft={() => {}} onApplyPriority={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Summarize/ }));
    await waitFor(() => expect(screen.getByText(/Customer cannot export/)).toBeTruthy());
    expect(repo.summarizeCase).toHaveBeenCalledWith(caseId);
  });

  it("hands the draft to the reply box instead of sending it", async () => {
    const repo = fakeRepo();
    const onDraft = vi.fn();
    render(<AiCaseTools caseId={caseId} repo={repo} onDraft={onDraft} onApplyPriority={() => {}} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Highest-quality draft/ }));
    fireEvent.click(screen.getByRole("button", { name: /Draft reply/ }));
    await waitFor(() => expect(onDraft).toHaveBeenCalledWith("Try splitting the export by month."));
    expect(repo.draftCaseReply).toHaveBeenCalledWith(caseId, "quality");
  });

  it("applies a triage priority only through the normal update callback", async () => {
    const repo = fakeRepo();
    const onApplyPriority = vi.fn();
    render(<AiCaseTools caseId={caseId} repo={repo} onDraft={() => {}} onApplyPriority={onApplyPriority} />);
    fireEvent.click(screen.getByRole("button", { name: /Suggest triage/ }));
    await waitFor(() => expect(screen.getByText(/Suggested priority/)).toBeTruthy());
    expect(screen.getByText(/Technical issue/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Apply priority/ }));
    expect(onApplyPriority).toHaveBeenCalledWith("high");
  });

  it("shows friendly copy when AI is not configured", async () => {
    const repo = fakeRepo({ summarizeCase: vi.fn(async () => { throw new AiNotConfiguredError(); }) });
    render(<AiCaseTools caseId={caseId} repo={repo} onDraft={() => {}} onApplyPriority={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Summarize/ }));
    await waitFor(() => expect(screen.getByText(/AI assistance isn.t set up yet/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Summarize/ })).toBeNull();
  });
});
