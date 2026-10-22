import { z } from "zod";
import { receiptUuid as id } from "./receiptProtocol.ts";
import { containsGovernedCredentials } from "../imports/governedLearningImport.ts";

/**
 * The CareBase training library route (/api/learning-admin/catalog): elective collections,
 * refresher lessons, course discovery metadata and global starter kits. Shapes mirror CareBase's
 * closed request checks so a bad record is refused before a delegation is issued.
 */
export const catalogSections = ["collections", "lessons", "metadata", "starterKits"] as const;
export type CatalogSection = typeof catalogSections[number];
/** Trimmed single line with no control characters. */
const line = (min: number, max: number) => z.string().min(min).max(max).refine(v => v === v.trim() && !/\p{Cc}/u.test(v));
/** Multi-line text, bounded on its trimmed length like the SQL checks; only line breaks and tabs. */
const prose = (min: number, max: number) => z.string().max(max).refine(v => v.trim().length >= min && !/\p{Cc}/u.test(v.replace(/[\r\n\t]/g, "")));
const uniqueIds = (max: number) => z.array(id).max(max).refine(v => new Set(v.map(item => item.toLowerCase())).size === v.length);
const revision = z.number().int().min(1).max(2_147_483_647);
const httpsUrl = z.string().max(2000).regex(/^https:\/\/[^\s]+$/);

export const collectionSchema = z.strictObject({ id, title: line(1, 150), description: prose(0, 2000), interests: z.array(line(1, 100)).max(20),
  jobTitles: z.array(line(1, 100)).max(30), published: z.boolean(), courseIds: uniqueIds(100) })
  .refine(v => !v.published || v.courseIds.length > 0, { message: "A published collection needs at least one course." });
export const lessonSchema = z.strictObject({ id, courseId: id.nullable(), title: line(1, 150), body: prose(30, 12_000), question: prose(5, 1000),
  choices: z.array(prose(1, 1000)).min(2).max(4), correctChoice: z.number().int().min(0), explanation: prose(10, 3000),
  minutes: z.number().int().min(3).max(5), published: z.boolean() })
  .refine(v => v.correctChoice < v.choices.length, { message: "Choose one of the answer choices as correct." });
export const metadataSchema = z.strictObject({ courseId: id, language: line(1, 100).nullable(), creditStatement: prose(1, 1500).nullable(),
  creditEvidenceUrl: httpsUrl.nullable() })
  .refine(v => (v.creditStatement === null) === (v.creditEvidenceUrl === null), { message: "Enter both the credit statement and its evidence link, or neither." });
export const kitSchema = z.strictObject({ id, revision: revision.nullable(), name: line(2, 160), description: prose(0, 3000),
  items: z.array(z.strictObject({ courseId: id, isRequired: z.boolean() })).max(100), published: z.boolean() })
  .refine(v => new Set(v.items.map(item => item.courseId.toLowerCase())).size === v.items.length, { message: "Each course can appear once." })
  .refine(v => !v.published || v.items.length > 0, { message: "A published starter kit needs at least one course." });
export type CatalogCollection = z.infer<typeof collectionSchema>;
export type CatalogLesson = z.infer<typeof lessonSchema>;
export type CatalogMetadata = z.infer<typeof metadataSchema>;
export type CatalogKit = z.infer<typeof kitSchema>;

const fits = (value: { operation: string }, record: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength <= 49_152 && !containsGovernedCredentials(JSON.stringify(record));
export const catalogOperationSchema = z.union([
  z.strictObject({ operation: z.literal("catalog.read"), section: z.enum(catalogSections), after: id.nullable() }),
  z.strictObject({ operation: z.literal("collections.save"), requestId: id, collection: collectionSchema }).refine(v => fits(v, v.collection)),
  z.strictObject({ operation: z.literal("refreshers.save"), requestId: id, lesson: lessonSchema }).refine(v => fits(v, v.lesson)),
  z.strictObject({ operation: z.literal("metadata.save"), requestId: id, metadata: metadataSchema }).refine(v => fits(v, v.metadata)),
  z.strictObject({ operation: z.literal("starterKits.save"), requestId: id, kit: kitSchema }).refine(v => fits(v, v.kit)),
]);
export type CatalogOperation = z.infer<typeof catalogOperationSchema>;
export type CatalogSave = Exclude<CatalogOperation, { operation: "catalog.read" }>;

const instant = z.string().refine(v => Number.isFinite(Date.parse(v)));
const storedCollection = z.strictObject({ id, title: z.string(), description: z.string(), interests: z.array(z.string()), jobTitles: z.array(z.string()),
  published: z.boolean(), courseIds: z.array(id), updatedAt: instant });
const storedLesson = z.strictObject({ id, courseId: id.nullable(), title: z.string(), body: z.string(), question: z.string(), choices: z.array(z.string()),
  correctChoice: z.number().int(), explanation: z.string(), minutes: z.number().int(), published: z.boolean(), revision: z.number().int(), updatedAt: instant });
const storedMetadata = z.strictObject({ courseId: id, language: z.string().nullable(), creditStatement: z.string().nullable(), creditEvidenceUrl: z.string().nullable() });
const storedKit = z.strictObject({ id, revision, name: z.string(), description: z.string(), published: z.boolean(),
  items: z.array(z.strictObject({ courseId: id, isRequired: z.boolean() })), updatedAt: instant });
export type StoredCollection = z.infer<typeof storedCollection>;
export type StoredLesson = z.infer<typeof storedLesson>;
export type StoredMetadata = z.infer<typeof storedMetadata>;
export type StoredKit = z.infer<typeof storedKit>;
const storedItems = { collections: storedCollection, lessons: storedLesson, metadata: storedMetadata, starterKits: storedKit } as const;
export type CatalogPage<S extends CatalogSection = CatalogSection> = { section: S; items: z.infer<typeof storedItems[S]>[]; nextAfter: string | null };

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** Checks a CareBase response against the exact operation that was sent. */
export function projectCatalogResult(value: unknown, op: CatalogOperation): CatalogPage | { kit: StoredKit } | { id: string } {
  if (op.operation === "catalog.read") {
    const page = z.strictObject({ section: z.literal(op.section), items: z.array(storedItems[op.section]).max(100), nextAfter: id.nullable() }).parse(value);
    // Pages follow record keys: the next page continues from this page's last record.
    const last = page.items.at(-1) as { id?: string; courseId?: string } | undefined;
    const key = op.section === "metadata" ? last?.courseId : last?.id;
    if (page.nextAfter !== null && (!key || !sameId(page.nextAfter, key))) throw new Error("Catalog page continuation mismatch");
    return page as CatalogPage;
  }
  if (op.operation === "starterKits.save") {
    const result = z.strictObject({ kit: storedKit }).parse(value);
    if (!sameId(result.kit.id, op.kit.id)) throw new Error("Starter kit identity mismatch");
    return result;
  }
  const result = z.strictObject({ id }).parse(value);
  const expected = op.operation === "metadata.save" ? op.metadata.courseId : op.operation === "collections.save" ? op.collection.id : op.lesson.id;
  if (!sameId(result.id, expected)) throw new Error("Catalog record identity mismatch");
  return result;
}
