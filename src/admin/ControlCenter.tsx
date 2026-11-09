import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Activity, ArrowRight, Bot, Boxes, CreditCard, Globe2, Headphones, Inbox, Link2, Mail, MessageCircle, MessageSquareText, Phone, Plug, Radio, RefreshCw, ShieldCheck, Users } from "lucide-react";
import { repository } from "../data";
import type { ContentItem, HubRepository, Product, SupportCase } from "../domain";
import { config } from "../lib/config";
import { communicationsClient } from "../support/communicationsClient";
import type { Channel } from "../support/communicationsClient";
import { readinessClient as supportReadinessClient } from "../support/readiness";
import type { ReadinessClient as SupportReadinessClient, ReadinessProduct } from "../support/readiness";
import { phoneRegistryClient } from "../support/phoneRegistryModel";
import type { PhoneRegistryClient, PhoneRow } from "../support/phoneRegistryModel";
import { Loading, ReadFailure } from "./AdminReads";
import { aiFeatureLabels, aiUsageClient, aiUsagePeriods } from "./aiUsageClient";
import type { AiUsageClient, AiUsagePeriod, AiUsageSummary } from "./aiUsageClient";
import { applicationCards, channelCards, goLiveChecks, headline, loadCommunicationsSnapshot, phoneSummary } from "./controlCenter";
import type { ApplicationCard, CommunicationsReader, ControlCenterInput } from "./controlCenter";
import { docsUrl, integrationSetupClient } from "./integrationSetupClient";
import type { IntegrationSetupClient, IntegrationSetupReport } from "./integrationSetupClient";
import { portfolioClient } from "./portfolioClient";
import type { PortfolioClient } from "./portfolioClient";
import { loadPortfolioRollup } from "./portfolioRollup";
import type { BillingReader } from "./portfolioRollup";
import { billingClient } from "../billing/billingClient";
import { formatCents } from "../billing/billingModel";
import { readinessClient as goLiveClient } from "./readinessClient";
import type { ReadinessClient as GoLiveClient } from "./readinessClient";
import type { GoLiveReadinessReport } from "./readinessProtocol";
import { timeLabel } from "./readState";
import type { AdminReadState } from "./readState";
import { useAdminRead } from "./useAdminRead";
import "./admin.css";

const formatNumber = new Intl.NumberFormat();
const channelIcons: Record<Channel, typeof Phone> = { phone: Phone, sms: MessageSquareText, email: Mail, chat: MessageCircle, web_form: Globe2 };
const previewNote = "Not available in the implementation preview. Sign in to the live Hub to see it.";

export interface ControlCenterData { products: Product[]; cases: SupportCase[]; content: ContentItem[] }
export interface ControlCenterClients {
  portfolio?: PortfolioClient;
  /** The Hub's own billing workspace, the source of every subscription figure. */
  billing?: BillingReader;
  communications?: CommunicationsReader;
  supportReadiness?: SupportReadinessClient;
  goLive?: GoLiveClient;
  phones?: PhoneRegistryClient;
  aiUsage?: AiUsageClient;
  integrationSetup?: IntegrationSetupClient;
  /** The Hub's own case and article records, re-read on refresh so the counts never go stale while the page stays open. */
  hub?: Pick<HubRepository, "listCases" | "listContent">;
  /** The credential-free preview has no live Hub services to read; those blocks say so instead of failing. */
  demo?: boolean;
}

function Status({ done, yes = "Done", no = "Still needed" }: { done: boolean; yes?: string; no?: string }) {
  return <span className={`admin-status ${done ? "admin-status-connected" : "admin-status-muted"}`}>{done ? yes : no}</span>;
}

function Figure<T>({ icon: Icon, tone, label, state, value, detail }: { icon: typeof Inbox; tone: string; label: string; state: AdminReadState<T>; value: (data: T) => string; detail: (data: T) => string }) {
  const figure = state.status === "ready" ? value(state.data) : state.status === "loading" ? "…" : "Unavailable";
  // A missing figure reads as a status, smaller than a real number, so it fits the card.
  const placeholder = figure === "…" || figure === "Unavailable";
  return <article className={`metric-card ${tone}`}><span className="metric-icon"><Icon /></span><div><p>{label}</p>
    <strong className={placeholder ? "metric-placeholder" : undefined}>{figure}</strong>
    <small>{state.status === "ready" ? detail(state.data) : state.status === "loading" ? "Loading live figures" : "Could not be loaded · never estimated"}</small></div></article>;
}

function Row({ icon: Icon, label, children }: { icon: typeof Activity; label: string; children: ReactNode }) {
  return <div><dt><Icon size={14} aria-hidden="true" />{label}</dt><dd>{children}</dd></div>;
}

function ApplicationPanel({ card, communicationsLoading, intakeLoading, usageLoading, preview }: { card: ApplicationCard; communicationsLoading: boolean; intakeLoading: boolean; usageLoading: boolean; preview: boolean }) {
  const connection = card.connection.state;
  const { support, intake, directory, integration, subscriptions, health, links } = card;
  return <article className="panel control-app" aria-label={`${card.name} controls`}>
    <header className="control-app-head"><div><h3>{card.name}</h3><p>{card.scope}</p></div>
      <Status done={connection === "verified"} yes="Connection verified" no={connection === "pending" ? "Connection pending" : "Unavailable"} /></header>
    <dl className="control-app-rows">
      <Row icon={Activity} label="Health">
        {health.state === "ready" && <><div className="control-chips">{health.metrics.map(metric => <span key={metric.label}>{metric.label}: <strong>{metric.value === null ? "Not reported" : formatNumber.format(metric.value)}</strong></span>)}</div>
          <small>Deployed source {card.connection.sourceRevision ?? "not reported"}</small></>}
        {health.state === "not-provided" && <span className="control-muted">This connection does not provide an application overview.</span>}
        {health.state === "unavailable" && <span className="control-muted">Unavailable — the application could not be reached. Its figures are never estimated.</span>}
      </Row>
      <Row icon={CreditCard} label="Subscriptions">
        {subscriptions.state === "ready" && subscriptions.data && <><strong>{formatNumber.format(subscriptions.data.count)}</strong> subscriptions · <strong>{formatCents(subscriptions.data.mrrCents)}</strong> MRR
          <div className="control-chips">{subscriptions.data.statusCounts.map(item => <span key={item.status}>{item.status.replaceAll("_", " ")}: <strong>{formatNumber.format(item.count)}</strong></span>)}</div></>}
        {subscriptions.state === "unavailable" && <span className="control-muted">Unavailable</span>}
        {subscriptions.note && <small>{subscriptions.note}</small>}
        {subscriptions.state !== "not-applicable" && <div className="control-links"><Link to={links.billing}>Billing and subscriptions</Link></div>}
      </Row>
      <Row icon={Users} label="Users & organizations">
        <span className={directory.state === "available" ? "" : "control-muted"}>{directory.label}</span>
        {(directory.organizations || directory.users) && <div className="control-links">{directory.organizations && <Link to={links.organizations}>Organizations</Link>}{directory.users && <Link to={links.users}>Users</Link>}{directory.accessControls && <small>Suspension and activation access changes are reviewed in the workspace.</small>}</div>}
      </Row>
      <Row icon={Link2} label="Integration">
        <div>Help SDK: <span className={`state-${integration.rollout.state}`}>{integration.rollout.stateLabel}</span> <small>{integration.rollout.integration}</small></div>
        <div>Administration connection: {integration.endpointHost ?? "not configured"} · <small>{connection === "verified" ? "verified now" : connection === "pending" ? "pending" : "not answering"}</small></div>
        {integration.sources.length > 0 && <div><small>Feeds the Hub inbox: {integration.sources.join(", ")}</small></div>}
        <div className="control-links"><Link to="/integration">App integration</Link></div>
      </Row>
      <Row icon={Headphones} label="Support">
        {support ? <>
          <div>{support.conversations === null ? <span className="control-muted">{communicationsLoading ? "Loading conversations…" : "Conversations unavailable"}</span> : <><strong>{formatNumber.format(support.conversations)}</strong> conversations waiting</>} · <strong>{formatNumber.format(support.openCases)}</strong> open cases{support.urgentCases > 0 && <> (<strong>{formatNumber.format(support.urgentCases)}</strong> urgent)</>} · <strong>{formatNumber.format(support.publishedArticles)}</strong> published articles <small>({support.appSpecificArticles} app-specific)</small>{" · "}{support.aiCalls === null ? <span className="control-muted">{preview ? "AI usage not available in the preview" : usageLoading ? "Loading AI usage…" : "AI usage unavailable"}</span> : <><strong>{formatNumber.format(support.aiCalls)}</strong> AI calls</>}</div>
          <div className="control-links">{links.communications && <Link to={links.communications}>Communications</Link>}{links.cases && <Link to={links.cases}>Support cases</Link>}{links.knowledge && <Link to={links.knowledge}>Knowledge</Link>}{card.product === "advisors" && connection === "verified" && <Link to={links.inquiries}>Consultation requests</Link>}</div>
        </> : <span className="control-muted">No Hub product is registered for this connection, so no cases, conversations or articles can belong to it.</span>}
      </Row>
      <Row icon={ShieldCheck} label="Customer intake">
        <span className={intake.state === "ready" ? "" : "control-muted"}>{intake.state === "unavailable" ? preview ? previewNote : intakeLoading ? "Loading customer intake readiness…" : intake.note : intake.note}</span>
        {intake.state !== "not-applicable" && <div className="control-links"><Link to="/integration">Review customer access</Link></div>}
      </Row>
    </dl>
    <footer><Link className="button button-secondary button-small" to={links.workspace}>Open {card.name} workspace <ArrowRight size={14} aria-hidden="true" /></Link></footer>
  </article>;
}

function AiUsagePanel({ state, period, onPeriod, retry }: { state: AdminReadState<AiUsageSummary | null>; period: AiUsagePeriod; onPeriod: (period: AiUsagePeriod) => void; retry: () => void }) {
  const tokens = (input: number, output: number) => `${formatNumber.format(input)} in / ${formatNumber.format(output)} out`;
  return <section className="panel control-panel" aria-label="AI usage">
    <div className="panel-heading"><div><h2>AI usage</h2><p>Every Anthropic call the Hub made, by application and by customer within each application. Counts and tokens only, never content.</p></div>
      <label className="control-period">Period<select value={period} onChange={event => onPeriod(Number(event.target.value) as AiUsagePeriod)}>{aiUsagePeriods.map(days => <option key={days} value={days}>Last {days} days</option>)}</select></label></div>
    {state.status === "loading" && <Loading label="Loading AI usage" app="the usage ledger" />}
    {state.status === "error" && <ReadFailure error={state.error} retry={retry} />}
    {state.status === "ready" && state.data === null && <p className="control-panel-note">{previewNote}</p>}
    {state.status === "ready" && state.data && <>
      <p className="control-panel-note control-usage-totals"><strong>{formatNumber.format(state.data.totals.calls)}</strong> calls · {formatNumber.format(state.data.totals.staffCalls)} by staff · {formatNumber.format(state.data.totals.automationCalls)} automated · {formatNumber.format(state.data.totals.failedCalls)} failed · {tokens(state.data.totals.inputTokens, state.data.totals.outputTokens)} tokens{state.data.unattributedCalls > 0 && <> · {formatNumber.format(state.data.unattributedCalls)} not attributed to an application</>}</p>
      <ul className="control-list control-usage">{state.data.products.map(product => <li key={product.productId}><Bot size={16} aria-hidden="true" /><div><strong>{product.name}</strong>
        <span className="control-detail">{formatNumber.format(product.staffCalls)} by staff · {formatNumber.format(product.automationCalls)} automated · {formatNumber.format(product.failedCalls)} failed · {tokens(product.inputTokens, product.outputTokens)} tokens</span>
        {product.tenants.length > 0 && <details className="control-tenants"><summary>{product.tenants.length} customer{product.tenants.length === 1 ? "" : "s"}</summary>
          <ul>{product.tenants.map(tenant => <li key={tenant.tenantId}><span>{tenant.name}</span><span>{formatNumber.format(tenant.calls)} calls · {formatNumber.format(tenant.failedCalls)} failed · {tokens(tenant.inputTokens, tenant.outputTokens)} tokens</span></li>)}</ul></details>}
      </div><span className="control-count">{formatNumber.format(product.calls)} calls</span></li>)}</ul>
      {state.data.features.length > 0 && <div className="control-panel-footer control-chips">{state.data.features.map(item => <span key={item.feature}>{aiFeatureLabels[item.feature] ?? item.feature}: <strong>{formatNumber.format(item.calls)}</strong></span>)}</div>}
    </>}
  </section>;
}

function IntegrationSetupPanel({ state, retry }: { state: AdminReadState<IntegrationSetupReport | null>; retry: () => void }) {
  return <section className="panel control-panel" aria-label="Integration setup">
    <div className="panel-heading"><div><h2>Integration setup</h2><p>The secrets each integration needs in Railway and whether they are set. A secret shows only as set or missing; its value never leaves the service. Switches, addresses and account ids are in <Link to="/admin/settings">Settings</Link>.</p></div></div>
    {state.status === "loading" && <Loading label="Checking integration settings" app="the Hub service" />}
    {state.status === "error" && <ReadFailure error={state.error} retry={retry} />}
    {state.status === "ready" && state.data === null && <p className="control-panel-note">{previewNote}</p>}
    {state.status === "ready" && state.data && <ul className="control-list control-integrations">{state.data.integrations.map(integration => <li key={integration.id}><Plug size={16} aria-hidden="true" /><div><strong>{integration.name}</strong><span className="control-detail">{integration.purpose}{integration.ready && !integration.complete ? " Optional settings are not set." : ""}</span>
      <div className="control-chips control-variables">{integration.variables.map(variable => <span key={variable.name} className={variable.satisfied ? "is-set" : variable.required ? "is-missing" : "is-optional"} title={variable.purpose}><code>{variable.name}</code> {variable.set ? variable.secret ? "set" : variable.value : variable.required ? "missing" : "not set"}</span>)}</div>
      <div className="control-links"><a href={docsUrl(integration.docs)} target="_blank" rel="noreferrer">Setup steps</a></div></div>
      <Status done={integration.ready} yes="Ready" no="Needs setup" /></li>)}</ul>}
    <div className="control-panel-footer"><p className="control-panel-note">To add or change a secret, open the Hub service in Railway, choose Variables, set the exact name shown here and let the service redeploy, then refresh this page. The Hub never stores or sends a secret from the browser.</p></div>
  </section>;
}

export function ControlCenter({ data, portfolio = portfolioClient, billing = billingClient.workspace, communications = communicationsClient, supportReadiness = supportReadinessClient, goLive = goLiveClient, phones = phoneRegistryClient, aiUsage = aiUsageClient, integrationSetup = integrationSetupClient, hub = repository, demo = config.demoMode }: { data: ControlCenterData } & ControlCenterClients) {
  const [refresh, setRefresh] = useState(0);
  const [period, setPeriod] = useState<AiUsagePeriod>(30);
  const retry = () => setRefresh(value => value + 1);
  const products = data.products;
  const readApps = useCallback((signal: AbortSignal) => { void refresh; return loadPortfolioRollup(portfolio, signal, demo ? undefined : billing); }, [billing, demo, portfolio, refresh]);
  const readCommunications = useCallback((signal: AbortSignal) => { void refresh; return loadCommunicationsSnapshot(communications, products, signal); }, [communications, products, refresh]);
  const readIntake = useCallback(async (signal: AbortSignal): Promise<ReadinessProduct[] | null> => { void refresh; return demo ? null : (await supportReadiness.summary(signal)).products; }, [demo, refresh, supportReadiness]);
  const readGoLive = useCallback(async (signal: AbortSignal): Promise<GoLiveReadinessReport | null> => { void refresh; return demo ? null : goLive.report({ signal }); }, [demo, goLive, refresh]);
  const readPhones = useCallback(async (signal: AbortSignal): Promise<PhoneRow[] | null> => { void refresh; return demo ? null : (await phones.list(signal)).rows; }, [demo, phones, refresh]);
  const readUsage = useCallback(async (signal: AbortSignal): Promise<AiUsageSummary | null> => { void refresh; return demo ? null : aiUsage.summary(period, signal); }, [aiUsage, demo, period, refresh]);
  const readSetup = useCallback(async (signal: AbortSignal): Promise<IntegrationSetupReport | null> => { void refresh; return demo ? null : integrationSetup.report({ signal }); }, [demo, integrationSetup, refresh]);
  const readHub = useCallback(async () => { void refresh; const [cases, content] = await Promise.all([hub.listCases(), hub.listContent()]); return { cases, content }; }, [hub, refresh]);
  const apps = useAdminRead(readApps);
  const inbox = useAdminRead(readCommunications);
  const intake = useAdminRead(readIntake);
  const live = useAdminRead(readGoLive);
  const numbers = useAdminRead(readPhones);
  const usage = useAdminRead(readUsage);
  const setup = useAdminRead(readSetup);
  // Until the first re-read answers, the records the app loaded on sign-in stand in.
  const records = useAdminRead(readHub);
  const cases = records.status === "ready" ? records.data.cases : data.cases;
  const content = records.status === "ready" ? records.data.content : data.content;

  const input: ControlCenterInput = {
    apps: apps.status === "ready" ? apps.data : [], products, cases, content,
    communications: inbox.status === "ready" ? inbox.data : null, readiness: intake.status === "ready" ? intake.data : null,
    aiUsage: usage.status === "ready" ? usage.data : null,
  };
  const summary = headline(input);
  const cards = apps.status === "ready" ? applicationCards(input) : [];
  const intakeReady = intake.status === "ready" && intake.data !== null ? intake.data : null;
  const intakeEnabled = intakeReady?.filter(item => item.supportEnabled) ?? [];
  const intakeDetail = intakeReady === null ? "" : `${formatNumber.format(intakeEnabled.reduce((sum, item) => sum + item.readyTenantCount, 0))} ready customers across ${formatNumber.format(intakeEnabled.length)} ${intakeEnabled.length === 1 ? "application" : "applications"} with support enabled`;

  return <div className="control-center">
    <div className="page-heading"><div><span className="eyebrow">CareMetric Admin</span><h1>Control center</h1>
      <p>Every application, customer channel and Hub service you run, read live when this page opens: connection health, subscriptions, users and organizations, integrations, AI usage, and technical support and customer service from phone, text, email, chat and web forms. A figure that could not be read is shown as unavailable, never estimated. Open any workspace from here with your current sign-in.</p></div>
      <button className="button button-secondary" type="button" onClick={retry}><RefreshCw size={15} aria-hidden="true" />Refresh everything</button></div>

    <section className="metric-grid control-center-metrics" aria-label="Portfolio at a glance">
      <Figure icon={Boxes} tone="metric-teal" label="Applications connected" state={apps} value={() => formatNumber.format(summary.connected)} detail={() => `of ${summary.total} administration connections`} />
      <Figure icon={Inbox} tone="metric-amber" label="Conversations waiting" state={inbox} value={() => formatNumber.format(summary.conversations ?? 0)} detail={() => "Phone, text, email, chat and web forms"} />
      <article className="metric-card metric-blue"><span className="metric-icon"><Headphones /></span><div><p>Open support cases</p><strong>{formatNumber.format(summary.openCases)}</strong><small>{summary.urgentCases ? `${formatNumber.format(summary.urgentCases)} urgent` : "No urgent cases"}</small></div></article>
      <Figure icon={CreditCard} tone="metric-violet" label="Subscriptions" state={apps} value={() => summary.subscriptions === null ? "Unavailable" : formatNumber.format(summary.subscriptions)} detail={() => summary.subscriptions === null ? "Hub billing could not be loaded" : "Billed by the Hub across every application"} />
      <Figure icon={Radio} tone="metric-teal" label="Channels live" state={inbox} value={() => `${summary.channelsLive ?? 0} of ${summary.channelsTotal}`} detail={() => "Live channels reach the Communications inbox"} />
    </section>

    <div className="control-center-grid">
      <section className="panel control-panel" aria-label="Customer channels">
        <div className="panel-heading"><div><h2>Customer channels</h2><p>Technical support and customer service from every channel land in one inbox.</p></div><Link className="text-link" to="/communications">Open inbox <ArrowRight size={14} aria-hidden="true" /></Link></div>
        {inbox.status === "loading" && <Loading label="Checking channels and waiting conversations" app="Communications" />}
        {inbox.status === "error" && <ReadFailure error={inbox.error} retry={retry} />}
        {inbox.status === "ready" && <ul className="control-list">{channelCards(inbox.data).map(card => { const Icon = channelIcons[card.channel]; return <li key={card.channel}>
          <Icon size={16} aria-hidden="true" /><div><strong>{card.label}</strong><span className="control-detail">{card.detail}</span></div>
          <Status done={card.ready} yes="Live" no="Not live" />
          <Link className="control-count" to={card.href} aria-label={`Open ${card.label} conversations`}>{formatNumber.format(card.waiting)} waiting</Link></li>; })}</ul>}
        <div className="control-panel-footer"><Link className="text-link" to="/admin/email">Bulk email to application users</Link><Link className="text-link" to="/phone-numbers">Phone numbers and routing</Link><Link className="text-link" to="/phone">AI phone inbox</Link><Link className="text-link" to="/cases">Support case queue</Link><Link className="text-link" to="/knowledge">Knowledge articles</Link></div>
      </section>

      <section className="panel control-panel" aria-label="Hub services">
        <div className="panel-heading"><div><h2>Hub services</h2><p>AI assistance prerequisites, the phone number inventory and customer intake, checked live.</p></div></div>
        <ul className="control-list">
          {live.status === "loading" && <li><Loading label="Checking AI go-live readiness" app="go-live" /></li>}
          {live.status === "error" && <li><ReadFailure error={live.error} retry={retry} /></li>}
          {live.status === "ready" && live.data === null && <li><ShieldCheck size={16} aria-hidden="true" /><div><strong>AI go-live readiness</strong><span className="control-detail">{previewNote}</span></div></li>}
          {live.status === "ready" && live.data && goLiveChecks(live.data).map(check => <li key={check.label}><ShieldCheck size={16} aria-hidden="true" /><div><strong>{check.label}</strong><span className="control-detail">{check.detail}</span></div><Status done={check.done} /></li>)}
          {numbers.status === "loading" && <li><Loading label="Loading the phone number inventory" app="phone registry" /></li>}
          {numbers.status === "error" && <li><ReadFailure error={numbers.error} retry={retry} /></li>}
          {numbers.status === "ready" && (numbers.data === null
            ? <li><Phone size={16} aria-hidden="true" /><div><strong>Phone numbers</strong><span className="control-detail">{previewNote}</span></div></li>
            : (() => { const phone = phoneSummary(numbers.data); return <li><Phone size={16} aria-hidden="true" /><div><strong>Phone numbers</strong><span className="control-detail">{formatNumber.format(phone.active)} active · {formatNumber.format(phone.needsReview)} need review · {formatNumber.format(phone.textingAttention)} with texting attention</span></div><Status done={phone.needsReview === 0} yes="Reviewed" no="Review needed" /><Link className="control-count" to="/phone-numbers">{formatNumber.format(phone.total)} numbers</Link></li>; })())}
          {intake.status === "loading" && <li><Loading label="Loading customer intake readiness" app="support readiness" /></li>}
          {intake.status === "error" && <li><ReadFailure error={intake.error} retry={retry} /></li>}
          {intake.status === "ready" && (intakeReady === null
            ? <li><Users size={16} aria-hidden="true" /><div><strong>Customer intake</strong><span className="control-detail">{previewNote}</span></div></li>
            : <li><Users size={16} aria-hidden="true" /><div><strong>Customer intake</strong><span className="control-detail">{intakeDetail}</span></div><Link className="control-count" to="/integration">Review access</Link></li>)}
        </ul>
        <div className="control-panel-footer"><Link className="text-link" to="/admin/settings">Settings: switches, addresses and ids</Link><Link className="text-link" to="/admin/billing">Billing: subscriptions, catalog and discounts</Link><Link className="text-link" to="/admin/go-live-readiness">AI go-live readiness</Link><Link className="text-link" to="/integration">Connections and customer onboarding</Link><Link className="text-link" to="/admin/portfolio">Portfolio rollup and coverage matrix</Link><Link className="text-link" to="/security">Account security</Link></div>
      </section>

      <AiUsagePanel state={usage} period={period} onPeriod={setPeriod} retry={retry} />
      <IntegrationSetupPanel state={setup} retry={retry} />
    </div>

    <section aria-label="Applications">
      <div className="admin-section-title"><div><h2>Applications</h2><p>Each card is read through that application's administration connection and the Hub's own records{apps.status === "ready" ? ` · loaded ${timeLabel(apps.receivedAt)}` : ""}. Open a workspace to manage users, organizations, billing, courses and more.</p></div><Link className="text-link" to="/admin/apps">Per-application workspace <ArrowRight size={14} aria-hidden="true" /></Link></div>
      {apps.status === "loading" && <Loading label="Checking every application connection" app="portfolio" />}
      {apps.status === "error" && <ReadFailure error={apps.error} retry={retry} />}
      {apps.status === "ready" && <div className="control-app-grid">{cards.map(card => <ApplicationPanel key={card.product} card={card} communicationsLoading={inbox.status === "loading"} intakeLoading={intake.status === "loading"} usageLoading={usage.status === "loading"} preview={demo} />)}</div>}
    </section>
  </div>;
}
