export type AdminOperation =
  | { operation: "overview" }
  | { operation: "courses.list"; search?: string; limit: number; offset: number }
  | { operation: "courses.get"; courseId: string };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === "string" && uuid.test(value);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid contract");
  return value as Record<string, unknown>;
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) throw new Error("Invalid contract");
  return value;
}
function text(value: unknown, max = 1000): string {
  if (typeof value !== "string" || value.length > max) throw new Error("Invalid contract");
  return value;
}
function nullableText(value: unknown, max = 1000): string | null { return value === null ? null : text(value, max); }
function id(value: unknown): string { if (!isUuid(value)) throw new Error("Invalid contract"); return value.toLowerCase(); }

export function parseAdminOperation(input: unknown): AdminOperation {
  const row = object(input);
  let fields: string[];
  let output: AdminOperation;
  if (row.operation === "overview") { fields = ["operation"]; output = { operation: "overview" }; }
  else if (row.operation === "courses.get") {
    fields = ["operation", "courseId"]; output = { operation: "courses.get", courseId: id(row.courseId) };
  } else if (row.operation === "courses.list") {
    fields = ["operation", "search", "limit", "offset"];
    const limit = integer(row.limit ?? 20, 50);
    if (limit < 1) throw new Error("Invalid contract");
    output = { operation: "courses.list", limit, offset: integer(row.offset ?? 0, 10000) };
    if (row.search !== undefined) {
      output.search = text(row.search, 100);
      if (Array.from(output.search).some(character => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127 || character === "*";
      })) throw new Error("Invalid contract");
    }
  } else throw new Error("Invalid contract");
  if (Object.keys(row).some(key => !fields.includes(key))) throw new Error("Invalid contract");
  return output;
}

function course(input: unknown) {
  const row = object(input);
  return {
    id: id(row.id), title: text(row.title, 1000), description: nullableText(row.description, 60000),
    category: nullableText(row.category, 500), status: text(row.status, 100),
    estimatedDurationMinutes: row.estimatedDurationMinutes === null ? null : integer(row.estimatedDurationMinutes, 100000),
    updatedAt: text(row.updatedAt, 100),
  };
}

/** Project onto the reviewed fields even if an upstream response grows new fields. */
export function parseAdminEnvelope(input: unknown, request: AdminOperation) {
  const envelope = object(input);
  if (envelope.contractVersion !== 1 || envelope.product !== "carebase" || envelope.operation !== request.operation
    || !Number.isFinite(Date.parse(text(envelope.generatedAt, 100)))) throw new Error("Invalid contract");
  const row = object(envelope.data);
  let data;
  if (request.operation === "overview") {
    data = { organizationCount: integer(row.organizationCount), activeUserCount: integer(row.activeUserCount), globalCourseCount: integer(row.globalCourseCount) };
  } else if (request.operation === "courses.list") {
    if (!Array.isArray(row.items) || row.items.length > request.limit || row.limit !== request.limit || row.offset !== request.offset) throw new Error("Invalid contract");
    data = { items: row.items.map(course), total: integer(row.total), limit: request.limit, offset: request.offset };
  } else {
    if (!Array.isArray(row.lessons) || row.lessons.length > 200 || typeof row.lessonsTruncated !== "boolean") throw new Error("Invalid contract");
    const summary = course(row.course);
    if (summary.id !== request.courseId.toLowerCase()) throw new Error("Invalid contract");
    data = { course: summary, lessons: row.lessons.map(value => {
      const lesson = object(value);
      if (typeof lesson.position !== "number" || !Number.isSafeInteger(lesson.position)) throw new Error("Invalid contract");
      return { id: id(lesson.id), title: nullableText(lesson.title, 1000), type: text(lesson.type, 100), position: lesson.position };
    }), lessonsTruncated: row.lessonsTruncated };
  }
  return { contractVersion: 1 as const, product: "carebase" as const, operation: request.operation, generatedAt: String(envelope.generatedAt), data };
}
