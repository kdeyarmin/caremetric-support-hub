// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { GoLiveReadiness } from "./GoLiveReadiness";
import type { ReadinessClient } from "./readinessClient";
import type { GoLiveReadinessReport } from "./readinessProtocol";

// DOM tests inject every data client; initialize the app's ordinary explicit preview configuration.
vi.hoisted(() => { vi.stubEnv("VITE_DEMO_MODE", "true"); });
afterEach(cleanup);

const stillNeeded: GoLiveReadinessReport = {
  checkedAt: "2026-10-17T20:00:00.000Z",
  migrations: {
    complete: false,
    items: [
      { version: "20261015120000", name: "AI case assistance", applied: false },
      { version: "20261015120100", name: "AI case assistance contract", applied: false },
    ],
  },
  anthropicKey: { present: false },
  aiAutomation: { enabled: false },
  helpDomain: { hostname: "help.caremetric.ai", resolves: false, targets: [] },
};

const allDone: GoLiveReadinessReport = {
  checkedAt: "2026-10-17T20:00:00.000Z",
  migrations: {
    complete: true,
    items: [
      { version: "20261015120000", name: "AI case assistance", applied: true },
      { version: "20261015120100", name: "AI case assistance contract", applied: true },
    ],
  },
  anthropicKey: { present: true },
  aiAutomation: { enabled: true },
  helpDomain: { hostname: "help.caremetric.ai", resolves: true, targets: ["support-hub-web-production.up.railway.app"] },
};

function fakeReadiness(report: GoLiveReadinessReport): ReadinessClient {
  return { report: vi.fn<ReadinessClient["report"]>(async () => report) };
}

describe("go-live readiness panel", () => {
  it("shows all four prerequisites as still needed when none are satisfied", async () => {
    render(<MemoryRouter><GoLiveReadiness readiness={fakeReadiness(stillNeeded)} /></MemoryRouter>);
    const migrations = await screen.findByRole("region", { name: "Production migrations" });
    expect(within(migrations).getByText("Still needed")).toBeTruthy();
    expect(within(migrations).getByText(/20261015120000/)).toBeTruthy();
    expect(within(migrations).getByText(/20261015120100/)).toBeTruthy();
    expect(within(migrations).getAllByText("Not applied")).toHaveLength(2);

    const key = screen.getByRole("region", { name: "Anthropic API key" });
    expect(within(key).getByText("Still needed")).toBeTruthy();
    expect(within(key).getByText(/No key is configured/)).toBeTruthy();

    const automation = screen.getByRole("region", { name: "AI automation" });
    expect(within(automation).getByText("Still needed")).toBeTruthy();
    expect(within(automation).getByText(/Automation is off/)).toBeTruthy();

    const domain = screen.getByRole("region", { name: "Help domain" });
    expect(within(domain).getByText("Still needed")).toBeTruthy();
    expect(within(domain).getByText(/does not resolve yet/)).toBeTruthy();
    expect(within(domain).getByText(/support-hub-web-production\.up\.railway\.app/)).toBeTruthy();
  });

  it("shows each prerequisite done separately when all are satisfied, including what the domain resolves to", async () => {
    render(<MemoryRouter><GoLiveReadiness readiness={fakeReadiness(allDone)} /></MemoryRouter>);
    const migrations = await screen.findByRole("region", { name: "Production migrations" });
    expect(within(migrations).getAllByText("Applied")).toHaveLength(2);
    for (const name of ["Production migrations", "Anthropic API key", "AI automation", "Help domain"]) {
      expect(within(screen.getByRole("region", { name })).getByText("Done")).toBeTruthy();
    }
    const domain = screen.getByRole("region", { name: "Help domain" });
    expect(within(domain).getByText(/resolves to support-hub-web-production\.up\.railway\.app/)).toBeTruthy();
    const key = screen.getByRole("region", { name: "Anthropic API key" });
    expect(within(key).getByText(/presence only/)).toBeTruthy();
  });

  it("keeps the four statuses independent in a mixed state", async () => {
    const mixed: GoLiveReadinessReport = {
      ...stillNeeded,
      migrations: {
        complete: false,
        items: [
          { version: "20261015120000", name: "AI case assistance", applied: true },
          { version: "20261015120100", name: "AI case assistance contract", applied: false },
        ],
      },
      anthropicKey: { present: true },
    };
    render(<MemoryRouter><GoLiveReadiness readiness={fakeReadiness(mixed)} /></MemoryRouter>);
    const migrations = await screen.findByRole("region", { name: "Production migrations" });
    expect(within(migrations).getByText("Still needed")).toBeTruthy();
    expect(within(migrations).getByText("Applied")).toBeTruthy();
    expect(within(migrations).getByText("Not applied")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Anthropic API key" })).getByText("Done")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "AI automation" })).getByText("Still needed")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Help domain" })).getByText("Still needed")).toBeTruthy();
  });
});
