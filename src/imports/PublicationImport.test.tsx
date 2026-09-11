// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PublicationImport } from "./PublicationImport";
import { PublicationError, type PublicationClient } from "./publicationClient";
import { fixtureManifest, articleBytes } from "./publicationFixtures";
import { previewPublicationImport } from "./publicationImportPreview";
import { type PublicationStage } from "./publicationProtocol";
afterEach(cleanup);
async function fixture() {
  const manifest = await fixtureManifest();
  const plan = await previewPublicationImport({ manifest, assets: { primary: Uint8Array.from(articleBytes) }, existing: null });
  const stage: PublicationStage = { id: crypto.randomUUID(), expiresAt: new Date(Date.now() + 1800000).toISOString(), manifest, uploadedParts: [], plan: null };
  const ready = { ...stage, uploadedParts: ["primary"] as const, plan: { ...plan, actions: [
    { type: "replace_placement" as const, previousRevision: 1, revision: 2, productSlug: "carebase" as const, audience: ["all"] as "all"[], routePattern: null, requiresExplicitApproval: true as const },
    { type: "retire_preview" as const, revision: 1, productSlug: "breathe" as const, audience: ["all"] as "all"[], routePattern: null, requiresExplicitApproval: true as const },
  ] } };
  const client = {
    access: vi.fn(async () => ({ maxVideoBytes: 26214400 })),
    stage: vi.fn(async () => stage), upload: vi.fn(async () => ({ ...stage, uploadedParts: ["primary"] as "primary"[] })),
    preview: vi.fn(async () => ({ ...ready, uploadedParts: [...ready.uploadedParts] })),
    commit: vi.fn<PublicationClient["commit"]>(async (_id, request) => ({ importId: stage.id, itemId: crypto.randomUUID(), revisionId: crypto.randomUUID(), revision: 2, planIdentity: request.planIdentity, committedAt: new Date().toISOString(), outcome: "published" })),
  } satisfies PublicationClient;
  const manifestFile = new File([JSON.stringify(manifest)], "publication.json", { type: "application/json" });
  Object.defineProperty(manifestFile, "text", { value: async () => JSON.stringify(manifest) });
  const article = new File([Uint8Array.from(articleBytes)], "primary.md", { type: "text/markdown" });
  Object.defineProperty(article, "text", { value: async () => new TextDecoder().decode(articleBytes) });
  return { client, manifestFile, article, stage };
}
async function selectPackage(value: Awaited<ReturnType<typeof fixture>>) {
  await screen.findByLabelText("Publication manifest");
  fireEvent.change(screen.getByLabelText("Publication manifest"), { target: { files: [value.manifestFile] } });
  await screen.findByLabelText("Primary article or video");
  fireEvent.change(screen.getByLabelText("Primary article or video"), { target: { files: [value.article] } });
}
describe("DocStudio import review", () => {
  it("shows authorization failure without an import form", async () => {
    const value = await fixture(); value.client.access.mockRejectedValue(new PublicationError(403, "Permission revoked."));
    render(<MemoryRouter><PublicationImport client={value.client} /></MemoryRouter>);
    expect(await screen.findByText("Permission revoked.")).toBeTruthy();
    expect(screen.queryByLabelText("Publication manifest")).toBeNull(); expect(value.client.stage).not.toHaveBeenCalled();
  });
  it("requires Hub source approval before uploading anything", async () => {
    const value = await fixture(); render(<MemoryRouter><PublicationImport client={value.client} /></MemoryRouter>); await selectPackage(value);
    const verify = screen.getByRole("button", { name: "Verify package and preview changes" });
    expect((verify as HTMLButtonElement).disabled).toBe(true); expect(value.client.stage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(/I reviewed the source content/)); fireEvent.click(verify);
    await screen.findByText("2. Review the exact catalog changes");
    expect(value.client.stage).toHaveBeenCalledOnce(); expect(value.client.upload).toHaveBeenCalledOnce(); expect(value.client.commit).not.toHaveBeenCalled();
  });
  it("requires each placement confirmation and retries a lost commit response with the identical key", async () => {
    const value = await fixture(); value.client.commit.mockRejectedValueOnce(new Error("Connection lost"));
    render(<MemoryRouter><PublicationImport client={value.client} /></MemoryRouter>); await selectPackage(value);
    fireEvent.click(screen.getByLabelText(/I reviewed the source content/)); fireEvent.click(screen.getByRole("button", { name: "Verify package and preview changes" }));
    await screen.findByText("2. Review the exact catalog changes");
    const commit = screen.getByRole("button", { name: "Commit reviewed publication" });
    fireEvent.click(screen.getByLabelText(/I approve this exact revision/));
    fireEvent.click(screen.getByLabelText("Replace carebase placement with revision 2"));
    expect((commit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Retire the breathe placement")); fireEvent.click(commit);
    await waitFor(() => expect(value.client.commit).toHaveBeenCalledOnce());
    expect(await screen.findByText("The publication result could not be confirmed. Retry the same publication to retrieve its result.")).toBeTruthy();
    const retry = await screen.findByRole("button", { name: "Retry the same publication" });
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByLabelText("Retire the breathe placement") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(retry); await screen.findByText("Publication complete");
    expect(value.client.commit.mock.calls[1]?.[1]).toEqual(value.client.commit.mock.calls[0]?.[1]);
    expect(value.client.commit.mock.calls[0]?.[1].confirmedActions).toEqual(["0:replace_placement", "1:retire_preview"]);
  });
  it("does not manufacture a preview when storage is unavailable", async () => {
    const value = await fixture(); value.client.upload.mockRejectedValue(new PublicationError(503, "Storage unavailable."));
    render(<MemoryRouter><PublicationImport client={value.client} /></MemoryRouter>); await selectPackage(value);
    fireEvent.click(screen.getByLabelText(/I reviewed the source content/)); fireEvent.click(screen.getByRole("button", { name: "Verify package and preview changes" }));
    expect(await screen.findByText("Storage unavailable.")).toBeTruthy(); expect(value.client.preview).not.toHaveBeenCalled(); expect(value.client.commit).not.toHaveBeenCalled();
    expect(screen.queryByText("2. Review the exact catalog changes")).toBeNull();
  });
});
