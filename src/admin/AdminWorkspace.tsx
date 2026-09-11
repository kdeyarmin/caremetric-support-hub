import { useCallback, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ArrowRight, BookOpen, Building2, CreditCard, Layers3, RefreshCw, Search, Users } from "lucide-react";
import { adminRegistry } from "../../supabase/functions/_shared/adminRegistry";
import { portfolioProducts } from "../../supabase/functions/_shared/portfolioProtocol";
import type { AdminDirectoryUser, AdminOrganization, AdminPage, AdminSubscription, PortfolioCapabilities, PortfolioOperationName, PortfolioProduct } from "../../supabase/functions/_shared/portfolioProtocol";
import { AdminInventory } from "./AdminInventory";
import { adminInventory } from "./inventory";
import { CourseCatalog } from "./CareBaseCourses";
import { Loading, ReadFailure } from "./AdminReads";
import { timeLabel } from "./readState";
import { useAdminRead } from "./useAdminRead";
import { portfolioClient } from "./portfolioClient";
import type { PortfolioClient } from "./portfolioClient";
import type { AdminClient } from "./types";
import "./admin.css";

type View = "overview" | "organizations" | "users" | "billing" | "courses" | "inventory";
const viewOperations: Record<Exclude<View, "inventory">, PortfolioOperationName[]> = {
  overview: ["overview"], organizations: ["organizations.list"], users: ["users.list"],
  billing: ["billing.overview", "billing.subscriptions.list"], courses: ["courses.list", "courses.get"],
};
const views = [
  { id: "overview", name: "Overview", icon: Layers3 }, { id: "organizations", name: "Organizations", icon: Building2 },
  { id: "users", name: "Users", icon: Users }, { id: "billing", name: "Billing", icon: CreditCard },
  { id: "courses", name: "CareBase courses", icon: BookOpen },
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

function ApplicationWorkspace({ product, client, portfolio }: { product: PortfolioProduct; client: AdminClient; portfolio: PortfolioClient }) {
  const [view, setView] = useState<View>("overview");
  const [refresh, setRefresh] = useState(0);
  const retry = () => setRefresh(value => value + 1);
  const readCapabilities = useCallback((signal: AbortSignal) => { void refresh; return portfolio.capabilities({ product, signal }); }, [portfolio, product, refresh]);
  const state = useAdminRead(readCapabilities);
  const app = adminRegistry[product];
  const capabilities = state.status === "ready" ? state.data : null;
  const supports = (candidate: Exclude<View, "inventory">) => viewOperations[candidate].every(operation => capabilities?.operations.includes(operation));
  return <>
    <div className="admin-section-title"><div><h2>{app.name}</h2><p>{app.userScope}</p></div><span className={`admin-status ${state.status === "ready" ? "admin-status-connected" : "admin-status-muted"}`}>{state.status === "ready" ? "Connection verified" : state.status === "loading" ? "Checking connection" : "Unavailable"}</span></div>
    <nav className="admin-view-nav" aria-label="Administration workspace views">{views.filter(item => supports(item.id)).map(({ id, name, icon: Icon }) => <button key={id} type="button" className={view === id ? "active" : ""} aria-pressed={view === id} onClick={() => setView(id)}><Icon size={16} aria-hidden="true" />{name}</button>)}<button type="button" className={view === "inventory" ? "active" : ""} aria-pressed={view === "inventory"} onClick={() => setView("inventory")}><Layers3 size={16} aria-hidden="true" />All app functions <span>{adminInventory.length}</span></button></nav>
    {view === "inventory" ? <AdminInventory /> : <>
      {state.status === "loading" && <Loading label={`Checking ${app.name} capabilities`} app={app.name} />}
      {state.status === "error" && <ReadFailure error={state.error} retry={retry} />}
      {capabilities && !supports(view) && <p className="admin-explanation">This connection does not currently provide this operation.</p>}
      {capabilities && supports(view) && <div key={`${view}:${refresh}`}>
        {view === "overview" && <Overview product={product} portfolio={portfolio} capabilities={capabilities} retry={retry} />}
        {view === "organizations" && <Directory product={product} portfolio={portfolio} kind="organizations" />}
        {view === "users" && <Directory product={product} portfolio={portfolio} kind="users" />}
        {view === "billing" && <Billing product={product} portfolio={portfolio} retry={retry} />}
        {view === "courses" && product === "carebase" && <CourseCatalog client={client} />}
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
    { label: product === "breathe" ? "Active staff accounts" : "Active application profiles", value: state.data.activeUserCount },
    ...(state.data.globalCourseCount === undefined ? [] : [{ label: "Shared courses · all publication states", value: state.data.globalCourseCount }]),
    ...(state.data.subscriptionCount === undefined ? [] : [{ label: "Recorded subscriptions", value: state.data.subscriptionCount }]),
  ];
  return <section><div className="metric-grid admin-metric-grid">{metrics.map(metric => <div className="metric-card metric-teal" key={metric.label}><div><p>{metric.label}</p><strong>{formatNumber.format(metric.value)}</strong><small>{app.name}</small></div></div>)}</div><p className="admin-read-time">Last loaded {timeLabel(state.receivedAt)}. These totals include only {app.name}.</p><details className="portfolio-connection-details"><summary>Connection details</summary><p>Supported reads: {capabilities.operations.join(", ")}</p><p>Deployed source: {capabilities.sourceRevision ?? "Not reported"}</p></details></section>;
}

function Directory({ product, portfolio, kind }: { product: PortfolioProduct; portfolio: PortfolioClient; kind: "organizations" | "users" }) {
  const columns = kind === "organizations" ? ["Organization", "Slug", product === "carebase" ? "Subscription status" : "Status", "Created"] : ["Name", "Email", "Role", product === "carebase" ? "Profile status" : "Account status", "Created"];
  const read = useCallback((search: string, offset: number, signal: AbortSignal) => kind === "organizations"
    ? portfolio.organizations({ product, search: search || undefined, offset, limit: 20, signal })
    : portfolio.users({ product, search: search || undefined, offset, limit: 20, signal }), [kind, portfolio, product]);
  return <PagedRecords<AdminOrganization | AdminDirectoryUser> app={adminRegistry[product].name} title={kind === "organizations" ? "Organizations" : product === "breathe" ? "Staff accounts" : "Application user profiles"} searchLabel={kind === "organizations" ? "Search organization names" : "Search account emails"} columns={columns} read={read} render={row => "name" in row
    ? <><td>{row.name ?? row.slug ?? row.id}</td><td>{row.slug ?? "—"}</td><td>{row.status}</td><td>{timeLabel(row.createdAt)}</td></>
    : <><td>{row.displayName ?? "Not recorded"}</td><td>{row.email ?? "Not recorded"}</td><td>{row.role}</td><td>{row.status}</td><td>{timeLabel(row.createdAt)}</td></>} />;
}

function Billing({ product, portfolio, retry }: { product: PortfolioProduct; portfolio: PortfolioClient; retry: () => void }) {
  const reader = useCallback((signal: AbortSignal) => portfolio.billing({ product, signal }), [portfolio, product]);
  const state = useAdminRead(reader);
  const read = useCallback((search: string, offset: number, signal: AbortSignal) => portfolio.subscriptions({ product, search: search || undefined, offset, limit: 20, signal }), [portfolio, product]);
  return <section><div className="panel portfolio-billing-summary"><h2>Subscription administration</h2><p>These are subscription records stored by {adminRegistry[product].name}, including historical records. Provider status reflects the app’s latest recorded synchronization. It is not a new query to the payment provider.</p>{state.status === "loading" && <Loading label="Loading subscription states" app={adminRegistry[product].name} />}{state.status === "error" && <ReadFailure error={state.error} retry={retry} />}{state.status === "ready" && <><p><strong>{formatNumber.format(state.data.subscriptionCount)}</strong> recorded subscriptions · loaded {timeLabel(state.receivedAt)}</p><div className="portfolio-status-counts">{state.data.statusCounts.map(item => <span key={item.status}>{item.status}: <strong>{formatNumber.format(item.count)}</strong></span>)}</div></>}</div>
    <PagedRecords<AdminSubscription> app={adminRegistry[product].name} title="Subscription records" searchLabel="Search provider subscription IDs" columns={["Organization", "Plan", "Application state", "Provider state", "Provider IDs", "Period end", "Updated"]} read={read} render={row => <><td>{row.organizationName ?? row.organizationId}</td><td>{row.planName ?? row.planCode ?? "Not recorded"}</td><td>{row.status}</td><td>{row.providerStatus ?? "Not recorded"}</td><td><div>{row.providerSubscriptionId ?? "No subscription ID"}</div><small>{row.providerCustomerId ?? "No customer ID"}</small></td><td>{timeLabel(row.currentPeriodEnd)}</td><td>{timeLabel(row.updatedAt)}</td></>} />
  </section>;
}

function PagedRecords<T extends { id: string }>({ app, title, searchLabel, columns, read, render }: { app: string; title: string; searchLabel: string; columns: string[]; read: (search: string, offset: number, signal: AbortSignal) => Promise<AdminPage<T>>; render: (item: T) => ReactNode }) {
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const retry = () => setRefresh(value => value + 1);
  const reader = useCallback((signal: AbortSignal) => { void refresh; return read(search, offset, signal); }, [read, search, offset, refresh]);
  const state = useAdminRead(reader);
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setSearch(input.trim()); setOffset(0); retry(); }
  return <section className="panel portfolio-records"><div className="panel-heading"><h2>{title}</h2></div><div className="admin-section-body"><form className="admin-course-search" onSubmit={submit}><label className="admin-search"><span className="admin-field-label">{searchLabel}</span><span className="admin-search-input"><Search size={16} aria-hidden="true" /><input type="search" maxLength={100} value={input} onChange={event => setInput(event.target.value)} /></span></label><button className="button button-primary" type="submit">Search</button></form>
    {state.status === "loading" && <Loading label={`Loading ${title.toLowerCase()}`} app={app} />}
    {state.status === "error" && <ReadFailure error={state.error} retry={retry} />}
    {state.status === "ready" && <><p role="status">{formatNumber.format(state.data.total)} matching records · loaded {timeLabel(state.receivedAt)}</p><div className="portfolio-table-wrap"><table><thead><tr>{columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead><tbody>{state.data.items.map(row => <tr key={row.id}>{render(row)}</tr>)}</tbody></table></div>{state.data.items.length === 0 && <p>No records on this page. Adjust your search or return to the previous page.</p>}<div className="admin-pagination"><span>{state.data.items.length} shown</span><div><button className="button button-secondary button-small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}><ArrowLeft size={13} aria-hidden="true" />Previous</button><button className="button button-secondary button-small" disabled={offset + 20 >= state.data.total || offset + 20 > 10000} onClick={() => setOffset(offset + 20)}>Next<ArrowRight size={13} aria-hidden="true" /></button></div></div>{offset + 20 > 10000 && offset + 20 < state.data.total && <p>Refine your search to browse more records.</p>}</>}
    </div></section>;
}
