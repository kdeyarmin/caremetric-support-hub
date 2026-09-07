import type {
  ActorContext,
  CaseMessage,
  ContentItem,
  CreateCaseInput,
  HubRepository,
  Product,
  SupportCase,
  SupportContact,
  UpdateCaseInput,
} from "../domain";

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
];

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
    value: "(877) 521-2890",
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
    productIds: ["prod-carebase", "prod-breathe", "prod-pennsync", "prod-emr"],
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
    productIds: ["prod-carebase", "prod-breathe", "prod-pennsync"],
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
    productIds: ["prod-carebase", "prod-breathe", "prod-pennsync", "prod-emr"],
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
];

const staffActor: ActorContext = {
  id: "agent-demo",
  name: "CareMetric Support",
  role: "support_manager",
  tenantId: null,
  tenantName: null,
};

const customerActor: ActorContext = {
  id: "customer-demo",
  name: "Penn Healthcare Administrator",
  role: "tenant_admin",
  tenantId: "tenant-penn",
  tenantName: "Penn Healthcare",
};

export class DemoSupportRepository implements HubRepository {
  private actor: ActorContext = staffActor;

  setActorRole(role: "staff" | "customer"): void {
    this.actor = role === "staff" ? staffActor : customerActor;
  }

  async getActorContext(): Promise<ActorContext> {
    return { ...this.actor };
  }

  async listProducts(): Promise<Product[]> {
    return products.map((product) => ({ ...product }));
  }

  async listContacts(): Promise<SupportContact[]> {
    return contacts.map((contact) => ({ ...contact }));
  }

  async listCases(): Promise<SupportCase[]> {
    const visible = this.actor.role === "tenant_admin"
      ? cases.filter((item) => item.tenantId === this.actor.tenantId)
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
    const now = new Date().toISOString();
    const nextNumber = Math.max(...cases.map((item) => item.caseNumber)) + 1;
    const nextCase: SupportCase = {
      id: crypto.randomUUID(),
      caseNumber: nextNumber,
      tenantId: input.tenantId,
      tenantName: this.actor.tenantName ?? "Customer organization",
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

  async replyToCase(caseId: string, body: string, visibility: "customer" | "internal"): Promise<CaseMessage> {
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
}

export const demoRepository = new DemoSupportRepository();
