// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import fixture from "../imports/fixtures/governedCourse.json";
import { validateGovernedCourse } from "../imports/governedLearningImport";
import { AdminApiError } from "../admin/transport";
import type { PackageClient } from "./packageClient";
import { PackageDependencyPanel } from "./PackageDependencyPanel";
afterEach(cleanup);
const course = "c3000000-0000-4000-8000-000000000001", version = "c3000000-0000-4000-8000-000000000002";
const source = "c3000000-0000-4000-8000-000000000003", accepted = "c3000000-0000-4000-8000-000000000004", pending = "c3000000-0000-4000-8000-000000000005";
const pkg = (id: string, validationStatus: string, standard = "scorm_1_2") => ({ id, standard, contentSha256: "a".repeat(64), entryPoint: "index.html", manifest: {},
  capabilities: [], connectivityMode: "online_only", validationStatus });
const material = validateGovernedCourse({ ...fixture, sourceVersionState: "draft", packages: [pkg(accepted, "accepted"), pkg(pending, "pending"), pkg("c3000000-0000-4000-8000-000000000006", "accepted", "xapi")] });
const row = { sourcePackageId: source, sourceSha256: "b".repeat(64), standard: "scorm_1_2", replacementPackageId: null, resolved: false };
function setup(resolve: PackageClient["resolve"]) {
  let resolved = false;
  const client: PackageClient = { available: vi.fn(), context: vi.fn(), status: vi.fn(), stage: vi.fn(), finish: vi.fn(), resolve: vi.fn(async (op, signal) => { const value = await resolve(op, signal); resolved = true; return value; }),
    dependencies: vi.fn(async () => [resolved ? { ...row, replacementPackageId: accepted, resolved: true } : row]) };
  const onResolved = vi.fn();
  render(<PackageDependencyPanel courseId={course} versionId={version} material={material} disabled={false} onResolved={onResolved} client={client} />);
  return { client, onResolved };
}
it("offers only accepted packages of the same standard and resolves each dependency", async () => {
  const { client, onResolved } = setup(async op => ({ versionId: op.versionId, sourcePackageId: op.sourcePackageId, replacementPackageId: op.replacementPackageId, replacementSha256: "c".repeat(64) }));
  const choice = await screen.findByLabelText("Replacement") as HTMLSelectElement;
  expect([...choice.options].map(option => option.value)).toEqual(["", accepted]);
  fireEvent.change(choice, { target: { value: accepted } });
  fireEvent.click(screen.getByRole("button", { name: "Use this replacement" }));
  await screen.findByText("Every package dependency is resolved. Load the course versions to preview publication.");
  expect(client.resolve).toHaveBeenCalledWith({ operation: "resolve", courseId: course, versionId: version, sourcePackageId: source, replacementPackageId: accepted }, expect.anything());
  expect(onResolved).toHaveBeenCalled();
});
it("explains an ineligible replacement and keeps the dependency open", async () => {
  const { onResolved } = setup(async () => { throw new AdminApiError("conflict"); });
  fireEvent.change(await screen.findByLabelText("Replacement"), { target: { value: accepted } });
  fireEvent.click(screen.getByRole("button", { name: "Use this replacement" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/not an eligible replacement/);
  expect(screen.getByText(/Needs a replacement/)).not.toBeNull();
  expect(onResolved).not.toHaveBeenCalled();
});
