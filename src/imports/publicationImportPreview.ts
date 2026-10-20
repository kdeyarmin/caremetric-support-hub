/**
 * Credential-free, transport-free planning boundary for approved DocStudio
 * publications. This module validates and hashes caller-supplied data, then
 * returns an immutable preview. It performs no persistence or network access.
 */

export const PUBLICATION_MANIFEST_SCHEMA = "caremetric.support-hub.publication.v1";
export const PUBLICATION_IMPORT_PLAN_SCHEMA = "caremetric.support-hub.import-plan.v1";

export const PUBLICATION_PRODUCT_SLUGS = Object.freeze([
  "advisors",
  "breathe",
  "carebase",
  "caremetric-emr",
  "caremetric-go",
  "caremetric-intel",
  "pennsync",
] as const);

export type PublicationProductSlug = (typeof PUBLICATION_PRODUCT_SLUGS)[number];
export type PublicationAudience = "all" | "customer" | "customer-admin" | "manager";
export type PublicationAccessLevel = "public" | "customer" | "staff";
export type PublicationContentKind = "article" | "video";

export interface PublicationPlacement {
  product_slug: PublicationProductSlug;
  audience: PublicationAudience[];
  route_pattern: string | null;
}

export interface PublicationManifest {
  schema_version: typeof PUBLICATION_MANIFEST_SCHEMA;
  source_system: "docstudio";
  source: {
    content_key: string;
    version: string;
  };
  content: {
    kind: PublicationContentKind;
    title: string;
    summary: string;
    locale: string;
    access_level: PublicationAccessLevel;
  };
  artifact: {
    sha256: string;
    media_type: "text/markdown" | "video/mp4";
    byte_length: number;
    duration_ms?: number;
    captions_sha256?: string;
    transcript_sha256?: string;
  };
  governance: {
    review_state: "approved";
    phi_review: "passed";
    approved_at: string;
    policy_version: "docstudio-phi-free-v1";
  };
  placements: PublicationPlacement[];
}

export interface PublicationAssetBundle {
  primary: Uint8Array;
  captions?: Uint8Array;
  transcript?: Uint8Array;
}

export interface CatalogPlacementSnapshot extends PublicationPlacement {
  state: "active" | "retired";
}

export interface CatalogRevisionSnapshot {
  revision: number;
  sourceVersion: string;
  revisionIdentity: string;
  artifactIdentity: string;
  state: "published" | "retired";
  placements: CatalogPlacementSnapshot[];
}

export interface PublicationCatalogSnapshot {
  contentKey: string;
  /**
   * The next source version accepted by the authoritative catalog workflow.
   * A preview cannot infer ordering from an arbitrary provider version string,
   * so a different version fails closed unless this exact value is supplied.
   */
  approvedNextSourceVersion: string | null;
  revisions: CatalogRevisionSnapshot[];
}

export interface PublicationImportPreviewInput {
  manifest: PublicationManifest;
  assets: PublicationAssetBundle;
  existing: PublicationCatalogSnapshot | null;
}

export type PublicationImportAction =
  | {
      type: "create";
      revision: 1;
      revisionIdentity: string;
      artifactIdentity: string;
    }
  | {
      type: "new_immutable_revision";
      previousRevision: number;
      revision: number;
      revisionIdentity: string;
      artifactIdentity: string;
    }
  | {
      type: "place";
      revision: number;
      productSlug: PublicationProductSlug;
      audience: PublicationAudience[];
      routePattern: string | null;
    }
  | {
      type: "replace_placement";
      previousRevision: number;
      revision: number;
      productSlug: PublicationProductSlug;
      audience: PublicationAudience[];
      routePattern: string | null;
      requiresExplicitApproval: true;
    }
  | {
      type: "retire_preview";
      revision: number;
      productSlug: PublicationProductSlug;
      audience: PublicationAudience[];
      routePattern: string | null;
      requiresExplicitApproval: true;
    }
  | {
      type: "retire_content_preview";
      revision: number;
      requiresExplicitApproval: true;
    }
  | {
      type: "reactivate_content_preview";
      previousRevision: number;
      revision: number;
      requiresExplicitApproval: true;
    }
  | {
      type: "no_op";
      revision: number;
      reason: "identical_revision_and_placements";
    };

export interface PublicationImportPlan {
  schemaVersion: typeof PUBLICATION_IMPORT_PLAN_SCHEMA;
  mode: "preview";
  contentKey: string;
  targetRevision: number;
  artifactIdentity: string;
  revisionIdentity: string;
  baseSnapshotIdentity: string;
  planIdentity: string;
  actions: PublicationImportAction[];
  writesPerformed: false;
  deletesPlanned: 0;
}

const PRODUCT_SLUG_SET = new Set<string>(PUBLICATION_PRODUCT_SLUGS);
const CONTENT_KINDS = ["article", "video"] as const;
const ACCESS_LEVELS = ["public", "customer", "staff"] as const;
const AUDIENCES = ["all", "customer", "customer-admin", "manager"] as const;
const REVISION_STATES = ["published", "retired"] as const;
const PLACEMENT_STATES = ["active", "retired"] as const;

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ARTICLE_BYTES = 2 * 1024 * 1024;
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
const MAX_SIDECAR_BYTES = 10 * 1024 * 1024;
const MAX_EXISTING_REVISIONS = 100;
const MAX_SNAPSHOT_PLACEMENTS_PER_REVISION = 24;

const SHA256 = /^[a-f0-9]{64}$/;
const CONTENT_IDENTITY = /^sha256:[a-f0-9]{64}$/;
const CONTENT_KEY = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SOURCE_VERSION = /^docstudio-v([1-9]\d{0,14})$/;
const LOCALE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

const SENSITIVE_TEXT_PATTERNS = [
  { pattern: /https?:\/\/|www\./i, reason: "web URLs are not permitted" },
  {
    pattern: /\b[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\//,
    reason: "URI schemes are not permitted",
  },
  {
    pattern: /(?:^|[^A-Za-z0-9])\/\/(?:\[|[A-Za-z0-9])/,
    reason: "protocol-relative destinations are not permitted",
  },
  {
    pattern: /\b(?:javascript|vbscript|data)\s*:/i,
    reason: "executable or embedded URL schemes are not permitted",
  },
  {
    pattern: /\b(?:file|ftp|mailto|tel|blob|filesystem|about|chrome|wss?|ssh|smb|nfs|cid)\s*:/i,
    reason: "external or local URI schemes are not permitted",
  },
  { pattern: /\burl\s*\(/i, reason: "CSS URL functions are not permitted" },
  { pattern: /@import\b/i, reason: "CSS imports are not permitted" },
  { pattern: /<[^>]+>/, reason: "HTML is not permitted" },
  { pattern: /heygen/i, reason: "renderer/provider details are not permitted" },
  {
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    reason: "email addresses are not permitted",
  },
  {
    pattern: /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/,
    reason: "phone numbers are not permitted",
  },
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/, reason: "SSN-shaped values are not permitted" },
  {
    pattern: /\b(?:date of birth|dob|medical record number|mrn|social security(?: number)?|ssn)\b/i,
    reason: "PHI identifier labels are not permitted",
  },
  {
    pattern: /\b(?:patient|member|client)\s+(?:name|id|identifier|record number|account number)\b/i,
    reason: "person or record identifier labels are not permitted",
  },
  {
    pattern: /\b(?:diagnosis|medication|prescription|clinical note)\s*:/i,
    reason: "clinical-value labels are not permitted",
  },
  { pattern: UUID, reason: "record-shaped UUIDs are not permitted" },
] as const;

function fail(path: string, message: string): never {
  throw new TypeError(`${path}: ${message}`);
}

function assertPlainObject(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be a plain object");
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, "must be a plain object");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail(path, "must not contain symbol fields");
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get || descriptor.set) {
      fail(path, "must not contain accessor fields");
    }
  }
}

function assertExactKeys(value: unknown, allowedKeys: readonly string[], path: string): asserts value is Record<string, unknown> {
  assertPlainObject(value, path);
  const unknown = Object.getOwnPropertyNames(value).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0) {
    fail(path, `contains forbidden or unknown field(s): ${unknown.sort().join(", ")}`);
  }
}

function assertArray(value: unknown, path: string, max: number, { nonEmpty = true } = {}): asserts value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(path, "must be an array");
  }
  if (nonEmpty && value.length === 0) fail(path, "must be a non-empty array");
  if (value.length > max) fail(path, `must contain at most ${max} entries`);
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) fail(path, "must not contain sparse entries");
  }
  const extraKeys = Object.getOwnPropertyNames(value).filter(
    (key) => key !== "length" && !/^(?:0|[1-9]\d*)$/.test(key),
  );
  if (extraKeys.length > 0 || Object.getOwnPropertySymbols(value).length > 0) {
    fail(path, "must not contain extra array fields");
  }
}

function assertString(
  value: unknown,
  path: string,
  options: { min?: number; max?: number; pattern?: RegExp } = {},
): string {
  const { min = 1, max, pattern } = options;
  if (typeof value !== "string") fail(path, "must be a string");
  if (value !== value.trim()) fail(path, "must not have leading or trailing whitespace");
  if (value.length < min) fail(path, `must contain at least ${min} character(s)`);
  if (max !== undefined && value.length > max) {
    fail(path, `must contain at most ${max} character(s)`);
  }
  if (pattern && !pattern.test(value)) fail(path, "has an invalid format");
  if (/\p{Cc}/u.test(value)) fail(path, "must not contain control characters");
  return value;
}

function assertSourceVersion(value: unknown, path: string): { value: string; ordinal: number } {
  const sourceVersion = assertString(value, path, { max: 80, pattern: SOURCE_VERSION });
  const match = SOURCE_VERSION.exec(sourceVersion);
  const ordinal = Number(match?.[1]);
  if (!Number.isSafeInteger(ordinal)) {
    fail(path, "must contain a safe monotonic DocStudio revision number");
  }
  return { value: sourceVersion, ordinal };
}

function assertEnum<const T extends readonly string[]>(value: unknown, choices: T, path: string): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) {
    fail(path, `must be one of: ${choices.join(", ")}`);
  }
  return value as T[number];
}

function assertPositiveInteger(value: unknown, path: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > max) {
    fail(path, `must be a positive safe integer no greater than ${max}`);
  }
  return value as number;
}

function assertSafeText(value: unknown, path: string, min: number, max: number): string {
  const text = assertString(value, path, { min, max });
  for (const { pattern, reason } of SENSITIVE_TEXT_PATTERNS) {
    if (pattern.test(text)) fail(path, reason);
  }
  if (/<[^>]+>/.test(text)) fail(path, "HTML is not permitted");
  return text;
}

function assertSafeArtifactText(value: string, path: string): void {
  if (value.trim().length === 0) fail(path, "must not be empty");
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      fail(path, "must not contain unsafe control characters");
    }
  }
  if (value.includes("](")) {
    fail(path, "Markdown links and images are not permitted");
  }
  if (/(?:^|\r?\n)\s*\[[^\r\n]*\]\s*:\s*\S/.test(value)) {
    fail(path, "Markdown link definitions are not permitted");
  }
  for (const { pattern, reason } of SENSITIVE_TEXT_PATTERNS) {
    if (pattern.test(value)) fail(path, reason);
  }
}

function assertSha256(value: unknown, path: string): string {
  return assertString(value, path, { min: 64, max: 64, pattern: SHA256 });
}

function assertContentIdentity(value: unknown, path: string): string {
  return assertString(value, path, { min: 71, max: 71, pattern: CONTENT_IDENTITY });
}

function assertIsoInstant(value: unknown, path: string): string {
  const instant = assertString(value, path, { pattern: ISO_INSTANT });
  const timestamp = Date.parse(instant);
  if (!Number.isFinite(timestamp)) fail(path, "must be a valid UTC instant");

  const canonicalInput = instant.includes(".")
    ? instant.replace(/\.(\d{1,3})Z$/, (_, digits: string) => `.${digits.padEnd(3, "0")}Z`)
    : instant.replace("Z", ".000Z");
  if (new Date(timestamp).toISOString() !== canonicalInput) {
    fail(path, "must be a real calendar instant");
  }
  return instant;
}

function validateRoutePattern(value: unknown, path: string): string | null {
  if (value === null) return null;
  const route = assertString(value, path, { max: 160 });
  if (!route.startsWith("/") || route.includes("//")) {
    fail(path, "must be an absolute application path");
  }
  if (!/^\/[A-Za-z0-9._/-]*(?:\/\*\*)?$/.test(route)) {
    fail(path, "must be a static path with only an optional trailing /** wildcard");
  }
  if (route.includes("..") || UUID.test(route) || route.split("/").some((part) => /^\d+$/.test(part))) {
    fail(path, "must not contain traversal or record-shaped path segments");
  }
  return route;
}

function validateAudience(value: unknown, path: string): PublicationAudience[] {
  assertArray(value, path, AUDIENCES.length);
  const audience = value.map((entry, index) =>
    assertEnum(entry, AUDIENCES, `${path}[${index}]`),
  );
  if (new Set(audience).size !== audience.length) fail(path, "must not contain duplicates");
  if (audience.includes("all") && audience.length > 1) {
    fail(path, "all cannot be combined with another audience");
  }
  return [...audience].sort();
}

function validateProductSlug(value: unknown, path: string): PublicationProductSlug {
  if (typeof value !== "string" || !PRODUCT_SLUG_SET.has(value)) {
    fail(path, `must be a registered Support Hub product: ${PUBLICATION_PRODUCT_SLUGS.join(", ")}`);
  }
  return value as PublicationProductSlug;
}

function validatePlacement(
  value: unknown,
  path: string,
  accessLevel?: PublicationAccessLevel,
): PublicationPlacement {
  assertExactKeys(value, ["product_slug", "audience", "route_pattern"], path);
  const audience = validateAudience(value.audience, `${path}.audience`);
  if (accessLevel === "public" && (audience.length !== 1 || audience[0] !== "all")) {
    fail(`${path}.audience`, "public content must target only the all audience");
  }
  return {
    product_slug: validateProductSlug(value.product_slug, `${path}.product_slug`),
    audience,
    route_pattern: validateRoutePattern(value.route_pattern, `${path}.route_pattern`),
  };
}

export function validatePublicationManifest(value: unknown): PublicationManifest {
  assertExactKeys(
    value,
    ["schema_version", "source_system", "source", "content", "artifact", "governance", "placements"],
    "manifest",
  );
  if (value.schema_version !== PUBLICATION_MANIFEST_SCHEMA) {
    fail("manifest.schema_version", `must be ${PUBLICATION_MANIFEST_SCHEMA}`);
  }
  if (value.source_system !== "docstudio") fail("manifest.source_system", "must be docstudio");

  assertExactKeys(value.source, ["content_key", "version"], "manifest.source");
  const contentKey = assertString(value.source.content_key, "manifest.source.content_key", {
    min: 3,
    max: 120,
    pattern: CONTENT_KEY,
  });
  const version = assertSourceVersion(value.source.version, "manifest.source.version").value;
  if (UUID.test(contentKey) || UUID.test(version)) {
    fail("manifest.source", "must not contain record-shaped UUIDs");
  }

  assertExactKeys(
    value.content,
    ["kind", "title", "summary", "locale", "access_level"],
    "manifest.content",
  );
  const kind = assertEnum(value.content.kind, CONTENT_KINDS, "manifest.content.kind");
  const accessLevel = assertEnum(
    value.content.access_level,
    ACCESS_LEVELS,
    "manifest.content.access_level",
  );
  const content = {
    kind,
    title: assertSafeText(value.content.title, "manifest.content.title", 2, 180),
    summary: assertSafeText(value.content.summary, "manifest.content.summary", 1, 500),
    locale: assertString(value.content.locale, "manifest.content.locale", {
      min: 2,
      max: 16,
      pattern: LOCALE,
    }),
    access_level: accessLevel,
  };

  assertExactKeys(
    value.artifact,
    ["sha256", "media_type", "byte_length", "duration_ms", "captions_sha256", "transcript_sha256"],
    "manifest.artifact",
  );
  const expectedMediaType = kind === "video" ? "video/mp4" : "text/markdown";
  if (value.artifact.media_type !== expectedMediaType) {
    fail("manifest.artifact.media_type", `must be ${expectedMediaType} for ${kind} content`);
  }
  const byteLimit = kind === "video" ? MAX_VIDEO_BYTES : MAX_ARTICLE_BYTES;
  const artifact: PublicationManifest["artifact"] = {
    sha256: assertSha256(value.artifact.sha256, "manifest.artifact.sha256"),
    media_type: expectedMediaType,
    byte_length: assertPositiveInteger(value.artifact.byte_length, "manifest.artifact.byte_length", byteLimit),
  };
  if (kind === "video") {
    artifact.duration_ms = assertPositiveInteger(
      value.artifact.duration_ms,
      "manifest.artifact.duration_ms",
      24 * 60 * 60 * 1000,
    );
    artifact.captions_sha256 = assertSha256(
      value.artifact.captions_sha256,
      "manifest.artifact.captions_sha256",
    );
    artifact.transcript_sha256 = assertSha256(
      value.artifact.transcript_sha256,
      "manifest.artifact.transcript_sha256",
    );
    const hashes = [artifact.sha256, artifact.captions_sha256, artifact.transcript_sha256].filter(
      (entry): entry is string => entry !== undefined,
    );
    if (new Set(hashes).size !== hashes.length) {
      fail("manifest.artifact", "primary, caption, and transcript hashes must be distinct");
    }
  } else if (
    value.artifact.duration_ms !== undefined ||
    value.artifact.captions_sha256 !== undefined ||
    value.artifact.transcript_sha256 !== undefined
  ) {
    fail("manifest.artifact", "video-only fields are not permitted for article content");
  }

  assertExactKeys(
    value.governance,
    ["review_state", "phi_review", "approved_at", "policy_version"],
    "manifest.governance",
  );
  if (value.governance.review_state !== "approved") {
    fail("manifest.governance.review_state", "must be approved");
  }
  if (value.governance.phi_review !== "passed") {
    fail("manifest.governance.phi_review", "must be passed");
  }
  if (value.governance.policy_version !== "docstudio-phi-free-v1") {
    fail("manifest.governance.policy_version", "must be docstudio-phi-free-v1");
  }

  assertArray(
    value.placements,
    "manifest.placements",
    PUBLICATION_PRODUCT_SLUGS.length,
    { nonEmpty: false },
  );
  const placements = value.placements.map((placement, index) =>
    validatePlacement(placement, `manifest.placements[${index}]`, accessLevel),
  );
  const productSlugs = placements.map((placement) => placement.product_slug);
  if (new Set(productSlugs).size !== productSlugs.length) {
    fail("manifest.placements", "must contain at most one placement per product");
  }
  placements.sort((left, right) => left.product_slug.localeCompare(right.product_slug));

  const manifest: PublicationManifest = {
    schema_version: PUBLICATION_MANIFEST_SCHEMA,
    source_system: "docstudio",
    source: { content_key: contentKey, version },
    content,
    artifact,
    governance: {
      review_state: "approved",
      phi_review: "passed",
      approved_at: assertIsoInstant(value.governance.approved_at, "manifest.governance.approved_at"),
      policy_version: "docstudio-phi-free-v1",
    },
    placements,
  };
  if (new TextEncoder().encode(canonicalJson(manifest)).byteLength > MAX_MANIFEST_BYTES) {
    fail("manifest", `must serialize to no more than ${MAX_MANIFEST_BYTES} bytes`);
  }
  return manifest;
}

function validateSnapshotPlacement(value: unknown, path: string): CatalogPlacementSnapshot {
  assertExactKeys(value, ["product_slug", "audience", "route_pattern", "state"], path);
  return {
    ...validatePlacement(
      {
        product_slug: value.product_slug,
        audience: value.audience,
        route_pattern: value.route_pattern,
      },
      path,
    ),
    state: assertEnum(value.state, PLACEMENT_STATES, `${path}.state`),
  };
}

function validateSnapshot(value: unknown, contentKey: string): PublicationCatalogSnapshot | null {
  if (value === null) return null;
  assertExactKeys(value, ["contentKey", "approvedNextSourceVersion", "revisions"], "existing");
  const snapshotContentKey = assertString(value.contentKey, "existing.contentKey", {
    min: 3,
    max: 120,
    pattern: CONTENT_KEY,
  });
  if (snapshotContentKey !== contentKey) {
    fail("existing.contentKey", "must match manifest.source.content_key");
  }
  const approvedNextSourceVersion = value.approvedNextSourceVersion === null
    ? null
    : assertSourceVersion(
        value.approvedNextSourceVersion,
        "existing.approvedNextSourceVersion",
      ).value;

  assertArray(value.revisions, "existing.revisions", MAX_EXISTING_REVISIONS);
  const revisions = value.revisions.map((revisionValue, index): CatalogRevisionSnapshot => {
    const path = `existing.revisions[${index}]`;
    assertExactKeys(
      revisionValue,
      ["revision", "sourceVersion", "revisionIdentity", "artifactIdentity", "state", "placements"],
      path,
    );
    const revision = assertPositiveInteger(
      revisionValue.revision,
      `${path}.revision`,
      MAX_EXISTING_REVISIONS,
    );
    const state = assertEnum(revisionValue.state, REVISION_STATES, `${path}.state`);
    assertArray(
      revisionValue.placements,
      `${path}.placements`,
      MAX_SNAPSHOT_PLACEMENTS_PER_REVISION,
      { nonEmpty: false },
    );
    const placements = revisionValue.placements
      .map((placement, placementIndex) =>
        validateSnapshotPlacement(placement, `${path}.placements[${placementIndex}]`),
      )
      .sort((left, right) => left.product_slug.localeCompare(right.product_slug));
    if (state === "retired" && placements.some((placement) => placement.state === "active")) {
      fail(`${path}.placements`, "a retired revision cannot have active placements");
    }
    const sourceVersion = assertSourceVersion(
      revisionValue.sourceVersion,
      `${path}.sourceVersion`,
    ).value;
    return {
      revision,
      sourceVersion,
      revisionIdentity: assertContentIdentity(
        revisionValue.revisionIdentity,
        `${path}.revisionIdentity`,
      ),
      artifactIdentity: assertContentIdentity(
        revisionValue.artifactIdentity,
        `${path}.artifactIdentity`,
      ),
      state,
      placements,
    };
  });
  revisions.sort((left, right) => left.revision - right.revision);
  for (let index = 0; index < revisions.length; index += 1) {
    if (revisions[index]?.revision !== index + 1) {
      fail("existing.revisions", "revision numbers must be unique and contiguous from 1");
    }
  }
  let priorSourceOrdinal = 0;
  for (const revision of revisions) {
    const sourceOrdinal = assertSourceVersion(
      revision.sourceVersion,
      `existing.revisions[${revision.revision - 1}].sourceVersion`,
    ).ordinal;
    if (sourceOrdinal <= priorSourceOrdinal) {
      fail("existing.revisions", "source versions must increase with immutable revisions");
    }
    priorSourceOrdinal = sourceOrdinal;
  }
  if (approvedNextSourceVersion !== null) {
    const approvedNextOrdinal = assertSourceVersion(
      approvedNextSourceVersion,
      "existing.approvedNextSourceVersion",
    ).ordinal;
    if (approvedNextOrdinal !== priorSourceOrdinal + 1) {
      fail(
        "existing.approvedNextSourceVersion",
        "must be the next monotonic DocStudio source revision",
      );
    }
  }

  const placementProducts = new Set<PublicationProductSlug>();
  for (const revision of revisions) {
    for (const placement of revision.placements) {
      if (placementProducts.has(placement.product_slug)) {
        fail(
          "existing.revisions",
          `contains more than one catalog placement row for ${placement.product_slug}`,
        );
      }
      placementProducts.add(placement.product_slug);
    }
  }
  return { contentKey: snapshotContentKey, approvedNextSourceVersion, revisions };
}

function validateAssetBundle(value: unknown): PublicationAssetBundle {
  assertExactKeys(value, ["primary", "captions", "transcript"], "assets");
  for (const key of ["primary", "captions", "transcript"] as const) {
    const asset = value[key];
    if (key === "primary" || asset !== undefined) {
      if (!(asset instanceof Uint8Array)) fail(`assets.${key}`, "must be a Uint8Array");
    }
  }
  return {
    primary: value.primary as Uint8Array,
    ...(value.captions === undefined ? {} : { captions: value.captions as Uint8Array }),
    ...(value.transcript === undefined ? {} : { transcript: value.transcript as Uint8Array }),
  };
}

function decodeTextAsset(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(path, "must be valid UTF-8 text");
  }
}

function parseWebVttTimestamp(value: string): number | null {
  const match = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4]);
  if (![hours, minutes, seconds, milliseconds].every(Number.isSafeInteger)) return null;
  return (((hours * 60) + minutes) * 60 + seconds) * 1000 + milliseconds;
}

function isWebVttPercentage(value: string): boolean {
  return /^\d+(?:\.\d+)?%$/.test(value) && Number(value.slice(0, -1)) <= 100;
}

function isWebVttAnchor(value: string): boolean {
  const parts = value.split(",");
  return parts.length === 2 && parts.every(isWebVttPercentage);
}

function assertWebVttRegion(
  lines: readonly string[],
  regionIds: Set<string>,
  path: string,
): void {
  const settings = lines.slice(1).flatMap((line) => line.split(/[ \t]+/)).filter(Boolean);
  const names = new Set<string>();
  let regionId: string | null = null;

  for (const setting of settings) {
    const separator = setting.indexOf(":");
    const name = separator < 0 ? "" : setting.slice(0, separator);
    const value = separator < 0 ? "" : setting.slice(separator + 1);
    if (!name || !value || names.has(name)) {
      fail(path, "WEBVTT REGION settings must be unique and well formed");
    }
    names.add(name);

    const valid =
      (name === "id" && !/[\t\n\f\r ]/.test(value)) ||
      (name === "width" && isWebVttPercentage(value)) ||
      (name === "lines" && /^\d+$/.test(value)) ||
      ((name === "regionanchor" || name === "viewportanchor") && isWebVttAnchor(value)) ||
      (name === "scroll" && value === "up");
    if (!valid) fail(path, "WEBVTT REGION settings must be unique and well formed");
    if (name === "id") regionId = value;
  }

  if (!regionId || regionIds.has(regionId)) {
    fail(path, "WEBVTT REGION blocks require a unique non-empty id");
  }
  regionIds.add(regionId);
}

function assertWebVttCueSettings(value: string, regionIds: ReadonlySet<string>, path: string): void {
  if (!value) return;
  const names = new Set<string>();
  for (const setting of value.split(/[ \t]+/).filter(Boolean)) {
    const separator = setting.indexOf(":");
    const name = separator < 0 ? "" : setting.slice(0, separator);
    const settingValue = separator < 0 ? "" : setting.slice(separator + 1);
    if (!name || !settingValue || names.has(name)) {
      fail(path, "WEBVTT cue settings must be unique and well formed");
    }
    names.add(name);

    const lineParts = settingValue.split(",");
    const validLine =
      (isWebVttPercentage(lineParts[0] ?? "") || /^-?\d+$/.test(lineParts[0] ?? "")) &&
      (lineParts.length === 1 ||
        (lineParts.length === 2 && ["start", "center", "end"].includes(lineParts[1] ?? "")));
    const positionParts = settingValue.split(",");
    const validPosition =
      isWebVttPercentage(positionParts[0] ?? "") &&
      (positionParts.length === 1 ||
        (positionParts.length === 2 &&
          ["line-left", "center", "line-right"].includes(positionParts[1] ?? "")));
    const valid =
      (name === "vertical" && ["rl", "lr"].includes(settingValue)) ||
      (name === "line" && validLine) ||
      (name === "position" && validPosition) ||
      (name === "size" && isWebVttPercentage(settingValue)) ||
      (name === "align" && ["start", "center", "end", "left", "right"].includes(settingValue)) ||
      (name === "region" && regionIds.has(settingValue));
    if (!valid) fail(path, "WEBVTT cue settings must be unique and well formed");
  }
}

function assertWebVttStyle(lines: readonly string[], path: string): void {
  const css = lines.slice(1).join("\n");
  const hasForbiddenControl = Array.from(css).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) || code === 0x7f;
  });
  if (
    /[\\@]/.test(css) ||
    /\/\*|\*\//.test(css) ||
    hasForbiddenControl ||
    /\b(?:image|image-set|cross-fade)\s*\(/i.test(css)
  ) {
    fail(path, "WEBVTT STYLE blocks cannot contain escaped or external-resource CSS");
  }
}

function assertWebVtt(value: string, durationMs: number, path: string): void {
  const normalized = value
    .replace(/^\uFEFF/, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
  const headerEnd = normalized.indexOf("\n\n");
  if (headerEnd < 0) {
    fail(path, "must separate the WEBVTT header from cues with a blank line");
  }
  const headerLines = normalized.slice(0, headerEnd).split("\n");
  const header = headerLines[0] ?? "";
  if (!/^WEBVTT(?:[ \t][^\n]*)?$/.test(header) || header.includes("-->")) {
    fail(path, "must begin with a WEBVTT header");
  }

  const metadataNames = new Set<string>();
  for (const line of headerLines.slice(1)) {
    const timestampMap = /^X-TIMESTAMP-MAP=LOCAL:([^,]+),MPEGTS:(\d+)$/.exec(line);
    const mpegTimestamp = Number(timestampMap?.[2]);
    if (
      !timestampMap ||
      metadataNames.has("X-TIMESTAMP-MAP") ||
      parseWebVttTimestamp(timestampMap[1] ?? "") === null ||
      !Number.isSafeInteger(mpegTimestamp) ||
      mpegTimestamp < 0 ||
      mpegTimestamp > 0x1ffffffff
    ) {
      fail(path, "contains unsupported or malformed WEBVTT header metadata");
    }
    metadataNames.add("X-TIMESTAMP-MAP");
  }

  const blocks = normalized
    .slice(headerEnd + 2)
    .split(/\n{2,}/)
    .filter((block) => block.trim().length > 0);
  let cueCount = 0;
  let seenCue = false;
  let previousStart = -1;
  const cueIds = new Set<string>();
  const regionIds = new Set<string>();
  for (const block of blocks) {
    const lines = block.split("\n");
    const firstLine = lines[0] ?? "";
    const specialBlock = /^(NOTE|STYLE|REGION)(?:[ \t]|$)/.exec(firstLine);
    if (specialBlock) {
      const kind = specialBlock[1];
      if (lines.some((line) => line.includes("-->"))) {
        fail(path, "WEBVTT metadata blocks cannot contain cue timing arrows");
      }
      if (kind === "NOTE") continue;
      if (!new RegExp(`^${kind}[ \\t]*$`).test(firstLine) || seenCue) {
        fail(path, `WEBVTT ${kind} blocks must be well formed and precede every cue`);
      }
      if (kind === "REGION") assertWebVttRegion(lines, regionIds, path);
      if (kind === "STYLE") assertWebVttStyle(lines, path);
      continue;
    }
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (
      timingIndex < 0 ||
      timingIndex > 1 ||
      (timingIndex === 1 && (lines[0] ?? "").length === 0)
    ) {
      fail(path, "must contain only usable timed WebVTT cues within the media duration");
    }
    const timingLine = lines[timingIndex] ?? "";
    const arrowCount = timingLine.split("-->").length - 1;
    const timing = /^(\S+)[ \t]+-->[ \t]+(\S+)(?:[ \t]+(.*))?$/.exec(timingLine);
    if (!timing || arrowCount !== 1) {
      fail(path, "must contain only usable timed WebVTT cues within the media duration");
    }
    const start = parseWebVttTimestamp(timing[1] ?? "");
    const end = parseWebVttTimestamp(timing[2] ?? "");
    const cueId = timingIndex === 1 ? lines[0]! : null;
    if (cueId && cueIds.has(cueId)) {
      fail(path, "WEBVTT cue identifiers must be unique");
    }
    if (cueId) cueIds.add(cueId);
    assertWebVttCueSettings(timing[3] ?? "", regionIds, path);
    const payload = lines.slice(timingIndex + 1);
    const hasPayload = payload.some((line) => line.trim().length > 0);
    if (
      start === null ||
      end === null ||
      end <= start ||
      start < previousStart ||
      start >= durationMs ||
      end > durationMs ||
      payload.some((line) => line.includes("-->")) ||
      !hasPayload
    ) {
      fail(path, "must contain only usable timed WebVTT cues within the media duration");
    }
    cueCount += 1;
    seenCue = true;
    previousStart = start;
  }
  if (cueCount === 0) {
    fail(path, "must contain at least one usable timed WebVTT cue within the media duration");
  }
}

function looksLikeMp4(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 16) return false;
  const boxSize = (
    (bytes[0]! * 0x1000000) +
    (bytes[1]! << 16) +
    (bytes[2]! << 8) +
    bytes[3]!
  );
  if (
    boxSize < 16 ||
    boxSize > bytes.byteLength ||
    (boxSize - 16) % 4 !== 0 ||
    bytes[4] !== 0x66 ||
    bytes[5] !== 0x74 ||
    bytes[6] !== 0x79 ||
    bytes[7] !== 0x70
  ) {
    return false;
  }
  const brandAt = (offset: number): string | null => {
    const brandBytes = Array.from(bytes.slice(offset, offset + 4));
    if (brandBytes.length !== 4 || brandBytes.some((byte) => byte < 0x20 || byte > 0x7e)) {
      return null;
    }
    return String.fromCharCode(...brandBytes);
  };
  const supportedMajorBrands = new Set([
    "isom", "iso2", "iso3", "iso4", "iso5", "iso6",
    "mp41", "mp42", "avc1", "M4V ", "MSNV", "dash", "cmfc", "cmfv",
  ]);
  const majorBrand = brandAt(8);
  if (!majorBrand || !supportedMajorBrands.has(majorBrand)) return false;
  for (let offset = 16; offset < boxSize; offset += 4) {
    if (!brandAt(offset)) return false;
  }
  return true;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyAsset(
  bytes: Uint8Array,
  expectedHash: string,
  path: string,
  maxBytes: number,
  scanText: boolean,
): Promise<void> {
  if (bytes.byteLength === 0) fail(path, "must not be empty");
  if (bytes.byteLength > maxBytes) fail(path, `must not exceed ${maxBytes} bytes`);
  const actualHash = await sha256Hex(bytes);
  if (actualHash !== expectedHash) fail(path, "SHA-256 digest does not match the manifest");
  if (scanText) assertSafeArtifactText(decodeTextAsset(bytes, path), path);
}

async function verifyAssets(manifest: PublicationManifest, assets: PublicationAssetBundle): Promise<void> {
  if (assets.primary.byteLength !== manifest.artifact.byte_length) {
    fail("assets.primary", "byte length does not match manifest.artifact.byte_length");
  }
  await verifyAsset(
    assets.primary,
    manifest.artifact.sha256,
    "assets.primary",
    manifest.content.kind === "video" ? MAX_VIDEO_BYTES : MAX_ARTICLE_BYTES,
    manifest.content.kind === "article",
  );
  if (manifest.content.kind === "video" && !looksLikeMp4(assets.primary)) {
    fail("assets.primary", "does not have an ISO BMFF/MP4 ftyp signature");
  }

  const sidecars = [
    ["captions", manifest.artifact.captions_sha256, assets.captions],
    ["transcript", manifest.artifact.transcript_sha256, assets.transcript],
  ] as const;
  for (const [name, declaredHash, bytes] of sidecars) {
    if (declaredHash === undefined && bytes !== undefined) {
      fail(`assets.${name}`, `is not declared by manifest.artifact.${name}_sha256`);
    }
    if (declaredHash !== undefined && bytes === undefined) {
      fail(`assets.${name}`, `is required by manifest.artifact.${name}_sha256`);
    }
    if (declaredHash !== undefined && bytes !== undefined) {
      await verifyAsset(bytes, declaredHash, `assets.${name}`, MAX_SIDECAR_BYTES, true);
      if (name === "captions") {
        assertWebVtt(
          decodeTextAsset(bytes, "assets.captions"),
          manifest.artifact.duration_ms!,
          "assets.captions",
        );
      }
    }
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("canonical value", "contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  fail("canonical value", "contains an unsupported value");
}

function placementIdentity(placement: PublicationPlacement): string {
  return canonicalJson({
    audience: [...placement.audience].sort(),
    product_slug: placement.product_slug,
    route_pattern: placement.route_pattern,
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

async function buildRevisionIdentity(manifest: PublicationManifest): Promise<string> {
  const revisionRecord = {
    artifact: manifest.artifact,
    content: manifest.content,
    governance: manifest.governance,
    schema_version: manifest.schema_version,
    source: manifest.source,
    source_system: manifest.source_system,
  };
  return `sha256:${await sha256Hex(new TextEncoder().encode(canonicalJson(revisionRecord)))}`;
}

function collectCatalogPlacements(snapshot: PublicationCatalogSnapshot): Array<{
  revision: number;
  placement: CatalogPlacementSnapshot;
}> {
  return snapshot.revisions
    .flatMap((revision) =>
      revision.placements.map((placement) => ({ revision: revision.revision, placement })),
    )
    .sort((left, right) => left.placement.product_slug.localeCompare(right.placement.product_slug));
}

/**
 * Validates a publication package and returns only a deterministic dry-run
 * plan. The caller must use a separate, authenticated approval boundary to
 * perform any write, including a retirement. This function never deletes.
 */
export async function previewPublicationImport(input: unknown): Promise<PublicationImportPlan> {
  assertExactKeys(input, ["manifest", "assets", "existing"], "input");
  const manifest = validatePublicationManifest(input.manifest);
  const assets = validateAssetBundle(input.assets);
  return previewPublicationImportWithVerifier({ manifest, existing: input.existing }, async () => verifyAssets(manifest, assets));
}

/**
 * Server planning entry point for bounded streaming asset verification. The
 * verifier must inspect the exact uploaded bytes; evidence from an HTTP body
 * is never a verifier. This still only plans, and grants no publication rights.
 */
export async function previewPublicationImportWithVerifier(
  input: unknown,
  verify: (manifest: PublicationManifest) => Promise<void>,
): Promise<PublicationImportPlan> {
  assertExactKeys(input, ["manifest", "existing"], "input");
  const manifest = validatePublicationManifest(input.manifest);
  const existing = validateSnapshot(input.existing, manifest.source.content_key);
  await verify(manifest);
  if (existing === null && manifest.placements.length === 0) {
    fail("manifest.placements", "new content requires at least one product placement");
  }

  const artifactIdentity = `sha256:${manifest.artifact.sha256}`;
  const revisionIdentity = await buildRevisionIdentity(manifest);
  const baseSnapshotIdentity = `sha256:${await sha256Hex(
    new TextEncoder().encode(canonicalJson(existing)),
  )}`;
  const actions: PublicationImportAction[] = [];
  let targetRevision: number;

  if (existing === null) {
    targetRevision = 1;
    actions.push({
      type: "create",
      revision: 1,
      revisionIdentity,
      artifactIdentity,
    });
    for (const placement of manifest.placements) {
      actions.push({
        type: "place",
        revision: targetRevision,
        productSlug: placement.product_slug,
        audience: [...placement.audience],
        routePattern: placement.route_pattern,
      });
    }
  } else {
    const latest = existing.revisions.at(-1);
    if (!latest) fail("existing.revisions", "must contain at least one revision");
    const catalogPlacements = collectCatalogPlacements(existing);
    const activePlacements = catalogPlacements.filter(
      ({ placement }) => placement.state === "active",
    );
    const sameSourceVersion = latest.sourceVersion === manifest.source.version;
    if (sameSourceVersion && latest.state === "retired" && manifest.placements.length > 0) {
      fail(
        "manifest.source.version",
        "a retired source version cannot be republished; approve a new source version",
      );
    }
    if (sameSourceVersion && latest.revisionIdentity !== revisionIdentity) {
      fail(
        "manifest.source.version",
        "an existing source version is immutable and cannot identify changed content",
      );
    }
    if (!sameSourceVersion && existing.approvedNextSourceVersion !== manifest.source.version) {
      fail(
        "manifest.source.version",
        "is not the authoritative catalog's approved next source version",
      );
    }
    const createsNewRevision = !sameSourceVersion;
    if (createsNewRevision && latest.revision >= MAX_EXISTING_REVISIONS) {
      fail(
        "existing.revisions",
        `cannot plan more than ${MAX_EXISTING_REVISIONS} immutable revisions`,
      );
    }
    targetRevision = createsNewRevision ? latest.revision + 1 : latest.revision;

    if (!createsNewRevision && latest.artifactIdentity !== artifactIdentity) {
      fail("existing.revisions", "revision identity conflicts with its artifact identity");
    }
    if (createsNewRevision) {
      actions.push({
        type: "new_immutable_revision",
        previousRevision: latest.revision,
        revision: targetRevision,
        revisionIdentity,
        artifactIdentity,
      });
      if (latest.state === "retired" && manifest.placements.length > 0) {
        actions.push({
          type: "reactivate_content_preview",
          previousRevision: latest.revision,
          revision: targetRevision,
          requiresExplicitApproval: true,
        });
      }
    }

    const placementActions: PublicationImportAction[] = [];
    const replacementActions: PublicationImportAction[] = [];
    const retirementActions: PublicationImportAction[] = [];
    for (const desired of manifest.placements) {
      const exactActive = activePlacements.find(
        ({ revision, placement }) =>
          revision === targetRevision && placementIdentity(placement) === placementIdentity(desired),
      );
      if (!exactActive) {
        const existingProductPlacement = catalogPlacements.find(
          ({ placement }) => placement.product_slug === desired.product_slug,
        );
        if (existingProductPlacement) {
          replacementActions.push({
            type: "replace_placement",
            previousRevision: existingProductPlacement.revision,
            revision: targetRevision,
            productSlug: desired.product_slug,
            audience: [...desired.audience],
            routePattern: desired.route_pattern,
            requiresExplicitApproval: true,
          });
        } else {
          placementActions.push({
            type: "place",
            revision: targetRevision,
            productSlug: desired.product_slug,
            audience: [...desired.audience],
            routePattern: desired.route_pattern,
          });
        }
      }
    }

    for (const { revision, placement } of activePlacements) {
      const productRemainsDesired = manifest.placements.some(
        (desired) => desired.product_slug === placement.product_slug,
      );
      if (!productRemainsDesired) {
        retirementActions.push({
          type: "retire_preview",
          revision,
          productSlug: placement.product_slug,
          audience: [...placement.audience],
          routePattern: placement.route_pattern,
          requiresExplicitApproval: true,
        });
      }
    }
    // Existing product publication rows are replaced transactionally rather
    // than retired-and-inserted, matching UNIQUE(item_id, product_id).
    actions.push(...retirementActions, ...replacementActions, ...placementActions);
    if (manifest.placements.length === 0 && (createsNewRevision || latest.state !== "retired")) {
      actions.push({
        type: "retire_content_preview",
        revision: targetRevision,
        requiresExplicitApproval: true,
      });
    }

    if (actions.length === 0) {
      actions.push({
        type: "no_op",
        revision: targetRevision,
        reason: "identical_revision_and_placements",
      });
    }
  }

  const planCore = {
    schemaVersion: PUBLICATION_IMPORT_PLAN_SCHEMA as typeof PUBLICATION_IMPORT_PLAN_SCHEMA,
    mode: "preview" as const,
    contentKey: manifest.source.content_key,
    targetRevision,
    artifactIdentity,
    revisionIdentity,
    baseSnapshotIdentity,
    actions,
    writesPerformed: false as const,
    deletesPlanned: 0 as const,
  };
  const planIdentity = `sha256:${await sha256Hex(new TextEncoder().encode(canonicalJson(planCore)))}`;
  return deepFreeze({ ...planCore, planIdentity });
}

/** Shared text/container checks used by both byte-array and streaming importers. */
export function validatePublicationText(bytes: Uint8Array, kind: "article" | "captions" | "transcript", durationMs?: number): string {
  const value = decodeTextAsset(bytes, `assets.${kind}`);
  assertSafeArtifactText(value, `assets.${kind}`);
  if (kind === "captions") assertWebVtt(value, durationMs!, "assets.captions");
  return value;
}

export function validatePublicationMp4Header(bytes: Uint8Array): void {
  if (!looksLikeMp4(bytes)) fail("assets.primary", "does not have a bounded ISO BMFF/MP4 ftyp signature");
}
