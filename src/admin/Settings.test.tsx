// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Settings } from "./Settings";
import { fieldText, fieldValue } from "./settingsFields";
import { SettingsApiError, settingsViewSchema } from "./settingsClient";
import type { HubSetting, SettingsClient, SettingsView } from "./settingsClient";

afterEach(cleanup);

const version = "2026-11-09T10:00:00.000001+00:00";
const base = { default: null, value: null, effective: null, source: "default", variableSet: false, changedAt: version } as const;
const chat: HubSetting = { ...base, key: "support.chat", label: "Website chat", help: "Shows the chat panel on every Help page.", input: "toggle", default: false, value: true, effective: true, source: "copied", variable: "HUB_CHAT_ENABLED", variableSet: true };
const agents: HubSetting = { ...base, key: "agents.enabled", label: "Run the AI team", help: "Runs the scheduler.", input: "toggle", default: false, effective: false, variable: "HUB_AGENTS_ENABLED" };
const owner: HubSetting = { ...base, key: "agents.owner_email", label: "Your email for alerts and the daily summary", help: "Where the AI team emails alerts.", input: "email", variable: "HUB_OWNER_EMAIL" };
const tier: HubSetting = { ...base, key: "support.ai_draft_tier", label: "AI answer quality", help: "Which model drafts answers.", input: "choice", default: "draft", effective: "draft", variable: "HUB_AI_DRAFT_TIER",
  choices: [{ value: "draft", label: "Standard (faster, lower cost)" }, { value: "quality", label: "Best quality (slower, higher cost)" }] };
const budget: HubSetting = { ...base, key: "social.max_daily_budget_cents", label: "Most any ad may spend per day", help: "The cap.", input: "cents", min: 1, max: 10000000, variable: "HUB_SOCIAL_AD_MAX_DAILY_BUDGET_CENTS" };
const images: HubSetting = { ...base, key: "social.image_urls", label: "Approved brand images", help: "One per line.", input: "lines", default: [], effective: ["https://a.test/1.png"], value: ["https://a.test/1.png"], source: "hub", variable: "HUB_SOCIAL_IMAGE_URLS" };
const view = (editable = true, overrides: Partial<Record<string, Partial<HubSetting>>> = {}): SettingsView => settingsViewSchema.parse({
  editable,
  groups: [
    { id: "agents", label: "AI team", description: "Whether the AI team runs.", settings: [agents, owner].map(item => ({ ...item, ...overrides[item.key] })) },
    { id: "support", label: "Customer support", description: "Chat and AI help.", settings: [chat, tier].map(item => ({ ...item, ...overrides[item.key] })) },
    { id: "social", label: "Social media", description: "Pages and ads.", settings: [budget, images].map(item => ({ ...item, ...overrides[item.key] })) },
  ],
});
function fakeClient(first: SettingsView = view()) {
  const client = { view: vi.fn(async () => first), save: vi.fn<SettingsClient["save"]>(async () => view()) };
  return client as typeof client & SettingsClient;
}
const show = (client: SettingsClient) => render(<MemoryRouter><Settings client={client} /></MemoryRouter>);

describe("the Settings page", () => {
  it("shows every group with switches, values and where each came from", async () => {
    show(fakeClient());
    expect(await screen.findByRole("heading", { name: "AI team" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Website chat" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "Run the AI team" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Copied in from the Railway variable HUB_CHAT_ENABLED. HUB_CHAT_ENABLED is still set in Railway but is no longer read: you can delete it.")).toBeTruthy();
    expect(screen.getByText("Not set: the default applies (off).")).toBeTruthy();
    expect(screen.getByText("Saved here.")).toBeTruthy();
    expect((screen.getByLabelText("AI answer quality") as HTMLSelectElement).value).toBe("draft");
    // A choice still on its default has nothing to save.
    const tierRow = screen.getByLabelText("AI answer quality").closest("li")!;
    expect((within(tierRow).getByRole("button", { name: /^Save/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("switches a setting with one click, quoting the version it was read at", async () => {
    const client = fakeClient();
    show(client);
    fireEvent.click(await screen.findByRole("switch", { name: "Run the AI team" }));
    await waitFor(() => expect(client.save).toHaveBeenCalledWith({ key: "agents.enabled", value: true, expectedChangedAt: version }));
    expect(await screen.findByText("Run the AI team is on. It applies within a minute.")).toBeTruthy();
  });

  it("saves a typed value, and clears one back to its default", async () => {
    const client = fakeClient();
    show(client);
    const email = await screen.findByLabelText("Your email for alerts and the daily summary");
    const row = email.closest("li")!;
    expect((within(row).getByRole("button", { name: /^Save/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(email, { target: { value: " owner@caremetric.test " } });
    fireEvent.click(within(row).getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(client.save).toHaveBeenCalledWith({ key: "agents.owner_email", value: "owner@caremetric.test", expectedChangedAt: version }));
    expect(await screen.findByText("Your email for alerts and the daily summary is saved. It applies within a minute.")).toBeTruthy();
    const list = screen.getByLabelText("Approved brand images").closest("li")!;
    fireEvent.click(within(list).getByRole("button", { name: /^Use default/ }));
    await waitFor(() => expect(client.save).toHaveBeenLastCalledWith({ key: "social.image_urls", value: null, expectedChangedAt: version }));
  });

  it("takes amounts in dollars and saves cents", async () => {
    const client = fakeClient();
    show(client);
    const amount = await screen.findByLabelText("Most any ad may spend per day");
    fireEvent.change(amount, { target: { value: "25.50" } });
    fireEvent.click(within(amount.closest("li")!).getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(client.save).toHaveBeenCalledWith({ key: "social.max_daily_budget_cents", value: 2550, expectedChangedAt: version }));
  });

  it("is read-only until the settings migration is applied", async () => {
    const client = fakeClient(view(false, { "support.chat": { source: "railway", changedAt: null, variableSet: true } }));
    show(client);
    expect(await screen.findByText(/Read-only for now: apply the settings migration/)).toBeTruthy();
    expect((screen.getByRole("switch", { name: "Website chat" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Your email for alerts and the daily summary") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("Read from the Railway variable HUB_CHAT_ENABLED.")).toBeTruthy();
  });

  it("shows the server's words when a save is refused, and reads the settings again after a stale screen", async () => {
    const client = fakeClient();
    client.save.mockRejectedValueOnce(new SettingsApiError(409, "This setting changed. Refresh and review again."));
    show(client);
    fireEvent.click(await screen.findByRole("switch", { name: "Website chat" }));
    expect(await screen.findByText("This setting changed. Refresh and review again.")).toBeTruthy();
    await waitFor(() => expect(client.view).toHaveBeenCalledTimes(2));
  });
});

describe("settings fields", () => {
  it("turns field text into values and back", () => {
    expect(fieldValue(budget, "$1,250")).toBe(125000);
    expect(fieldValue(budget, "0")).toBeUndefined();
    expect(fieldValue(budget, " ")).toBeNull();
    expect(fieldText(budget, 2500)).toBe("25");
    expect(fieldText(budget, 2550)).toBe("25.50");
    expect(fieldValue(images, " https://a.test/1.png \n\n https://a.test/2.png ")).toEqual(["https://a.test/1.png", "https://a.test/2.png"]);
    expect(fieldValue(images, "\n")).toBeNull();
    const hours: HubSetting = { ...base, key: "support.ai_follow_up_hours", label: "Follow up after", help: "Hours.", input: "number", min: 1, max: 720, default: 24, effective: 24, variable: "HUB_AI_FOLLOW_UP_DELAY_HOURS" };
    expect(fieldValue(hours, "48")).toBe(48);
    expect(fieldValue(hours, "0")).toBeUndefined();
    expect(fieldValue(hours, "1.5")).toBeUndefined();
  });
});
