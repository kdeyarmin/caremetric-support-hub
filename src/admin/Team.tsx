import { useCallback, useState } from "react";
import { Bot, RefreshCw } from "lucide-react";
import { Link, useInRouterContext } from "react-router-dom";
import { Loading, ReadFailure } from "./AdminReads";
import { timeLabel } from "./readState";
import { useAdminRead } from "./useAdminRead";
import { TeamApiError, teamClient } from "./teamClient";
import type { TeamClient } from "./teamClient";
import {
  actionLabel, approvalTitle, autonomyHelp, autonomyLabels, cadenceLabel, centsLabel, errorLabel, failedActionLabel, outcomeLabel, statusLabel, stepHelpText, targetLabel, taskLabel, tierLabels,
} from "./teamProtocol";
import type { ActivityKind, ActivityPage, AuditPage, AutonomyStep, TeamAgent, TeamApproval, TeamOverview, TeamServices } from "./teamProtocol";
import "./admin.css";

type Notice = { ok: boolean; text: string } | null;
type Change = (id: string, work: () => Promise<unknown>, success: string | (() => string)) => Promise<void>;

// A refusal from the server carries its reviewed text. Anything else (a timeout, a dropped connection, an answer the screen could not read)
// can happen after the server has acted, so it never claims that nothing changed: a second press could queue the same work again.
const failureText = (error: unknown) => error instanceof TeamApiError ? error.message
  : "The result could not be confirmed, so the change may have gone through. Refresh and check the lists below before you try again.";
const clip = (value: string, limit: number) => (value.length <= limit ? value : `${value.slice(0, limit - 1)}…`);
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function Pill({ good, children }: { good: boolean; children: string }) {
  return <span className={`admin-status ${good ? "admin-status-connected" : "admin-status-muted"}`}>{children}</span>;
}

function ServicesPanel({ services, awaitingSession, waitingActions, busy, onRunWaiting }: { services: TeamServices; awaitingSession: number; waitingActions: number; busy: string; onRunWaiting: () => void }) {
  const handled = services.handlers.map(taskLabel);
  const rows: Array<{ name: string; good: boolean; state: string; detail: string }> = [
    { name: "Scheduler", good: services.enabled, state: services.enabled ? "On" : "Off",
      detail: services.enabled ? "The team's clock runs every minute." : "Set HUB_AGENTS_ENABLED to true on the Hub service to start the team." },
    { name: "Work with code behind it", good: handled.length > 0, state: handled.length ? `${handled.length} ready` : "None yet",
      detail: handled.length ? handled.join(", ") : "An agent stays idle until the code for its work ships. Nothing here is broken." },
    { name: "Your email address", good: services.ownerEmail, state: services.ownerEmail ? "Set" : "Missing", detail: services.ownerEmail ? "Alerts and the morning brief go here." : "Set HUB_OWNER_EMAIL so the team can email you." },
    { name: "Email delivery", good: services.email, state: services.email ? "Ready" : "Not set up", detail: services.email ? "Through SendGrid." : "Set HUB_SENDGRID_API_KEY so the team can email you." },
    { name: "Text alerts", good: services.sms, state: services.sms ? "Ready" : "Not set up", detail: services.sms ? "Urgent items are texted to your verified number." : "Urgent items fall back to email until Twilio is configured." },
    { name: "AI model", good: services.ai, state: services.ai ? "Ready" : "Not set up", detail: services.ai ? "Anthropic is connected. An agent uses it only where its own setting says so." : "Set ANTHROPIC_API_KEY on the Hub service. Agents that need a model wait until then." },
    { name: "Customer text to AI", good: services.customerTextToAi, state: services.customerTextToAi ? "On" : "Off",
      detail: services.customerTextToAi ? "The Concierge sends a plain question's scrubbed text to the model to draft an answer for you to approve. Billing, outages, sales and anything with personal identifiers never go." : "Customer messages stay in the Hub. Set HUB_AGENTS_CUSTOMER_TEXT_TO_AI to true, with the AI model ready, to let the Concierge draft answers from your published guides." },
  ];
  return <section className="panel team-services" aria-labelledby="team-services-title">
    <div className="admin-section-title"><div><h2 id="team-services-title">What the team can use</h2><p>The team only does what is switched on here.</p></div></div>
    <ul className="team-service-list">
      {rows.map(row => <li key={row.name}><span className="team-service-name">{row.name}</span><Pill good={row.good}>{row.state}</Pill><span className="muted">{row.detail}</span></li>)}
    </ul>
    {(awaitingSession > 0 || waitingActions > 0) && <div className="team-waiting">
      <p className="admin-explanation" role="status">
        {awaitingSession > 0 && <>{awaitingSession === 1 ? "1 task is" : `${awaitingSession} tasks are`} waiting for you to be signed in, because reading another product needs your live session. </>}
        {waitingActions > 0 && <>{waitingActions === 1 ? "1 reply you approved has" : `${waitingActions} replies you approved have`} not been sent yet. </>}
        Run {awaitingSession + waitingActions === 1 ? "it" : "them"} now while you are signed in.</p>
      {/* Approved replies go out with this session whether or not the scheduler is on; only the waiting tasks need it. */}
      <button type="button" className="button button-primary button-small" disabled={Boolean(busy) || (!services.enabled && waitingActions === 0)} onClick={onRunWaiting}>Run what's waiting</button>
    </div>}
  </section>;
}

type StepAction = "supervise" | "hold" | "automatic";
/**
 * The kinds of work the owner hands over. Each starts with a supervised week (the owner approves every item), then switches to
 * automatic by itself; "Keep approving" stops that at any time, and "Make automatic now" skips the rest of the week.
 */
function AutonomyPanel({ steps, busy, onStep }: { steps: AutonomyStep[]; busy: string; onStep: (step: AutonomyStep, action: StepAction) => void }) {
  const working = Boolean(busy);
  return <section className="panel team-autonomy" aria-labelledby="team-autonomy-title">
    <div className="admin-section-title"><div><h2 id="team-autonomy-title">Work the team does on its own</h2>
      <p>Each kind of work starts with a supervised week: you approve every item. Then it switches to automatic by itself, and you get an email the day before and when it switches. Keep approving stops that at any time.</p></div></div>
    <ul className="team-service-list">
      {steps.map(step => {
        const state = step.status === "supervised" ? `Supervised until ${timeLabel(step.automaticAt ?? step.changedAt)}`
          : step.status === "automatic" ? `On its own since ${timeLabel(step.automaticAt ?? step.changedAt)}`
          : step.status === "held" ? "You approve each one" : "Not started";
        return <li key={step.category}>
          <span className="team-service-name">{step.label}</span>
          <Pill good={step.status === "automatic"}>{state}</Pill>
          <span className="muted">{stepHelpText(step.category)}{!step.ready ? " Its code is not on the Hub yet, so it cannot run on its own; a supervised week switches as soon as the code arrives." : ""}</span>
          <span className="button-row">
            {(step.status === "off" || step.status === "held") && <button type="button" className="button button-secondary button-small" disabled={working}
              aria-label={`Start a supervised week for ${step.label}`} onClick={() => onStep(step, "supervise")}>Start supervised week</button>}
            {(step.status === "supervised" || step.status === "automatic") && <button type="button" className="button button-secondary button-small" disabled={working}
              aria-label={`Keep approving ${step.label}`} onClick={() => onStep(step, "hold")}>Keep approving</button>}
            {step.status !== "automatic" && step.status !== "off" && <button type="button" className="button button-primary button-small" disabled={working || !step.ready}
              aria-label={`Make ${step.label} automatic now`} title={step.ready ? undefined : "Its code is not on the Hub yet"} onClick={() => onStep(step, "automatic")}>Make automatic now</button>}
          </span>
        </li>;
      })}
    </ul>
  </section>;
}

/** A link to the conversation a proposal is about, in the inbox (a plain link where there is no router, as in tests). */
function RecordLink({ reference }: { reference: string }) {
  const href = `/communications?search=${encodeURIComponent(reference)}&status=all`;
  return useInRouterContext() ? <Link to={href}>Open {reference}</Link> : <a href={href}>Open {reference}</a>;
}

function ApprovalCard({ approval, busy, onDecide }: { approval: TeamApproval; busy: string; onDecide: (approval: TeamApproval, decision: "approve" | "reject", note: string) => void }) {
  const [note, setNote] = useState("");
  const email = approval.kind === "email.send";
  // A customer email is named by its account and subject, so two waiting emails never share a name.
  const what = email ? approvalTitle(approval) : actionLabel(approval.kind);
  // Approving a reply or a customer email sends it.
  const sends = ["communication.reply", "growth.message"].includes(approval.kind) || email;
  return <li className="team-approval">
    <div className="team-approval-head"><strong>{approval.agentName}</strong> proposes: {email ? what
      : <>{what}{approval.targetId ? <> for <span className="team-target">{targetLabel(approval.targetKind, approval.targetId)}</span></> : null}</>}</div>
    {/^CM-\d+$/.test(approval.targetId) && <p className="team-record"><RecordLink reference={approval.targetId} /></p>}
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
        <td>{centsLabel(item.costCents)}</td><td className="team-wide">{item.summary ?? (item.errorCode ? errorLabel(item.errorCode) : "—")}</td></tr>)}
    </Table>;
  }
  if (tab === "tasks") {
    const { items } = data as ActivityPage<"tasks">;
    return <Table caption="Tasks" head={["Created", "Agent", "Task", "Status", "Attempts", "Detail"]}>
      {items.map(item => <tr key={item.id}><td>{timeLabel(item.createdAt)}</td><td>{who(item.agentKey)}</td><td>{taskLabel(item.kind)}</td><td>{statusLabel(item.status)}</td><td>{item.attempts}</td>
        <td className="team-wide">{item.lastErrorCode ? errorLabel(item.lastErrorCode) : item.result ? clip(JSON.stringify(item.result), 120) : "—"}</td></tr>)}
    </Table>;
  }
  if (tab === "actions") {
    const { items } = data as ActivityPage<"actions">;
    return <Table caption="Proposed actions" head={["Proposed", "Agent", "Action", "For", "Status", "Decision"]}>
      {items.map(item => {
        // Why a carried-out action failed: the code its executor stored, in plain words, so a refused send is not just "Failed".
        const failure = item.status === "failed" && typeof item.result?.error === "string" ? failedActionLabel(item.result.error) : "";
        const decision = item.decidedAt ? `${timeLabel(item.decidedAt)}${item.decisionNote ? ` — ${item.decisionNote}` : ""}` : "";
        return <tr key={item.id}><td>{timeLabel(item.createdAt)}</td><td>{who(item.agentKey)}</td><td>{actionLabel(item.kind)}</td><td>{item.targetId ? targetLabel(item.targetKind, item.targetId) : "—"}</td><td>{statusLabel(item.status)}</td>
          <td className="team-wide">{[decision, failure].filter(Boolean).join(" · ") || "—"}</td></tr>;
      })}
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

function ActivityPanel({ client, agents, refresh }: { client: TeamClient; agents: TeamAgent[]; refresh: number }) {
  const [tab, setTab] = useState<Tab>("runs");
  const [agentKey, setAgentKey] = useState("");
  const [offset, setOffset] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const names = Object.fromEntries(agents.map(agent => [agent.key, agent.displayName]));
  const reader = useCallback(async (signal: AbortSignal) => {
    void attempt; void refresh;
    const page = tab === "audit"
      ? await client.audit({ prefix: null, offset, limit: pageSize }, { signal })
      : await client.activity({ kind: tab as ActivityKind, agentKey: agentKey || null, offset, limit: pageSize }, { signal });
    return { tab, page };
  }, [client, tab, agentKey, offset, attempt, refresh]);
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
  const onStep = (step: AutonomyStep, action: StepAction) => void change(`step:${step.category}`,
    () => client.setStep({ category: step.category, action, expectedChangedAt: step.changedAt }),
    action === "supervise" ? `${step.label}: supervised week started. You approve each one until it ends.`
      : action === "hold" ? `${step.label}: you approve each one from now on.` : `${step.label}: the team does this on its own from now on.`);
  const onRunWaiting = () => {
    let started = 0;
    let sending = 0;
    void change("waiting", async () => { const result = await client.waiting(); started = result.started; sending = result.actions; },
      () => started === 0 && sending === 0 ? "Nothing was waiting to run." : `${[started > 0 ? `Started ${plural(started, "task")}` : "", sending > 0 ? `${started > 0 ? "sending" : "Sending"} ${plural(sending, "approved reply").replace("replys", "replies")}` : ""].filter(Boolean).join(" and ")}. ${started + sending === 1 ? "It finishes" : "They finish"} in the background; refresh in a minute to see the result.`);
  };
  const onDecide = (approval: TeamApproval, decision: "approve" | "reject", note: string) => {
    let outcome: "sent" | "waiting" | "unconfirmed" = "unconfirmed";
    void change(`decide:${approval.id}`,
    async () => {
      const result = await client.decide({ actionId: approval.id, decision, note: note.trim() || undefined });
      if (!result.decided) throw new TeamApiError(409, "That was already decided or has expired. The list has been refreshed.");
      // A failed reply is final, so "press Run what's waiting" (the label a waiting task gets) would send the owner the wrong way.
      if (result.status === "failed") throw new TeamApiError(500, result.error ? failedActionLabel(result.error) : "It was approved but could not be carried out. See the activity below.");
      // Only the server can say a reply was not started. A plain "approved" may be an action whose work was done and whose result could not
      // be recorded, so it is never reported as unsent.
      outcome = result.status === "executed" ? "sent" : result.needsSession ? "waiting" : "unconfirmed";
    }, () => {
      if (decision === "reject") return "Rejected.";
      if (outcome === "sent") return "Approved.";
      if (outcome === "waiting") return "Approved. It has not been sent yet. Press Run what's waiting while you are signed in.";
      return "Approved, but the Hub could not confirm what happened next. Check the Proposed actions below, and for a reply open the conversation before answering again.";
    });
  };

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
      <ServicesPanel services={shown.data.services} awaitingSession={shown.data.team.awaitingSessionCount} waitingActions={shown.data.waitingActions} busy={busy} onRunWaiting={onRunWaiting} />
      {shown.data.autonomy && shown.data.autonomy.length > 0 && <AutonomyPanel steps={shown.data.autonomy} busy={busy} onStep={onStep} />}
      <ApprovalsPanel approvals={shown.data.team.approvals} count={shown.data.team.approvalCount} busy={busy} onDecide={onDecide} />
      <section aria-labelledby="team-agents-title"><h2 id="team-agents-title" className="team-section-heading">Agents</h2>
        <div className="team-agent-grid">
          {shown.data.team.agents.map(agent => <AgentCard key={`${agent.key}:${agent.updatedAt}`} agent={agent} services={shown.data.services} busy={busy} onStatus={onStatus} onAutonomy={onAutonomy} onBudget={onBudget} onRun={onRun} />)}
        </div></section>
      <ActivityPanel client={client} agents={shown.data.team.agents} refresh={refresh} />
    </>}
  </div>;
}
