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
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { demoRepository, repository } from "./data";
import { defaultIntegrationRollout, integrationRolloutBySlug } from "./data/integrationRollout";
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
import { careBaseCourseLaunchUrl } from "./security/careBaseCourseLaunch";
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
import { decideMfaGate, normalizeAuthenticatorLevel, type MfaGate } from "./security/mfaGate";
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
  { to: "/overview", label: "Overview", icon: LayoutDashboard },
  { to: "/cases", label: "Support cases", icon: Inbox },
  { to: "/knowledge", label: "Knowledge", icon: BookOpen },
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

function courseLaunchUrl(item: ContentItem): string | null {
  return careBaseCourseLaunchUrl(item.courseLaunchPath, config.pennTrainBaseUrl);
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
    if (parsed.origin !== window.location.origin || !["/help", "/cases"].includes(parsed.pathname)) return;
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
    if (parsed.origin !== window.location.origin || !["/help", "/cases"].includes(parsed.pathname)) return null;
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
    rememberPendingPortalPath();
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        shouldCreateUser: false,
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
        <div className="sign-in-support" aria-label="Central support contacts">
          <a href={`tel:${config.centralSupportPhone}`}><Phone size={17} /><span><small>Call central support</small><strong>{config.centralSupportPhoneDisplay}</strong></span></a>
          <a href={`mailto:${config.centralSupportEmail}`}><Mail size={17} /><span><small>Email central support</small><strong>{config.centralSupportEmail}</strong></span></a>
        </div>
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

async function inspectMfaGate(actor: ActorContext): Promise<MfaGate> {
  if (!supabase) return { status: "ready" };

  const [assurance, factors] = await Promise.all([
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    supabase.auth.mfa.listFactors(),
  ]);
  if (assurance.error) throw assurance.error;
  if (factors.error) throw factors.error;

  const currentLevel = normalizeAuthenticatorLevel(assurance.data.currentLevel);
  const nextLevel = normalizeAuthenticatorLevel(assurance.data.nextLevel);
  if (!currentLevel || !nextLevel) throw new Error("The secure session is missing authenticator assurance data. Sign out and try again.");

  return decideMfaGate({
    currentLevel,
    nextLevel,
    verifiedTotpFactors: factors.data.totp.map((factor, index) => ({
      id: factor.id,
      label: factor.friendly_name?.trim() || `Authenticator ${index + 1}`,
    })),
    requiresMfa: isSupportStaff(actor.role),
  });
}

function MfaScreen({ gate, onVerified }: { gate: Extract<MfaGate, { status: "enroll" | "challenge" }>; onVerified: () => Promise<void> }) {
  const [setup, setSetup] = useState<{ factorId: string; qrCode: string; secret: string } | null>(null);
  const [selectedFactorId, setSelectedFactorId] = useState(gate.status === "challenge" ? gate.factors[0]?.id ?? "" : "");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const startEnrollment = async () => {
    if (!supabase) return;
    setBusy(true); setMessage("");
    try {
      const factors = await supabase.auth.mfa.listFactors();
      if (factors.error) throw factors.error;
      for (const factor of factors.data.all.filter((item) => item.factor_type === "totp" && item.status === "unverified")) {
        const removal = await supabase.auth.mfa.unenroll({ factorId: factor.id });
        if (removal.error) throw removal.error;
      }

      const enrollment = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: "CareMetric Support Hub",
      });
      if (enrollment.error) throw enrollment.error;
      setSetup({
        factorId: enrollment.data.id,
        qrCode: enrollment.data.totp.qr_code,
        secret: enrollment.data.totp.secret,
      });
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Authenticator setup could not be started.");
    } finally {
      setBusy(false);
    }
  };

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabase) return;
    const factorId = gate.status === "challenge" ? selectedFactorId : setup?.factorId;
    if (!factorId || !/^\d{6}$/.test(code)) return;

    setBusy(true); setMessage("");
    try {
      const verification = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
      if (verification.error) throw verification.error;
      await onVerified();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "The authenticator code could not be verified.");
    } finally {
      setBusy(false);
    }
  };

  const enrolling = gate.status === "enroll";

  return (
    <main className="mfa-page">
      <section className="mfa-panel">
        <div className="brand-lockup brand-lockup-large">
          <span className="brand-icon"><ShieldCheck size={25} /></span>
          <span><strong>CareMetric</strong><small>Support Hub security</small></span>
        </div>
        <div className="mfa-copy">
          <span className="eyebrow">Two-step verification required</span>
          <h1>{enrolling ? "Protect your Support Hub account." : "Enter your authenticator code."}</h1>
          <p>{enrolling
            ? "Set up a time-based code in your authenticator app before opening customer support data."
            : "Your secure email link completed the first step. Use the six-digit code from your authenticator app to continue."}</p>
        </div>

        {enrolling && !setup ? (
          <button className="button button-primary mfa-start" disabled={busy} onClick={() => void startEnrollment()}>
            {busy ? <LoaderCircle className="spin" size={17} /> : <LockKeyhole size={17} />}
            Set up authenticator
          </button>
        ) : (
          <>
            {setup && (
              <div className="mfa-setup">
                <img src={setup.qrCode} alt="QR code for CareMetric Support Hub authenticator setup" />
                <div><strong>Scan this QR code</strong><p>Or enter this setup key manually:</p><code>{setup.secret}</code></div>
              </div>
            )}
            <form className="mfa-form" onSubmit={verify}>
              {gate.status === "challenge" && gate.factors.length > 1 && (
                <label htmlFor="mfa-factor">Authenticator device
                  <select id="mfa-factor" value={selectedFactorId} onChange={(event) => setSelectedFactorId(event.target.value)}>
                    {gate.factors.map((factor) => <option key={factor.id} value={factor.id}>{factor.label}</option>)}
                  </select>
                </label>
              )}
              <label htmlFor="mfa-code">Six-digit authenticator code</label>
              <input
                id="mfa-code"
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                placeholder="000000"
                autoFocus
                required
              />
              <button className="button button-primary" disabled={busy || code.length !== 6}>
                {busy ? <LoaderCircle className="spin" size={17} /> : <ShieldCheck size={17} />}
                Verify and continue
              </button>
            </form>
          </>
        )}

        {message && <p className="form-message form-error"><AlertCircle size={15} /> {message}</p>}
        <div className="mfa-actions">
          <button type="button" onClick={() => void supabase?.auth.signOut().then(() => { window.location.assign("/help"); })}>Open public help</button>
          <button type="button" onClick={() => void supabase?.auth.signOut()}>Sign out</button>
        </div>
        <div className="sign-in-support" aria-label="Central support contacts">
          <a href={`tel:${config.centralSupportPhone}`}><Phone size={17} /><span><small>Call central support</small><strong>{config.centralSupportPhoneDisplay}</strong></span></a>
          <a href={`mailto:${config.centralSupportEmail}`}><Mail size={17} /><span><small>Email central support</small><strong>{config.centralSupportEmail}</strong></span></a>
        </div>
        <div className="privacy-note"><ShieldCheck size={16} /> MFA protects customer support data. Never include patient information in a support request.</div>
      </section>
    </main>
  );
}

function SecurityPage({ actor }: { actor: ActorContext }) {
  const [factors, setFactors] = useState<Array<{ id: string; label: string; createdAt: string }>>([]);
  const [friendlyName, setFriendlyName] = useState("Backup authenticator");
  const [setup, setSetup] = useState<{ factorId: string; qrCode: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  const [hasError, setHasError] = useState(false);

  const refreshFactors = useCallback(async () => {
    if (!supabase) return;
    const result = await supabase.auth.mfa.listFactors();
    if (result.error) throw result.error;
    setFactors(result.data.totp.map((factor, index) => ({
      id: factor.id,
      label: factor.friendly_name?.trim() || `Authenticator ${index + 1}`,
      createdAt: factor.created_at,
    })));
  }, []);

  useEffect(() => {
    void Promise.resolve().then(() => refreshFactors())
      .catch((caught) => { setHasError(true); setMessage(caught instanceof Error ? caught.message : "Authenticator devices could not be loaded."); })
      .finally(() => setBusy(false));
  }, [refreshFactors]);

  const beginEnrollment = async () => {
    if (!supabase || !friendlyName.trim()) return;
    setBusy(true); setMessage(""); setHasError(false);
    try {
      const enrollment = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: friendlyName.trim().slice(0, 64),
      });
      if (enrollment.error) throw enrollment.error;
      setSetup({ factorId: enrollment.data.id, qrCode: enrollment.data.totp.qr_code, secret: enrollment.data.totp.secret });
      setCode("");
    } catch (caught) {
      setHasError(true); setMessage(caught instanceof Error ? caught.message : "Authenticator setup could not be started.");
    } finally { setBusy(false); }
  };

  const verifyEnrollment = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabase || !setup || !/^\d{6}$/.test(code)) return;
    setBusy(true); setMessage(""); setHasError(false);
    try {
      const result = await supabase.auth.mfa.challengeAndVerify({ factorId: setup.factorId, code });
      if (result.error) throw result.error;
      setSetup(null); setCode(""); setFriendlyName("Another authenticator");
      await refreshFactors();
      setMessage("Authenticator added. Keep at least two verified devices for administrator recovery.");
    } catch (caught) {
      setHasError(true); setMessage(caught instanceof Error ? caught.message : "The authenticator code could not be verified.");
    } finally { setBusy(false); }
  };

  const removeFactor = async (factorId: string) => {
    if (!supabase || factors.length < 2) return;
    setBusy(true); setMessage(""); setHasError(false);
    try {
      const result = await supabase.auth.mfa.unenroll({ factorId });
      if (result.error) throw result.error;
      await refreshFactors();
      setMessage("Authenticator removed.");
    } catch (caught) {
      setHasError(true); setMessage(caught instanceof Error ? caught.message : "The authenticator could not be removed.");
    } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeading
        eyebrow="Account protection"
        title="Authenticator security"
        description={`Manage time-based authenticator devices for ${actor.name}. Staff access requires an AAL2 session.`}
      />
      <div className="security-settings-grid">
        <section className="panel security-factor-panel">
          <div className="panel-heading"><div><h2>Verified authenticators</h2><p>Keep a second device as a recovery factor.</p></div><ShieldCheck size={20} /></div>
          <div className="factor-list">
            {factors.map((factor) => (
              <div className="factor-row" key={factor.id}>
                <span className="factor-icon"><LockKeyhole size={17} /></span>
                <div><strong>{factor.label}</strong><small>Added {formatDate(factor.createdAt)}</small></div>
                <button className="button button-secondary button-small" disabled={busy || factors.length < 2} onClick={() => void removeFactor(factor.id)}>Remove</button>
              </div>
            ))}
            {!busy && factors.length === 0 && <div className="empty-state"><LockKeyhole /><strong>No verified authenticator</strong><p>Add one before using staff tools.</p></div>}
          </div>
          <div className="factor-recovery-note"><AlertCircle size={16} /><span>Recovery codes are not available. The last verified authenticator cannot be removed here; use a second device or controlled Supabase administrator recovery.</span></div>
        </section>

        <section className="panel security-enroll-panel">
          <div className="panel-heading"><div><h2>Add an authenticator</h2><p>Use any standards-based TOTP authenticator app.</p></div></div>
          <div className="security-enroll-body">
            {!setup ? (
              <>
                <label htmlFor="factor-name"><span>Device name</span><input id="factor-name" value={friendlyName} maxLength={64} onChange={(event) => setFriendlyName(event.target.value)} /></label>
                <button className="button button-primary" disabled={busy || !friendlyName.trim()} onClick={() => void beginEnrollment()}>{busy ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />} Create setup code</button>
              </>
            ) : (
              <form className="mfa-form" onSubmit={verifyEnrollment}>
                <div className="mfa-setup security-qr"><img src={setup.qrCode} alt="QR code for a new Support Hub authenticator" /><div><strong>Scan this QR code</strong><p>Or enter this setup key manually:</p><code>{setup.secret}</code></div></div>
                <label htmlFor="new-factor-code">Six-digit authenticator code</label>
                <input id="new-factor-code" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} placeholder="000000" autoFocus required />
                <button className="button button-primary" disabled={busy || code.length !== 6}>{busy ? <LoaderCircle className="spin" size={17} /> : <ShieldCheck size={17} />} Verify authenticator</button>
              </form>
            )}
            {message && <p className={`form-message ${hasError ? "form-error" : "form-success"}`}>{hasError ? <AlertCircle size={15} /> : <CheckCircle2 size={15} />} {message}</p>}
          </div>
        </section>
      </div>
    </>
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
            <Route path="/overview" element={<OverviewPage data={data} />} />
            <Route path="/cases" element={<CasesPage key={`${data.actor.id}:${data.actor.role}`} data={data} />} />
            <Route path="/knowledge" element={<KnowledgePage data={data} />} />
            <Route path="/library" element={<ContentLibraryPage data={data} />} />
            <Route path="/products" element={<ProductsPage data={data} />} />
            <Route path="/integration" element={<IntegrationPage data={data} />} />
            <Route path="/security" element={<SecurityPage actor={data.actor} />} />
            <Route path="/help" element={<ContextualHelpPage data={data} />} />
            <Route path="/learn" element={<PublicLearningPage data={data} />} />
            <Route path="*" element={<Navigate to="/overview" replace />} />
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
          <Route path="/learn" element={<PublicLearningPage data={data} />} />
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
  const [selectedId, setSelectedId] = useState<string | null>(data.cases[0]?.id ?? null);
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
        <textarea rows={4} value={body} onChange={(event) => setBody(event.target.value)} maxLength={5000} disabled={threadStatus !== "ready"} placeholder={visibility === "internal" ? "Add a note visible only to support staff…" : "Write a reply…"} />
        <div className="reply-footer"><span><ShieldCheck size={14} /> Do not request or repeat patient information.</span><button className="button button-primary" onClick={() => void reply()} disabled={saving || threadStatus !== "ready" || !body.trim()}>{saving ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />} {visibility === "internal" ? "Add note" : "Send reply"}</button></div>
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
        <section className="panel content-section">
          <div className="panel-heading"><div><h2>Explainer videos</h2><p>Immutable renders connected to approved revisions</p></div><span className="count-pill">{videos.length}</span></div>
          {videos.map((item) => (
            <article className="media-row" key={item.id}>
              <div className="media-thumb"><MonitorPlay /><span>Preview</span></div>
              <div className="media-copy"><div><span className="content-key">{item.contentKey}</span><span className={`publication-status ${item.videoStatus}`}>{item.videoStatus ?? "pending"}</span></div><h3>{item.title}</h3><p>{item.summary}</p><div className="media-meta"><span><Boxes size={14} /> {item.productIds.length} products</span><span><FileText size={14} /> Rev {item.revision}</span><span><ShieldCheck size={14} /> Captions required</span></div></div>
              <button className="icon-button" disabled aria-label={`Playback unavailable for ${item.title}`} title={item.videoStatus === "ready" ? "Playback will be enabled after a governed media URL is connected" : "Playback is enabled only after rendering and approval"}><ChevronRight /></button>
            </article>
          ))}
        </section>
        <section className="panel content-section">
          <div className="panel-heading"><div><h2>PennTrain course catalog</h2><p>Searchable metadata; learning records remain in PennTrain</p></div><span className="count-pill">{courses.length}</span></div>
          {courses.map((item) => {
            const launchUrl = courseLaunchUrl(item);
            return (
              <article className="course-row" key={item.id}>
                <span className="course-icon"><GraduationCap /></span>
                <div><span className="content-key">{item.contentKey}</span><h3>{item.title}</h3><p>{item.summary}</p><div className="media-meta"><span><UsersRound size={14} /> {item.audience.join(", ")}</span><span><Boxes size={14} /> {item.productIds.length} products</span></div></div>
                {launchUrl
                  ? <a className="button button-secondary button-small" href={launchUrl} target="_blank" rel="noreferrer">Open in PennTrain <ExternalLink size={14} /></a>
                  : <button className="button button-secondary button-small" disabled title="PennTrain launch is enabled after its verified production URL is configured">PennTrain not connected <LockKeyhole size={14} /></button>}
              </article>
            );
          })}
        </section>
      </div>
      <section className="ownership-boundary panel"><div><strong>Content ownership boundary</strong><p>No HeyGen URL is embedded in an app. Products resolve a stable Support Hub content key, while final media is rehosted and can be rolled back independently.</p></div><span><LockKeyhole /> Provider-independent</span></section>
    </>
  );
}

function formatCourseDuration(minutes?: number): string | null {
  if (minutes === undefined) return null;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} hr ${remainder} min` : `${hours} hr`;
}

function PublicLearningPage({ data }: { data: HubData }) {
  const location = useLocation();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const requestedSlug = (new URLSearchParams(location.search).get("product") ?? "").trim().toLowerCase();
  const normalizedSlug = requestedSlug === "pennfit" ? "breathe" : requestedSlug;
  const requestedProduct = data.products.find((product) => product.slug === normalizedSlug);
  const courses = useMemo(() => data.content
    .filter((item) => item.kind === "course" && item.status === "published")
    .filter((item) => !requestedProduct || item.productIds.includes(requestedProduct.id))
    .sort((left, right) => left.title.localeCompare(right.title)), [data.content, requestedProduct]);
  const categories = useMemo(() => Array.from(new Set(courses
    .map((item) => item.contentCategory)
    .filter((value): value is string => Boolean(value))))
    .sort((left, right) => left.localeCompare(right)), [courses]);
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return courses.filter((course) =>
      (category === "all" || course.contentCategory === category) &&
      (!needle || `${course.title} ${course.summary} ${course.contentCategory ?? ""} ${(course.courseVideoTitles ?? []).join(" ")}`.toLowerCase().includes(needle)));
  }, [category, courses, search]);
  const videoCount = courses.reduce((total, course) => total + (course.courseVideoCount ?? 0), 0);

  return (
    <>
      <PageHeading
        eyebrow="CareMetric learning library"
        title={requestedProduct ? `Training for ${requestedProduct.name}` : "One governed course catalog for every CareMetric product."}
        description="Browse shared CareMetric training here, then open CareBase to enroll, complete quizzes, and manage certificates. Course content is maintained once and reused across the software ecosystem."
        action={<NavLink className="button button-secondary" to={`/help${requestedProduct ? `?product=${encodeURIComponent(requestedProduct.slug)}` : ""}`}><CircleHelp size={17} /> Get support</NavLink>}
      />
      <section className="learning-metrics" aria-label="Learning catalog summary">
        <div><strong>{courses.length}</strong><span>Published courses</span></div>
        <div><strong>{categories.length}</strong><span>Training categories</span></div>
        <div><strong>{videoCount}</strong><span>Included video lessons</span></div>
        <div><strong>{data.products.length}</strong><span>Registered products</span></div>
      </section>
      <section className="learning-toolbar panel">
        <label className="search-box large"><Search size={18} /><input aria-label="Search learning library" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search courses, topics, and requirements" /></label>
        <select aria-label="Filter courses by category" value={category} onChange={(event) => setCategory(event.target.value)}>
          <option value="all">All categories</option>
          {categories.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <span className="learning-result-count">{filtered.length} result{filtered.length === 1 ? "" : "s"}</span>
      </section>
      {filtered.length ? (
        <section className="learning-grid" aria-label="Published CareMetric courses">
          {filtered.map((course) => {
            const launchUrl = courseLaunchUrl(course);
            const duration = formatCourseDuration(course.courseDurationMinutes);
            return (
              <article className="learning-card" key={course.id}>
                <div className="learning-card-top">
                  <span className="course-icon"><GraduationCap /></span>
                  <span className="publication-status published">Published</span>
                </div>
                <span className="learning-category">{course.contentCategory ?? "CareMetric training"}</span>
                <h2>{course.title}</h2>
                <p>{course.summary}</p>
                <div className="learning-card-meta">
                  {duration && <span><Clock3 size={14} /> {duration}</span>}
                  {(course.courseVideoCount ?? 0) > 0 && <span><Video size={14} /> {course.courseVideoCount} video{course.courseVideoCount === 1 ? "" : "s"}</span>}
                  <span><Boxes size={14} /> {course.productIds.length} products</span>
                </div>
                {(course.courseVideoTitles?.length ?? 0) > 0 && (
                  <details className="lesson-list">
                    <summary>Browse {course.courseVideoTitles?.length} video lessons</summary>
                    <ol>{course.courseVideoTitles?.map((title) => <li key={title}>{title}</li>)}</ol>
                  </details>
                )}
                {launchUrl
                  ? <a className="button button-primary" href={launchUrl} target="_blank" rel="noreferrer">Open in CareBase <ExternalLink size={15} /></a>
                  : <button className="button button-secondary" disabled>Course unavailable <LockKeyhole size={15} /></button>}
              </article>
            );
          })}
        </section>
      ) : (
        <section className="panel empty-state learning-empty"><Search /><strong>No courses match</strong><p>Try a broader search or a different category.</p></section>
      )}
      <section className="learning-boundary panel">
        <ShieldCheck size={21} />
        <div><strong>Catalog here. Learning records in CareBase.</strong><p>The Support Hub shares approved course metadata across products. Enrollments, progress, quiz scores, attestations, and certificates remain protected inside CareMetric CareBase.</p></div>
      </section>
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
  const productSlug = requestedSlug === "pennfit" ? "breathe" : requestedSlug;
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
            const launchUrl = item.kind === "course" ? courseLaunchUrl(item) : null;
            return (
              <article className="contextual-result" key={item.id}>
                <span><Icon size={19} /></span>
                <div>
                  <small>{item.kind} · Rev {item.revision}</small><h3>{item.title}</h3><p>{item.summary}</p>
                  {item.body && <details><summary>Read answer</summary><div>{item.body}</div></details>}
                  {launchUrl && <a className="text-link contextual-action" href={launchUrl} target="_blank" rel="noreferrer">Open course in PennTrain <ExternalLink size={14} /></a>}
                  {item.kind === "course" && !launchUrl && <span className="contextual-action action-unavailable"><LockKeyhole size={13} /> Course launch not connected</span>}
                  {item.kind === "video" && <span className="contextual-action action-unavailable"><Clock3 size={13} /> Video playback available after approval</span>}
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
  const [mfaGate, setMfaGate] = useState<MfaGate>(config.demoMode ? { status: "ready" } : { status: "checking" });

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
      const gate = await inspectMfaGate(actor);
      setMfaGate(gate);
      if (gate.status !== "ready") {
        setLoading(false);
        return;
      }
      if (window.location.pathname === "/") {
        const pendingPath = takePendingHelpPath();
        if (pendingPath) navigate(pendingPath, { replace: true });
      }
      await load(actor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Two-step verification could not be checked.");
      setLoading(false);
    }
  }, [load, navigate]);

  useEffect(() => {
    if (config.demoMode) { void Promise.resolve().then(() => load()); return; }
    void supabase?.auth.getSession().then(({ data: sessionData }) => {
      setAuthenticated(Boolean(sessionData.session));
      if (sessionData.session) {
        void loadAuthenticated();
      } else if (["/help", "/learn"].includes(window.location.pathname)) void loadPublicHelp();
      else { setMfaGate({ status: "checking" }); setLoading(false); }
    });
    const subscription = supabase?.auth.onAuthStateChange((_event, session) => {
      setAuthenticated(Boolean(session));
      if (session) {
        void loadAuthenticated();
      } else if (["/help", "/learn"].includes(window.location.pathname)) void loadPublicHelp();
      else { setMfaGate({ status: "checking" }); setLoading(false); }
    });
    return () => subscription?.data.subscription.unsubscribe();
  }, [load, loadAuthenticated, loadPublicHelp, location.pathname]);

  const completeMfa = async () => {
    const actor = await repository.getActorContext();
    const gate = await inspectMfaGate(actor);
    if (gate.status !== "ready") throw new Error("Two-step verification did not complete. Try a new code.");
    setMfaGate(gate);
    if (window.location.pathname === "/") {
      const pendingPath = takePendingHelpPath();
      if (pendingPath) navigate(pendingPath, { replace: true });
    }
    await load(actor);
  };

  const changePersona = async (mode: "staff" | "customer") => {
    demoRepository.setActorRole(mode);
    await load();
  };

  const publicPortal = !authenticated && !config.demoMode && ["/help", "/learn"].includes(location.pathname);
  if (!authenticated && !config.demoMode && !publicPortal) return <SignInScreen />;
  if (loading) return <LoadingScreen />;
  if (error) return <ErrorScreen message={error} onRetry={() => void (publicPortal ? loadPublicHelp() : authenticated ? loadAuthenticated() : load())} />;
  if (authenticated && !config.demoMode && (mfaGate.status === "enroll" || mfaGate.status === "challenge")) {
    return <MfaScreen gate={mfaGate} onVerified={completeMfa} />;
  }
  if (authenticated && !config.demoMode && mfaGate.status !== "ready") return <LoadingScreen />;
  if (publicPortal) return <PublicHelpShell data={data} />;
  return <AppShell data={data} onPersonaChange={(mode) => void changePersona(mode)} />;
}
