import {
  Activity,
  AlertCircle,
  ArrowRight,
  BookOpen,
  Bot,
  Boxes,
  Building2,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Clock3,
  ExternalLink,
  FileText,
  Gauge,
  GraduationCap,
  Headphones,
  Inbox,
  LayoutDashboard,
  Library,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Mail,
  Menu,
  MessageSquareText,
  MessagesSquare,
  MonitorPlay,
  Phone,
  Plus,
  Rocket,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  UserRound,
  X,
  Zap,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { demoRepository, repository } from "./data";
import { defaultIntegrationRollout, integrationRolloutBySlug } from "./data/integrationRollout";
import {
  categoryLabels,
  isSupportStaff,
  priorityLabels,
  resolveProductSlug,
  statusLabels,
  type ActorContext,
  type CaseCategory,
  type CaseMessage,
  type CasePriority,
  type CaseStatus,
  type ContentItem,
  type Product,
  type SupportCase,
  type SupportContact,
} from "./domain";
import { CourseLibrary, CourseEditor } from "./learning/Editor";
import { CoursePlayer, MyLearning, LearningCertificate } from "./learning/Player";
import { LearningCatalog } from "./learning/Catalog";
import { AiCaseTools } from "./support/AiCaseTools";
import { AiResolutionPrompt } from "./support/AiResolutionPrompt";
import { PhoneInbox } from "./support/PhoneInbox";
import { Communications } from "./support/Communications";
import { channels, conversationStatuses, type Channel, type CommunicationsClient, type ConversationStatus } from "./support/communicationsClient";
import { ChatPanel } from "./support/ChatPanel";
import { KnowledgeCoverage } from "./support/KnowledgeCoverage";
import { demoCommunicationsClient } from "./support/demoCommunications";
import { PhoneRegistry } from "./support/PhoneRegistry";
import { AdminWorkspace } from "./admin/AdminWorkspace";
import { ControlCenter } from "./admin/ControlCenter";
import { PortfolioRollup } from "./admin/PortfolioRollup";
import { GoLiveReadiness } from "./admin/GoLiveReadiness";
import { TenantAccounts } from "./admin/TenantAccounts";
import { SupportReadiness } from "./support/SupportReadiness";
import { adminClient } from "./admin/client";
import { safeLearningPath } from "./learning/model";
import { config } from "./lib/config";
import { appSession } from "./lib/appSession";
import { SmsSignIn } from "./auth/SmsSignIn";
import { JoinHub } from "./auth/JoinHub";
import { PublicationImport } from "./imports/PublicationImport";
import { PublicationVideo } from "./imports/PublicationVideo";
import { DocStudioWorkspace } from "./docstudio/Workspace";
import { courseLaunchUrl } from "./security/courseLaunch";
import { reconcileCaseSelection } from "./security/caseListState";
import { caseTargetByKey, eligibleCaseTargets, preferredCaseTarget } from "./security/caseTargets";
import {
  beginCaseThreadLoad,
  completeCaseThreadLoad,
  emptyCaseThread,
  failCaseThreadLoad,
  readCaseThread,
  type CaseThreadStatus,
} from "./security/caseThreadState";
import { prepareMutationRequest, type PendingMutationRequest } from "./security/mutationRequestKey";

interface HubData {
  actor: ActorContext;
  products: Product[];
  contacts: SupportContact[];
  cases: SupportCase[];
  content: ContentItem[];
}

const emptyData: HubData = {
  actor: { id: "", name: "", role: "customer", tenantId: null, tenantName: null, memberships: [] },
  products: [],
  contacts: [],
  cases: [],
  content: [],
};

const pendingHelpPathKey = "caremetric.pendingHelpPath";
const registeredProductSlugs = new Set(Object.keys(integrationRolloutBySlug));

const navItems = [
  { to: "/admin", label: "Control center", icon: Gauge },
  { to: "/admin/apps", label: "Applications", icon: Boxes },
  { to: "/admin/tenants", label: "Tenants & pricing", icon: Building2 },
  { to: "/phone-numbers", label: "Phone numbers", icon: Phone },
  { to: "/phone", label: "Phone messages", icon: Phone },
  { to: "/admin/portfolio", label: "Portfolio rollup", icon: Activity },
  { to: "/admin/go-live-readiness", label: "AI go-live readiness", icon: Rocket },
  { to: "/overview", label: "Overview", icon: LayoutDashboard },
  { to: "/communications", label: "Communications", icon: MessagesSquare },
  { to: "/cases", label: "Support cases", icon: Inbox },
  { to: "/knowledge", label: "Knowledge", icon: BookOpen },
  { to: "/docstudio", label: "DocStudio", icon: FileText },
  { to: "/library", label: "Videos & courses", icon: Library },
  { to: "/products", label: "Products & contacts", icon: Boxes },
  { to: "/integration", label: "App integration", icon: Link2 },
  { to: "/security", label: "Security", icon: ShieldCheck },
] as const;

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function supportContactHref(contact: SupportContact): string {
  if (contact.channel === "phone") return `tel:${contact.value.replace(/[^+\d]/g, "")}`;
  if (contact.channel === "email") return `mailto:${contact.value}`;
  return contact.value.startsWith("http") ? contact.value : `https://${contact.value}`;
}

function supportContactDisplay(contact: SupportContact): string {
  if (contact.channel === "phone" && contact.value.replace(/\D/g, "") === "18775212890") {
    return config.centralSupportPhoneDisplay;
  }
  return contact.value.replace(/^https?:\/\//, "").replace(/\/$/, "");
}


function routeMatches(pattern: string | null, route: string): boolean {
  if (!pattern || !route) return !pattern;
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "__DOUBLE_STAR__")
    .replaceAll("*", "[^/]*")
    .replaceAll("__DOUBLE_STAR__", ".*");
  return new RegExp(`^${escaped}$`, "i").test(route);
}

function placementsFor(item: ContentItem): NonNullable<ContentItem["placements"]> {
  if (item.placements?.length) return item.placements;
  return item.productIds.map((productId) => ({
    productId,
    audience: item.audience,
    routePattern: item.routePattern,
  }));
}

function rememberPendingPortalPath(value = `${window.location.pathname}${window.location.search}`): void {
  if (value.length > 2048) return;
  try {
    const parsed = new URL(value, window.location.origin);
    if (parsed.origin !== window.location.origin) return;
    if (safeLearningPath(parsed.pathname)) { window.localStorage.setItem(pendingHelpPathKey, parsed.pathname); return; }
    if (!["/help", "/cases"].includes(parsed.pathname)) return;
    if (parsed.pathname === "/cases") {
      const product = (parsed.searchParams.get("product") ?? "").toLowerCase();
      const safe = new URLSearchParams();
      if (parsed.searchParams.get("new") === "1") safe.set("new", "1");
      if (registeredProductSlugs.has(product)) safe.set("product", product);
      window.localStorage.setItem(pendingHelpPathKey, `/cases${safe.size ? `?${safe}` : ""}`);
      return;
    }
    window.localStorage.setItem(pendingHelpPathKey, "/help");
  } catch {
    // Sign-in still works when browser storage is unavailable.
  }
}

function takePendingHelpPath(): string | null {
  try {
    const value = window.localStorage.getItem(pendingHelpPathKey);
    window.localStorage.removeItem(pendingHelpPathKey);
    if (!value || value.length > 2048) return null;
    const parsed = new URL(value, window.location.origin);
    if (parsed.origin !== window.location.origin) return null;
    if (safeLearningPath(parsed.pathname)) return parsed.pathname;
    if (!["/help", "/cases"].includes(parsed.pathname)) return null;
    if (parsed.pathname === "/help") return "/help";
    const product = (parsed.searchParams.get("product") ?? "").toLowerCase();
    const safe = new URLSearchParams();
    if (parsed.searchParams.get("new") === "1") safe.set("new", "1");
    if (registeredProductSlugs.has(product)) safe.set("product", product);
    return `/cases${safe.size ? `?${safe}` : ""}`;
  } catch {
    return null;
  }
}

function caseCode(value: number): string {
  return `CM-${String(value).padStart(6, "0")}`;
}

function productFor(products: Product[], id: string): Product | undefined {
  return products.find((product) => product.id === id);
}

function StatusBadge({ status }: { status: CaseStatus }) {
  return <span className={`badge badge-${status}`}>{statusLabels[status]}</span>;
}

function PriorityBadge({ priority }: { priority: CasePriority }) {
  return <span className={`priority priority-${priority}`}>{priorityLabels[priority]}</span>;
}

function LoadingScreen() {
  return (
    <div className="center-screen">
      <div className="loading-mark"><LoaderCircle size={26} /></div>
      <p>Opening the CareMetric Support Hub…</p>
    </div>
  );
}

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="center-screen">
      <div className="error-mark"><AlertCircle size={25} /></div>
      <h1>We couldn’t open the Support Hub</h1>
      <p>{message}</p>
      <button className="button button-primary" onClick={onRetry}>Try again</button>
    </div>
  );
}

function SecurityPage({ actor }: { actor: ActorContext }) {
  return <><PageHeading eyebrow="Account protection" title="SMS sign-in" description={`Secure CareMetric access for ${actor.name}.`} />
    <section className="panel security-factor-panel"><h2>Your CareMetric session</h2><p>Sign in using a six-digit code sent to your registered mobile number. Codes expire after five minutes and can be used once. This session expires after eight hours.</p>
    <p>To change your registered number or recover access, contact CareMetric support.</p>
    {!config.demoMode && <button className="button button-secondary" onClick={() => void appSession.signOut()}>Sign out</button>}</section></>;
}

/** The control center is the administrator's home. Links from before it existed carried the per-application workspace's query and still open that workspace. */
function AdminHome({ data, communications }: { data: HubData; communications?: CommunicationsClient }) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  if (params.has("product") || params.has("view")) return <Navigate to={`/admin/apps${location.search}`} replace />;
  return <ControlCenter key={data.actor.id} data={data} {...(communications ? { communications } : {})} />;
}

/** The inbox opens with the filters a link carries: a channel, a status, and an application by slug (or repository name) or id. */
function CommunicationsRoute({ data, communications }: { data: HubData; communications?: CommunicationsClient }) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const channel = params.get("channel"), status = params.get("status"), requested = params.get("product");
  const product = requested ? data.products.find((item) => item.slug === resolveProductSlug(requested) || item.id === requested) : undefined;
  const initialFilter = {
    ...(channel && channels.includes(channel as Channel) ? { channel: channel as Channel } : {}),
    ...(status && (status === "active" || conversationStatuses.includes(status as ConversationStatus)) ? { status: status as ConversationStatus | "active" } : {}),
    ...(product ? { productId: product.id } : {}),
  };
  return <Communications key={`${data.actor.id}:${location.search}`} products={data.products} actor={data.actor} initialFilter={initialFilter} {...(communications ? { client: communications } : {})} />;
}

function AppShell({ data, onPersonaChange }: { data: HubData; onPersonaChange: (mode: "staff" | "customer" | "admin") => void }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const staff = isSupportStaff(data.actor.role);
  // The preview's in-memory inbox is created once per data load so replies and notes survive navigation within the session.
  const demoCommunications = useMemo(() => config.demoMode ? demoCommunicationsClient({
    breathe: data.products.find((product) => product.slug === "breathe")?.id, advisors: data.products.find((product) => product.slug === "advisors")?.id, pennsync: data.products.find((product) => product.slug === "pennsync")?.id,
  }) : undefined, [data.products]);

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileOpen ? "sidebar-open" : ""}`}>
        <div className="brand-lockup">
          <span className="brand-icon"><CircleHelp size={21} /></span>
          <span><strong>CareMetric</strong><small>{data.actor.role === "platform_admin" ? "Admin" : "Support Hub"}</small></span>
        </div>
        <nav className="primary-nav" aria-label="Main navigation">
          <p className="nav-label">Workspace</p>
          {navItems.filter(item => (!["/admin", "/admin/apps", "/admin/tenants", "/admin/portfolio", "/admin/go-live-readiness", "/phone", "/phone-numbers"].includes(item.to) || data.actor.role === "platform_admin") && (!["/docstudio", "/communications"].includes(item.to) || staff)).map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} onClick={() => setMobileOpen(false)}>
              <Icon size={18} /> <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-lower">
          <div className="ownership-card">
            <span className="ownership-icon"><LockKeyhole size={17} /></span>
            <div><strong>First-party platform</strong><p>Cases and content stay under CareMetric control.</p></div>
          </div>
          <div className="user-card">
            <span className="avatar">{data.actor.name.charAt(0) || "C"}</span>
            <div className="user-copy"><strong>{data.actor.name}</strong><span>{data.actor.role.replaceAll("_", " ")}</span></div>
            <Settings2 size={17} />
          </div>
        </div>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <button className="icon-button mobile-menu" onClick={() => setMobileOpen((value) => !value)} aria-label="Open navigation">
            {mobileOpen ? <X /> : <Menu />}
          </button>
          <div className="environment-pill"><span /> {config.demoMode ? "Implementation preview" : "Connected environment"}</div>
          <div className="topbar-actions">
            {config.demoMode && (
              <div className="persona-switch" aria-label="Preview persona">
                <button className={data.actor.role === "platform_admin" ? "active" : ""} onClick={() => onPersonaChange("admin")}><Boxes size={15} /> Admin</button>
                <button className={staff && data.actor.role !== "platform_admin" ? "active" : ""} onClick={() => onPersonaChange("staff")}><Headphones size={15} /> Staff</button>
                <button className={!staff ? "active" : ""} onClick={() => onPersonaChange("customer")}><UserRound size={15} /> Customer</button>
              </div>
            )}
            {!config.demoMode && <button className="button button-secondary" onClick={() => void appSession.signOut()}>Sign out</button>}
            <NavLink className="icon-button" to="/help" aria-label="Help"><CircleHelp size={19} /></NavLink>
          </div>
        </header>
        <main className="page-wrap">
          {config.demoMode && (
            <div className="preview-banner">
              <Sparkles size={17} />
              <span><strong>Live implementation preview.</strong> Demo data stays in this session; the dedicated backend is provisioned and remains gated until administrator and compliance setup is complete.</span>
            </div>
          )}
          <Routes>
            <Route path="/phone" element={data.actor.role === "platform_admin" ? <PhoneInbox key={data.actor.id} /> : <Navigate to="/overview" replace />} />
            <Route path="/phone-numbers" element={data.actor.role === "platform_admin" ? <PhoneRegistry key={data.actor.id} /> : <Navigate to="/overview" replace />} />
            <Route path="/admin" element={data.actor.role === "platform_admin" ? <AdminHome data={data} communications={demoCommunications} /> : <Navigate to="/overview" replace />} />
            <Route path="/admin/apps" element={data.actor.role === "platform_admin" ? <AdminWorkspace key={data.actor.id} actorId={data.actor.id} client={adminClient} /> : <Navigate to="/overview" replace />} />
            <Route path="/admin/tenants" element={data.actor.role === "platform_admin" ? <TenantAccounts key={data.actor.id} /> : <Navigate to="/overview" replace />} />
            <Route path="/admin/portfolio" element={data.actor.role === "platform_admin" ? <PortfolioRollup key={data.actor.id} /> : <Navigate to="/overview" replace />} />
            <Route path="/admin/go-live-readiness" element={data.actor.role === "platform_admin" ? <GoLiveReadiness key={data.actor.id} /> : <Navigate to="/overview" replace />} />
            <Route path="/communications" element={staff ? <CommunicationsRoute data={data} communications={demoCommunications} /> : <Navigate to="/overview" replace />} />
            <Route path="/overview" element={<OverviewPage data={data} />} />
            <Route path="/cases" element={<CasesPage key={`${data.actor.id}:${data.actor.role}:${location.search}`} data={data} />} />
            <Route path="/knowledge" element={<KnowledgePage key={location.search} data={data} />} />
            <Route path="/imports/docstudio" element={staff ? <PublicationImport key={data.actor.id} /> : <Navigate to="/knowledge" replace />} />
            <Route path="/docstudio" element={staff ? <DocStudioWorkspace key={data.actor.id} /> : <Navigate to="/knowledge" replace />} />
            <Route path="/library/courses/:itemId" element={<CourseEditor key={window.location.pathname} products={data.products} />} />
            <Route path="/learn/courses/:itemId" element={<CoursePlayer key={window.location.pathname} />} />
            <Route path="/learn/my" element={<MyLearning />} />
            <Route path="/learn/certificates/:enrollmentId" element={<LearningCertificate />} />
            <Route path="/library" element={<CourseLibrary products={data.products} />} />
            <Route path="/products" element={<ProductsPage data={data} />} />
            <Route path="/integration" element={<IntegrationPage data={data} />} />
            <Route path="/security" element={<SecurityPage actor={data.actor} />} />
            <Route path="/help" element={<ContextualHelpPage data={data} />} />
            <Route path="/learn" element={<LearningCatalog products={data.products} legacyContent={data.content} />} />
            <Route path="*" element={<Navigate to={data.actor.role === "platform_admin" ? "/admin" : "/overview"} replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function PublicHelpShell({ data }: { data: HubData }) {
  return (
    <div className="public-help-shell">
      <header className="public-help-header">
        <div className="brand-lockup brand-lockup-large">
          <span className="brand-icon"><CircleHelp size={21} /></span>
          <span><strong>CareMetric</strong><small>Support Hub</small></span>
        </div>
        <nav className="public-help-nav" aria-label="Public support navigation">
          <NavLink to="/help">Help center</NavLink>
          <NavLink to="/learn">Learning library</NavLink>
          <NavLink className="button button-secondary" to="/">Staff and customer sign-in</NavLink>
        </nav>
      </header>
      <main className="public-help-wrap">
        <Routes>
          <Route path="/help" element={<ContextualHelpPage data={data} />} />
          <Route path="/learn" element={<LearningCatalog products={data.products} legacyContent={data.content} />} />
          <Route path="*" element={<Navigate to="/help" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="page-heading">
      <div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>
      {action}
    </div>
  );
}

function OverviewPage({ data }: { data: HubData }) {
  const staff = isSupportStaff(data.actor.role);
  const summary = useMemo(() => ({
    open: data.cases.filter((item) => !["resolved", "closed"].includes(item.status)).length,
    urgent: data.cases.filter((item) => item.priority === "urgent" && !["resolved", "closed"].includes(item.status)).length,
    waiting: data.cases.filter((item) => item.status === "waiting_on_customer").length,
    articles: data.content.filter((item) => item.kind === "article" && item.status === "published").length,
    shared: data.content.filter((item) => item.productIds.length > 1).length,
  }), [data]);
  const recent = data.cases.slice(0, 4);
  const coverage = data.products.map((product) => ({
    ...product,
    count: data.content.filter((item) => item.productIds.includes(product.id)).length,
  }));

  return (
    <>
      <PageHeading
        eyebrow={staff ? "Support operations" : `Welcome, ${data.actor.name.split(" ")[0]}`}
        title={staff ? "Everything your customers need—one place." : "How can we help today?"}
        description={staff
          ? "Manage support across every CareMetric product while sharing one governed library of answers, videos, and courses."
          : "Search shared guidance, open a support case, or continue a conversation with CareMetric."}
        action={<NavLink className="button button-primary" to="/cases"><Plus size={17} /> {staff ? "Open queue" : "New support case"}</NavLink>}
      />
      <section className="metric-grid" aria-label="Support summary">
        <article className="metric-card metric-teal"><span className="metric-icon"><Inbox /></span><div><p>Active cases</p><strong>{summary.open}</strong><small>{staff ? "Across all products" : "For your organization"}</small></div></article>
        <article className="metric-card metric-amber"><span className="metric-icon"><Zap /></span><div><p>Urgent</p><strong>{summary.urgent}</strong><small>{summary.urgent ? "Needs attention" : "No urgent cases"}</small></div></article>
        <article className="metric-card metric-blue"><span className="metric-icon"><BookOpen /></span><div><p>Published answers</p><strong>{summary.articles}</strong><small>In the initial catalog</small></div></article>
        <article className="metric-card metric-violet"><span className="metric-icon"><Boxes /></span><div><p>Reusable items</p><strong>{summary.shared}</strong><small>Shared across products</small></div></article>
      </section>
      <div className="overview-grid">
        <section className="panel">
          <div className="panel-heading"><div><h2>{staff ? "Recent support activity" : "Your recent cases"}</h2><p>Latest conversations across the hub</p></div><NavLink to="/cases" className="text-link">View all <ArrowRight size={15} /></NavLink></div>
          <div className="activity-list">
            {recent.map((supportCase) => {
              const product = productFor(data.products, supportCase.productId);
              return (
                <NavLink to="/cases" className="activity-row" key={supportCase.id}>
                  <span className="product-dot" style={{ background: product?.color }} />
                  <div className="activity-copy"><strong>{supportCase.subject}</strong><span>{caseCode(supportCase.caseNumber)} · {product?.name}</span></div>
                  <StatusBadge status={supportCase.status} />
                  <time>{formatDate(supportCase.lastMessageAt)}</time>
                  <ChevronRight size={17} />
                </NavLink>
              );
            })}
          </div>
        </section>
        <section className="panel coverage-panel">
          <div className="panel-heading"><div><h2>Product coverage</h2><p>Content available by product</p></div></div>
          <div className="coverage-list">
            {coverage.map((product) => (
              <div className="coverage-row" key={product.id}>
                <span className="product-monogram" style={{ background: `${product.color}18`, color: product.color }}>{product.name.charAt(11) || product.name.charAt(0)}</span>
                <div><strong>{product.name}</strong><div className="progress-track"><span style={{ width: `${Math.min(100, product.count * 18 + 18)}%`, background: product.color }} /></div></div>
                <span>{product.count} items</span>
              </div>
            ))}
          </div>
        </section>
      </div>
      <section className="security-strip">
        <span><ShieldCheck /></span>
        <div><strong>Patient information is blocked from the initial support flow.</strong><p>The dedicated environment, BAA, restricted-data queue, retention rules, and attachment scanning must be active before PHI-capable intake is enabled.</p></div>
        <NavLink to="/knowledge" className="button button-secondary">View safe-support guide</NavLink>
      </section>
    </>
  );
}

interface CasesPageProps { data: HubData }

function CasesPage({ data }: CasesPageProps) {
  const location = useLocation();
  const staff = isSupportStaff(data.actor.role);
  const params = new URLSearchParams(location.search);
  const requestedProduct = data.products.find((product) => product.slug === params.get("product"));
  // A link can open the queue for one application: /cases?product=<slug>. The detail pane then starts on that application's first case.
  const [productFilter, setProductFilter] = useState(requestedProduct?.id ?? "all");
  const [selectedId, setSelectedId] = useState<string | null>((requestedProduct ? data.cases.find((item) => item.productId === requestedProduct.id) : data.cases[0])?.id ?? null);
  const [thread, setThread] = useState(emptyCaseThread);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<CaseStatus | "all">("all");
  const [showCreate, setShowCreate] = useState(!staff && (data.cases.length === 0 || params.get("new") === "1"));
  const [refresh, setRefresh] = useState(0);
  const [caseRows, setCaseRows] = useState(data.cases);
  const [caseListError, setCaseListError] = useState("");
  const caseListRequest = useRef(0);

  const reloadCases = async (preferId?: string) => {
    const requestId = ++caseListRequest.current;
    setCaseListError("");
    try {
      const rows = await repository.listCases();
      if (requestId !== caseListRequest.current) return;
      setCaseRows(rows);
      setSelectedId((currentId) => reconcileCaseSelection(rows, currentId, preferId));
    } catch (caught) {
      if (requestId === caseListRequest.current) {
        setCaseListError(caught instanceof Error ? caught.message : "The case list could not be refreshed.");
      }
    }
  };

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    void readCaseThread(repository, selectedId).then((result) => {
      if (!active) return;
      setThread((current) => result.messages
        ? completeCaseThreadLoad(beginCaseThreadLoad(current, result.caseId), result.caseId, result.messages)
        : failCaseThreadLoad(beginCaseThreadLoad(current, result.caseId), result.caseId, result.error));
    });
    return () => { active = false; };
  }, [selectedId, refresh]);

  const selectCase = (caseId: string) => {
    if (caseId === selectedId) return;
    setThread((current) => beginCaseThreadLoad(current, caseId));
    setSelectedId(caseId);
  };

  const visibleCases = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return caseRows.filter((item) =>
      (statusFilter === "all" || item.status === statusFilter) &&
      (productFilter === "all" || item.productId === productFilter) &&
      (!needle || item.subject.toLowerCase().includes(needle) || caseCode(item.caseNumber).toLowerCase().includes(needle) || item.tenantName.toLowerCase().includes(needle)),
    );
  }, [caseRows, productFilter, search, statusFilter]);
  const selected = caseRows.find((item) => item.id === selectedId) ?? null;

  return (
    <>
      <PageHeading
        eyebrow={staff ? "Unified agent console" : "Customer support"}
        title={staff ? "Support case queue" : "Your support cases"}
        description={staff ? "One queue, consistent priorities, and complete context from every connected product." : "Start a secure conversation and track every reply in one place."}
        action={!staff ? <button className="button button-primary" onClick={() => setShowCreate(true)}><Plus size={17} /> New case</button> : undefined}
      />
      {showCreate && !staff && (
        <NewCasePanel data={data} preferredProductId={requestedProduct?.id} onCancel={() => setShowCreate(false)} onCreated={(id) => { setShowCreate(false); void reloadCases(id); }} />
      )}
      <section className="case-workspace">
        <div className="case-list-panel">
          <div className="case-tools">
            <label className="search-box"><Search size={17} /><input aria-label="Search cases" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search cases" /></label>
            <select aria-label="Filter by status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as CaseStatus | "all")}>
              <option value="all">All statuses</option>
              {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <select className="case-application-filter" aria-label="Filter by application" value={productFilter} onChange={(event) => { const next = event.target.value; setProductFilter(next); setSelectedId((current) => reconcileCaseSelection(caseRows.filter((item) => next === "all" || item.productId === next), current)); }}>
              <option value="all">All applications</option>
              {data.products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
            </select>
          </div>
          <div className="case-count">{visibleCases.length} case{visibleCases.length === 1 ? "" : "s"}</div>
          {caseListError && (
            <div className="case-list-error" role="alert">
              <span>{caseListError}</span>
              <button type="button" className="button button-small button-secondary" onClick={() => void reloadCases()}>Retry</button>
            </div>
          )}
          <div className="case-list">
            {visibleCases.map((supportCase) => {
              const product = productFor(data.products, supportCase.productId);
              return (
                <button key={supportCase.id} className={`case-list-row ${selectedId === supportCase.id ? "selected" : ""}`} onClick={() => selectCase(supportCase.id)}>
                  <div className="case-list-top"><span>{caseCode(supportCase.caseNumber)}</span><time>{formatDate(supportCase.lastMessageAt)}</time></div>
                  <strong>{supportCase.subject}</strong>
                  <p>{supportCase.tenantName} · {product?.name}</p>
                  <div className="case-list-bottom"><StatusBadge status={supportCase.status} /><PriorityBadge priority={supportCase.priority} />{supportCase.aiStage === "exhausted" && <span className="ai-escalated-badge">AI escalated</span>}</div>
                </button>
              );
            })}
            {visibleCases.length === 0 && <div className="empty-state"><Inbox /><strong>No cases match</strong><p>Try a different search or status.</p></div>}
          </div>
        </div>
        <div className="case-detail-panel">
          {selected ? (
            <CaseDetail
              key={selected.id}
              supportCase={selected}
              thread={thread.caseId === selected.id ? thread.messages : []}
              threadStatus={thread.caseId === selected.id ? thread.status : "loading"}
              threadError={thread.caseId === selected.id ? thread.error : ""}
              threadStale={thread.caseId === selected.id && thread.stale}
              products={data.products}
              actor={data.actor}
              staff={staff}
              onChanged={() => {
                setThread((current) => beginCaseThreadLoad(current, selected.id));
                setRefresh((value) => value + 1);
                void reloadCases();
              }}
              onRetryThread={() => {
                setThread((current) => beginCaseThreadLoad(current, selected.id));
                setRefresh((value) => value + 1);
              }}
            />
          ) : (
            <div className="empty-state detail-empty"><MessageSquareText /><strong>Select a case</strong><p>Choose a conversation from the queue to see its full history.</p></div>
          )}
        </div>
      </section>
    </>
  );
}

function NewCasePanel({ data, preferredProductId, onCancel, onCreated }: { data: HubData; preferredProductId?: string; onCancel: () => void; onCreated: (id: string) => void }) {
  const caseTargets = useMemo(
    () => eligibleCaseTargets(data.actor, data.products),
    [data.actor, data.products],
  );
  const initialTarget = preferredCaseTarget(caseTargets, preferredProductId);
  const [targetKey, setTargetKey] = useState(initialTarget?.key ?? "");
  const selectedTarget = caseTargetByKey(caseTargets, targetKey);
  const [subject, setSubject] = useState("");
  const [category, setCategory] = useState<CaseCategory>("general");
  const [priority, setPriority] = useState<CasePriority>("normal");
  const [message, setMessage] = useState("");
  const [appVersion, setAppVersion] = useState("");
  const [route, setRoute] = useState("");
  const [containsPhi, setContainsPhi] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pendingRequest = useRef<PendingMutationRequest | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedTarget) {
      setError("No active organization and product entitlement is available for support intake.");
      return;
    }
    if (!acknowledged || containsPhi) return;
    const { tenantId, productId } = selectedTarget;
    const request = prepareMutationRequest(pendingRequest.current, [
      "create-support-case",
      tenantId,
      productId,
      subject,
      category,
      priority,
      message,
      appVersion,
      route,
      containsPhi,
    ]);
    pendingRequest.current = request;
    setSaving(true);
    setError("");
    try {
      const created = await repository.createCase({
        tenantId,
        productId,
        subject,
        category,
        priority,
        message,
        appVersion,
        route,
        containsPhi,
        requestKey: request.requestKey,
      });
      pendingRequest.current = null;
      onCreated(created.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The case could not be created.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="new-case-panel panel">
      <div className="panel-heading"><div><h2>Open a new support case</h2><p>Tell us about the software problem—not a patient or clinical case.</p></div><button className="icon-button" onClick={onCancel} aria-label="Close form"><X size={18} /></button></div>
      <div className="phi-warning"><ShieldCheck size={19} /><div><strong>Do not include protected health information.</strong><p>No patient names, dates of birth, MRNs, diagnoses, clinical notes, or screenshots with patient data.</p></div></div>
      <form className="case-form" onSubmit={submit}>
        <div className="form-grid">
          <label><span>Organization and product</span><select value={targetKey} onChange={(event) => setTargetKey(event.target.value)} required disabled={caseTargets.length === 0}><option value="" disabled>{caseTargets.length === 0 ? "No active support intake" : "Choose an organization and product"}</option>{caseTargets.map((target) => <option key={target.key} value={target.key}>{target.product.name} · {target.tenantName}</option>)}</select></label>
          <label><span>Category</span><select value={category} onChange={(event) => setCategory(event.target.value as CaseCategory)}>{Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label><span>Priority</span><select value={priority} onChange={(event) => setPriority(event.target.value as CasePriority)}>{Object.entries(priorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label><span>App version <small>optional</small></span><input value={appVersion} onChange={(event) => setAppVersion(event.target.value)} maxLength={48} placeholder="e.g. 3.8.2" /></label>
        </div>
        <label><span>Subject</span><input value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={160} placeholder="Briefly describe what is not working" required /></label>
        <label><span>Page or route <small>optional</small></span><input value={route} onChange={(event) => setRoute(event.target.value)} maxLength={256} placeholder="e.g. /training/assignments" /></label>
        <label><span>What happened?</span><textarea value={message} onChange={(event) => setMessage(event.target.value)} minLength={10} maxLength={5000} rows={5} placeholder="Include the steps you took, what you expected, and the exact non-sensitive error wording." required /></label>
        <label className={`check-row ${containsPhi ? "danger-check" : ""}`}><input type="checkbox" checked={containsPhi} onChange={(event) => setContainsPhi(event.target.checked)} /><span><strong>This request contains patient or clinical information.</strong><small>If checked, online submission is blocked. Remove the information before continuing.</small></span></label>
        <label className="check-row"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /><span><strong>I confirm this request contains no patient information.</strong><small>The support team can request a compliant escalation if one is genuinely required.</small></span></label>
        {error && <p className="form-message form-error"><AlertCircle size={16} /> {error}</p>}
        <div className="form-actions"><button type="button" className="button button-secondary" onClick={onCancel}>Cancel</button><button className="button button-primary" disabled={saving || !selectedTarget || !acknowledged || containsPhi || !subject.trim() || message.trim().length < 10}>{saving ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />} Submit case</button></div>
      </form>
    </section>
  );
}

function CaseDetail({ supportCase, thread, threadStatus, threadError, threadStale, products, actor, staff, onChanged, onRetryThread }: { supportCase: SupportCase; thread: CaseMessage[]; threadStatus: CaseThreadStatus; threadError: string; threadStale: boolean; products: Product[]; actor: ActorContext; staff: boolean; onChanged: () => void; onRetryThread: () => void }) {
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<"customer" | "internal">("customer");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pendingReply = useRef<PendingMutationRequest | null>(null);
  const product = productFor(products, supportCase.productId);

  const reply = async () => {
    const submittedBody = body;
    const submittedVisibility = visibility;
    if (!submittedBody.trim()) return;
    const request = prepareMutationRequest(pendingReply.current, [
      "reply-to-support-case",
      supportCase.id,
      submittedBody,
      submittedVisibility,
    ]);
    pendingReply.current = request;
    setSaving(true); setError("");
    try {
      await repository.replyToCase(
        supportCase.id,
        submittedBody,
        submittedVisibility,
        request.requestKey,
      );
      pendingReply.current = null;
      setBody((current) => current === submittedBody ? "" : current);
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The reply could not be saved.");
    } finally { setSaving(false); }
  };

  const update = async (input: { status?: CaseStatus; priority?: CasePriority; assignedTo?: string | null }) => {
    setSaving(true); setError("");
    try { await repository.updateCase(supportCase.id, input); onChanged(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "The case could not be updated."); }
    finally { setSaving(false); }
  };

  return (
    <div className="case-detail">
      <header className="case-detail-header">
        <div className="case-title-line"><span>{caseCode(supportCase.caseNumber)}</span><StatusBadge status={supportCase.status} /><PriorityBadge priority={supportCase.priority} /></div>
        <h2>{supportCase.subject}</h2>
        <div className="case-context"><span className="product-dot" style={{ background: product?.color }} /> {product?.name}<span>•</span>{supportCase.tenantName}<span>•</span>{categoryLabels[supportCase.category]}</div>
        {supportCase.aiStage === "exhausted" && (
          <div className="ai-escalation-banner" role="alert"><Bot size={16} /><span><strong>Escalated — AI attempts exhausted.</strong> Automated help tried {supportCase.aiAttempts ?? 2} suggestions without resolving this case. It needs a human support agent.</span></div>
        )}
      </header>
      {staff && (
        <AiCaseTools
          caseId={supportCase.id}
          disabled={threadStatus !== "ready"}
          onDraft={(text) => { setBody(text); setVisibility("customer"); }}
          onApplyPriority={(priority) => void update({ priority })}
        />
      )}
      {staff && (
        <div className="case-controls">
          <label><span>Status</span><select value={supportCase.status} onChange={(event) => void update({ status: event.target.value as CaseStatus })} disabled={saving}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label><span>Priority</span><select value={supportCase.priority} onChange={(event) => void update({ priority: event.target.value as CasePriority })} disabled={saving}>{Object.entries(priorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <div className="assignment-control"><span>Assigned to</span>{supportCase.assignedTo ? <button className="assignment-chip" onClick={() => void update({ assignedTo: null })}>{supportCase.assignedToName}<X size={13} /></button> : <button className="button button-small" onClick={() => void update({ assignedTo: actor.id })}><UserRound size={14} /> Assign to me</button>}</div>
        </div>
      )}
      <div className="context-grid">
        <div><span>Requester</span><strong>{supportCase.requesterName}</strong></div>
        <div><span>Source</span><strong>{supportCase.source.replaceAll("_", " ")}</strong></div>
        <div><span>App version</span><strong>{supportCase.appVersion ?? "Not supplied"}</strong></div>
        <div><span>Page</span><strong>{supportCase.route ?? "Not supplied"}</strong></div>
      </div>
      <div className="thread" aria-label="Case conversation">
        {threadStatus === "loading" && (
          <div className="thread-load-state"><LoaderCircle className="spin" size={18} /><span>{threadStale ? "Refreshing conversation; the messages below may be stale." : "Loading conversation…"}</span></div>
        )}
        {threadStatus === "error" && (
          <div className="thread-load-state thread-load-error" role="alert">
            <AlertCircle size={18} />
            <span>{threadStale ? "Conversation refresh failed; the messages below may be stale." : threadError || "The conversation could not be loaded."}</span>
            <button type="button" className="button button-small button-secondary" onClick={onRetryThread}>Retry</button>
          </div>
        )}
        {thread.map((message) => {
          const fromAi = message.authorRole === "ai_assistant";
          const fromStaff = !fromAi && isSupportStaff(message.authorRole as Parameters<typeof isSupportStaff>[0]);
          return (
            <article key={message.id} className={`message ${fromStaff ? "message-staff" : ""} ${fromAi ? "message-ai" : ""} ${message.visibility === "internal" ? "message-internal" : ""}`}>
              <span className="message-avatar">{fromAi ? <Bot size={17} /> : fromStaff ? <Headphones size={17} /> : message.authorName.charAt(0)}</span>
              <div className="message-card"><div className="message-meta"><strong>{message.authorName}</strong>{fromAi && <span>Automated</span>}{message.visibility === "internal" && <span>Internal note</span>}<time>{formatDate(message.createdAt)}</time></div><p>{message.body}</p></div>
            </article>
          );
        })}
      </div>
      {!staff && supportCase.aiStage === "awaiting_response" && (
        <AiResolutionPrompt caseId={supportCase.id} onChanged={onChanged} />
      )}
      <div className="reply-box">
        {staff && <div className="reply-tabs"><button className={visibility === "customer" ? "active" : ""} onClick={() => setVisibility("customer")}><MessageSquareText size={14} /> Reply to customer</button><button className={visibility === "internal" ? "active" : ""} onClick={() => setVisibility("internal")}><LockKeyhole size={14} /> Internal note</button></div>}
        <textarea rows={4} value={body} onChange={(event) => setBody(event.target.value)} maxLength={5000} disabled={threadStatus !== "ready"} placeholder={visibility === "internal" ? "Add a note visible only to support staff…" : "Write a reply…"} />
        <div className="reply-footer"><span><ShieldCheck size={14} /> Do not request or repeat patient information.</span><button className="button button-primary" onClick={() => void reply()} disabled={saving || threadStatus !== "ready" || !body.trim()}>{saving ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />} {visibility === "internal" ? "Add note" : "Send reply"}</button></div>
        {error && <p className="form-message form-error"><AlertCircle size={15} /> {error}</p>}
      </div>
    </div>
  );
}

function KnowledgePage({ data }: { data: HubData }) {
  const location = useLocation();
  const [search, setSearch] = useState("");
  // A link can open the catalog filtered to one application: /knowledge?product=<slug>.
  const [productId, setProductId] = useState(() => data.products.find((product) => product.slug === resolveProductSlug(new URLSearchParams(location.search).get("product")))?.id ?? "all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const articles = useMemo(() => data.content.filter((item) => {
    if (item.kind !== "article") return false;
    const needle = search.trim().toLowerCase();
    return (productId === "all" || item.productIds.includes(productId)) && (!needle || `${item.title} ${item.summary} ${item.body ?? ""}`.toLowerCase().includes(needle));
  }), [data.content, productId, search]);
  const selected = data.content.find((item) => item.id === selectedId) ?? null;

  return (
    <>
      <PageHeading eyebrow="Canonical knowledge" title="One answer, wherever customers need it." description="Publish shared core guidance once, then add small product or industry overlays only when the workflow truly differs." />
      {isSupportStaff(data.actor.role) && <KnowledgeCoverage products={data.products} content={data.content} selectedProductId={productId} onSelect={setProductId} canWrite />}
      <section className="library-toolbar panel">
        <label className="search-box large"><Search size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search articles, workflows, and questions" /></label>
        <select value={productId} onChange={(event) => setProductId(event.target.value)}><option value="all">All products</option>{data.products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select>
      </section>
      <div className="knowledge-layout">
        <section className="article-grid">
          {articles.map((article) => (
            <button className="article-card" key={article.id} onClick={() => setSelectedId(article.id)}>
              <div className="article-card-top"><span className="content-kind"><FileText size={15} /> Article</span><span className={`publication-status ${article.status}`}>{article.status}</span></div>
              <h2>{article.title}</h2><p>{article.summary}</p>
              <div className="product-stack">{article.productIds.slice(0, 4).map((id) => { const product = productFor(data.products, id); return <span key={id} title={product?.name} style={{ background: product?.color }}>{product?.name.charAt(0)}</span>; })}<small>{article.productIds.length > 1 ? `Shared across ${article.productIds.length} products` : "Product-specific"}</small></div>
              <div className="article-footer"><span>Rev {article.revision} · {article.locale}</span><ChevronRight size={17} /></div>
            </button>
          ))}
        </section>
        <aside className={`article-preview ${selected ? "open" : ""}`}>
          {selected ? <><button className="icon-button preview-close" onClick={() => setSelectedId(null)}><X size={18} /></button><span className="eyebrow">{selected.contentKey}</span><h2>{selected.title}</h2><p className="preview-summary">{selected.summary}</p><div className="preview-body">{selected.body}</div><div className="preview-meta"><div><span>Source</span><strong>{selected.sourceSystem}</strong></div><div><span>Access</span><strong>{selected.accessLevel}</strong></div><div><span>Revision</span><strong>{selected.revision}</strong></div><div><span>Route</span><strong>{selected.routePattern ?? "Search only"}</strong></div></div></> : <div className="empty-state"><FileText /><strong>Choose an article</strong><p>Preview its canonical copy, placements, and governance details.</p></div>}
        </aside>
      </div>
    </>
  );
}

function ProductsPage({ data }: { data: HubData }) {
  return (
    <>
      <PageHeading eyebrow="Product & contact registry" title="Owner-approved routing from one source." description="Every app reads the same product names, support channels, availability, and fallback rules—eliminating conflicting phone numbers and email addresses." />
      <div className="product-grid">
        {data.products.map((product) => {
          const productContent = data.content.filter((item) => item.productIds.includes(product.id));
          const productCases = data.cases.filter((item) => item.productId === product.id && !["resolved", "closed"].includes(item.status));
          return <article className="product-card" key={product.id}><div className="product-card-header"><span className="product-logo" style={{ background: `${product.color}18`, color: product.color }}>{product.name.charAt(0)}</span><div><h2>{product.name}</h2><span className={`publication-status ${product.status === "active" ? "published" : "review"}`}>{product.status}</span></div></div><p>{product.description}</p><dl><div><dt>Product key</dt><dd>{product.slug}</dd></div><div><dt>Active cases</dt><dd>{productCases.length}</dd></div><div><dt>Published placements</dt><dd>{productContent.length}</dd></div></dl><NavLink className="button button-secondary" to={`/help?product=${encodeURIComponent(product.slug)}`}>Preview help <ArrowRight size={15} /></NavLink></article>;
        })}
      </div>
      <section className="panel contact-registry">
        <div className="panel-heading"><div><h2>Central support channels</h2><p>Unapproved values are never published to applications.</p></div><span className="verified-counter"><ShieldCheck size={16} /> {data.contacts.filter((item) => item.verified).length} of {data.contacts.length} owner-approved</span></div>
        <div className="contact-table"><div className="contact-table-head"><span>Channel</span><span>Published value</span><span>Availability</span><span>Status</span></div>{data.contacts.map((contact) => { const Icon = contact.channel === "phone" ? Phone : contact.channel === "email" ? Mail : ExternalLink; return <div className="contact-table-row" key={contact.id}><span><Icon size={17} /> {contact.label}</span><strong>{contact.verified ? <a href={supportContactHref(contact)} target={contact.channel === "web" ? "_blank" : undefined} rel={contact.channel === "web" ? "noreferrer" : undefined}>{supportContactDisplay(contact)}</a> : supportContactDisplay(contact)}</strong><span>{contact.channel === "email" ? "Mailbox DNS pending" : contact.hours ?? "Not set"}</span><span className={contact.verified ? "verified" : "unverified"}>{contact.verified ? <><CheckCircle2 size={15} /> Owner-approved</> : <><Clock3 size={15} /> Needs approval</>}</span></div>; })}</div>
      </section>
    </>
  );
}

function ContextualHelpPage({ data }: { data: HubData }) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const requestedSlug = (params.get("product") ?? "").trim().toLowerCase();
  const productSlug = resolveProductSlug(requestedSlug);
  const product = data.products.find((item) => item.slug === productSlug);
  const route = (params.get("route") ?? "").split(/[?#]/, 1)[0];
  const feature = (params.get("feature") ?? "").slice(0, 96);
  const appVersion = (params.get("app_version") ?? "").slice(0, 48);
  const environment = (params.get("environment") ?? "").slice(0, 24);
  const productContent = data.content
    .filter((item) => item.status === "published" && (!product || placementsFor(item).some((placement) => placement.productId === product.id)))
    .sort((left, right) => {
      const matches = (item: ContentItem) => placementsFor(item).some((placement) =>
        (!product || placement.productId === product.id) &&
        Boolean(placement.routePattern) &&
        routeMatches(placement.routePattern, route));
      const routePriority = Number(matches(right)) - Number(matches(left));
      if (routePriority) return routePriority;
      const kindPriority = { article: 0, video: 1, course: 2 } as const;
      return kindPriority[left.kind] - kindPriority[right.kind] || left.title.localeCompare(right.title);
    });
  const relevant = productContent.filter((item) => placementsFor(item).some((placement) =>
    (!product || placement.productId === product.id) && routeMatches(placement.routePattern, route)));
  const results = (relevant.length ? relevant : productContent).slice(0, 8);
  const verifiedContacts = data.contacts.filter((item) => item.verified && item.channel !== "web");
  const casePath = `/cases?new=1${product ? `&product=${encodeURIComponent(product.slug)}` : ""}`;

  return (
    <>
      <PageHeading
        eyebrow="Contextual support"
        title={product ? `Help for ${product.name}` : "CareMetric help"}
        description={product
          ? "Guidance shared from the central CareMetric library, filtered for this product and workflow."
          : requestedSlug
            ? `We did not recognize “${requestedSlug}”. The shared catalog and central support team are still available below.`
            : "Search the shared CareMetric library or contact the central support team."}
        action={<div className="heading-actions"><NavLink className="button button-secondary" to={`/learn${product ? `?product=${encodeURIComponent(product.slug)}` : ""}`}><GraduationCap size={17} /> Learning library</NavLink><NavLink className="button button-primary" to={casePath} onClick={() => { if (!data.actor.id) rememberPendingPortalPath(casePath); }}><MessageSquareText size={17} /> Open support</NavLink></div>}
      />
      {(route || feature || appVersion || environment) && (
        <section className="context-strip" aria-label="Application context">
          {feature && <span><strong>Feature</strong>{feature}</span>}
          {route && <span><strong>Page</strong>{route}</span>}
          {appVersion && <span><strong>Version</strong>{appVersion}</span>}
          {environment && <span><strong>Environment</strong>{environment}</span>}
        </section>
      )}
      <div className="context-help-grid">
        <section className="panel contextual-results">
          <div className="panel-heading"><div><h2>Recommended guidance</h2><p>{results.length ? `${results.length} relevant item${results.length === 1 ? "" : "s"} from the governed library` : "No matching content has been published yet"}</p></div><NavLink to="/knowledge" className="text-link">Search everything <ArrowRight size={15} /></NavLink></div>
          {results.length ? results.map((item) => {
            const Icon = item.kind === "article" ? FileText : item.kind === "video" ? MonitorPlay : GraduationCap;
            const launchUrl = courseLaunchUrl(item, config.pennTrainBaseUrl);
            return (
              <article className="contextual-result" key={item.id}>
                <span><Icon size={19} /></span>
                <div>
                  <small>{item.kind} · Rev {item.revision}</small><h3>{item.title}</h3><p>{item.summary}</p>
                  {item.body && <details><summary>Read answer</summary><div>{item.body}</div></details>}
                  {launchUrl && (item.sourceSystem === "support_hub"
                    ? <NavLink className="text-link contextual-action" to={launchUrl}>Open course <ArrowRight size={14} /></NavLink>
                    : <a className="text-link contextual-action" href={launchUrl} target="_blank" rel="noreferrer">Open existing course <ExternalLink size={14} /></a>)}
                  {item.kind === "course" && !launchUrl && <span className="contextual-action action-unavailable"><LockKeyhole size={13} /> Course launch not connected</span>}
                  {item.kind === "video" && (item.sourceSystem === "docstudio" && item.videoStatus === "ready"
                    ? <PublicationVideo key={item.id} revisionId={item.id} title={item.title} locale={item.locale} />
                    : <span className="contextual-action action-unavailable"><Clock3 size={13} /> Video playback available after approval</span>)}
                </div>
              </article>
            );
          }) : <div className="empty-state"><Search /><strong>No exact match yet</strong><p>Contact central support and include the product, page, version, expected behavior, and error wording—never patient information.</p></div>}
        </section>
        <aside className="panel central-contact-panel">
          <span className="eyebrow">One support team</span>
          <h2>Contact CareMetric</h2>
          <p>Every CareMetric product uses these owner-approved contact values. The web portal is live; email delivery still requires mailbox DNS.</p>
          {verifiedContacts.map((contact) => {
            const Icon = contact.channel === "phone" ? Phone : Mail;
            return <a key={contact.id} href={supportContactHref(contact)} className="central-contact-link" aria-label={`${contact.label}: ${supportContactDisplay(contact)}`}><Icon size={19} /><span><small>{contact.label}</small><strong>{supportContactDisplay(contact)}</strong></span><ArrowRight size={16} /></a>;
          })}
          {!verifiedContacts.length && <p className="contact-unavailable">Owner-approved contact values are temporarily unavailable. Use the support case form and do not include patient information.</p>}
          <div className="privacy-note"><ShieldCheck size={16} /> Do not send patient names, identifiers, clinical notes, or screenshots containing patient information.</div>
          <ChatPanel productSlug={product?.slug} productName={product?.name} available={!config.demoMode} />
        </aside>
      </div>
    </>
  );
}

function IntegrationPage({ data }: { data: HubData }) {
  const [copied, setCopied] = useState(false);
  const code = `import { openHelp } from "@caremetric/help-sdk";

const supportRoutes = {
  adminSupport: "/admin/support"
} as const;

openHelp({
  routeAllowlist: Object.values(supportRoutes),
  context: {
    product: "breathe",
    route: supportRoutes.adminSupport,
    appVersion: APP_VERSION,
    environment: "production"
  }
});`;
  const copy = async () => { await navigator.clipboard.writeText(code); setCopied(true); window.setTimeout(() => setCopied(false), 1800); };
  return (
    <>
      <PageHeading eyebrow="Universal Help SDK" title="Connect every app without coupling its backend." description="The first package is framework-neutral and sends only approved application context. Identity and tenant claims will be exchanged server-to-server using short-lived signed tokens." />
      <div className="integration-grid">
        <section className="panel integration-code"><div className="panel-heading"><div><h2>React, Vite, Next.js, or Base44</h2><p>Open contextual help from any screen.</p></div><button className="button button-secondary button-small" onClick={() => void copy()}>{copied ? <Check size={14} /> : <FileText size={14} />} {copied ? "Copied" : "Copy"}</button></div><pre><code>{code}</code></pre></section>
        <section className="panel context-contract"><div className="panel-heading"><div><h2>Approved context contract</h2><p>Deliberately excludes personal and clinical fields.</p></div></div><ul><li><CheckCircle2 /> Product slug</li><li><CheckCircle2 /> App route or feature key</li><li><CheckCircle2 /> App version and environment</li><li><CheckCircle2 /> Locale</li><li className="blocked"><X /> No patient, user, tenant, or free-text data in URLs</li><li className="blocked"><X /> No service-role key in the app</li></ul></section>
      </div>
      <section className="panel rollout-table">
        <div className="panel-heading"><div><h2>Application integration status</h2><p>Verified rollout state by stable product key, independent of display order.</p></div></div>
        <div className="rollout-head"><span>Application</span><span>Previous help</span><span>Central integration</span><span>State</span></div>
        {data.products.map((product) => {
          const rollout = integrationRolloutBySlug[product.slug] ?? defaultIntegrationRollout;
          return <div className="rollout-row" key={product.id}><span><span className="product-dot" style={{ background: product.color }} /> {product.name}</span><span>{rollout.previousHelp}</span><span>{rollout.integration}</span><span className={`state-${rollout.state}`}>{rollout.stateLabel}</span></div>;
        })}
      </section>
      {data.actor.role === "platform_admin" && <SupportReadiness />}
    </>
  );
}

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [data, setData] = useState<HubData>(emptyData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [authenticated, setAuthenticated] = useState(config.demoMode);

  const load = useCallback(async (actorOverride?: ActorContext) => {
    setLoading(true); setError("");
    try {
      const [actor, products, contacts, cases, content] = await Promise.all([
        actorOverride ?? repository.getActorContext(), repository.listProducts(), repository.listContacts(), repository.listCases(), repository.listContent(),
      ]);
      setData({ actor, products, contacts, cases, content });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unknown Support Hub error.");
    } finally { setLoading(false); }
  }, []);

  const loadPublicHelp = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [products, contacts, content] = await Promise.all([
        repository.listProducts(), repository.listContacts(), repository.listContent(),
      ]);
      setData({ ...emptyData, products, contacts, content });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unknown Support Hub error.");
    } finally { setLoading(false); }
  }, []);

  const loadAuthenticated = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const actor = await repository.getActorContext();
      if (window.location.pathname === "/") {
        const pendingPath = takePendingHelpPath();
        if (pendingPath) navigate(pendingPath, { replace: true });
      }
      await load(actor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Your session could not be checked.");
      setLoading(false);
    }
  }, [load, navigate]);

  useEffect(() => {
    if (config.demoMode) { void Promise.resolve().then(() => load()); return; }
    let active = true;
    const refresh = async () => {
      try {
        const session = await appSession.current();
        if (!active) return;
        setAuthenticated(session.authenticated);
        if (session.authenticated) await loadAuthenticated();
        else {
          setData(emptyData);
          if (["/help","/learn"].includes(window.location.pathname)) await loadPublicHelp();
          else setLoading(false);
        }
      } catch {
        if (active) { setAuthenticated(false); setData(emptyData); setLoading(false); }
      }
    };
    void refresh();
    const unsubscribe = appSession.subscribe(() => { void refresh(); });
    return () => { active = false; unsubscribe(); };
  },[load,loadAuthenticated,loadPublicHelp,location.pathname]);

  const changePersona = async (mode: "staff" | "customer" | "admin") => {
    demoRepository.setActorRole(mode);
    await load();
  };

  const publicPortal = !authenticated && !config.demoMode && ["/help", "/learn"].includes(location.pathname);
  if(location.pathname==='/join'&&!config.demoMode)return <JoinHub authenticated={authenticated}/>;
  if (!authenticated && !config.demoMode && !publicPortal) return <SmsSignIn rememberPath={rememberPendingPortalPath} />;
  if (loading) return <LoadingScreen />;
  if (error) return <ErrorScreen message={error} onRetry={() => void (publicPortal ? loadPublicHelp() : authenticated ? loadAuthenticated() : load())} />;
  if (publicPortal) return <PublicHelpShell data={data} />;
  return <AppShell data={data} onPersonaChange={(mode) => void changePersona(mode)} />;
}
