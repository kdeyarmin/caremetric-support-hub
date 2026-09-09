import type {
  ActorContext,
  ActorMembership,
  CaseMessage,
  ContentItem,
  CreateCaseInput,
  HubRepository,
  Product,
  SupportCase,
  SupportContact,
  UpdateCaseInput,
} from "../domain";
import { supabase } from "../lib/supabase";

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The Support Hub returned an invalid response.");
  }
  return value as JsonObject;
};

const asString = (value: unknown, field: string): string => {
  if (typeof value !== "string") throw new Error(`Missing ${field} in Support Hub response.`);
  return value;
};
const asBoolean = (value: unknown, field: string): boolean => {
  if (typeof value !== "boolean") throw new Error(`Missing ${field} in Support Hub response.`);
  return value;
};

const nullableString = (value: unknown): string | null => (typeof value === "string" ? value : null);
const nullableNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const contentPlacements = (value: unknown): NonNullable<ContentItem["placements"]> =>
  Array.isArray(value)
    ? value.flatMap((placement) => {
        if (!placement || typeof placement !== "object" || Array.isArray(placement)) return [];
        const row = placement as JsonObject;
        if (typeof row.product_id !== "string") return [];
        return [{
          productId: row.product_id,
          audience: stringArray(row.audience),
          routePattern: nullableString(row.route_pattern),
        }];
      })
    : [];

const client = () => {
  if (!supabase) throw new Error("Supabase is not configured. Enable demo mode or provide environment variables.");
  return supabase;
};

const hub = () => client().schema("hub");

function mapActorMembership(value: unknown): ActorMembership {
  const row = asObject(value);
  const role = asString(row.role, "membership role");
  if (role !== "customer" && role !== "tenant_admin") {
    throw new Error("Invalid membership role in Support Hub response.");
  }
  return {
    tenantId: asString(row.tenant_id, "membership tenant id"),
    tenantName: asString(row.tenant_name, "membership tenant name"),
    productId: asString(row.product_id, "membership product id"),
    role,
    intakeEnabled: asBoolean(row.intake_enabled, "membership intake state"),
  };
}

function mapActor(value: unknown): ActorContext {
  const row = asObject(value);
  if (!Array.isArray(row.memberships)) {
    throw new Error("Missing actor memberships in Support Hub response.");
  }
  return {
    id: asString(row.id, "actor id"),
    name: asString(row.name, "actor name"),
    role: asString(row.role, "actor role") as ActorContext["role"],
    tenantId: nullableString(row.tenant_id),
    tenantName: nullableString(row.tenant_name),
    memberships: row.memberships.map(mapActorMembership),
  };
}

function mapProduct(value: unknown): Product {
  const row = asObject(value);
  return {
    id: asString(row.id, "product id"),
    slug: asString(row.slug, "product slug"),
    name: asString(row.name, "product name"),
    description: nullableString(row.description) ?? "",
    status: asString(row.status, "product status") as Product["status"],
    color: nullableString(row.color) ?? "#0a7a70",
  };
}

function mapContact(value: unknown): SupportContact {
  const row = asObject(value);
  return {
    id: asString(row.id, "contact id"),
    productId: nullableString(row.product_id),
    channel: asString(row.channel, "contact channel") as SupportContact["channel"],
    label: asString(row.label, "contact label"),
    value: asString(row.value, "contact value"),
    hours: nullableString(row.hours),
    verified: Boolean(row.verified_at),
  };
}

function mapCase(value: unknown): SupportCase {
  const row = asObject(value);
  return {
    id: asString(row.id, "case id"),
    caseNumber: Number(row.case_number),
    tenantId: asString(row.tenant_id, "tenant id"),
    tenantName: asString(row.tenant_name, "tenant name"),
    productId: asString(row.product_id, "product id"),
    requesterId: asString(row.requester_id, "requester id"),
    requesterName: asString(row.requester_name, "requester name"),
    subject: asString(row.subject, "subject"),
    category: asString(row.category, "category") as SupportCase["category"],
    priority: asString(row.priority, "priority") as SupportCase["priority"],
    status: asString(row.status, "status") as SupportCase["status"],
    source: asString(row.source, "source") as SupportCase["source"],
    assignedTo: nullableString(row.assigned_to),
    assignedToName: nullableString(row.assigned_to_name),
    appVersion: nullableString(row.app_version),
    route: nullableString(row.route),
    createdAt: asString(row.created_at, "created timestamp"),
    updatedAt: asString(row.updated_at, "updated timestamp"),
    lastMessageAt: asString(row.last_message_at, "last message timestamp"),
  };
}

function mapMessage(value: unknown): CaseMessage {
  const row = asObject(value);
  return {
    id: asString(row.id, "message id"),
    caseId: asString(row.case_id, "case id"),
    authorId: asString(row.author_id, "author id"),
    authorName: asString(row.author_name, "author name"),
    authorRole: asString(row.author_role, "author role") as CaseMessage["authorRole"],
    visibility: asString(row.visibility, "visibility") as CaseMessage["visibility"],
    body: asString(row.body, "message body"),
    createdAt: asString(row.created_at, "created timestamp"),
  };
}

function mapContent(value: unknown): ContentItem {
  const row = asObject(value);
  return {
    id: asString(row.id, "content id"),
    contentKey: asString(row.content_key, "content key"),
    kind: asString(row.kind, "content kind") as ContentItem["kind"],
    title: asString(row.title, "content title"),
    summary: nullableString(row.summary) ?? "",
    body: nullableString(row.body_markdown),
    status: asString(row.status, "content status") as ContentItem["status"],
    accessLevel: asString(row.access_level, "access level") as ContentItem["accessLevel"],
    productIds: stringArray(row.product_ids),
    audience: stringArray(row.audience),
    locale: asString(row.locale, "locale"),
    revision: Number(row.revision_no),
    sourceSystem: asString(row.source_system, "source system") as ContentItem["sourceSystem"],
    routePattern: nullableString(row.route_pattern),
    videoStatus: nullableString(row.video_status) as ContentItem["videoStatus"],
    courseLaunchPath: nullableString(row.course_launch_path) ?? undefined,
    contentCategory: nullableString(row.content_category) ?? undefined,
    courseDurationMinutes: nullableNumber(row.course_duration_minutes) ?? undefined,
    courseVideoCount: nullableNumber(row.course_video_count) ?? undefined,
    courseVideoTitles: stringArray(row.course_video_titles),
    placements: contentPlacements(row.placements),
  };
}

export class SupabaseSupportRepository implements HubRepository {
  async getActorContext(): Promise<ActorContext> {
    const { data, error } = await hub().rpc("get_support_actor_context");
    if (error) throw error;
    return mapActor(data);
  }

  async listProducts(): Promise<Product[]> {
    const { data, error } = await hub().from("products").select("*").order("name");
    if (error) throw error;
    return (data ?? []).map(mapProduct);
  }

  async listContacts(): Promise<SupportContact[]> {
    const { data, error } = await hub().from("support_contacts").select("*").order("priority_order");
    if (error) throw error;
    return (data ?? []).map(mapContact);
  }

  async listCases(): Promise<SupportCase[]> {
    const { data, error } = await hub()
      .from("support_case_queue")
      .select("*")
      .order("last_message_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapCase);
  }

  async listMessages(caseId: string): Promise<CaseMessage[]> {
    const { data, error } = await hub().rpc("get_support_case_thread", { p_case_id: caseId });
    if (error) throw error;
    return (data ?? []).map(mapMessage);
  }

  async listContent(): Promise<ContentItem[]> {
    const { data, error } = await hub().rpc("list_published_content");
    if (error) throw error;
    return (data ?? []).map(mapContent);
  }

  async createCase(input: CreateCaseInput): Promise<SupportCase> {
    const { data, error } = await hub().rpc("create_support_case", {
      p_tenant_id: input.tenantId,
      p_product_id: input.productId,
      p_subject: input.subject,
      p_category: input.category,
      p_priority: input.priority,
      p_body: input.message,
      p_app_version: input.appVersion ?? null,
      p_route: input.route ?? null,
      p_contains_phi: input.containsPhi,
      p_request_key: input.requestKey,
    });
    if (error) throw error;
    return mapCase(data);
  }

  async replyToCase(
    caseId: string,
    body: string,
    visibility: "customer" | "internal",
    requestKey: string,
  ): Promise<CaseMessage> {
    const { data, error } = await hub().rpc("reply_to_support_case", {
      p_case_id: caseId,
      p_body: body,
      p_visibility: visibility,
      p_request_key: requestKey,
    });
    if (error) throw error;
    return mapMessage(data);
  }

  async updateCase(caseId: string, input: UpdateCaseInput): Promise<SupportCase> {
    const { data, error } = await hub().rpc("update_support_case", {
      p_case_id: caseId,
      p_status: input.status ?? null,
      p_priority: input.priority ?? null,
      p_assigned_to: input.assignedTo ?? null,
      p_change_assignment: input.assignedTo !== undefined,
    });
    if (error) throw error;
    return mapCase(data);
  }
}
