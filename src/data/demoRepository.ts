import { isCentralHubApp } from '../hubScope';
import type {
  ActorContext,
  CaseCategory,
  CaseMessage,
  CasePriority,
  ContentItem,
  CreateCaseInput,
  HubRepository,
  Product,
  SupportCase,
  SupportContact,
  UpdateCaseInput,
} from "../domain";
import { AiNotConfiguredError } from "./supabaseRepository";

const products: Product[] = [
  {
    id: "prod-carebase",
    slug: "carebase",
    name: "CareMetric CareBase",
    description: "Operations, compliance, workforce, and learning management.",
    status: "active",
    color: "#0a7a70",
  },
  {
    id: "prod-breathe",
    slug: "breathe",
    name: "CareMetric Breathe",
    description: "DME resupply, mask fitting, and patient engagement.",
    status: "active",
    color: "#2378c8",
  },
  {
    id: "prod-pennsync",
    slug: "pennsync",
    name: "PennSync",
    description: "Clinical documentation assistance and OASIS workflow support.",
    status: "pilot",
    color: "#7654c6",
  },
  {
    id: "prod-emr",
    slug: "caremetric-emr",
    name: "CareMetric EMR",
    description: "Care delivery, scheduling, billing, and practice operations.",
    status: "pilot",
    color: "#c46a25",
  },
  {
    id: "prod-go",
    slug: "caremetric-go",
    name: "CareMetric Go",
    description: "Secure companion clinical app and patient portal for CareMetric AI.",
    status: "pilot",
    color: "#2563eb",
  },
  {
    id: "prod-intel",
    slug: "caremetric-intel",
    name: "CareMetric Intel",
    description: "Healthcare provider intelligence, CRM, and analytics for post-acute organizations.",
    status: "pilot",
    color: "#0891b2",
  },
  {
    id: "prod-advisors",
    slug: "advisors",
    name: "CareMetric Healthcare Advisors",
    description: "Healthcare and senior-care advisory consultations, acquisition support, and staff education.",
    status: "active",
    color: "#07356F",
  },
].map(product => ({ ...product, status: isCentralHubApp(product.slug) ? product.status : "retired" })) as Product[];

const contacts: SupportContact[] = [
  {
    id: "contact-web",
    productId: null,
    channel: "web",
    label: "Central support portal",
    value: "https://support-hub-web-production.up.railway.app",
    hours: "Available anytime",
    verified: true,
  },
  {
    id: "contact-email",
    productId: null,
    channel: "email",
    label: "Central support email",
    value: "support@caremetric.ai",
    hours: null,
    verified: true,
  },
  {
    id: "contact-phone",
    productId: null,
    channel: "phone",
    label: "Central support phone",
    value: "+18775212890",
    hours: null,
    verified: true,
  },
];

let cases: SupportCase[] = [
  {
    id: "case-1042",
    caseNumber: 1042,
    tenantId: "tenant-penn",
    tenantName: "Penn Healthcare",
    productId: "prod-carebase",
    requesterId: "customer-demo",
    requesterName: "Operations Manager",
    subject: "New employee cannot see assigned course",
    category: "training_content",
    priority: "high",
    status: "in_progress",
    source: "in_app",
    assignedTo: "agent-demo",
    assignedToName: "CareMetric Support",
    appVersion: "2.4.1",
    route: "/training/assignments",
    createdAt: "2026-09-06T13:20:00.000Z",
    updatedAt: "2026-09-06T14:12:00.000Z",
    lastMessageAt: "2026-09-06T14:12:00.000Z",
    aiStage: null,
    aiAttempts: null,
  },
  {
    id: "case-1041",
    caseNumber: 1041,
    tenantId: "tenant-penn",
    tenantName: "Penn Healthcare",
    productId: "prod-breathe",
    requesterId: "customer-demo",
    requesterName: "DME Coordinator",
    subject: "Resupply reminder status is unclear",
    category: "general",
    priority: "normal",
    status: "waiting_on_customer",
    source: "portal",
    assignedTo: "agent-demo",
    assignedToName: "CareMetric Support",
    appVersion: "3.8.2",
    route: "/admin/resupply",
    createdAt: "2026-09-05T15:04:00.000Z",
    updatedAt: "2026-09-06T11:30:00.000Z",
    lastMessageAt: "2026-09-06T11:30:00.000Z",
    aiStage: null,
    aiAttempts: null,
  },
  {
    id: "case-1040",
    caseNumber: 1040,
    tenantId: "tenant-penn",
    tenantName: "Penn Healthcare",
    productId: "prod-pennsync",
    requesterId: "customer-demo",
    requesterName: "Clinical Manager",
    subject: "Unable to finish an OASIS review",
    category: "technical_issue",
    priority: "urgent",
    status: "open",
    source: "in_app",
    assignedTo: null,
    assignedToName: null,
    appVersion: "1.12.0",
    route: "/oasis/review",
    createdAt: "2026-09-06T15:08:00.000Z",
    updatedAt: "2026-09-06T15:08:00.000Z",
    lastMessageAt: "2026-09-06T15:08:00.000Z",
    aiStage: null,
    aiAttempts: null,
  },
  {
    id: "case-1039",
    caseNumber: 1039,
    tenantId: "tenant-penn",
    tenantName: "Penn Healthcare",
    productId: "prod-emr",
    requesterId: "customer-demo",
    requesterName: "Billing Specialist",
    subject: "Claim export walkthrough request",
    category: "training_content",
    priority: "low",
    status: "resolved",
    source: "email",
    assignedTo: "agent-demo",
    assignedToName: "CareMetric Support",
    appVersion: null,
    route: null,
    createdAt: "2026-09-03T09:14:00.000Z",
    updatedAt: "2026-09-04T16:42:00.000Z",
    lastMessageAt: "2026-09-04T16:42:00.000Z",
    aiStage: null,
    aiAttempts: null,
  },
];

let messages: CaseMessage[] = [
  {
    id: "message-1",
    caseId: "case-1042",
    authorId: "customer-demo",
    authorName: "Operations Manager",
    authorRole: "tenant_admin",
    visibility: "customer",
    body: "The employee accepted the invitation and signed in, but the annual compliance course is not listed under Assigned Training.",
    createdAt: "2026-09-06T13:20:00.000Z",
  },
  {
    id: "message-2",
    caseId: "case-1042",
    authorId: "agent-demo",
    authorName: "CareMetric Support",
    authorRole: "support_agent",
    visibility: "customer",
    body: "I found the enrollment and am checking the audience rule on the published course version. No patient information is needed for this review.",
    createdAt: "2026-09-06T14:12:00.000Z",
  },
  {
    id: "message-3",
    caseId: "case-1041",
    authorId: "customer-demo",
    authorName: "DME Coordinator",
    authorRole: "tenant_admin",
    visibility: "customer",
    body: "The dashboard says queued, but the patient-facing timeline says scheduled. Which status should our staff use?",
    createdAt: "2026-09-05T15:04:00.000Z",
  },
  {
    id: "message-4",
    caseId: "case-1041",
    authorId: "agent-demo",
    authorName: "CareMetric Support",
    authorRole: "support_agent",
    visibility: "customer",
    body: "Queued means the reminder is eligible but has not reached its send window. Please confirm the configured local send time shown in Settings.",
    createdAt: "2026-09-06T11:30:00.000Z",
  },
  {
    id: "message-5",
    caseId: "case-1040",
    authorId: "customer-demo",
    authorName: "Clinical Manager",
    authorRole: "tenant_admin",
    visibility: "customer",
    body: "The review returns to the same section after the validation step. This report contains no patient names, identifiers, screenshots, or clinical details.",
    createdAt: "2026-09-06T15:08:00.000Z",
  },
];

const content: ContentItem[] = [
  {
    id: "content-1",
    contentKey: "account.invite-user",
    kind: "article",
    title: "Invite a team member",
    summary: "Add a user, assign the correct role, and confirm access.",
    body: "Open Team, select Invite member, choose the least-privileged role that fits the person's work, and send the invitation. The invitation expires according to your organization's security policy.",
    status: "published",
    accessLevel: "customer",
    productIds: ["prod-carebase", "prod-breathe", "prod-pennsync", "prod-emr", "prod-go", "prod-intel"],
    audience: ["customer-admin"],
    locale: "en-US",
    revision: 12,
    sourceSystem: "support_hub",
    routePattern: "/**/team/**",
  },
  {
    id: "content-2",
    contentKey: "account.invite-user.video",
    kind: "video",
    title: "Inviting and onboarding a new user",
    summary: "A reusable two-minute walkthrough with product-specific screen overlays.",
    body: null,
    status: "review",
    accessLevel: "customer",
    productIds: ["prod-carebase", "prod-breathe"],
    audience: ["customer-admin"],
    locale: "en-US",
    revision: 3,
    sourceSystem: "support_hub",
    routePattern: "/**/team/**",
    videoStatus: "review",
  },
  {
    id: "content-3",
    contentKey: "course.team-onboarding",
    kind: "course",
    title: "CareMetric administrator onboarding",
    summary: "Shared orientation course with product-specific modules and assignments.",
    body: null,
    status: "published",
    accessLevel: "customer",
    productIds: ["prod-carebase", "prod-breathe", "prod-pennsync", "prod-emr", "prod-go", "prod-intel"],
    audience: ["customer-admin", "manager"],
    locale: "en-US",
    revision: 8,
    sourceSystem: "penntrain",
    routePattern: null,
    courseLaunchPath: "/courses/caremetric-administrator-onboarding",
    courseVideoCount: 3,
    courseVideoTitles: [
      "Welcome to CareMetric",
      "Invite and organize your team",
      "Find help across every product",
    ],
  },
  {
    id: "content-4",
    contentKey: "support.protect-patient-information",
    kind: "article",
    title: "Protect patient information in support requests",
    summary: "What to include—and what never to include—when asking for software support.",
    body: "Describe the workflow, product, page, expected behavior, and error wording. Do not include patient names, dates of birth, medical record numbers, diagnoses, screenshots with patient data, or attachments containing clinical information.",
    status: "published",
    accessLevel: "public",
    productIds: ["prod-carebase", "prod-breathe", "prod-pennsync", "prod-emr", "prod-go", "prod-intel", "prod-advisors"],
    audience: ["all"],
    locale: "en-US",
    revision: 1,
    sourceSystem: "support_hub",
    routePattern: null,
  },
  {
    id: "content-5",
    contentKey: "breathe.resupply-statuses",
    kind: "article",
    title: "Understand resupply reminder statuses",
    summary: "Definitions for eligible, queued, scheduled, sent, delivered, and failed.",
    body: "Queued reminders are eligible and waiting for their configured send window. Scheduled reminders have an exact delivery attempt time. Sent means accepted by the delivery provider; delivered means provider-confirmed delivery.",
    status: "published",
    accessLevel: "customer",
    productIds: ["prod-breathe"],
    audience: ["dme-coordinator", "customer-admin"],
    locale: "en-US",
    revision: 5,
    sourceSystem: "support_hub",
    routePattern: "/admin/resupply/**",
  },
  {
    id: "content-6",
    contentKey: "advisors.faq.how-does-an-engagement-begin",
    kind: "article",
    title: "How does an engagement begin?",
    summary: "It starts with a conversation about the decision, problem, or opportunity you are working through.",
    body: "It starts with a conversation about the decision, problem, or opportunity you are working through. CareMetric then outlines a proposed scope, approach, deliverables, and timeline so expectations are clear before any work begins.",
    status: "published",
    accessLevel: "public",
    productIds: ["prod-advisors"],
    audience: ["all"],
    locale: "en-US",
    revision: 1,
    sourceSystem: "legacy",
    routePattern: null,
  },
];

const staffActor: ActorContext = {
  id: "agent-demo",
  name: "CareMetric Support",
  role: "support_manager",
  tenantId: null,
  tenantName: null,
  memberships: [],
};

const customerActor: ActorContext = {
  id: "customer-demo",
  name: "Penn Healthcare Administrator",
  role: "tenant_admin",
  tenantId: "tenant-penn",
  tenantName: "Penn Healthcare",
  memberships: products.map((product) => ({
    tenantId: "tenant-penn",
    tenantName: "Penn Healthcare",
    productId: product.id,
    role: "tenant_admin" as const,
    intakeEnabled: true,
  })),
};

export class DemoSupportRepository implements HubRepository {
  private actor: ActorContext = staffActor;

  setActorRole(role: "staff" | "customer" | "admin"): void {
    this.actor = role === "admin" ? { ...staffActor, id: "admin-demo", name: "CareMetric Administrator", role: "platform_admin" } : role === "staff" ? staffActor : customerActor;
  }

  async getActorContext(): Promise<ActorContext> {
    return {
      ...this.actor,
      memberships: this.actor.memberships.map((membership) => ({ ...membership })),
    };
  }

  async listProducts(): Promise<Product[]> {
    return products.map((product) => ({ ...product }));
  }

  async listContacts(): Promise<SupportContact[]> {
    return contacts.map((contact) => ({ ...contact }));
  }

  async listCases(): Promise<SupportCase[]> {
    const visible = this.actor.role === "tenant_admin" || this.actor.role === "customer"
      ? cases.filter((item) => this.actor.memberships.some((membership) =>
          membership.tenantId === item.tenantId && membership.productId === item.productId))
      : cases;
    return visible.map((item) => ({ ...item }));
  }

  async listMessages(caseId: string): Promise<CaseMessage[]> {
    const includeInternal = this.actor.role !== "tenant_admin" && this.actor.role !== "customer";
    return messages
      .filter((message) => message.caseId === caseId && (includeInternal || message.visibility === "customer"))
      .map((message) => ({ ...message }));
  }

  async listContent(): Promise<ContentItem[]> {
    return content.map((item) => ({ ...item, productIds: [...item.productIds], audience: [...item.audience] }));
  }

  async createCase(input: CreateCaseInput): Promise<SupportCase> {
    if (input.containsPhi) {
      throw new Error("Remove patient or clinical information before creating this support case.");
    }
    const membership = this.actor.memberships.find((candidate) =>
      candidate.tenantId === input.tenantId &&
      candidate.productId === input.productId &&
      candidate.intakeEnabled);
    if (!membership) {
      throw new Error("No active support intake entitlement exists for this organization and product.");
    }
    const now = new Date().toISOString();
    const nextNumber = Math.max(...cases.map((item) => item.caseNumber)) + 1;
    const nextCase: SupportCase = {
      id: crypto.randomUUID(),
      caseNumber: nextNumber,
      tenantId: input.tenantId,
      tenantName: membership.tenantName,
      productId: input.productId,
      requesterId: this.actor.id,
      requesterName: this.actor.name,
      subject: input.subject.trim(),
      category: input.category,
      priority: input.priority,
      status: "open",
      source: "portal",
      assignedTo: null,
      assignedToName: null,
      appVersion: input.appVersion?.trim() || null,
      route: input.route?.trim() || null,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
      aiStage: null,
      aiAttempts: null,
    };
    cases = [nextCase, ...cases];
    messages = [
      ...messages,
      {
        id: crypto.randomUUID(),
        caseId: nextCase.id,
        authorId: this.actor.id,
        authorName: this.actor.name,
        authorRole: this.actor.role,
        visibility: "customer",
        body: input.message.trim(),
        createdAt: now,
      },
    ];
    return { ...nextCase };
  }

  async replyToCase(
    caseId: string,
    body: string,
    visibility: "customer" | "internal",
    _requestKey: string,
  ): Promise<CaseMessage> {
    void _requestKey;
    if (visibility === "internal" && (this.actor.role === "customer" || this.actor.role === "tenant_admin")) {
      throw new Error("Customers cannot create internal notes.");
    }
    const target = cases.find((item) => item.id === caseId);
    if (!target) throw new Error("Support case not found.");
    const now = new Date().toISOString();
    const message: CaseMessage = {
      id: crypto.randomUUID(),
      caseId,
      authorId: this.actor.id,
      authorName: this.actor.name,
      authorRole: this.actor.role,
      visibility,
      body: body.trim(),
      createdAt: now,
    };
    messages = [...messages, message];
    cases = cases.map((item) =>
      item.id === caseId
        ? {
            ...item,
            status: this.actor.role === "tenant_admin" ? "open" : "waiting_on_customer",
            lastMessageAt: now,
            updatedAt: now,
          }
        : item,
    );
    return { ...message };
  }

  async updateCase(caseId: string, input: UpdateCaseInput): Promise<SupportCase> {
    const current = cases.find((item) => item.id === caseId);
    if (!current) throw new Error("Support case not found.");
    const updated: SupportCase = {
      ...current,
      ...input,
      assignedToName:
        input.assignedTo === undefined
          ? current.assignedToName
          : input.assignedTo
            ? "CareMetric Support"
            : null,
      updatedAt: new Date().toISOString(),
    };
    cases = cases.map((item) => (item.id === caseId ? updated : item));
    return { ...updated };
  }

  async summarizeCase(_caseId: string): Promise<string> {
    void _caseId;
    throw new AiNotConfiguredError();
  }

  async draftCaseReply(_caseId: string, _qualityTier?: "draft" | "quality"): Promise<string> {
    void _caseId;
    void _qualityTier;
    throw new AiNotConfiguredError();
  }

  async suggestCaseTriage(_caseId: string): Promise<{ category: CaseCategory; priority: CasePriority }> {
    void _caseId;
    throw new AiNotConfiguredError();
  }

  async respondToAiResolution(caseId: string, fixed: boolean, _requestKey: string): Promise<{ stage: string | null }> {
    void _requestKey;
    const current = cases.find((item) => item.id === caseId);
    if (!current) throw new Error("Support case not found.");
    if (current.aiStage !== "awaiting_response") {
      throw new Error("No AI resolution is waiting for an answer on this case.");
    }
    const now = new Date().toISOString();
    if (fixed) {
      cases = cases.map((item) => (item.id === caseId ? { ...item, status: "resolved", aiStage: "resolved", updatedAt: now } : item));
      return { stage: "resolved" };
    }
    const exhausted = (current.aiAttempts ?? 0) >= 2;
    cases = cases.map((item) => (item.id === caseId
      ? { ...item, aiStage: exhausted ? "exhausted" : "attempt_due", ...(exhausted ? { status: "in_progress" as const, priority: "high" as const } : {}), updatedAt: now }
      : item));
    return { stage: exhausted ? "exhausted" : "attempt_due" };
  }
}

export const demoRepository = new DemoSupportRepository();
