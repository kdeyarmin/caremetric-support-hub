import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { Activity, BookOpen, Building2, CreditCard, Flag, History, Layers3, RefreshCw, Users } from "lucide-react";
import { adminRegistry } from "../../supabase/functions/_shared/adminRegistry";
import { portfolioProducts } from "../../supabase/functions/_shared/portfolioProtocol";
import type { AdminDirectoryUser, AdminOrganization, AdminSubscription, PortfolioCapabilities, PortfolioOperationName, PortfolioProduct } from "../../supabase/functions/_shared/portfolioProtocol";
import { AdminInventory } from "./AdminInventory";
import { AdminFunctionCatalog } from "./AdminFunctionCatalog";
import { adminInventory } from "./inventory";
import { CourseCatalog } from "./CareBaseCourses";
import { AccessCommand } from "./AccessCommand";
import type { AccessTarget } from "./AccessCommand";
import { Loading, ReadFailure } from "./AdminReads";
import { timeLabel } from "./readState";
import { useAdminRead } from "./useAdminRead";
import { portfolioClient } from "./portfolioClient";
import type { PortfolioClient } from "./portfolioClient";
import type { AdminClient } from "./types";
import { PagedRecords } from "./PagedRecords";
import { AuditRecords } from "./OperationalRecords";
import {OperationalWorkspace} from './OperationalWorkspace';
import { InvoiceRecords, SubscriptionVerification } from "./BillingRecords";
import { BillingPortal } from "./BillingPortal";
import { BillingCheckout } from "./BillingCheckout";
import type { BillingPortalTarget } from "./BillingPortal";
import "./admin.css";

type View = "overview" | "organizations" | "users" | "billing" | "courses" | "jobs" | "releases" | "audit" | "inventory";
const viewOperations: Record<Exclude<View, "inventory">, PortfolioOperationName[]> = {
  overview: ["overview"], organizations: ["organizations.list"], users: ["users.list"],
  billing: ["billing.overview", "billing.subscriptions.list"], courses: ["courses.list", "courses.get"],
  jobs: ["operations.jobs.list"], releases: ["operations.releases.list"], audit: ["operations.audit.list"],
};
const views = [
  { id: "overview", name: "Overview", icon: Layers3 }, { id: "organizations", name: "Organizations", icon: Building2 },
  { id: "users", name: "Users", icon: Users }, { id: "billing", name: "Billing", icon: CreditCard },
  { id: "courses", name: "CareBase courses", icon: BookOpen },
  { id: "jobs", name: "Jobs", icon: Activity }, { id: "releases", name: "Releases", icon: Flag }, { id: "audit", name: "Audit", icon: History },
] as const;
const formatNumber = new Intl.NumberFormat();

export function AdminWorkspace({ client, portfolio = portfolioClient }: { client: AdminClient; portfolio?: PortfolioClient }) {
  const [product, setProduct] = useState<PortfolioProduct>("carebase");
  const [refresh, setRefresh] = useState(0);
  return <div className="admin-workspace">
    <div className="page-heading"><div><span className="eyebrow">CareMetric Admin</span><h1>Your apps, in one workspace</h1><p>Manage shared learning and support, and inspect current organizations, users, and subscriptions across connected apps.</p></div><button className="button button-secondary" type="button" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} aria-hidden="true" />Refresh connection</button></div>
    <section className="panel portfolio-selector" aria-label="Application selection"><label><span>Application</span><select value={product} onChange={event => setProduct(event.target.value as PortfolioProduct)}>{portfolioProducts.map(id => <option key={id} value={id}>{adminRegistry[id].name}{adminRegistry[id].endpoint ? "" : " — connection pending"}</option>)}</select></label><div className="admin-quick-links"><Link to="/library">Create and manage courses</Link><Link to="/cases">Support cases</Link><Link to="/security">Security</Link></div></section>
    <ApplicationWorkspace key={`${product}:${refresh}`} product={product} client={client} portfolio={portfolio} />
  </div>;
}

const supportsCheckout = (product: PortfolioProduct, capabilities?: PortfolioCapabilities | null) => product === "carebase" && (["billing.packages.list", "billing.checkout.preview", "billing.checkout.apply", "billing.checkout.check", "billing.checkout.recover"] as const).every(operation => capabilities?.operations.includes(operation));

function ApplicationWorkspace({ product, client, portfolio }: { product: PortfolioProduct; client: AdminClient; portfolio: PortfolioClient }) {
  const [view, setView] = useState<View>("overview");
  const [refresh, setRefresh] = useState(0);
  const retry = () => setRefresh(value => value + 1);
  const readCapabilities = useCallback((signal: AbortSignal) => { void refresh; return portfolio.capabilities({ product, signal }); }, [portfolio, product, refresh]);
  const state = useAdminRead(readCapabilities);
  const app = adminRegistry[product];
  const capabilities = state.status === "ready" ? state.data : null;
  const supports = (candidate: Exclude<View, "inventory">) => (product === "carebase" || !["jobs", "releases", "audit"].includes(candidate)) && viewOperations[candidate].every(operation => capabilities?.operations.includes(operation));
  const allowCommands = product === "carebase" && capabilities?.operations.includes("commands.preview") === true && capabilities.operations.includes("commands.apply");
  const allowPortal = product === "carebase" && capabilities?.operations.includes("billing.commands.preview") === true && capabilities.operations.includes("billing.commands.apply");
  return <>
    <div className="admin-section-title"><div><h2>{app.name}</h2><p>{app.userScope}</p></div><span className={`admin-status ${state.status === "ready" ? "admin-status-connected" : "admin-status-muted"}`}>{state.status === "ready" ? "Connection verified" : state.status === "loading" ? "Checking connection" : "Unavailable"}</span></div>
    <nav className="admin-view-nav" aria-label="Administration workspace views">{views.filter(item => supports(item.id)).map(({ id, name, icon: Icon }) => <button key={id} type="button" className={view === id ? "active" : ""} aria-pressed={view === id} onClick={() => setView(id)}><Icon size={16} aria-hidden="true" />{name}</button>)}<button type="button" className={view === "inventory" ? "active" : ""} aria-pressed={view === "inventory"} onClick={() => setView("inventory")}><Layers3 size={16} aria-hidden="true" />All app functions <span>{adminInventory.length}</span></button></nav>
    {view === "inventory" ? <><AdminFunctionCatalog product={product} capabilities={capabilities} onNavigate={setView}/><details><summary>View the original audit of {adminInventory.length} source surfaces</summary><AdminInventory /></details></> : <>
      {state.status === "loading" && <Loading label={`Checking ${app.name} capabilities`} app={app.name} />}
      {state.status === "error" && <ReadFailure error={state.error} retry={retry} />}
      {capabilities && !supports(view) && <p className="admin-explanation">This connection does not currently provide this operation.</p>}
      {capabilities && supports(view) && <div key={`${view}:${refresh}`}>
        {view === "overview" && <Overview product={product} portfolio={portfolio} capabilities={capabilities} retry={retry} />}
        {view === "organizations" && <Directory product={product} portfolio={portfolio} kind="organizations" allowCommands={allowCommands} allowPortal={allowPortal} allowCheckout={supportsCheckout(product, capabilities)} />}
        {view === "users" && <Directory product={product} portfolio={portfolio} kind="users" allowCommands={allowCommands} allowPortal={false} allowCheckout={false} />}
        {view === "billing" && <Billing product={product} portfolio={portfolio} retry={retry} allowCommands={allowCommands} capabilities={capabilities} />}
        {view === "courses" && product === "carebase" && <CourseCatalog client={client} />}
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
  const metrics = [
    { label: "Organizations", value: state.data.organizationCount },
    { label: product === "breathe" || product === "caremetric-emr" || product === "caremetric-go" ? "Active staff accounts" : "Active application profiles", value: state.data.activeUserCount },
    ...(state.data.registeredUserCount === undefined ? [] : [{ label: product === "intel" ? "Registered application profiles" : "Registered staff profiles", value: state.data.registeredUserCount }]),
    ...(state.data.globalCourseCount === undefined ? [] : [{ label: "Shared courses · all publication states", value: state.data.globalCourseCount }]),
    ...(state.data.subscriptionCount === undefined ? [] : [{ label: "Recorded subscriptions", value: state.data.subscriptionCount }]),
  ];
  return <section><div className="metric-grid admin-metric-grid">{metrics.map(metric => <div className="metric-card metric-teal" key={metric.label}><div><p>{metric.label}</p><strong>{metric.value === null ? "Not reported" : formatNumber.format(metric.value)}</strong><small>{app.name}</small></div></div>)}</div><p className="admin-read-time">Last loaded {timeLabel(state.receivedAt)}. {product === "caremetric-go" ? "These records are shared with CareMetric EMR and must not be counted as additional organizations or subscriptions." : `These totals include only ${app.name}.`}</p><details className="portfolio-connection-details"><summary>Connection details</summary><p>Supported reads: {capabilities.operations.join(", ")}</p><p>Deployed source: {capabilities.sourceRevision ?? "Not reported"}</p></details></section>;
}

function Directory({ product, portfolio, kind, allowCommands, allowPortal, allowCheckout }: { product: PortfolioProduct; portfolio: PortfolioClient; kind: "organizations" | "users"; allowCommands: boolean; allowPortal: boolean; allowCheckout: boolean }) {
  const [selected, setSelected] = useState<AccessTarget | null>(null);
  const [portal, setPortal] = useState<BillingPortalTarget | null>(null);
  const [checkout, setCheckout] = useState<BillingPortalTarget | null>(null);
  const [revision, setRevision] = useState(0);
  const columns = kind === "organizations" ? ["Organization", "Slug", product === "carebase" ? "Subscription status" : "Status", "Created"] : ["Name", "Email", "Role", product === "carebase" ? "Profile status" : "Account status", "Created"];
  if (allowCommands) columns.push("Access");
  if (allowPortal) columns.push("Billing portal");
  if (allowCheckout) columns.push("Subscription checkout");
  const read = useCallback((search: string, offset: number, signal: AbortSignal) => kind === "organizations"
    ? portfolio.organizations({ product, search: search || undefined, offset, limit: 20, signal })
    : portfolio.users({ product, search: search || undefined, offset, limit: 20, signal }), [kind, portfolio, product]);
  return <>{checkout && <BillingCheckout key={checkout.id} target={checkout} onClose={() => setCheckout(null)} />}{portal && <BillingPortal key={portal.id} target={portal} onClose={() => setPortal(null)} />}{selected && <AccessCommand key={`${selected.action}:${selected.id}`} target={selected} onClose={() => setSelected(null)} onApplied={() => setRevision(value => value + 1)} />}<PagedRecords<AdminOrganization | AdminDirectoryUser> key={revision} app={adminRegistry[product].name} title={kind === "organizations" ? "Organizations" : product === "breathe" ? "Staff accounts" : "Application user profiles"} searchLabel={kind === "organizations" ? "Search organization names" : "Search account emails"} columns={columns} read={read} render={row => <>{"name" in row
    ? <><td>{row.name ?? row.slug ?? row.id}</td><td>{row.slug ?? "—"}</td><td>{row.status}</td><td>{timeLabel(row.createdAt)}</td></>
    : <><td>{row.displayName ?? "Not recorded"}</td><td>{row.email ?? "Not recorded"}</td><td>{row.role}</td><td>{row.status}</td><td>{timeLabel(row.createdAt)}</td></>}{allowCommands && <td>{!("name" in row) && row.role === "platform_admin" ? "Protected administrator" : <button type="button" className="button button-secondary button-small" onClick={() => setSelected({ id: row.id, label: "name" in row ? row.name ?? row.slug ?? row.id : row.displayName ?? row.email ?? row.id, action: "name" in row ? "organizations.setSuspension" : "users.setActive" })}>Change access</button>}</td>}{allowPortal && <td>{"name" in row && <button type="button" className="button button-secondary button-small" onClick={() => setPortal({ id: row.id, label: row.name ?? row.slug ?? row.id })}>Review billing portal</button>}</td>}{allowCheckout && <td>{"name" in row && <button type="button" className="button button-secondary button-small" onClick={() => setCheckout({ id: row.id, label: row.name ?? row.slug ?? row.id })}>Review subscription checkout</button>}</td>}</>} /></>;
}

function Billing({ product, portfolio, retry, allowCommands, capabilities }: { product: PortfolioProduct; portfolio: PortfolioClient; retry: () => void; allowCommands: boolean; capabilities: PortfolioCapabilities }) {
  const [selected, setSelected] = useState<AccessTarget | null>(null);
  const [verifiedId, setVerifiedId] = useState<string | null>(null);
  const [portal, setPortal] = useState<BillingPortalTarget | null>(null);
  const [checkout, setCheckout] = useState<BillingPortalTarget | null>(null);
  const allowPortal = product === "carebase" && capabilities.operations.includes("billing.commands.preview") && capabilities.operations.includes("billing.commands.apply");
  const allowCheckout = supportsCheckout(product, capabilities);
  const [revision, setRevision] = useState(0);
  const allowInvoices = product === "carebase" && capabilities.operations.includes("billing.invoices.list");
  const allowVerify = product === "carebase" && capabilities.operations.includes("billing.subscriptions.verify");
  const reader = useCallback((signal: AbortSignal) => { void revision; return portfolio.billing({ product, signal }); }, [portfolio, product, revision]);
  const state = useAdminRead(reader);
  const read = useCallback((search: string, offset: number, signal: AbortSignal) => portfolio.subscriptions({ product, search: search || undefined, offset, limit: 20, signal }), [portfolio, product]);
  return <section><div className="panel portfolio-billing-summary"><h2>Subscription administration</h2><p>These are subscription records stored by {adminRegistry[product].name}, including historical records. Provider status in the table reflects the app’s latest recorded synchronization.{allowVerify && " Choose Verify with Stripe to request a current provider comparison."}</p>{product === "caremetric-emr" && <p>EMR records shown here are application entitlements. Chargebee subscription records are excluded until their organization mappings are verified.</p>}{product === "pennsync" && <p>PennSync subscriptions belong to individual accounts. An organization is shown only when an explicit native relationship exists.</p>}{state.status === "loading" && <Loading label="Loading subscription states" app={adminRegistry[product].name} />}{state.status === "error" && <ReadFailure error={state.error} retry={retry} />}{state.status === "ready" && <><p><strong>{formatNumber.format(state.data.subscriptionCount)}</strong> recorded subscriptions · loaded {timeLabel(state.receivedAt)}</p><div className="portfolio-status-counts">{state.data.statusCounts.map(item => <span key={item.status}>{item.status}: <strong>{formatNumber.format(item.count)}</strong></span>)}</div></>}</div>
    {selected && <AccessCommand key={`${selected.action}:${selected.id}`} target={selected} onClose={() => setSelected(null)} onApplied={() => setRevision(value => value + 1)} />}
    {checkout && <BillingCheckout key={checkout.id} target={checkout} onClose={() => setCheckout(null)} />}
    {portal && <BillingPortal key={portal.id} target={portal} onClose={() => setPortal(null)} />}
    {verifiedId && <SubscriptionVerification key={`${verifiedId}:${revision}`} id={verifiedId} portfolio={portfolio} onClose={() => setVerifiedId(null)} />}
    <PagedRecords<AdminSubscription> key={revision} app={adminRegistry[product].name} title="Subscription records" searchLabel="Search provider subscription IDs" columns={["Organization", "Plan", "Application state", "Provider state", "Provider IDs", "Period end", "Updated", ...(allowVerify ? ["Verification"] : []), ...(allowCommands ? ["Access"] : []), ...(allowPortal ? ["Billing portal"] : []), ...(allowCheckout ? ["Subscription checkout"] : [])]} read={read} render={row => <><td>{row.organizationName ?? row.organizationId ?? "Individual account"}</td><td>{row.planName ?? row.planCode ?? "Not recorded"}</td><td>{row.status}</td><td>{row.providerStatus ?? "Not recorded"}</td><td><div>{row.providerSubscriptionId ?? "No subscription ID"}</div><small>{row.providerCustomerId ?? "No customer ID"}</small></td><td>{timeLabel(row.currentPeriodEnd)}</td><td>{timeLabel(row.updatedAt)}</td>{allowVerify && <td><button type="button" className="button button-secondary button-small" onClick={() => setVerifiedId(row.id)} aria-label={`Verify subscription ${row.providerSubscriptionId ?? row.id}`}>Verify with Stripe</button></td>}{allowCommands && <td><button type="button" className="button button-secondary button-small" disabled={!row.organizationId} onClick={() => { if (row.organizationId) setSelected({ id: row.organizationId, label: row.organizationName ?? row.organizationId, action: "billing.setAccessOverride" }); }}>Change access</button></td>}{allowPortal && <td><button type="button" className="button button-secondary button-small" disabled={!row.organizationId} onClick={() => { if (row.organizationId) setPortal({ id: row.organizationId, label: row.organizationName ?? row.organizationId }); }}>Review billing portal</button></td>}{allowCheckout && <td><button type="button" className="button button-secondary button-small" disabled={!row.organizationId} onClick={() => { if (row.organizationId) setCheckout({ id: row.organizationId, label: row.organizationName ?? row.organizationId }); }}>Review subscription checkout</button></td>}</>} />
    {allowInvoices && <InvoiceRecords portfolio={portfolio} canGet={capabilities.operations.includes("billing.invoices.get")} />}
  </section>;
}
