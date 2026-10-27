import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { adminRegistry } from "../../supabase/functions/_shared/adminRegistry";
import type { PortfolioProduct } from "../../supabase/functions/_shared/portfolioProtocol";
import { Loading, ReadFailure } from "./AdminReads";
import { formatBillingMoney } from "./billingMoney";
import { portfolioClient } from "./portfolioClient";
import type { PortfolioClient } from "./portfolioClient";
import { buildPortfolioRollup, loadPortfolioRollup, sharedWithProduct } from "./portfolioRollup";
import type { BillingReader } from "./portfolioRollup";
import { billingClient } from "../billing/billingClient";
import { formatCents } from "../billing/billingModel";
import { config } from "../lib/config";
import { applicationLabel, overviewMetrics } from "./overviewMetrics";
import { coverageAreas, coverageMatrix, coverageSummary } from "./coverageMatrix";
import type { RollupAppSnapshot } from "./portfolioRollup";
import { timeLabel } from "./readState";
import { useAdminRead } from "./useAdminRead";
import "./admin.css";

const formatNumber = new Intl.NumberFormat();

function productName(product: PortfolioProduct): string {
  return adminRegistry[product].name;
}

function OverviewMetrics({ app }: { app: RollupAppSnapshot }) {
  const product = app.product;
  if (app.overview.state === "not-advertised") return <p className="admin-explanation">This connection does not provide an application overview.</p>;
  if (app.overview.state === "unavailable") return <p className="admin-explanation">The application overview could not be loaded from this connection.</p>;
  const metrics = overviewMetrics(product, app.overview.data);
  return <div className="metric-grid admin-metric-grid">{metrics.map(metric => <div className="metric-card metric-teal" key={metric.label}><div><p>{metric.label}</p><strong>{metric.value === null ? "Not reported" : formatNumber.format(metric.value)}</strong><small>{productName(product)}</small></div></div>)}</div>;
}

function HealthCard({ app }: { app: RollupAppSnapshot }) {
  const registry = adminRegistry[app.product];
  const capabilities = app.capabilities;
  const verified = capabilities !== null;
  const sharedWith = sharedWithProduct(app.product);
  return <section className="panel rollup-app-panel" aria-label={`${registry.name} health`}>
    <div className="admin-section-title"><div><h2>{applicationLabel(app.product)}</h2><p>{registry.userScope}</p></div><span className={`admin-status ${verified ? "admin-status-connected" : "admin-status-muted"}`}>{verified ? "Connection verified" : "Unavailable"}</span></div>
    {verified ? <>
      <OverviewMetrics app={app} />
      {sharedWith && <p className="admin-read-time">These records are shared with {productName(sharedWith)} and must not be counted as additional organizations.</p>}
      <details className="portfolio-connection-details"><summary>Connection details</summary><p>Supported reads: {capabilities.operations.join(", ")}</p><p>Deployed source: {capabilities.sourceRevision ?? "Not reported"}</p></details>
    </> : <p className="admin-explanation">This application could not be reached. Its records and totals are unavailable and are not estimated.</p>}
  </section>;
}

const coverageLabels = { available: "In the Hub", partial: "Partly in the Hub", missing: "Needs app-side work", "not-applicable": "Not applicable", unavailable: "Unavailable" } as const;

function CoverageMatrix({ apps }: { apps: RollupAppSnapshot[] }) {
  const rows = coverageMatrix(apps);
  const summary = coverageSummary(rows);
  return <section aria-label="Super-admin coverage">
    <div className="admin-section-title"><div><h2>Super-admin coverage</h2><p>{summary.available} of {summary.applicable} applicable areas are in the Hub now. Each cell reflects what the application’s live connection provides; gaps are listed with the app-side work they need.</p></div></div>
    <div className="panel portfolio-table-wrap"><table className="coverage-matrix"><thead><tr><th scope="col">Application</th>{coverageAreas.map(area => <th key={area.id} scope="col">{area.label}</th>)}</tr></thead>
      <tbody>{rows.map(row => <tr key={row.product}><th scope="row">{applicationLabel(row.product)}</th>{coverageAreas.map(area => { const cell = row.cells[area.id]; return <td key={area.id} className={`coverage-${cell.state}`}><strong>{coverageLabels[cell.state]}</strong><small>{cell.label}</small></td>; })}</tr>)}</tbody></table></div>
    {rows.some(row => row.nextSteps.length) && <div className="panel coverage-next-steps"><h3>What each gap needs</h3><ul>{rows.filter(row => row.nextSteps.length).map(row => <li key={row.product}><strong>{applicationLabel(row.product)}:</strong> {row.nextSteps.join(" ")}</li>)}</ul></div>}
  </section>;
}

function BillingRow({ app }: { app: RollupAppSnapshot }) {
  return <div className="rollup-billing-row">
    <h3>{applicationLabel(app.product)}</h3>
    {app.product === "advisors" && <p>Healthcare Advisors is a consulting practice. It has no software subscriptions; engagement fees are set by written proposal outside the website.</p>}
    {app.billing.state === "unavailable" && <p>Unavailable — the Hub's billing records could not be loaded.</p>}
    {app.billing.state === "ready" && <><p><strong>{formatNumber.format(app.billing.data.subscriptionCount)}</strong> subscriptions · <strong>{formatCents(app.billing.data.mrrCents)}</strong> MRR</p><div className="portfolio-status-counts">{app.billing.data.statusCounts.map(item => <span key={item.status}>{item.status.replaceAll("_", " ")}: <strong>{formatNumber.format(item.count)}</strong></span>)}</div></>}
  </div>;
}

export function PortfolioRollup({ portfolio = portfolioClient, billing = billingClient.workspace, demo = config.demoMode }: { portfolio?: PortfolioClient; billing?: BillingReader; demo?: boolean }) {
  const [refresh, setRefresh] = useState(0);
  const retry = () => setRefresh(value => value + 1);
  const reader = useCallback((signal: AbortSignal) => { void refresh; return loadPortfolioRollup(portfolio, signal, demo ? undefined : billing); }, [billing, demo, portfolio, refresh]);
  const state = useAdminRead(reader);
  const totals = state.status === "ready" ? buildPortfolioRollup(state.data) : null;
  return <div className="portfolio-rollup">
    <div className="page-heading"><div><span className="eyebrow">CareMetric Admin</span><h1>Portfolio rollup</h1><p>Connection health for every connected application, loaded live through the administration connections, and subscription financials from the Hub's own billing. An application that cannot be reached is shown as unavailable — its figures are never estimated.</p></div><button className="button button-secondary" type="button" onClick={retry}><RefreshCw size={15} aria-hidden="true" />Refresh rollup</button></div>
    {state.status === "loading" && <Loading label="Loading portfolio rollup" app="portfolio" />}
    {state.status === "error" && <ReadFailure error={state.error} retry={retry} />}
    {state.status === "ready" && totals && <>
      <CoverageMatrix apps={state.data} />
      <section aria-label="Application health">
        <div className="admin-section-title"><div><h2>Application health</h2><p>Connections verified for {totals.connectionsVerified} of {totals.connectionsTotal} applications · last loaded {timeLabel(state.receivedAt)}</p></div></div>
        <div className="rollup-app-grid">{state.data.map(app => <HealthCard key={app.product} app={app} />)}</div>
      </section>
      <section aria-label="Subscription financials">
        <div className="admin-section-title"><div><h2>Subscription financials</h2><p>Every application's subscriptions as the Hub bills them in Stripe. Monthly recurring revenue counts active and past-due subscriptions after discounts; trials are not revenue yet. <Link to="/admin/billing">Open Billing</Link></p></div></div>
        <div className="panel portfolio-billing-summary rollup-billing-panel">
          {state.data.map(app => <BillingRow key={app.product} app={app} />)}
          <div className="rollup-totals">
            <h3>Portfolio totals</h3>
            {totals.subscriptionTotal === null
              ? <p>The Hub's billing records could not be loaded, so no portfolio total is shown.</p>
              : <><p><strong>{formatNumber.format(totals.subscriptionTotal)}</strong> subscriptions across {totals.billingReportingApps.map(productName).join(", ")}</p>
                <div className="portfolio-status-counts">{totals.statusTotals.map(item => <span key={item.status}>{item.status}: <strong>{formatNumber.format(item.count)}</strong></span>)}</div></>}
            {totals.moneyByCurrency.map(item => <p key={item.currency}>{item.currency.toUpperCase()} monthly recurring revenue: <strong>{formatBillingMoney(item.amountMinor, item.currency)}</strong></p>)}
          </div>
        </div>
      </section>
      <p className="admin-explanation">Support inquiries from every application are handled in the Hub’s <Link to="/communications">Communications inbox</Link> (phone, text, email, chat and web forms) and its <Link to="/cases">support case queue</Link>. Those records belong to the Hub itself and are not reported by the application connections, so they are not repeated here.</p>
    </>}
  </div>;
}
