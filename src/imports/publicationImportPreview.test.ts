import { describe, expect, it } from "vitest";
import {
  PUBLICATION_PRODUCT_SLUGS,
  previewPublicationImport,
  type PublicationCatalogSnapshot,
  type PublicationImportPreviewInput,
  type PublicationManifest,
} from "./publicationImportPreview";

const encoder = new TextEncoder();

async function digest(bytes: Uint8Array): Promise<string> {
  const result = await globalThis.crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function articleInput(): Promise<PublicationImportPreviewInput> {
  const primary = encoder.encode("# Invite a teammate\n\nUse the Team page to send an invitation.\n");
  const manifest: PublicationManifest = {
    schema_version: "caremetric.support-hub.publication.v1",
    source_system: "docstudio",
    source: {
      content_key: "shared.invite-team-member",
      version: "docstudio-v7",
    },
    content: {
      kind: "article",
      title: "Invite a teammate",
      summary: "A reusable administrator walkthrough for inviting a teammate.",
      locale: "en-US",
      access_level: "customer",
    },
    artifact: {
      sha256: await digest(primary),
      media_type: "text/markdown",
      byte_length: primary.byteLength,
    },
    governance: {
      review_state: "approved",
      phi_review: "passed",
      approved_at: "2026-09-07T16:30:00Z",
      policy_version: "docstudio-phi-free-v1",
    },
    placements: [
      {
        product_slug: "caremetric-emr",
        audience: ["customer-admin"],
        route_pattern: "/admin/team/**",
      },
    ],
  };
  return { manifest, assets: { primary }, existing: null };
}

function matchingSnapshot(
  input: PublicationImportPreviewInput,
  revisionIdentity: string,
  artifactIdentity: string,
): PublicationCatalogSnapshot {
  return {
    contentKey: input.manifest.source.content_key,
    approvedNextSourceVersion: null,
    revisions: [
      {
        revision: 1,
        sourceVersion: input.manifest.source.version,
        revisionIdentity,
        artifactIdentity,
        state: "published",
        placements: input.manifest.placements.map((placement) => ({
          ...placement,
          audience: [...placement.audience],
          state: "active",
        })),
      },
    ],
  };
}

describe("publication import preview", () => {
  it("uses exactly the six registered CareMetric product slugs", () => {
    expect(PUBLICATION_PRODUCT_SLUGS).toEqual([
      "breathe",
      "carebase",
      "caremetric-emr",
      "caremetric-go",
      "caremetric-intel",
      "pennsync",
    ]);
  });

  it("builds an immutable create-and-place preview without writes or deletes", async () => {
    const input = await articleInput();
    const plan = await previewPublicationImport(input);

    expect(plan.actions.map((action) => action.type)).toEqual(["create", "place"]);
    expect(plan.artifactIdentity).toBe(`sha256:${input.manifest.artifact.sha256}`);
    expect(plan.revisionIdentity).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(plan.baseSnapshotIdentity).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(plan.planIdentity).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(plan.writesPerformed).toBe(false);
    expect(plan.deletesPlanned).toBe(0);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.actions)).toBe(true);
  });

  it("is deterministic and returns a no-op for an identical published revision", async () => {
    const initialInput = await articleInput();
    const initial = await previewPublicationImport(initialInput);
    const existing = matchingSnapshot(initialInput, initial.revisionIdentity, initial.artifactIdentity);
    const input = { ...initialInput, existing };

    const first = await previewPublicationImport(input);
    const second = await previewPublicationImport(input);

    expect(first).toEqual(second);
    expect(first.baseSnapshotIdentity).not.toBe(initial.baseSnapshotIdentity);
    expect(first.actions).toEqual([
      {
        type: "no_op",
        revision: 1,
        reason: "identical_revision_and_placements",
      },
    ]);
  });

  it("canonicalizes equivalent catalog placement order before hashing the snapshot", async () => {
    const input = await articleInput();
    const initial = await previewPublicationImport(input);
    const existing = matchingSnapshot(input, initial.revisionIdentity, initial.artifactIdentity);
    existing.revisions[0]!.placements.push({
      product_slug: "pennsync",
      audience: ["customer-admin"],
      route_pattern: "/team/**",
      state: "active",
    });
    const reversed = structuredClone(existing);
    reversed.revisions[0]!.placements.reverse();

    const forwardPlan = await previewPublicationImport({ ...input, existing });
    const reversedPlan = await previewPublicationImport({ ...input, existing: reversed });

    expect(reversedPlan.baseSnapshotIdentity).toBe(forwardPlan.baseSnapshotIdentity);
    expect(reversedPlan.planIdentity).toBe(forwardPlan.planIdentity);
    expect(reversedPlan.actions).toEqual(forwardPlan.actions);
  });

  it("plans a new immutable revision and previews retirement of the old placement", async () => {
    const originalInput = await articleInput();
    const originalPlan = await previewPublicationImport(originalInput);
    const existing = matchingSnapshot(
      originalInput,
      originalPlan.revisionIdentity,
      originalPlan.artifactIdentity,
    );
    const revisedInput = await articleInput();
    revisedInput.manifest.source.version = "docstudio-v8";
    existing.approvedNextSourceVersion = "docstudio-v8";
    revisedInput.existing = existing;

    const plan = await previewPublicationImport(revisedInput);

    expect(plan.targetRevision).toBe(2);
    expect(plan.actions.map((action) => action.type)).toEqual([
      "new_immutable_revision",
      "replace_placement",
    ]);
    expect(plan.actions.at(1)).toMatchObject({
      type: "replace_placement",
      previousRevision: 1,
      revision: 2,
      requiresExplicitApproval: true,
    });
    expect(plan.actions.some((action) => (action.type as string) === "delete")).toBe(false);
  });

  it("requires explicit content reactivation when a new approved revision revives retired content", async () => {
    const originalInput = await articleInput();
    const originalPlan = await previewPublicationImport(originalInput);
    const existing = matchingSnapshot(
      originalInput,
      originalPlan.revisionIdentity,
      originalPlan.artifactIdentity,
    );
    existing.revisions[0]!.state = "retired";
    existing.revisions[0]!.placements[0]!.state = "retired";
    existing.approvedNextSourceVersion = "docstudio-v8";

    const revisedInput = await articleInput();
    revisedInput.manifest.source.version = "docstudio-v8";
    revisedInput.existing = existing;

    const plan = await previewPublicationImport(revisedInput);

    expect(plan.actions).toEqual([
      expect.objectContaining({
        type: "new_immutable_revision",
        previousRevision: 1,
        revision: 2,
      }),
      {
        type: "reactivate_content_preview",
        previousRevision: 1,
        revision: 2,
        requiresExplicitApproval: true,
      },
      {
        type: "replace_placement",
        previousRevision: 1,
        revision: 2,
        productSlug: "caremetric-emr",
        audience: ["customer-admin"],
        routePattern: "/admin/team/**",
        requiresExplicitApproval: true,
      },
    ]);
  });

  it("plans placement additions and only previews placement removals", async () => {
    const initialInput = await articleInput();
    const initialPlan = await previewPublicationImport(initialInput);
    const existing = matchingSnapshot(
      initialInput,
      initialPlan.revisionIdentity,
      initialPlan.artifactIdentity,
    );
    existing.revisions[0]?.placements.push({
      product_slug: "pennsync",
      audience: ["customer-admin"],
      route_pattern: "/team/**",
      state: "active",
    });
    initialInput.existing = existing;

    const retirePlan = await previewPublicationImport(initialInput);
    expect(retirePlan.actions).toEqual([
      {
        type: "retire_preview",
        revision: 1,
        productSlug: "pennsync",
        audience: ["customer-admin"],
        routePattern: "/team/**",
        requiresExplicitApproval: true,
      },
    ]);

    const addInput = await articleInput();
    addInput.existing = matchingSnapshot(
      addInput,
      initialPlan.revisionIdentity,
      initialPlan.artifactIdentity,
    );
    addInput.manifest.placements.push({
      product_slug: "pennsync",
      audience: ["customer-admin"],
      route_pattern: "/team/**",
    });
    const addPlan = await previewPublicationImport(addInput);
    expect(addPlan.actions).toEqual([
      {
        type: "place",
        revision: 1,
        productSlug: "pennsync",
        audience: ["customer-admin"],
        routePattern: "/team/**",
      },
    ]);
  });

  it("previews retirement of every placement and the content item without deleting history", async () => {
    const input = await articleInput();
    const initial = await previewPublicationImport(input);
    input.existing = matchingSnapshot(input, initial.revisionIdentity, initial.artifactIdentity);
    input.manifest.placements = [];

    const plan = await previewPublicationImport(input);
    expect(plan.actions).toEqual([
      {
        type: "retire_preview",
        revision: 1,
        productSlug: "caremetric-emr",
        audience: ["customer-admin"],
        routePattern: "/admin/team/**",
        requiresExplicitApproval: true,
      },
      {
        type: "retire_content_preview",
        revision: 1,
        requiresExplicitApproval: true,
      },
    ]);
    expect(plan.deletesPlanned).toBe(0);
  });

  it("rejects new content with no product placement", async () => {
    const input = await articleInput();
    input.manifest.placements = [];

    await expect(previewPublicationImport(input)).rejects.toThrow(/requires at least one/);
  });

  it("plans a transactional replacement when a product placement changes", async () => {
    const input = await articleInput();
    const initial = await previewPublicationImport(input);
    input.existing = matchingSnapshot(input, initial.revisionIdentity, initial.artifactIdentity);
    input.manifest.placements[0]!.route_pattern = "/admin/users/**";

    const plan = await previewPublicationImport(input);
    expect(plan.actions).toEqual([
      {
        type: "replace_placement",
        previousRevision: 1,
        revision: 1,
        productSlug: "caremetric-emr",
        audience: ["customer-admin"],
        routePattern: "/admin/users/**",
        requiresExplicitApproval: true,
      },
    ]);
  });

  it("accepts all registered placements but rejects any seventh or unknown product", async () => {
    const allProducts = await articleInput();
    allProducts.manifest.placements = PUBLICATION_PRODUCT_SLUGS.map((product_slug) => ({
      product_slug,
      audience: ["customer-admin"],
      route_pattern: null,
    }));
    const plan = await previewPublicationImport(allProducts);
    expect(plan.actions.filter((action) => action.type === "place")).toHaveLength(6);

    const unknown = await articleInput();
    Object.assign(unknown.manifest.placements[0] ?? {}, { product_slug: "docstudio" });
    await expect(previewPublicationImport(unknown)).rejects.toThrow(
      /must be a registered Support Hub product/,
    );
  });

  it("uses the same content-key grammar as the catalog database", async () => {
    for (const invalidKey of ["a..b", "a--b", "a.-b", "a-.b"]) {
      const input = await articleInput();
      input.manifest.source.content_key = invalidKey;
      await expect(previewPublicationImport(input)).rejects.toThrow(
        /manifest\.source\.content_key: has an invalid format/,
      );
    }
  });

  it("rejects unknown identity, tenant, URL, and PHI-shaped data", async () => {
    const unknownField = await articleInput();
    Object.assign(unknownField.manifest, { tenant_id: "tenant-one" });
    await expect(previewPublicationImport(unknownField)).rejects.toThrow(
      /forbidden or unknown field.*tenant_id/,
    );

    const url = await articleInput();
    url.manifest.content.summary = "Open https://private.example.test to continue.";
    await expect(previewPublicationImport(url)).rejects.toThrow(/web URLs are not permitted/);

    const phiMetadata = await articleInput();
    phiMetadata.manifest.content.summary = "Enter the patient ID to continue.";
    await expect(previewPublicationImport(phiMetadata)).rejects.toThrow(/identifier labels/);

    const phiBody = await articleInput();
    phiBody.assets.primary = encoder.encode("# Example\n\nMedical record number: 001122\n");
    phiBody.manifest.artifact.sha256 = await digest(phiBody.assets.primary);
    phiBody.manifest.artifact.byte_length = phiBody.assets.primary.byteLength;
    await expect(previewPublicationImport(phiBody)).rejects.toThrow(/PHI identifier labels/);
  });

  it("verifies declared lengths and SHA-256 before planning", async () => {
    const wrongLength = await articleInput();
    wrongLength.manifest.artifact.byte_length += 1;
    await expect(previewPublicationImport(wrongLength)).rejects.toThrow(/byte length does not match/);

    const wrongDigest = await articleInput();
    wrongDigest.manifest.artifact.sha256 = "0".repeat(64);
    await expect(previewPublicationImport(wrongDigest)).rejects.toThrow(/SHA-256 digest does not match/);

    const oversizedDeclaration = await articleInput();
    oversizedDeclaration.manifest.artifact.byte_length = 2 * 1024 * 1024 + 1;
    await expect(previewPublicationImport(oversizedDeclaration)).rejects.toThrow(/no greater than 2097152/);
  });

  it("verifies MP4 identity plus declared caption and transcript sidecars", async () => {
    const primary = new Uint8Array([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
      0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    ]);
    const captions = encoder.encode(
      "WEBVTT\n\nNOTE reviewed caption track\n\nintro\n00:00.000 --> 00:01.000\nWelcome\n",
    );
    const transcript = encoder.encode("Welcome to the Team page.\n");
    const input = await articleInput();
    input.manifest.content.kind = "video";
    input.manifest.artifact = {
      sha256: await digest(primary),
      media_type: "video/mp4",
      byte_length: primary.byteLength,
      duration_ms: 1000,
      captions_sha256: await digest(captions),
      transcript_sha256: await digest(transcript),
    };
    input.assets = { primary, captions, transcript };

    await expect(previewPublicationImport(input)).resolves.toMatchObject({
      mode: "preview",
      writesPerformed: false,
    });

    input.assets.transcript = encoder.encode("Tampered transcript\n");
    await expect(previewPublicationImport(input)).rejects.toThrow(/SHA-256 digest does not match/);
  });

  it("requires both caption and transcript sidecars for every video preview", async () => {
    const primary = new Uint8Array([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
      0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    ]);
    const input = await articleInput();
    input.manifest.content.kind = "video";
    input.manifest.artifact = {
      sha256: await digest(primary),
      media_type: "video/mp4",
      byte_length: primary.byteLength,
      duration_ms: 1000,
    };
    input.assets = { primary };

    await expect(previewPublicationImport(input)).rejects.toThrow(/captions_sha256/);
  });

  it("requires captions to contain a forward, non-note WebVTT cue with payload", async () => {
    const primary = new Uint8Array([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
      0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    ]);
    const transcript = encoder.encode("Welcome to the Team page.\n");
    for (const captionText of [
      "WEBVTT\n\nWelcome without timing\n",
      "WEBVTT\n\n00:01.000 --> 00:00.000\nReversed\n",
      "WEBVTT\n\nNOTE\n00:00.000 --> 00:01.000\nNot a cue\n",
      "WEBVTT\n\n00:00.000 --> 00:01.000\n",
      "WEBVTT\n\n00:10.000 --> 00:11.000\nOutside the media\n",
    ]) {
      const captions = encoder.encode(captionText);
      const input = await articleInput();
      input.manifest.content.kind = "video";
      input.manifest.artifact = {
        sha256: await digest(primary),
        media_type: "video/mp4",
        byte_length: primary.byteLength,
        duration_ms: 1000,
        captions_sha256: await digest(captions),
        transcript_sha256: await digest(transcript),
      };
      input.assets = { primary, captions, transcript };

      await expect(previewPublicationImport(input)).rejects.toThrow(/timed WebVTT cue/);
    }
  });

  it("rejects malformed WebVTT blocks even when another cue is valid", async () => {
    const primary = new Uint8Array([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
      0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    ]);
    const transcript = encoder.encode("Welcome to the Team page.\n");
    for (const captionText of [
      "WEBVTT\n\n00:00.000 --> 00:00.500\nWelcome\n\nOrphan caption text\n",
      "WEBVTT\n00:00.000 --> 00:00.500\nDropped first cue\n\n00:00.500 --> 00:01.000\nSecond cue\n",
      "WEBVTT\n\ncue-id\nunexpected line\n00:00.000 --> 00:01.000\nLate timing\n",
      "WEBVTT\n\n00:00.000 --> 00:00.500 --> 00:01.000\nAmbiguous timing\n",
      "WEBVTT\n\n00:00.000 --> 00:01.001\nPast the media duration\n",
    ]) {
      const captions = encoder.encode(captionText);
      const input = await articleInput();
      input.manifest.content.kind = "video";
      input.manifest.artifact = {
        sha256: await digest(primary),
        media_type: "video/mp4",
        byte_length: primary.byteLength,
        duration_ms: 1000,
        captions_sha256: await digest(captions),
        transcript_sha256: await digest(transcript),
      };
      input.assets = { primary, captions, transcript };

      await expect(previewPublicationImport(input)).rejects.toThrow(/WEBVTT|timed WebVTT cue/);
    }
  });

  it("rejects executable markup and Markdown destinations in text artifacts", async () => {
    for (const body of [
      "# Unsafe\n\n<script>alert('x')</script>\n",
      "# Unsafe\n\n[Open the page](javascript:alert(1))\n",
      "# Unsafe\n\n![Embedded image](data:image/svg+xml,unsafe)\n",
      "# Unsafe\n\n[relative link](/private/record)\n",
      "# Unsafe\n\nfile:///etc/passwd\n",
      "# Unsafe\n\ngopher://private.example.test/resource\n",
      "# Unsafe\n\nx://private.example.test/resource\n",
      "# Unsafe\n\n(//private.example.test/resource)\n",
      "# Unsafe\n\nintent://private.example.test/resource\n",
      `# Unsafe\n\n[${"x".repeat(501)}](relative/path)\n`,
      `# Unsafe\n\n[${"x".repeat(201)}]: relative/path\n`,
    ]) {
      const input = await articleInput();
      input.assets.primary = encoder.encode(body);
      input.manifest.artifact.sha256 = await digest(input.assets.primary);
      input.manifest.artifact.byte_length = input.assets.primary.byteLength;
      await expect(previewPublicationImport(input)).rejects.toThrow(
        /HTML|URL schemes|URI schemes|protocol-relative destinations|Markdown links and images|Markdown link definitions/,
      );
    }
  });

  it("fails closed on source rollback and same-version content mutation", async () => {
    const originalInput = await articleInput();
    const originalPlan = await previewPublicationImport(originalInput);
    const existing = matchingSnapshot(
      originalInput,
      originalPlan.revisionIdentity,
      originalPlan.artifactIdentity,
    );
    existing.approvedNextSourceVersion = "docstudio-v8";

    const rollback = await articleInput();
    rollback.manifest.source.version = "docstudio-v6";
    rollback.existing = existing;
    await expect(previewPublicationImport(rollback)).rejects.toThrow(/approved next source version/);

    const mutated = await articleInput();
    mutated.manifest.content.summary = "Changed copy under the same source version.";
    mutated.existing = existing;
    await expect(previewPublicationImport(mutated)).rejects.toThrow(/source version is immutable/);

    const currentV8 = await articleInput();
    currentV8.manifest.source.version = "docstudio-v8";
    const currentV8Plan = await previewPublicationImport(currentV8);
    const forgedDowngrade = matchingSnapshot(
      currentV8,
      currentV8Plan.revisionIdentity,
      currentV8Plan.artifactIdentity,
    );
    forgedDowngrade.approvedNextSourceVersion = "docstudio-v7";
    const olderV7 = await articleInput();
    olderV7.existing = forgedDowngrade;
    await expect(previewPublicationImport(olderV7)).rejects.toThrow(/next monotonic/);
  });

  it("binds governance approval evidence into revision and plan identities", async () => {
    const firstInput = await articleInput();
    const first = await previewPublicationImport(firstInput);
    const laterApproval = await articleInput();
    laterApproval.manifest.governance.approved_at = "2026-09-07T17:30:00Z";
    const second = await previewPublicationImport(laterApproval);

    expect(second.revisionIdentity).not.toBe(first.revisionIdentity);
    expect(second.planIdentity).not.toBe(first.planIdentity);
  });

  it("rejects malformed or ambiguous existing catalog state", async () => {
    const input = await articleInput();
    const initial = await previewPublicationImport(input);
    const snapshot = matchingSnapshot(input, initial.revisionIdentity, initial.artifactIdentity);
    snapshot.revisions.push({
      ...snapshot.revisions[0]!,
      revision: 3,
      sourceVersion: "docstudio-v9",
      placements: [],
    });
    input.existing = snapshot;
    await expect(previewPublicationImport(input)).rejects.toThrow(/contiguous from 1/);
  });

  it("does not plan an unbounded revision after the maximum retained history", async () => {
    const input = await articleInput();
    const initial = await previewPublicationImport(input);
    input.existing = {
      contentKey: input.manifest.source.content_key,
      approvedNextSourceVersion: "docstudio-v101",
      revisions: Array.from({ length: 100 }, (_, index) => ({
        revision: index + 1,
        sourceVersion: `docstudio-v${index + 1}`,
        revisionIdentity: initial.revisionIdentity,
        artifactIdentity: initial.artifactIdentity,
        state: index === 99 ? ("published" as const) : ("retired" as const),
        placements: [],
      })),
    };
    input.manifest.source.version = "docstudio-v101";

    await expect(previewPublicationImport(input)).rejects.toThrow(
      /cannot plan more than 100 immutable revisions/,
    );
  });
});
