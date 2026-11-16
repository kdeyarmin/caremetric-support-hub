import { useCallback, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Activity, BookOpen, Building2, Flag, GraduationCap, History, Inbox, Layers3, RefreshCw, Users } from "lucide-react";
import { adminRegistry } from "../../supabase/functions/_shared/adminRegistry";
import { centralHubPortfolioApps as portfolioProducts } from "../hubScope";
import type { AdminDirectoryUser, AdminOrganization, PortfolioCapabilities, PortfolioOperationName, PortfolioProduct } from "../../supabase/functions/_shared/portfolioProtocol";
import { AdminInventory } from "./AdminInventory";
import { AdminFunctionCatalog } from "./AdminFunctionCatalog";
import { adminFunctions } from "./functionCatalog";
import { adminInventory } from "./inventory";
import { CourseCatalog } from "./CareBaseCourses";
import { TrainingLibrary } from "../learning/TrainingLibrary";
import { AccessCommand } from "./AccessCommand";
import type { AccessTarget } from "./AccessCommand";
import { TenantLifecyclePanel } from "./TenantLifecyclePanel";
import { Loading, ReadFailure } from "./AdminReads";
import { timeLabel } from "./readState";
import { useAdminRead } from "./useAdminRead";
import { portfolioClient } from "./portfolioClient";
import type { PortfolioClient } from "./portfolioClient";
import type { AdminClient } from "./types";
import { PagedRecords } from "./PagedRecords";
import { AuditRecords } from "./OperationalRecords";
import {OperationalWorkspace} from './OperationalWorkspace';
import { TrainingWorkspace } from "./TrainingWorkspace";
import { SharedAdminWorkspaces } from "./SharedAdminWorkspaces";
import { ConsultationRequests } from "./ConsultationRequests";
import { applicationLabel, overviewMetrics } from "./overviewMetrics";
import "./admin.css";

type View = "overview" | "organizations" | "users" | "inquiries" | "training" | "courses" | "jobs" | "releases" | "audit" | "inventory";
const viewOperations: Record<Exclude<View, "inventory">, PortfolioOperationName[]> = {
  overview: ["overview"], organizations: ["organizations.list"], users: ["users.list"],
  inquiries: ["inquiries.list"], courses: ["courses.list", "courses.get"],
  training: ["training.v1", "organizations.list"],
  jobs: ["operations.jobs.list"], releases: ["operations.releases.list"], audit: ["operations.audit.list"],
};
const views = [
  { id: "overview", name: "Overview", icon: Layers3 }, { id: "organizations", name: "Organizations", icon: Building2 },
  { id: "users", name: "Users", icon: Users },
  { id: "inquiries", name: "Consultation requests", icon: Inbox },
  { id: "training", name: "Facility training", icon: GraduationCap },
  { id: "courses", name: "CareBase courses", icon: BookOpen },
  { id: "jobs", name: "Jobs", icon: Activity }, { id: "releases", name: "Releases", icon: Flag }, { id: "audit", name: "Audit", icon: History },
] as const;
const formatNumber = new Intl.NumberFormat();

export function AdminWorkspace({ client, actorId, portfolio = portfolioClient }: { client: AdminClient; actorId?: string; portfolio?: PortfolioClient }) {
  const [params, setParams] = useSearchParams();
  // The rest of the Hub names Intel "caremetric-intel"; a link or bookmark using that name opens Intel, not the CareBase default.
  const requested = params.get("product") === "caremetric-intel" ? "intel" : params.get("product");
  const product = portfolioProducts.some(value => value === requested) ? requested as PortfolioProduct : "carebase";
  const [refresh, setRefresh] = useState(0);
  return <div className="admin-workspace">
    <div className="page-heading"><div><span className="eyebrow">CareMetric Admin</span><h1>Your apps, in one workspace</h1><p>Manage connected applications, facility training, courses and support with your Hub sign-in. Subscriptions and charges for every application are in Billing.</p></div><button className="button button-secondary" type="button" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} aria-hidden="true" />Refresh connection</button></div>
    <SharedAdminWorkspaces />
    <section className="panel portfolio-selector" aria-label="Application selection"><label><span>Application</span><select value={product} onChange={event => setParams({ product: event.target.value })}>{portfolioProducts.map(id => <option key={id} value={id}>{applicationLabel(id)}{adminRegistry[id].endpoint ? "" : " — connection pending"}</option>)}</select></label><p>Application controls below appear when the connected service supports them.</p></section>
    <ApplicationWorkspace key={`${product}:${refresh}`} product={product} actorId={actorId} client={client} portfolio={portfolio} />
  </div>;
}


function ApplicationWorkspace({ product, client, portfolio, actorId }: { product: PortfolioProduct; client: AdminClient; portfolio: PortfolioClient; actorId?: string }) {
  const [params, setParams] = useSearchParams();
  const requestedView = params.get("view");
  const view: View = requestedView === "inventory" || views.some(item => item.id === requestedView) ? requestedView as View : "overview";
  const setView = (next: View) => setParams(previous => { const updated = new URLSearchParams(previous); updated.set("view", next); return updated; });
  const [refresh, setRefresh] = useState(0);
  const retry = () => setRefresh(value => value + 1);
  const readCapabilities = useCallback((signal: AbortSignal) => { void refresh; return portfolio.capabilities({ product, signal }); }, [portfolio, product, refresh]);
  const state = useAdminRead(readCapabilities);
  const app = adminRegistry[product];
  const capabilities = state.status === "ready" ? state.data : null;
  const supports = (candidate: Exclude<View, "inventory">) => (product === "carebase" || !["training", "jobs", "releases", "audit"].includes(candidate)) && viewOperations[candidate].every(operation => capabilities?.operations.includes(operation));
  // Access changes appear only for an application whose connection advertises them: CareBase and Intel profiles and accounts,
  // CareBase organizations, and Breathe organizations through Breathe's own suspend/restore review.
  const allowCommands = (product === "carebase" || product === "intel") && capabilities?.operations.includes("commands.preview") === true && capabilities.operations.includes("commands.apply");
  const allowLifecycle = product === "breathe" && ["organizations.lifecycle.context", "organizations.lifecycle.preview", "organizations.lifecycle.apply", "organizations.lifecycle.resume"].every(operation => capabilities?.operations.includes(operation as PortfolioOperationName));
  return <>
    <div className="admin-section-title"><div><h2>{applicationLabel(product)}</h2><p>{app.userScope}</p></div><span className={`admin-status ${state.status === "ready" ? "admin-status-connected" : "admin-status-muted"}`}>{state.status === "ready" ? "Connection verified" : state.status === "loading" ? "Checking connection" : "Unavailable"}</span></div>
    <nav className="admin-view-nav" aria-label="Administration workspace views">{views.filter(item => supports(item.id)).map(({ id, name, icon: Icon }) => <button key={id} type="button" className={view === id ? "active" : ""} aria-pressed={view === id} onClick={() => setView(id)}><Icon size={16} aria-hidden="true" />{name}</button>)}<button type="button" className={view === "inventory" ? "active" : ""} aria-pressed={view === "inventory"} onClick={() => setView("inventory")}><Layers3 size={16} aria-hidden="true" />All app functions <span>{adminFunctions.length}</span></button></nav>
    {view === "inventory" ? <><AdminFunctionCatalog product={product} capabilities={capabilities} onNavigate={setView}/><details><summary>View the original audit of {adminInventory.length} source surfaces</summary><AdminInventory /></details></> : <>
      {state.status === "loading" && <Loading label={`Checking ${app.name} capabilities`} app={app.name} />}
      {state.status === "error" && <ReadFailure error={state.error} retry={retry} />}
      {capabilities && !supports(view) && <p className="admin-explanation">This connection does not currently provide this operation.</p>}
      {capabilities && supports(view) && <div key={`${view}:${refresh}`}>
        {view === "overview" && <Overview product={product} portfolio={portfolio} capabilities={capabilities} retry={retry} />}
        {view === "organizations" && <Directory product={product} portfolio={portfolio} kind="organizations" allowCommands={product === "carebase" ? allowCommands : allowLifecycle} />}
        {view === "users" && <Directory product={product} portfolio={portfolio} kind="users" allowCommands={allowCommands} />}
        {view === "inquiries" && product === "advisors" && <ConsultationRequests />}
        {view === "courses" && product === "carebase" && <><CourseCatalog client={client} /><TrainingLibrary client={client} /></>}
        {view === "training" && product === "carebase" && (actorId ? <TrainingWorkspace actorId={actorId} portfolio={portfolio} /> : <p role="alert">Your administrator identity could not be verified. Refresh your Hub session before managing facility training.</p>)}
        {(view === "jobs"||view === "releases") && product === "carebase" && <OperationalWorkspace view={view} canConfigure={capabilities.operations.includes('operations.config.v1')}/>}
        {view === "audit" && product === "carebase" && <AuditRecords />}
      </div>}
    </>}
  </>;
}

function Overview({ product, portfolio, capabilities, retry }: { product: PortfolioProduct; portfolio: PortfolioClient; capabilities: PortfolioCapabilities; retry: () => void }) {
  const reader = useCallback((signal: AbortSignal) => portfolio.overview({ product, signal }), [portfolio, product]);
  const state = useAdminRead(reader);
  const app = adminRegistry[product];
  if (state.status === "loading") return <Loading label="Loading application overview" app={app.name} />;
  if (state.status === "error") return <ReadFailure error={state.error} retry={retry} />;
  const metrics = overviewMetrics(product, state.data);
  return <section><div className="metric-grid admin-metric-grid">{metrics.map(metric => <div className="metric-card metric-teal" key={metric.label}><div><p>{metric.label}</p><strong>{metric.value === null ? "Not reported" : formatNumber.format(metric.value)}</strong><small>{app.name}</small></div></div>)}</div><p className="admin-read-time">Last loaded {timeLabel(state.receivedAt)}. {product === "caremetric-go" ? "These records are shared with CareMetric EMR and must not be counted as additional organizations or subscriptions." : `These totals include only ${app.name}.`}</p><details className="portfolio-connection-details"><summary>Connection details</summary><p>Supported reads: {capabilities.operations.join(", ")}</p><p>Deployed source: {capabilities.sourceRevision ?? "Not reported"}</p></details></section>;
}

function Directory({ product, portfolio, kind, allowCommands }: { product: PortfolioProduct; portfolio: PortfolioClient; kind: "organizations" | "users"; allowCommands: boolean }) {
  const [selected, setSelected] = useState<AccessTarget | null>(null);
  const [commandBusy, setCommandBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const columns = kind === "organizations" ? ["Organization", "Slug", product === "carebase" ? "Subscription status" : "Status", "Created"] : ["Name", "Email", "Role", product === "carebase" ? "Profile status" : "Account status", "Created"];
  if (allowCommands) columns.push("Access");
  const read = useCallback((search: string, offset: number, signal: AbortSignal) => kind === "organizations"
    ? portfolio.organizations({ product, search: search || undefined, offset, limit: 20, signal })
    : portfolio.users({ product, search: search || undefined, offset, limit: 20, signal }), [kind, portfolio, product]);
  const lifecycle = product === "breathe" && kind === "organizations";
  return <>{selected && (lifecycle
    ? <TenantLifecyclePanel key={selected.id} organizationId={selected.id} label={selected.label} onClose={() => setSelected(null)} onApplied={() => setRevision(value => value + 1)} onBusyChange={setCommandBusy} />
    : <AccessCommand key={`${selected.action}:${selected.id}`} target={selected} product={product === "intel" ? "intel" : "carebase"} onClose={() => setSelected(null)} onApplied={() => setRevision(value => value + 1)} onBusyChange={setCommandBusy} />)}<PagedRecords<AdminOrganization | AdminDirectoryUser> key={revision} app={adminRegistry[product].name} title={kind === "organizations" ? "Organizations" : product === "breathe" ? "Staff accounts" : "Application user profiles"} searchLabel={kind === "organizations" ? "Search organization names" : "Search account emails"} columns={columns} read={read} render={row => <>{"name" in row
    ? <><td>{row.name ?? row.slug ?? row.id}</td><td>{row.slug ?? "—"}</td><td>{row.status}</td><td>{timeLabel(row.createdAt)}</td></>
    : <><td>{row.displayName ?? "Not recorded"}</td><td>{row.email ?? "Not recorded"}</td><td>{row.role}</td><td>{row.accountStatus ?? row.status}</td><td>{timeLabel(row.createdAt)}</td></>}{allowCommands && <td>{!("name" in row) && row.role === "platform_admin" ? "Protected administrator" : <button type="button" className="button button-secondary button-small" disabled={commandBusy} onClick={() => setSelected({ id: row.id, label: "name" in row ? row.name ?? row.slug ?? row.id : row.displayName ?? row.email ?? row.id, action: "name" in row ? "organizations.setSuspension" : "users.setActive" })}>{lifecycle ? "Suspend or restore" : "Change access"}</button>}</td>}</>} /></>;
}
