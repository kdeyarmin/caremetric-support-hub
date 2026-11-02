import { useCallback, useState } from "react";
import { Bot, RefreshCw } from "lucide-react";
import { Loading, ReadFailure } from "./AdminReads";
import { timeLabel } from "./readState";
import { useAdminRead } from "./useAdminRead";
import { TeamApiError, teamClient } from "./teamClient";
import type { TeamClient } from "./teamClient";
import {
  actionLabel, autonomyHelp, autonomyLabels, cadenceLabel, centsLabel, outcomeLabel, statusLabel, taskLabel, tierLabels,
} from "./teamProtocol";
import type { ActivityKind, ActivityPage, AuditPage, TeamAgent, TeamApproval, TeamOverview, TeamServices } from "./teamProtocol";
import "./admin.css";

type Notice = { ok: boolean; text: string } | null;
type Change = (id: string, work: () => Promise<unknown>, success: string | (() => string)) => Promise<void>;

const failureText = (error: unknown) => error instanceof TeamApiError ? error.message : "The change could not be completed. Nothing was changed.";
const clip = (value: string, limit: number) => (value.length <= limit ? value : `${value.slice(0, limit - 1)}…`);
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function Pill({ good, children }: { good: boolean; children: string }) {
  return <span className={`admin-status ${good ? "admin-status-connected" : "admin-status-muted"}`}>{children}</span>;
}

function ServicesPanel({ services, awaitingSession, busy, onRunWaiting }: { services: TeamServices; awaitingSession: number; busy: string; onRunWaiting: () => void }) {
  const handled = services.handlers.map(taskLabel);
  const rows: Array<{ name: string; good: boolean; state: string; detail: string }> = [
    { name: "Scheduler", good: services.enabled, state: services.enabled ? "On" : "Off",
      detail: services.enabled ? "The team's clock runs every minute." : "Set HUB_AGENTS_ENABLED to true on the Hub service to start the team." },
    { name: "Work with code behind it", good: handled.length > 0, state: handled.length ? `${handled.length} ready` : "None yet",
      detail: handled.length ? handled.join(", ") : "An agent stays idle until the code for its work ships. Nothing here is broken." },
    { name: "Your email address", good: services.ownerEmail, state: services.ownerEmail ? "Set" : "Missing", detail: services.ownerEmail ? "Alerts and the morning brief go here." : "Set HUB_OWNER_EMAIL so the team can email you." },
    { name: "Email delivery", good: services.email, state: services.email ? "Ready" : "Not set up", detail: services.email ? "Through SendGrid." : "Set HUB_SENDGRID_API_KEY so the team can email you." },
    { name: "Text alerts", good: services.sms, state: services.sms ? "Ready" : "Not set up", detail: services.sms ? "Urgent items are texted to your verified number." : "Urgent items fall back to email until Twilio is configured." },
  ];
  return <section className="panel team-services" aria-labelledby="team-services-title">
    <div className="admin-section-title"><div><h2 id="team-services-title">What the team can use</h2><p>The team only does what is switched on here.</p></div></div>
    <ul className="team-service-list">
      {rows.map(row => <li key={row.name}><span className="team-service-name">{row.name}</span><Pill good={row.good}>{row.state}</Pill><span className="muted">{row.detail}</span></li>)}
    </ul>
    {awaitingSession > 0 && <div className="team-waiting">
      <p className="admin-explanation" role="status">{awaitingSession === 1 ? "1 task is" : `${awaitingSession} tasks are`} waiting for you to be signed in, because reading another product needs your live session. Run {awaitingSession === 1 ? "it" : "them"} now while you are signed in.</p>
      <button type="button" className="button button-primary button-small" disabled={Boolean(busy) || !services.enabled} onClick={onRunWaiting}>Run what's waiting</button>
    </div>}
  </section>;
}

function ApprovalCard({ approval, busy, onDecide }: { approval: TeamApproval; busy: string; onDecide: (approval: TeamApproval, decision: "approve" | "reject", note: string) => void }) {
  const [note, setNote] = useState("");
  const what = actionLabel(approval.kind);
  const sends = approval.kind === "communication.reply";
  return <li className="team-approval">
    <div className="team-approval-head"><strong>{approval.agentName}</strong> proposes: {what}{approval.targetId ? <> for <span className="team-target">{approval.targetId}</span></> : null}</div>
    <pre className="team-preview" aria-label={`Proposed text: ${what}`}>{approval.preview}</pre>
    <label className="team-note">Note (optional)<input value={note} maxLength={1000} disabled={Boolean(busy)} onChange={event => setNote(event.target.value)} /></label>
    <div className="button-row">
      <button type="button" className="button button-primary button-small" disabled={Boolean(busy)} aria-label={`${sends ? "Approve and send" : "Approve"}: ${what} from ${approval.agentName}`}
        onClick={() => onDecide(approval, "approve", note)}>{sends ? "Approve and send" : "Approve"}</button>
      <button type="button" className="button button-secondary button-small" disabled={Boolean(busy)} aria-label={`Reject: ${what} from ${approval.agentName}`}
        onClick={() => onDecide(approval, "reject", note)}>Reject</button>
      <span className="muted">Proposed {timeLabel(approval.createdAt)} · expires {timeLabel(approval.expiresAt)}</span>
    </div>
  </li>;
}

function ApprovalsPanel({ approvals, count, busy, onDecide }: { approvals: TeamApproval[]; count: number; busy: string; onDecide: (approval: TeamApproval, decision: "approve" | "reject", note: string) => void }) {
  return <section className="panel team-approvals" aria-labelledby="team-approvals-title">
    <div className="admin-section-title"><div><h2 id="team-approvals-title">Waiting for you{count ? ` (${count})` : ""}</h2><p>Nothing here has happened yet. Approve what you want done; reject the rest.</p></div></div>
    {approvals.length === 0
      ? <p className="admin-explanation">Nothing is waiting for your approval.</p>
      : <ul className="team-approval-list">{approvals.map(approval => <ApprovalCard key={approval.id} approval={approval} busy={busy} onDecide={onDecide} />)}</ul>}
    {count > approvals.length && <p className="muted">Showing the oldest {approvals.length} of {count}.</p>}
  </section>;
}

function AgentCard({ agent, services, busy, onStatus, onAutonomy, onBudget, onRun }: {
  agent: TeamAgent; services: TeamServices; busy: string;
  onStatus: (agent: TeamAgent, status: "active" | "paused") => void;
  onAutonomy: (agent: TeamAgent, autonomy: TeamAgent["autonomy"]) => void;
  onBudget: (agent: TeamAgent, cents: number) => void;
  onRun: (agent: TeamAgent, taskKind: string) => void;
}) {
  const [dollars, setDollars] = useState((agent.dailyBudgetCents / 100).toFixed(2));
  const cents = Math.round(Number(dollars) * 100);
  const valid = dollars.trim() !== "" && Number.isFinite(Number(dollars)) && cents >= 0 && cents <= 100000;
  const working = Boolean(busy);
  const active = agent.status === "active";
  const { counts } = agent;
  return <article className="panel team-agent" aria-labelledby={`team-agent-${agent.key}`}>
    <div className="team-agent-head">
      <div><h3 id={`team-agent-${agent.key}`}>{agent.displayName}</h3><p className="muted">{agent.roleSummary}</p></div>
      <Pill good={active}>{active ? "Active" : "Paused"}</Pill>
    </div>
    <div className="button-row">
      <button type="button" className={`button button-small ${active ? "button-secondary" : "button-primary"}`} disabled={working}
        aria-label={`${active ? "Pause" : "Resume"} ${agent.displayName}`} onClick={() => onStatus(agent, active ? "paused" : "active")}>{active ? "Pause" : "Resume"}</button>
      <label className="team-field">Autonomy
        <select value={agent.autonomy} disabled={working} aria-label={`Autonomy for ${agent.displayName}`} onChange={event => onAutonomy(agent, event.target.value as TeamAgent["autonomy"])}>
          {(Object.keys(autonomyLabels) as Array<TeamAgent["autonomy"]>).map(value => <option key={value} value={value}>{autonomyLabels[value]}</option>)}
        </select></label>
    </div>
    <p className="muted">{autonomyHelp[agent.autonomy]}</p>
    <div className="team-budget">
      <label className="team-field">Daily budget (dollars)
        <input type="number" inputMode="decimal" min="0" max="1000" step="0.01" value={dollars} disabled={working} aria-label={`Daily budget for ${agent.displayName} in dollars`} onChange={event => setDollars(event.target.value)} /></label>
      <button type="button" className="button button-secondary button-small" disabled={working || !valid || cents === agent.dailyBudgetCents}
        aria-label={`Save budget for ${agent.displayName}`} onClick={() => onBudget(agent, cents)}>Save budget</button>
      <span className="muted">Spent today: {centsLabel(agent.spentTodayCents)} of {centsLabel(agent.dailyBudgetCents)}</span>
    </div>
    {!valid && <p className="form-message form-error" role="alert">Enter a budget between $0 and $1,000.</p>}
    <dl className="team-facts">
      <div><dt>Model</dt><dd>{tierLabels[agent.modelTier]}</dd></div>
      <div><dt>Last run</dt><dd>{agent.lastRun ? `${timeLabel(agent.lastRun.startedAt)} — ${outcomeLabel(agent.lastRun.outcome)}` : "Not yet"}</dd></div>
      <div><dt>Tasks</dt><dd>{counts.queued} queued · {counts.running} running · {counts.awaitingApproval} waiting for approval{counts.awaitingSession ? ` · ${counts.awaitingSession} waiting for your sign-in` : ""}</dd></div>
      <div><dt>Failed, last 24 hours</dt><dd>{counts.failedLast24h}</dd></div>
    </dl>
    <h4 className="team-schedules-title">Scheduled work</h4>
    <ul className="team-schedules">
      {agent.schedules.map(schedule => {
        const ready = services.handlers.includes(schedule.taskKind);
        return <li key={schedule.id}>
          <span><strong>{taskLabel(schedule.taskKind)}</strong> — {cadenceLabel(schedule)}{schedule.requiresSession ? " (needs your sign-in)" : ""}<span className="muted"> · next {timeLabel(schedule.nextRunAt)}</span></span>
          {ready
            ? <button type="button" className="button button-secondary button-small" disabled={working || !active} aria-label={`Run ${taskLabel(schedule.taskKind)} now`} title={active ? undefined : `Resume ${agent.displayName} first`} onClick={() => onRun(agent, schedule.taskKind)}>Run now</button>
            : <span className="muted">No code behind it yet</span>}
        </li>;
      })}
    </ul>
  </article>;
}

const tabs = [["runs", "Runs"], ["tasks", "Tasks"], ["actions", "Proposed actions"], ["notifications", "Alerts to you"], ["audit", "Audit log"]] as const;
type Tab = (typeof tabs)[number][0];
const pageSize = 15;

function Table({ caption, head, children }: { caption: string; head: string[]; children: React.ReactNode }) {
  return <div className="portfolio-table-wrap"><table className="coverage-matrix team-table"><caption className="sr-only">{caption}</caption>
    <thead><tr>{head.map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;
}

function ActivityRows({ tab, data, names }: { tab: Tab; data: unknown; names: Record<string, string> }) {
  const who = (key: string | null) => (key ? names[key] ?? key : "—");
  if (tab === "runs") {
    const { items } = data as ActivityPage<"runs">;
    return <Table caption="Runs" head={["Started", "Agent", "Outcome", "Usage", "Cost", "Summary"]}>
      {items.map(item => <tr key={item.id}><td>{timeLabel(item.startedAt)}</td><td>{who(item.agentKey)}</td><td>{outcomeLabel(item.outcome)}</td>
        <td>{plural(item.rounds, "round")} · {plural(item.toolCalls, "tool call")}<div className="muted">{item.inputTokens.toLocaleString()} in / {item.outputTokens.toLocaleString()} out</div></td>
        <td>{centsLabel(item.costCents)}</td><td className="team-wide">{item.summary ?? item.errorCode ?? "—"}</td></tr>)}
    </Table>;
  }
  if (tab === "tasks") {
    const { items } = data as ActivityPage<"tasks">;
    return <Table caption="Tasks" head={["Created", "Agent", "Task", "Status", "Attempts", "Detail"]}>
      {items.map(item => <tr key={item.id}><td>{timeLabel(item.createdAt)}</td><td>{who(item.agentKey)}</td><td>{taskLabel(item.kind)}</td><td>{statusLabel(item.status)}</td><td>{item.attempts}</td>
        <td className="team-wide">{item.lastErrorCode ?? (item.result ? clip(JSON.stringify(item.result), 120) : "—")}</td></tr>)}
    </Table>;
  }
  if (tab === "actions") {
    const { items } = data as ActivityPage<"actions">;
    return <Table caption="Proposed actions" head={["Proposed", "Agent", "Action", "For", "Status", "Decision"]}>
      {items.map(item => <tr key={item.id}><td>{timeLabel(item.createdAt)}</td><td>{who(item.agentKey)}</td><td>{actionLabel(item.kind)}</td><td>{item.targetId || "—"}</td><td>{statusLabel(item.status)}</td>
        <td className="team-wide">{item.decidedAt ? `${timeLabel(item.decidedAt)}${item.decisionNote ? ` — ${item.decisionNote}` : ""}` : "—"}</td></tr>)}
    </Table>;
  }
  if (tab === "notifications") {
    const { items } = data as ActivityPage<"notifications">;
    return <Table caption="Alerts to you" head={["Created", "Agent", "Channel", "Importance", "Subject", "Status"]}>
      {items.map(item => <tr key={item.id}><td>{timeLabel(item.createdAt)}</td><td>{who(item.agentKey)}</td><td>{item.channel === "sms" ? "Text" : "Email"}</td><td>{item.severity}</td><td className="team-wide">{item.subject}</td><td>{statusLabel(item.status)}</td></tr>)}
    </Table>;
  }
  const { items } = data as AuditPage;
  return <Table caption="Audit log" head={["When", "Who", "What happened", "Details"]}>
    {items.map(item => <tr key={item.id}><td>{timeLabel(item.createdAt)}</td><td>{item.actorName ?? "—"}</td><td>{item.action}</td><td className="team-wide">{Object.keys(item.metadata).length ? clip(JSON.stringify(item.metadata), 140) : "—"}</td></tr>)}
  </Table>;
}

function ActivityPanel({ client, agents }: { client: TeamClient; agents: TeamAgent[] }) {
  const [tab, setTab] = useState<Tab>("runs");
  const [agentKey, setAgentKey] = useState("");
  const [offset, setOffset] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const names = Object.fromEntries(agents.map(agent => [agent.key, agent.displayName]));
  const reader = useCallback(async (signal: AbortSignal) => {
    void attempt;
    const page = tab === "audit"
      ? await client.audit({ prefix: null, offset, limit: pageSize }, { signal })
      : await client.activity({ kind: tab as ActivityKind, agentKey: agentKey || null, offset, limit: pageSize }, { signal });
    return { tab, page };
  }, [client, tab, agentKey, offset, attempt]);
  const state = useAdminRead(reader);
  const choose = (next: Tab) => { setTab(next); setOffset(0); };
  return <section className="panel team-activity" aria-labelledby="team-activity-title">
    <div className="admin-section-title"><div><h2 id="team-activity-title">What the team has done</h2><p>The newest first. Message text is never kept here.</p></div></div>
    <div className="team-tabs" role="tablist" aria-label="Kinds of activity">
      {tabs.map(([value, label]) => <button key={value} type="button" role="tab" id={`team-tab-${value}`} aria-selected={tab === value} aria-controls="team-activity-panel"
        className={`button button-small ${tab === value ? "button-primary" : "button-secondary"}`} onClick={() => choose(value)}>{label}</button>)}
    </div>
    <div id="team-activity-panel" role="tabpanel" aria-labelledby={`team-tab-${tab}`}>
      {tab !== "audit" && <label className="team-field">Agent
        <select value={agentKey} onChange={event => { setAgentKey(event.target.value); setOffset(0); }}>
          <option value="">All agents</option>{agents.map(agent => <option key={agent.key} value={agent.key}>{agent.displayName}</option>)}</select></label>}
      {state.status === "loading" && <Loading label="Loading activity" app="AI team" />}
      {state.status === "error" && <ReadFailure error={state.error} retry={() => setAttempt(value => value + 1)} />}
      {state.status === "ready" && state.data.tab === tab && (() => {
        const { items, total } = state.data.page as { items: unknown[]; total: number };
        return items.length === 0 ? <p className="admin-explanation">Nothing here yet.</p> : <>
          <ActivityRows tab={tab} data={state.data.page} names={names} />
          <div className="button-row team-paging">
            <button type="button" className="button button-secondary button-small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))}>Newer</button>
            <span className="muted" role="status">Showing {offset + 1}–{offset + items.length} of {total}</span>
            <button type="button" className="button button-secondary button-small" disabled={offset + items.length >= total} onClick={() => setOffset(offset + pageSize)}>Older</button>
          </div></>;
      })()}
    </div>
  </section>;
}

/** The AI team: who is on it, what is switched on, what waits for approval, and what has happened. */
export function Team({ client = teamClient }: { client?: TeamClient }) {
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const reload = useCallback(() => setRefresh(value => value + 1), []);
  const reader = useCallback((signal: AbortSignal) => { void refresh; return client.overview({ signal }); }, [client, refresh]);
  const state = useAdminRead(reader);
  // Keep showing the last roster while a refresh is in flight, so a change never blanks the page.
  const [kept, setKept] = useState<{ data: TeamOverview; receivedAt: Date } | null>(null);
  if (state.status === "ready" && kept?.data !== state.data) setKept({ data: state.data, receivedAt: state.receivedAt });
  const shown = state.status === "ready" ? state : kept;

  const change: Change = async (id, work, success) => {
    if (busy) return;
    setBusy(id); setNotice(null);
    try { await work(); setNotice({ ok: true, text: typeof success === "function" ? success() : success }); }
    catch (error) { setNotice({ ok: false, text: failureText(error) }); }
    finally { setBusy(""); reload(); }
  };
  const onStatus = (agent: TeamAgent, status: "active" | "paused") => void change(`status:${agent.key}`,
    () => client.setStatus({ key: agent.key, status, expectedUpdatedAt: agent.updatedAt }), `${agent.displayName} is ${status === "active" ? "active" : "paused"}.`);
  const onAutonomy = (agent: TeamAgent, autonomy: TeamAgent["autonomy"]) => void change(`autonomy:${agent.key}`,
    () => client.setAutonomy({ key: agent.key, autonomy, expectedUpdatedAt: agent.updatedAt }), `${agent.displayName} is set to ${autonomyLabels[autonomy]}.`);
  const onBudget = (agent: TeamAgent, cents: number) => void change(`budget:${agent.key}`,
    () => client.setBudget({ key: agent.key, dailyBudgetCents: cents, expectedUpdatedAt: agent.updatedAt }), `${agent.displayName}'s daily budget is ${centsLabel(cents)}.`);
  const onRun = (agent: TeamAgent, taskKind: string) => void change(`run:${agent.key}:${taskKind}`,
    () => client.run({ agentKey: agent.key, taskKind }), `${taskLabel(taskKind)} is queued for ${agent.displayName}.`);
  const onRunWaiting = () => {
    let started = 0;
    void change("waiting", async () => { started = (await client.waiting()).started; },
      () => started === 0 ? "Nothing was waiting to run." : `Started ${plural(started, "task")}. They finish in the background; refresh in a minute to see the result.`);
  };
  const onDecide = (approval: TeamApproval, decision: "approve" | "reject", note: string) => void change(`decide:${approval.id}`,
    async () => {
      const result = await client.decide({ actionId: approval.id, decision, note: note.trim() || undefined });
      if (!result.decided) throw new TeamApiError(409, "That was already decided or has expired. The list has been refreshed.");
      if (result.status === "failed") throw new TeamApiError(500, "It was approved but could not be carried out. See the activity below.");
    }, decision === "approve" ? "Approved." : "Rejected.");

  return <div className="team">
    <div className="page-heading"><div><span className="eyebrow">CareMetric Admin</span><h1><Bot size={22} aria-hidden="true" /> AI team</h1>
      <p>Your AI agents: what they can use, what waits for your approval, and what they have done. Every agent starts paused.</p></div>
      <button type="button" className="button button-secondary" onClick={reload} disabled={state.status === "loading"}><RefreshCw size={16} aria-hidden="true" /> Refresh</button></div>
    {notice && <p role={notice.ok ? "status" : "alert"} className={notice.ok ? "admin-explanation" : "form-message form-error"}>{notice.text}</p>}
    {!shown && state.status === "loading" && <Loading label="Loading the AI team" app="AI team" />}
    {state.status === "error" && !shown && <ReadFailure error={state.error} retry={reload} />}
    {state.status === "error" && shown && <ReadFailure error={state.error} retry={reload} />}
    {shown && <>
      <p className="admin-read-time">Loaded {timeLabel(shown.receivedAt)}.</p>
      <ServicesPanel services={shown.data.services} awaitingSession={shown.data.team.awaitingSessionCount} busy={busy} onRunWaiting={onRunWaiting} />
      <ApprovalsPanel approvals={shown.data.team.approvals} count={shown.data.team.approvalCount} busy={busy} onDecide={onDecide} />
      <section aria-labelledby="team-agents-title"><h2 id="team-agents-title" className="team-section-heading">Agents</h2>
        <div className="team-agent-grid">
          {shown.data.team.agents.map(agent => <AgentCard key={`${agent.key}:${agent.updatedAt}`} agent={agent} services={shown.data.services} busy={busy} onStatus={onStatus} onAutonomy={onAutonomy} onBudget={onBudget} onRun={onRun} />)}
        </div></section>
      <ActivityPanel client={client} agents={shown.data.team.agents} />
    </>}
  </div>;
}
