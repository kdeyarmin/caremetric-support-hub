export type ActorRole =
  | "customer"
  | "tenant_admin"
  | "support_agent"
  | "support_manager"
  | "platform_admin";

export type CaseStatus = "open" | "in_progress" | "waiting_on_customer" | "resolved" | "closed";
export type CasePriority = "low" | "normal" | "high" | "urgent";
export type CaseCategory =
  | "general"
  | "technical_issue"
  | "billing"
  | "training_content"
  | "account_access"
  | "feature_request";

export interface ActorContext {
  id: string;
  name: string;
  role: ActorRole;
  tenantId: string | null;
  tenantName: string | null;
}

export interface Product {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: "active" | "pilot" | "retired";
  color: string;
}

export interface SupportContact {
  id: string;
  productId: string | null;
  channel: "email" | "phone" | "web";
  label: string;
  value: string;
  hours: string | null;
  verified: boolean;
}

export interface SupportCase {
  id: string;
  caseNumber: number;
  tenantId: string;
  tenantName: string;
  productId: string;
  requesterId: string;
  requesterName: string;
  subject: string;
  category: CaseCategory;
  priority: CasePriority;
  status: CaseStatus;
  source: "portal" | "in_app" | "email" | "phone" | "api";
  assignedTo: string | null;
  assignedToName: string | null;
  appVersion: string | null;
  route: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
}

export interface CaseMessage {
  id: string;
  caseId: string;
  authorId: string;
  authorName: string;
  authorRole: ActorRole;
  visibility: "customer" | "internal";
  body: string;
  createdAt: string;
}

export interface ContentItem {
  id: string;
  contentKey: string;
  kind: "article" | "video" | "course";
  title: string;
  summary: string;
  body: string | null;
  status: "draft" | "review" | "published" | "retired";
  accessLevel: "public" | "customer" | "staff";
  productIds: string[];
  audience: string[];
  locale: string;
  revision: number;
  sourceSystem: "support_hub" | "penntrain" | "docstudio" | "legacy";
  routePattern: string | null;
  videoStatus?: "ready" | "rendering" | "review";
  courseLaunchPath?: string;
  placements?: Array<{
    productId: string;
    audience: string[];
    routePattern: string | null;
  }>;
}

export interface DashboardSummary {
  openCases: number;
  urgentCases: number;
  waitingCases: number;
  publishedArticles: number;
  sharedAssets: number;
  productsCovered: number;
}

export interface CreateCaseInput {
  tenantId: string;
  productId: string;
  subject: string;
  category: CaseCategory;
  priority: CasePriority;
  message: string;
  appVersion?: string;
  route?: string;
  containsPhi: boolean;
}

export interface UpdateCaseInput {
  status?: CaseStatus;
  priority?: CasePriority;
  assignedTo?: string | null;
}

export interface HubRepository {
  getActorContext(): Promise<ActorContext>;
  listProducts(): Promise<Product[]>;
  listContacts(): Promise<SupportContact[]>;
  listCases(): Promise<SupportCase[]>;
  listMessages(caseId: string): Promise<CaseMessage[]>;
  listContent(): Promise<ContentItem[]>;
  createCase(input: CreateCaseInput): Promise<SupportCase>;
  replyToCase(caseId: string, body: string, visibility: "customer" | "internal"): Promise<CaseMessage>;
  updateCase(caseId: string, input: UpdateCaseInput): Promise<SupportCase>;
}

export const categoryLabels: Record<CaseCategory, string> = {
  general: "General question",
  technical_issue: "Technical issue",
  billing: "Billing",
  training_content: "Training or content",
  account_access: "Account access",
  feature_request: "Feature request",
};

export const statusLabels: Record<CaseStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  waiting_on_customer: "Waiting on customer",
  resolved: "Resolved",
  closed: "Closed",
};

export const priorityLabels: Record<CasePriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

export function isSupportStaff(role: ActorRole): boolean {
  return role === "support_agent" || role === "support_manager" || role === "platform_admin";
}
