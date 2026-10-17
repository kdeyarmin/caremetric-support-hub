import { useCallback, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Loading, ReadFailure } from "./AdminReads";
import { readinessClient } from "./readinessClient";
import type { ReadinessClient } from "./readinessClient";
import type { GoLiveReadinessReport } from "./readinessProtocol";
import { timeLabel } from "./readState";
import { useAdminRead } from "./useAdminRead";
import "./admin.css";

function Status({ done }: { done: boolean }) {
  return <span className={`admin-status ${done ? "admin-status-connected" : "admin-status-muted"}`}>{done ? "Done" : "Still needed"}</span>;
}

function MigrationsRow({ report }: { report: GoLiveReadinessReport }) {
  return <section className="panel" aria-label="Production migrations">
    <div className="admin-section-title"><div><h2>Production migrations</h2><p>The AI case assistance release must be applied to the production database. Each migration is checked separately against the live database — the objects it creates and the backend contract features it registers.</p></div><Status done={report.migrations.complete} /></div>
    <div className="readiness-migrations">
      {report.migrations.items.map(item => <p key={item.version}><strong>{item.version}</strong> · {item.name} — <span className={`admin-status ${item.applied ? "admin-status-connected" : "admin-status-muted"}`}>{item.applied ? "Applied" : "Not applied"}</span></p>)}
    </div>
    {!report.migrations.complete && <p className="admin-explanation">Apply the missing migrations to the production database, then refresh. Nothing is applied from this panel.</p>}
  </section>;
}

function AnthropicKeyRow({ report }: { report: GoLiveReadinessReport }) {
  const present = report.anthropicKey.present;
  return <section className="panel" aria-label="Anthropic API key">
    <div className="admin-section-title"><div><h2>Anthropic API key</h2><p>The Hub service calls Anthropic directly for staff AI assistance and the customer auto-resolution loop.</p></div><Status done={present} /></div>
    {present
      ? <p className="admin-explanation">A key is configured on the Hub service. For security this panel reports presence only — never the key itself, in whole or in part.</p>
      : <p className="admin-explanation">No key is configured on the Hub service. Set ANTHROPIC_API_KEY on the service, then refresh.</p>}
  </section>;
}

function AutomationRow({ report }: { report: GoLiveReadinessReport }) {
  const enabled = report.aiAutomation.enabled;
  return <section className="panel" aria-label="AI automation">
    <div className="admin-section-title"><div><h2>AI automation</h2><p>The customer auto-resolution loop stays off until it is deliberately enabled on the Hub service.</p></div><Status done={enabled} /></div>
    {enabled
      ? <p className="admin-explanation">Automation is enabled: HUB_AI_AUTOMATION_ENABLED is set to true on the Hub service.</p>
      : <p className="admin-explanation">Automation is off. It turns on only when HUB_AI_AUTOMATION_ENABLED is set to exactly true on the Hub service — keep it off until the migrations and the Anthropic key above are in place, because the loop needs both.</p>}
  </section>;
}

function HelpDomainRow({ report }: { report: GoLiveReadinessReport }) {
  const { hostname, resolves, targets } = report.helpDomain;
  return <section className="panel" aria-label="Help domain">
    <div className="admin-section-title"><div><h2>{hostname}</h2><p>The public help address must resolve to this Hub before customers can use it.</p></div><Status done={resolves} /></div>
    {resolves
      ? <p className="admin-explanation">{hostname} resolves to {targets.join(", ")} — checked live just now.</p>
      : <p className="admin-explanation">{hostname} does not resolve yet. Add its CNAME record with your DNS provider pointing to support-hub-web-production.up.railway.app, then refresh.</p>}
  </section>;
}

export function GoLiveReadiness({ readiness = readinessClient }: { readiness?: ReadinessClient }) {
  const [refresh, setRefresh] = useState(0);
  const retry = () => setRefresh(value => value + 1);
  const reader = useCallback((signal: AbortSignal) => { void refresh; return readiness.report({ signal }); }, [readiness, refresh]);
  const state = useAdminRead(reader);
  return <div className="go-live-readiness">
    <div className="page-heading"><div><span className="eyebrow">CareMetric Admin</span><h1>AI go-live readiness</h1><p>The four prerequisites for switching on AI case assistance and the customer auto-resolution loop, each checked live when this page loads — nothing here is remembered from an earlier visit. This panel reports only: it never applies a migration, sets a key, enables automation, or changes DNS.</p></div><button className="button button-secondary" type="button" onClick={retry}><RefreshCw size={15} aria-hidden="true" />Refresh checks</button></div>
    {state.status === "loading" && <Loading label="Checking go-live readiness" app="go-live" />}
    {state.status === "error" && <ReadFailure error={state.error} retry={retry} />}
    {state.status === "ready" && <>
      <p className="admin-read-time">Checked {timeLabel(state.receivedAt)} against the live production database, this service’s own configuration, and public DNS.</p>
      <MigrationsRow report={state.data} />
      <AnthropicKeyRow report={state.data} />
      <AutomationRow report={state.data} />
      <HelpDomainRow report={state.data} />
    </>}
  </div>;
}
