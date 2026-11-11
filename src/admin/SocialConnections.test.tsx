// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SocialConnections } from "./SocialConnections";
import { SettingsApiError } from "./settingsClient";
import { socialConnectionsSchema } from "./socialConnectionsClient";
import type { SocialConnectionsClient, SocialConnectionsView } from "./socialConnectionsClient";

afterEach(cleanup);
const changedAt = "2026-11-11T06:00:00Z";
const view: SocialConnectionsView = { editable: true, message: null, connections: [
  { provider: "meta", revision: "12345678-1111-4111-8111-111111111111", fields: { pageId: { value: "123", changedAt }, instagramId: { value: "", changedAt }, adAccountId: { value: "", changedAt } }, secrets: { token: true } },
  { provider: "linkedin", revision: "12345678-1111-4111-8111-222222222222", fields: { organizationId: { value: "456", changedAt }, adAccountId: { value: "", changedAt }, clientId: { value: "", changedAt }, adsClientId: { value: "", changedAt } }, secrets: { token: false, clientSecret: false, refreshToken: false, adsToken: false, adsRefreshToken: false, adsClientSecret: false } },
] };
const client = () => ({ view: vi.fn<SocialConnectionsClient["view"]>(async () => structuredClone(view)), save: vi.fn<SocialConnectionsClient["save"]>(async () => ({ saved: true })), check: vi.fn<SocialConnectionsClient["check"]>(async () => ({ ok: true, message: "Read access verified. No content was published." })) });

it("masks credentials, saves both account and token, clears the entered token and checks the saved connection", async () => {
  const api = client(); render(<SocialConnections client={api} />);
  const token = await screen.findByLabelText("Meta API access token");
  expect(token.getAttribute("type")).toBe("password");
  expect((token as HTMLInputElement).value).toBe("");
  fireEvent.change(token, { target: { value: "test-only-meta-token-123456789" } });
  fireEvent.change(screen.getByLabelText("Facebook Page ID or profile link"), { target: { value: "https://www.facebook.com/profile.php?id=789" } });
  const form = screen.getByRole("form", { name: "Meta connection" });
  expect((within(form).getByRole("button", { name: /^Check saved/ }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(form).getByRole("button", { name: /^Save and check/ }));
  await waitFor(() => expect(api.save).toHaveBeenCalledWith({ provider: "meta", revision: view.connections[0].revision,
    fields: { ...view.connections[0].fields, pageId: { value: "https://www.facebook.com/profile.php?id=789", changedAt } }, secrets: { token: "test-only-meta-token-123456789" } }));
  expect(await screen.findByText("Saved securely. Read access verified. No content was published.")).toBeTruthy();
  expect((token as HTMLInputElement).value).toBe("");
  expect(api.check).toHaveBeenCalledWith("meta");
  expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
});

it("keeps an unchanged saved token and supports explicit removal", async () => {
  const api = client(); render(<SocialConnections client={api} />);
  const form = await screen.findByRole("form", { name: "Meta connection" });
  fireEvent.click(within(form).getByRole("button", { name: /^Save and check/ }));
  await waitFor(() => expect(api.check).toHaveBeenCalledTimes(1));
  expect(api.save.mock.calls[0][0].secrets).toEqual({});
  fireEvent.click(screen.getByLabelText("Remove saved meta api access token on save"));
  fireEvent.click(within(form).getByRole("button", { name: /^Save and check/ }));
  await waitFor(() => expect(api.save).toHaveBeenCalledTimes(2));
  expect(api.save.mock.calls[1][0].secrets).toEqual({ token: null });
});

it("distinguishes saved details from a failed check and invalidates results when inputs change", async () => {
  const api = client(); api.check.mockResolvedValue({ ok: false, message: "Page permissions are missing." });
  render(<SocialConnections client={api} />);
  fireEvent.click(await screen.findByRole("button", { name: "Save and check Meta" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Saved securely. Page permissions are missing.");
  fireEvent.change(screen.getByLabelText("Facebook Page ID or profile link"), { target: { value: "789" } });
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps secrets hidden after a committed save even if the read-back fails", async () => {
  const api = client(); api.view.mockResolvedValueOnce(structuredClone(view)).mockRejectedValue(new Error("offline"));
  render(<SocialConnections client={api} />);
  const token = await screen.findByLabelText("Meta API access token");
  fireEvent.change(token, { target: { value: "test-only-token-123456789" } });
  fireEvent.click(screen.getByRole("button", { name: "Save and check Meta" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Your details were saved"));
  expect((token as HTMLInputElement).value).toBe(""); expect(api.check).not.toHaveBeenCalled();
});

it("shows a stale or expired-session failure without falsely reporting a save", async () => {
  const api = client(); api.save.mockRejectedValue(new SettingsApiError(409, "This connection changed. Refresh and review again."));
  render(<SocialConnections client={api} />);
  fireEvent.click(await screen.findByRole("button", { name: "Save and check Meta" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "This connection changed. Refresh and review again.");
  expect(api.check).not.toHaveBeenCalled();
});

it("rejects a server response that contains a secret value", () => {
  const unsafe = structuredClone(view); Object.assign(unsafe.connections[0].secrets, { token: "must-never-be-returned" });
  expect(() => socialConnectionsSchema.parse(unsafe)).toThrow();
});

it.each([
  ["Meta", "Facebook Page ID or profile link"],
  ["LinkedIn", "LinkedIn Company Page ID or admin link"],
])("blocks %s sign-in details before credentials reach the server", async (provider, label) => {
  const api = client(); render(<SocialConnections client={api} />);
  const page = await screen.findByLabelText(label);
  fireEvent.change(page, { target: { value: "owner@example.test" } });
  fireEvent.change(screen.getByLabelText(`${provider} API access token`), { target: { value: "synthetic-password-not-a-token" } });
  fireEvent.click(screen.getByRole("button", { name: `Save and check ${provider}` }));
  expect(screen.getByRole("alert").textContent).toContain("That looks like an email address");
  expect(page.getAttribute("aria-invalid")).toBe("true");
  expect(document.activeElement).toBe(page);
  expect(api.save).not.toHaveBeenCalled(); expect(api.check).not.toHaveBeenCalled();
  fireEvent.change(page, { target: { value: "123456" } });
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: `Save and check ${provider}` }));
  await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
});

it("keeps credential storage separate from verified access and clears verification on edit", async () => {
  const api = client(); render(<SocialConnections client={api} />);
  const form = await screen.findByRole("form", { name: "Meta connection" });
  expect(within(form).getByText("API credential saved · access not verified")).toBeTruthy();
  api.check.mockResolvedValueOnce({ ok: false, message: "Meta rejected the API token." });
  fireEvent.click(within(form).getByRole("button", { name: "Check saved connection Meta" }));
  expect(await within(form).findByText("Connection needs attention")).toBeTruthy();
  expect(within(form).queryByText("Read access verified")).toBeNull();
  fireEvent.click(within(form).getByRole("button", { name: "Check saved connection Meta" }));
  expect(await within(form).findByText("Read access verified")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Facebook Page ID or profile link"), { target: { value: "789" } });
  expect(within(form).queryByText("Read access verified")).toBeNull();
});
