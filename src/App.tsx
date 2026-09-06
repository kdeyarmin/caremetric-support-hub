import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  Boxes,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Clock3,
  ExternalLink,
  FileText,
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
  MonitorPlay,
  Phone,
  Plus,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  UserRound,
  UsersRound,
  Video,
  X,
  Zap,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { demoRepository, repository } from "./data";
import {
  categoryLabels,
  isSupportStaff,
  priorityLabels,
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
import { config } from "./lib/config";
import { supabase } from "./lib/supabase";

interface HubData {
  actor: ActorContext;
  products: Product[];
  contacts: SupportContact[];
  cases: SupportCase[];
  content: ContentItem[];
}

const emptyData: HubData = {
  actor: { id: "", name: "", role: "customer", tenantId: null, tenantName: null },
  products: [],
  contacts: [],
  cases: [],
  content: [],
};

const navItems = [
  { to: "/overview", label: "Overview", icon: LayoutDashboard },
  { to: "/cases", label: "Support cases", icon: Inbox },
  { to: "/knowledge", label: "Knowledge", icon: BookOpen },
  { to: "/library", label: "Videos & courses", icon: Library },
  { to: "/products", label: "Products & contacts", icon: Boxes },
  { to: "/integration", label: "App integration", icon: Link2 },
] as const;

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
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

function SignInScreen() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [message, setMessage] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabase || !email.trim()) return;
    setBusy(true);
    setHasError(false);
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        shouldCreateUser: true,
        emailRedirectTo: window.location.origin,
      },
    });
    setBusy(false);
    if (error) {
      setHasError(true);
      setMessage(error.message);
      return;
    }
    setSent(true);
    setMessage("Check your email and click the secure sign-in link. It will return you here.");
  };

  return (
    <main className="sign-in-page">
      <section className="sign-in-panel">
        <div className="brand-lockup brand-lockup-large">
          <span className="brand-icon"><CircleHelp size={25} /></span>
          <span><strong>CareMetric</strong><small>Support Hub</small></span>
        </div>
        <div className="sign-in-copy">
          <span className="eyebrow">One place for every product</span>
          <h1>Answers, training, and real support from CareMetric.</h1>
          <p>Use the same secure email associated with your CareMetric account.</p>
        </div>
        <form onSubmit={submit} className="sign-in-form">
          <label htmlFor="email">Work email</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@company.com"
            disabled={sent}
            required
          />
          <button className="button button-primary" disabled={busy || sent}>
            {busy ? <LoaderCircle className="spin" size={17} /> : <Mail size={17} />}
            {sent ? "Check your email" : "Email secure sign-in link"}
          </button>
          {sent && !busy && <button type="button" className="button button-secondary" onClick={() => { setSent(false); setMessage(""); }}>Use a different email</button>}
          {message && <p className={`form-message ${hasError ? "form-error" : "form-success"}`}>{message}</p>}
        </form>
        <div className="privacy-note"><ShieldCheck size={16} /> CareMetric-managed support. Never include patient information in a support request.</div>
      </section>
      <aside className="sign-in-aside" aria-label="Support Hub capabilities">
        <div className="aside-orbit orbit-one" />
        <div className="aside-orbit orbit-two" />
        <div className="capability-card card-one"><MessageSquareText /><span>Central case management</span></div>
        <div className="capability-card card-two"><MonitorPlay /><span>Shared explainer videos</span></div>
        <div className="capability-card card-three"><GraduationCap /><span>One course catalog</span></div>
      </aside>
    </main>
  );
}

function AppShell({ data, onPersonaChange }: { data: HubData; onPersonaChange: (mode: "staff" | "customer") => void }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const staff = isSupportStaff(data.actor.role);

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileOpen ? "sidebar-open" : ""}`}>
        <div className="brand-lockup">
          <span className="brand-icon"><CircleHelp size={21} /></span>
          <span><strong>CareMetric</strong><small>Support Hub</small></span>
        </div>
        <nav className="primary-nav" aria-label="Main navigation">
          <p className="nav-label">Workspace</p>
          {navItems.map(({ to, label, icon: Icon }) => (
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
                <button className={staff ? "active" : ""} onClick={() => onPersonaChange("staff")}><Headphones size={15} /> Staff</button>
                <button className={!staff ? "active" : ""} onClick={() => onPersonaChange("customer")}><UserRound size={15} /> Customer</button>
              </div>
            )}
            {!config.demoMode && <button className="button button-secondary" onClick={() => void supabase?.auth.signOut()}>Sign out</button>}
            <button className="icon-button" aria-label="Help"><CircleHelp size={19} /></button>
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
            <Route path="/overview" element={<OverviewPage data={data} />} />
            <Route path="/cases" element={<CasesPage key={`${data.actor.id}:${data.actor.role}`} data={data} />} />
            <Route path="/knowledge" element={<KnowledgePage data={data} />} />
            <Route path="/library" element={<ContentLibraryPage data={data} />} />
            <Route path="/products" element={<ProductsPage data={data} />} />
            <Route path="/integration" element={<IntegrationPage data={data} />} />
            <Route path="*" element={<Navigate to="/overview" replace />} />
          </Routes>
        </main>
      </div>
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
  const staff = isSupportStaff(data.actor.role);
  const [selectedId, setSelectedId] = useState(data.cases[0]?.id ?? null);
  const [thread, setThread] = useState<CaseMessage[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<CaseStatus | "all">("all");
  const [showCreate, setShowCreate] = useState(!staff && data.cases.length === 0);
  const [refresh, setRefresh] = useState(0);
  const [caseRows, setCaseRows] = useState(data.cases);

  const reloadCases = useCallback(async (preferId?: string) => {
    const rows = await repository.listCases();
    setCaseRows(rows);
    setSelectedId(preferId ?? ((current) => current && rows.some((item) => item.id === current) ? current : rows[0]?.id ?? null));
    setRefresh((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    void repository.listMessages(selectedId).then((rows) => {
      if (active) setThread(rows);
    });
    return () => { active = false; };
  }, [selectedId, refresh]);

  const visibleCases = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return caseRows.filter((item) =>
      (statusFilter === "all" || item.status === statusFilter) &&
      (!needle || item.subject.toLowerCase().includes(needle) || caseCode(item.caseNumber).toLowerCase().includes(needle) || item.tenantName.toLowerCase().includes(needle)),
    );
  }, [caseRows, search, statusFilter]);
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
        <NewCasePanel data={data} onCancel={() => setShowCreate(false)} onCreated={(id) => { setShowCreate(false); void reloadCases(id); }} />
      )}
      <section className="case-workspace">
        <div className="case-list-panel">
          <div className="case-tools">
            <label className="search-box"><Search size={17} /><input aria-label="Search cases" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search cases" /></label>
            <select aria-label="Filter by status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as CaseStatus | "all")}>
              <option value="all">All statuses</option>
              {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          <div className="case-count">{visibleCases.length} case{visibleCases.length === 1 ? "" : "s"}</div>
          <div className="case-list">
            {visibleCases.map((supportCase) => {
              const product = productFor(data.products, supportCase.productId);
              return (
                <button key={supportCase.id} className={`case-list-row ${selectedId === supportCase.id ? "selected" : ""}`} onClick={() => setSelectedId(supportCase.id)}>
                  <div className="case-list-top"><span>{caseCode(supportCase.caseNumber)}</span><time>{formatDate(supportCase.lastMessageAt)}</time></div>
                  <strong>{supportCase.subject}</strong>
                  <p>{supportCase.tenantName} · {product?.name}</p>
                  <div className="case-list-bottom"><StatusBadge status={supportCase.status} /><PriorityBadge priority={supportCase.priority} /></div>
                </button>
              );
            })}
            {visibleCases.length === 0 && <div className="empty-state"><Inbox /><strong>No cases match</strong><p>Try a different search or status.</p></div>}
          </div>
        </div>
        <div className="case-detail-panel">
          {selected ? (
            <CaseDetail
              supportCase={selected}
              thread={thread}
              products={data.products}
              actor={data.actor}
              staff={staff}
              onChanged={() => void reloadCases(selected.id)}
            />
          ) : (
            <div className="empty-state detail-empty"><MessageSquareText /><strong>Select a case</strong><p>Choose a conversation from the queue to see its full history.</p></div>
          )}
        </div>
      </section>
    </>
  );
}

function NewCasePanel({ data, onCancel, onCreated }: { data: HubData; onCancel: () => void; onCreated: (id: string) => void }) {
  const [productId, setProductId] = useState(data.products[0]?.id ?? "");
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

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!data.actor.tenantId || !acknowledged || containsPhi) return;
    setSaving(true);
    setError("");
    try {
      const created = await repository.createCase({
        tenantId: data.actor.tenantId,
        productId,
        subject,
        category,
        priority,
        message,
        appVersion,
        route,
        containsPhi,
      });
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
          <label><span>Product</span><select value={productId} onChange={(event) => setProductId(event.target.value)} required>{data.products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
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
        <div className="form-actions"><button type="button" className="button button-secondary" onClick={onCancel}>Cancel</button><button className="button button-primary" disabled={saving || !acknowledged || containsPhi || !subject.trim() || message.trim().length < 10}>{saving ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />} Submit case</button></div>
      </form>
    </section>
  );
}

function CaseDetail({ supportCase, thread, products, actor, staff, onChanged }: { supportCase: SupportCase; thread: CaseMessage[]; products: Product[]; actor: ActorContext; staff: boolean; onChanged: () => void }) {
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<"customer" | "internal">("customer");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const product = productFor(products, supportCase.productId);

  const reply = async () => {
    if (!body.trim()) return;
    setSaving(true); setError("");
    try {
      await repository.replyToCase(supportCase.id, body, visibility);
      setBody("");
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
      </header>
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
        {thread.map((message) => {
          const fromStaff = isSupportStaff(message.authorRole);
          return (
            <article key={message.id} className={`message ${fromStaff ? "message-staff" : ""} ${message.visibility === "internal" ? "message-internal" : ""}`}>
              <span className="message-avatar">{fromStaff ? <Headphones size={17} /> : message.authorName.charAt(0)}</span>
              <div className="message-card"><div className="message-meta"><strong>{message.authorName}</strong>{message.visibility === "internal" && <span>Internal note</span>}<time>{formatDate(message.createdAt)}</time></div><p>{message.body}</p></div>
            </article>
          );
        })}
      </div>
      <div className="reply-box">
        {staff && <div className="reply-tabs"><button className={visibility === "customer" ? "active" : ""} onClick={() => setVisibility("customer")}><MessageSquareText size={14} /> Reply to customer</button><button className={visibility === "internal" ? "active" : ""} onClick={() => setVisibility("internal")}><LockKeyhole size={14} /> Internal note</button></div>}
        <textarea rows={4} value={body} onChange={(event) => setBody(event.target.value)} maxLength={5000} placeholder={visibility === "internal" ? "Add a note visible only to support staff…" : "Write a reply…"} />
        <div className="reply-footer"><span><ShieldCheck size={14} /> Do not request or repeat patient information.</span><button className="button button-primary" onClick={() => void reply()} disabled={saving || !body.trim()}>{saving ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />} {visibility === "internal" ? "Add note" : "Send reply"}</button></div>
        {error && <p className="form-message form-error"><AlertCircle size={15} /> {error}</p>}
      </div>
    </div>
  );
}

function KnowledgePage({ data }: { data: HubData }) {
  const [search, setSearch] = useState("");
  const [productId, setProductId] = useState("all");
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

function ContentLibraryPage({ data }: { data: HubData }) {
  const videos = data.content.filter((item) => item.kind === "video");
  const courses = data.content.filter((item) => item.kind === "course");
  return (
    <>
      <PageHeading eyebrow="Shared learning library" title="Create once. Publish everywhere." description="HeyGen renders the approved script; the Support Hub owns the catalog and published asset; PennTrain continues to own assignments, tests, and certificates." action={<button className="button button-primary" disabled title="Enabled after media credentials are connected"><Plus size={17} /> New content</button>} />
      <section className="pipeline panel">
        <div className="pipeline-step complete"><span><Check /></span><div><strong>Approved source</strong><small>Support Hub revision</small></div></div><ChevronRight />
        <div className="pipeline-step active"><span><Video /></span><div><strong>HeyGen render</strong><small>Server-side job</small></div></div><ChevronRight />
        <div className="pipeline-step"><span><ShieldCheck /></span><div><strong>Review & captions</strong><small>Human approval</small></div></div><ChevronRight />
        <div className="pipeline-step"><span><MonitorPlay /></span><div><strong>Controlled publish</strong><small>Stable content key</small></div></div>
      </section>
      <div className="content-columns">
        <section className="panel content-section"><div className="panel-heading"><div><h2>Explainer videos</h2><p>Immutable renders connected to approved revisions</p></div><span className="count-pill">{videos.length}</span></div>{videos.map((item) => <article className="media-row" key={item.id}><div className="media-thumb"><MonitorPlay /><span>2:14</span></div><div className="media-copy"><div><span className="content-key">{item.contentKey}</span><span className={`publication-status ${item.videoStatus}`}>{item.videoStatus}</span></div><h3>{item.title}</h3><p>{item.summary}</p><div className="media-meta"><span><Boxes size={14} /> {item.productIds.length} products</span><span><FileText size={14} /> Rev {item.revision}</span><span><ShieldCheck size={14} /> Captions required</span></div></div><button className="icon-button"><ChevronRight /></button></article>)}</section>
        <section className="panel content-section"><div className="panel-heading"><div><h2>PennTrain course catalog</h2><p>Searchable metadata; learning records remain in PennTrain</p></div><span className="count-pill">{courses.length}</span></div>{courses.map((item) => <article className="course-row" key={item.id}><span className="course-icon"><GraduationCap /></span><div><span className="content-key">{item.contentKey}</span><h3>{item.title}</h3><p>{item.summary}</p><div className="media-meta"><span><UsersRound size={14} /> {item.audience.join(", ")}</span><span><Boxes size={14} /> {item.productIds.length} products</span></div></div><button className="button button-secondary button-small">Open in PennTrain <ExternalLink size={14} /></button></article>)}</section>
      </div>
      <section className="ownership-boundary panel"><div><strong>Content ownership boundary</strong><p>No HeyGen URL is embedded in an app. Products resolve a stable Support Hub content key, while final media is rehosted and can be rolled back independently.</p></div><span><LockKeyhole /> Provider-independent</span></section>
    </>
  );
}

function ProductsPage({ data }: { data: HubData }) {
  return (
    <>
      <PageHeading eyebrow="Product & contact registry" title="Verified routing from one source." description="Every app reads the same product names, support channels, availability, and fallback rules—eliminating conflicting phone numbers and email addresses." />
      <div className="product-grid">
        {data.products.map((product) => {
          const productContent = data.content.filter((item) => item.productIds.includes(product.id));
          const productCases = data.cases.filter((item) => item.productId === product.id && !["resolved", "closed"].includes(item.status));
          return <article className="product-card" key={product.id}><div className="product-card-header"><span className="product-logo" style={{ background: `${product.color}18`, color: product.color }}>{product.name.charAt(0)}</span><div><h2>{product.name}</h2><span className={`publication-status ${product.status === "active" ? "published" : "review"}`}>{product.status}</span></div></div><p>{product.description}</p><dl><div><dt>Product key</dt><dd>{product.slug}</dd></div><div><dt>Active cases</dt><dd>{productCases.length}</dd></div><div><dt>Published placements</dt><dd>{productContent.length}</dd></div></dl><button className="button button-secondary">Manage routing <ArrowRight size={15} /></button></article>;
        })}
      </div>
      <section className="panel contact-registry">
        <div className="panel-heading"><div><h2>Central support channels</h2><p>Unverified values are never published to applications.</p></div><span className="verified-counter"><ShieldCheck size={16} /> {data.contacts.filter((item) => item.verified).length} of {data.contacts.length} verified</span></div>
        <div className="contact-table"><div className="contact-table-head"><span>Channel</span><span>Published value</span><span>Availability</span><span>Status</span></div>{data.contacts.map((contact) => { const Icon = contact.channel === "phone" ? Phone : contact.channel === "email" ? Mail : ExternalLink; return <div className="contact-table-row" key={contact.id}><span><Icon size={17} /> {contact.label}</span><strong>{contact.value}</strong><span>{contact.hours ?? "Not set"}</span><span className={contact.verified ? "verified" : "unverified"}>{contact.verified ? <><CheckCircle2 size={15} /> Verified</> : <><Clock3 size={15} /> Needs verification</>}</span></div>; })}</div>
      </section>
    </>
  );
}

function IntegrationPage({ data }: { data: HubData }) {
  const [copied, setCopied] = useState(false);
  const code = `import { openHelp } from "@caremetric/help-sdk";

openHelp({
  baseUrl: "${config.helpBaseUrl}",
  context: {
    product: "pennfit",
    route: window.location.pathname,
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
        <div className="panel-heading"><div><h2>Planned application rollout</h2><p>Start with the strongest reference implementation, then prove cross-stack portability.</p></div></div>
        <div className="rollout-head"><span>Application</span><span>Current help</span><span>First integration</span><span>State</span></div>
        {data.products.map((product, index) => <div className="rollout-row" key={product.id}><span><span className="product-dot" style={{ background: product.color }} /> {product.name}</span><span>{index === 0 ? "PennTrain DB articles + tickets" : index === 1 ? "Two embedded help stores" : index === 2 ? "Static help page" : "Local support center"}</span><span>{index === 0 ? "Import content + redirect" : index === 1 ? "SDK pilot + route mapping" : "SDK launcher + legacy fallback"}</span><span className={index < 2 ? "state-progress" : "state-planned"}>{index === 0 ? "Source mapped" : index === 1 ? "Pilot" : "Planned"}</span></div>)}
      </section>
    </>
  );
}

export default function App() {
  const [data, setData] = useState<HubData>(emptyData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [authenticated, setAuthenticated] = useState(config.demoMode);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [actor, products, contacts, cases, content] = await Promise.all([
        repository.getActorContext(), repository.listProducts(), repository.listContacts(), repository.listCases(), repository.listContent(),
      ]);
      setData({ actor, products, contacts, cases, content });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unknown Support Hub error.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (config.demoMode) { void Promise.resolve().then(load); return; }
    void supabase?.auth.getSession().then(({ data: sessionData }) => {
      setAuthenticated(Boolean(sessionData.session));
      if (sessionData.session) void load(); else setLoading(false);
    });
    const subscription = supabase?.auth.onAuthStateChange((_event, session) => {
      setAuthenticated(Boolean(session));
      if (session) void load();
    });
    return () => subscription?.data.subscription.unsubscribe();
  }, [load]);

  const changePersona = async (mode: "staff" | "customer") => {
    demoRepository.setActorRole(mode);
    await load();
  };

  if (!authenticated && !config.demoMode) return <SignInScreen />;
  if (loading) return <LoadingScreen />;
  if (error) return <ErrorScreen message={error} onRetry={() => void load()} />;
  return <AppShell data={data} onPersonaChange={(mode) => void changePersona(mode)} />;
}
