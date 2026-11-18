import { useCallback, useRef, useState } from "react";
import { Bot, RefreshCw } from "lucide-react";
import { Link, useInRouterContext } from "react-router-dom";
import { Loading, ReadFailure } from "./AdminReads";
import { timeLabel } from "./readState";
import { useAdminRead } from "./useAdminRead";
import { TeamApiError, teamClient } from "./teamClient";
import type { TeamClient } from "./teamClient";
import { externalEmailRequestKey } from "./externalEmailDraft";
import {
  actionLabel, approvalTitle, autonomyHelp, autonomyLabels, cadenceLabel, centsLabel, errorLabel, externalEmailFailure, externalEmailRecipient, failedActionLabel, outcomeLabel, statusLabel, stepHelpText, targetLabel, taskLabel, tierLabels,
} from "./teamProtocol";
import type { ActivityKind, ActivityPage, AuditPage, AutonomyStep, ExternalEmailDraft, ExternalEmailProposal, MarketingProduct, MenuOffer, OfferCoupon, ScorecardSettings, TeamAgent, TeamApproval, TeamOverview, TeamServices } from "./teamProtocol";
import "./admin.css";

type Notice = { ok: boolean; text: string } | null;
type Change = (id: string, work: () => Promise<unknown>, success: string | (() => string), failure?: (error: unknown) => string) => Promise<void>;

// A refusal from the server carries its reviewed text. Anything else (a timeout, a dropped connection, an answer the screen could not read)
// can happen after the server has acted, so it never claims that nothing changed: a second press could queue the same work again.
const failureText = (error: unknown) => error instanceof TeamApiError ? error.message
  : "The result could not be confirmed, so the change may have gone through. Refresh and check the lists below before you try again.";
const waitingFailureText = (error: unknown) => error instanceof TeamApiError && error.status < 500 ? error.message
  : "The status of the approved messages could not be confirmed. Do not resend them. Refresh Proposed actions and check the email provider's activity.";
const clip = (value: string, limit: number) => (value.length <= limit ? value : `${value.slice(0, limit - 1)}…`);
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function Pill({ good, children }: { good: boolean; children: string }) {
  return <span className={`admin-status ${good ? "admin-status-connected" : "admin-status-muted"}`}>{children}</span>;
}

function ServicesPanel({ services, awaitingSession, waitingActions, busy, onRunWaiting }: { services: TeamServices; awaitingSession: number; waitingActions: number; busy: string; onRunWaiting: () => void }) {
  const handled = services.handlers.map(taskLabel);
  const rows: Array<{ name: string; good: boolean; state: string; detail: string }> = [
    { name: "Scheduler", good: services.enabled, state: services.enabled ? "On" : "Off",
      detail: services.enabled ? "The team's clock runs every minute." : "Switch on \"Run the AI team\" in Settings to start the team." },
    { name: "Work with code behind it", good: handled.length > 0, state: handled.length ? `${handled.length} registered` : "None yet",
      detail: handled.length ? handled.join(", ") : "An agent stays idle until the code for its work ships. Nothing here is broken." },
    { name: "Your email address", good: services.ownerEmail, state: services.ownerEmail ? "Set" : "Missing", detail: services.ownerEmail ? "Alerts and the end-of-day summary go here." : "Add your email in Settings (AI team) so the team can email you." },
    { name: "Email delivery", good: services.email, state: services.email ? "Ready" : "Not set up", detail: services.email ? "Through SendGrid." : "Set HUB_SENDGRID_API_KEY so the team can email you." },
    { name: "Text alerts", good: services.sms, state: services.sms ? "Ready" : "Not set up", detail: services.sms ? "Urgent items are texted to your verified number." : "Urgent items fall back to email until Twilio is configured." },
    { name: "AI model", good: services.ai, state: services.ai ? "Key configured" : "Not set up", detail: services.ai ? "An Anthropic key is configured. An agent uses it only where its own setting says so. Check task results to confirm access." : "Set ANTHROPIC_API_KEY on the Hub service. Agents that need a model wait until then." },
    ...(services.creative?.declared ? [{ name: "Creative Director", good: services.creative.enabled, state: services.creative.enabled ? "On" : "Off",
      detail: services.creative.enabled
        ? `Renders up to ${services.creative.dailyRenderCap} assets a day; videos by ${services.creative.videoProvider === "heygen" ? "HeyGen" : "the Hub itself"}. Review them on the Creative screen.`
        : "Switch on \"Turn on the Creative Director\" in Settings → Creative to let it work. Creative you already approved is still handed over." }] : []),
    { name: "Customer text to AI", good: services.customerTextToAi, state: services.customerTextToAi ? "On" : "Off",
      detail: services.customerTextToAi ? "The Concierge and Sales Executive can send eligible questions' scrubbed text to the model to draft answers under your approval settings. Billing, outages and anything with personal identifiers never go." : "Customer messages stay in the Hub. Switch on \"Let agents send customer messages to the AI\" in Settings, with the AI model configured, to let the Concierge draft support answers and the Sales Executive draft eligible prospect answers." },
  ];
  return <section className="panel team-services" aria-labelledby="team-services-title">
    <div className="admin-section-title"><div><h2 id="team-services-title">What the team can use</h2><p>The team only does what is switched on here.</p></div></div>
    <ul className="team-service-list">
      {rows.map(row => <li key={row.name}><span className="team-service-name">{row.name}</span><Pill good={row.good}>{row.state}</Pill><span className="muted">{row.detail}</span></li>)}
    </ul>
    {(awaitingSession > 0 || waitingActions > 0) && <div className="team-waiting">
      <p className="admin-explanation" role="status">
        {awaitingSession > 0 && <>{awaitingSession === 1 ? "1 task is" : `${awaitingSession} tasks are`} waiting for you to be signed in, because reading another product needs your live session. </>}
        {waitingActions > 0 && <>{waitingActions === 1 ? "1 approved message needs" : `${waitingActions} approved messages need`} checking or completion. </>}
        Run {awaitingSession + waitingActions === 1 ? "it" : "them"} now while you are signed in.</p>
      {/* Message status checks and completion work with this session even when the scheduler is off; waiting tasks need it on. */}
      <button type="button" className="button button-primary button-small" disabled={Boolean(busy) || (!services.enabled && waitingActions === 0)} onClick={onRunWaiting}>Run what's waiting</button>
    </div>}
  </section>;
}

function ToolkitLink({ path }: { path: NonNullable<NonNullable<TeamServices["marketingTools"]>[number]["settingsPath"]> }) {
  const label = path === "/admin" ? "Open integration setup" : path === "/admin/growth" ? "Open customer growth" : path === "/admin/creative" ? "Open Creative" : "Open Settings";
  return useInRouterContext() ? <Link to={path}>{label}</Link> : <a href={path}>{label}</a>;
}

function MarketingToolkit({ services, agents }: { services: TeamServices; agents: TeamAgent[] }) {
  if (!services.marketingTools) return null;
  const agentByKey = new Map(agents.map(agent => [agent.key, agent]));
  return <section className="panel team-services team-toolkit" aria-labelledby="team-toolkit-title">
    <div className="admin-section-title"><div><h2 id="team-toolkit-title">Marketing toolkit</h2>
      <p>Configuration checks for finding prospects, creating campaigns and measuring sales. Configured does not confirm provider authorization or connectivity; check task results to verify each connection.</p></div></div>
    <p className="admin-explanation">The scheduler, each agent's status, campaign policies and approval settings still control whether work runs. {services.enabled ? "The scheduler is on." : "The scheduler is off. Switch on Run the AI team in Settings to start scheduled work."}</p>
    {services.marketingTools.length === 0 ? <p>No marketing tool checks were returned by this Hub.</p> : <ul className="team-service-list">
      {services.marketingTools.map(tool => <li key={tool.key}>
        <span className="team-service-name">{tool.label}</span>
        <Pill good={tool.supported !== false && tool.configured && tool.missing.length === 0}>{tool.supported === false ? "Not available" : tool.configured && tool.missing.length === 0 ? "Configured" : "Setup needed"}</Pill>
        <details className="muted"><summary>Details and {tool.supported === false ? "next steps" : "setup"}{tool.missing.length > 0 ? ` · ${plural(tool.missing.length, "step")}` : ""}</summary><p>{tool.detail}</p>
          {tool.agents.length > 0 && <p>Used by: {tool.agents.map(key => {
            const agent = agentByKey.get(key);
            if (!agent) return `${key.replaceAll("_", " ")} (not available on this Hub)`;
            return `${agent.displayName}${agent.status === "paused" ? " (paused)" : agent.autonomy === "observe" ? " (Observe: proposals and actions are off)" : ""}`;
          }).join(", ")}</p>}
          {tool.missing.length > 0 && <ul className="team-toolkit-setup" aria-label={`Setup for ${tool.label}`}>{tool.missing.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul>}
          {tool.settingsPath && <ToolkitLink path={tool.settingsPath} />}
        </details>
      </li>)}
    </ul>}
  </section>;
}

const emptyEmail = (): ExternalEmailDraft => ({ to: "", subject: "", body: "" });
const sameEmail = (left: ExternalEmailDraft, right: ExternalEmailDraft) => left.to === right.to && left.subject === right.subject && left.body === right.body;
const controlCharacter = (value: string, multiline = false) => Array.from(value).some(character => {
  const code = character.charCodeAt(0);
  return code === 127 || (code < 32 && !(multiline && [9, 10, 13].includes(code)));
});
const emailDraftError = (draft: ExternalEmailDraft) => {
  if (draft.to.length > 320 || !/^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/.test(draft.to) || controlCharacter(draft.to)) return "Enter one email address in To.";
  if (!draft.subject.trim() || Array.from(draft.subject).length > 200 || controlCharacter(draft.subject)) return "Enter a subject of 1–200 characters on one line.";
  if (!draft.body.trim() || Array.from(draft.body).length > 5000 || controlCharacter(draft.body, true)) return "Enter a message of 1–5,000 characters. Line breaks and tabs are allowed.";
  return null;
};
function proposalNotice(result: ExternalEmailProposal): string {
  if (result.status === "proposed") return `${result.created ? "Email proposal prepared." : "This email proposal already exists."} Review the exact text in Waiting for you, then choose Approve and send. Preparing a proposal does not send it.`;
  if (result.status === "executed") return "This email was already accepted by the email provider. Delivery to the recipient is not confirmed. No new proposal was created.";
  if (result.status === "approved" || result.status === "executing") return "This email was already approved. Do not resend it; check Proposed actions for the outcome. No new proposal was created.";
  if (result.status === "failed") return "This request already has a finished action. Check Proposed actions for its result. If the outcome is unknown, do not resend the email. No new proposal was created.";
  return `This email proposal was already ${result.status}. No new proposal was created.`;
}

/** An owner writes the exact message. The only operation here creates a proposal; sending is a separate decision below. */
function EmailComposer({ client, ready, busy, change, terminalDecisions }: { client: TeamClient; ready: boolean; busy: string; change: Change; terminalDecisions: Record<string, "rejected" | "expired"> }) {
  const [draft, setDraft] = useState<ExternalEmailDraft>(emptyEmail);
  const [prepared, setPrepared] = useState<ExternalEmailProposal | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const attempt = useRef<{ draft: ExternalEmailDraft; requestKey: string } | null>(null);
  const preparing = useRef(false);
  const confirmed = prepared && terminalDecisions[prepared.id] ? { ...prepared, status: terminalDecisions[prepared.id] } : prepared;
  const renewable = confirmed && (confirmed.status === "rejected" || confirmed.status === "expired") ? confirmed : null;
  const edit = (field: keyof ExternalEmailDraft, value: string) => {
    setDraft(previous => ({ ...previous, [field]: value }));
    setValidationError(null);
  };
  const prepare = async (renew?: ExternalEmailProposal) => {
    if (!ready || busy || preparing.current || (prepared && !renew)) return;
    if (renew && (!renewable || renew.id !== renewable.id || renew.requestKey !== renewable.requestKey)) return;
    const exact = { ...draft, to: draft.to.trim() };
    // Only the address's outer whitespace is normalized, and the field shows what is submitted.
    setDraft(exact);
    const invalid = emailDraftError(exact);
    if (invalid) { setValidationError(invalid); return; }
    preparing.current = true;
    let result: ExternalEmailProposal | null = null;
    try {
      await change("email:prepare", async () => {
        if (renew || !attempt.current || !sameEmail(attempt.current.draft, exact)) {
          attempt.current = { draft: exact, requestKey: await externalEmailRequestKey(exact, renew) };
        }
        // Consume the terminal confirmation before posting. If its response is lost, the next
        // ordinary prepare retries this new key; it must not renew the old proposal a second time.
        if (renew) setPrepared(null);
        result = await client.prepareEmail({ ...exact, requestKey: attempt.current.requestKey });
        setPrepared(result);
      }, () => result ? proposalNotice(result) : "The proposal result could not be confirmed.", error => error instanceof TeamApiError
        ? `Draft kept. ${error.message}`
        : "The proposal result could not be confirmed. Your draft is unchanged. Prepare it again to check the same request; this will not create a second proposal. Preparing never sends an email.");
    } finally { preparing.current = false; }
  };
  const another = () => { setDraft(emptyEmail()); setPrepared(null); setValidationError(null); attempt.current = null; };
  const disabled = !ready || Boolean(busy);
  return <section className="panel team-email" aria-labelledby="team-email-title">
    <div className="admin-section-title"><div><h2 id="team-email-title">Prepare an email</h2><p>Write a message for the team to send. You review and approve its exact text before it goes out.</p></div></div>
    <form className="team-email-form" onSubmit={event => { event.preventDefault(); void prepare(); }}>
      {!ready && <p className="muted">Owner-written email is not available on this Hub yet.</p>}
      <label className="team-field">To<input type="email" required maxLength={320} autoComplete="off" autoCapitalize="none" spellCheck={false}
        value={draft.to} disabled={disabled} readOnly={Boolean(prepared)} onChange={event => edit("to", event.target.value)} /></label>
      <label className="team-field">Subject<input required maxLength={400} value={draft.subject} disabled={disabled} readOnly={Boolean(prepared)} onChange={event => edit("subject", event.target.value)} /></label>
      <label className="team-field">Message<textarea required rows={10} maxLength={10000} value={draft.body} disabled={disabled} readOnly={Boolean(prepared)} onChange={event => edit("body", event.target.value)} /></label>
      <p className="muted">One recipient · plain text · up to 5,000 message characters</p>
      {renewable && <p className="muted">The previous proposal was {renewable.status}. You can prepare a fresh proposal with the same text, then approve it separately.</p>}
      {validationError && <p className="form-message form-error" role="alert">{validationError}</p>}
      <div className="button-row">
        <button type="submit" className="button button-primary button-small" disabled={disabled || Boolean(prepared)}>{busy === "email:prepare" ? "Preparing…" : renewable ? `Proposal ${renewable.status}` : prepared ? "Proposal prepared" : "Prepare email for approval"}</button>
        {renewable && <button type="button" className="button button-primary button-small" disabled={disabled} onClick={() => void prepare(renewable)}>Prepare a fresh proposal</button>}
        {prepared && <button type="button" className="button button-secondary button-small" disabled={Boolean(busy)} onClick={another}>Write another email</button>}
      </div>
    </form>
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

type NewOffer = Parameters<TeamClient["addOffer"]>[0];
const offerWhat = (offer: MenuOffer) => offer.kind === "trial_extension" ? `${offer.trialDays} more trial days` : `Your Stripe coupon ${offer.couponId}`;
const couponWords = (coupon: OfferCoupon) => `${coupon.name || coupon.id}: ${coupon.percentOff !== null ? `${coupon.percentOff}% off` : coupon.amountOff !== null ? `${centsLabel(coupon.amountOff)} off` : "discount"}${coupon.duration === "repeating" && coupon.durationInMonths ? ` for ${coupon.durationInMonths} months` : coupon.duration ? `, ${coupon.duration}` : ""}`;

/** One offer on the menu: what it gives, who qualifies, this month's use against its cap, switched on or off. */
function OfferRow({ offer, busy, onOffer }: { offer: MenuOffer; busy: string; onOffer: (offer: MenuOffer, enabled: boolean, monthlyCap: number) => void }) {
  const [cap, setCap] = useState(String(offer.monthlyCap));
  const capValue = Number(cap);
  const capValid = Number.isInteger(capValue) && capValue >= 1 && capValue <= 50;
  const working = Boolean(busy);
  return <li>
    <span className="team-service-name">{offer.label}</span>
    <Pill good={offer.enabled}>{offer.enabled ? "On" : "Off"}</Pill>
    <span className="muted">{offerWhat(offer)} for a trial of {offer.apps.join(", ")} that ends within {plural(offer.windowDays, "day")}. Once per account; {offer.usedThisMonth} of {offer.monthlyCap} used this month, {offer.appliedTotal} applied in all.</span>
    <span className="button-row">
      <label className="team-field">Monthly cap<input type="number" min={1} max={50} value={cap} disabled={working} aria-label={`Monthly cap for ${offer.label}`} onChange={event => setCap(event.target.value)} /></label>
      <button type="button" className="button button-secondary button-small" disabled={working || !capValid || capValue === offer.monthlyCap}
        onClick={() => onOffer(offer, offer.enabled, capValue)}>Save cap</button>
      <button type="button" className={`button button-small ${offer.enabled ? "button-secondary" : "button-primary"}`} disabled={working || !capValid}
        aria-label={`${offer.enabled ? "Switch off" : "Switch on"} ${offer.label}`} onClick={() => onOffer(offer, !offer.enabled, capValid ? capValue : offer.monthlyCap)}>{offer.enabled ? "Switch off" : "Switch on"}</button>
    </span>
  </li>;
}

/** Add an offer to the menu: more trial days, or one of the owner's own Stripe coupons. It starts switched off. */
function AddOfferForm({ coupons, apps, busy, onAdd }: { coupons: OfferCoupon[]; apps: string[]; busy: string; onAdd: (offer: NewOffer) => void }) {
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<"trial_extension" | "coupon">("trial_extension");
  const [days, setDays] = useState("7");
  const [coupon, setCoupon] = useState("");
  const [chosen, setChosen] = useState<string[]>(apps);
  const [windowDays, setWindowDays] = useState("7");
  const [cap, setCap] = useState("5");
  const whole = (value: string, low: number, high: number) => Number.isInteger(Number(value)) && Number(value) >= low && Number(value) <= high;
  const valid = label.trim().length >= 3 && label.trim().length <= 80 && chosen.length > 0 && whole(windowDays, 1, 30) && whole(cap, 1, 50)
    && (kind === "trial_extension" ? whole(days, 1, 30) : coupons.some(item => item.id === coupon));
  const submit = () => onAdd({ label: label.trim(), kind, ...(kind === "trial_extension" ? { trialDays: Number(days) } : { couponId: coupon }), apps: chosen, windowDays: Number(windowDays), monthlyCap: Number(cap) });
  return <details className="team-add-offer"><summary>Add an offer</summary>
    <div className="team-add-offer-fields">
      <label className="team-field">Name<input value={label} maxLength={80} disabled={Boolean(busy)} onChange={event => setLabel(event.target.value)} /></label>
      <label className="team-field">What it gives<select value={kind} disabled={Boolean(busy)} onChange={event => setKind(event.target.value === "coupon" ? "coupon" : "trial_extension")}>
        <option value="trial_extension">More trial days</option><option value="coupon" disabled={coupons.length === 0}>One of your Stripe coupons</option></select></label>
      {kind === "trial_extension"
        ? <label className="team-field">Extra days<input type="number" min={1} max={30} value={days} disabled={Boolean(busy)} onChange={event => setDays(event.target.value)} /></label>
        : <label className="team-field">Coupon<select value={coupon} disabled={Boolean(busy)} onChange={event => setCoupon(event.target.value)}>
            <option value="">Choose a coupon</option>{coupons.map(item => <option key={item.id} value={item.id}>{couponWords(item)}</option>)}</select></label>}
      <fieldset className="team-field"><legend>Products</legend>
        {apps.map(app => <label key={app}><input type="checkbox" checked={chosen.includes(app)} disabled={Boolean(busy)}
          onChange={event => setChosen(list => event.target.checked ? [...list, app] : list.filter(item => item !== app))} /> {app}</label>)}</fieldset>
      <label className="team-field">Trial ends within (days)<input type="number" min={1} max={30} value={windowDays} disabled={Boolean(busy)} onChange={event => setWindowDays(event.target.value)} /></label>
      <label className="team-field">Monthly cap<input type="number" min={1} max={50} value={cap} disabled={Boolean(busy)} onChange={event => setCap(event.target.value)} /></label>
      <button type="button" className="button button-secondary button-small" disabled={Boolean(busy) || !valid} onClick={submit}>Add offer (switched off)</button>
    </div>
    {coupons.length === 0 && <p className="muted">To offer a discount, create the coupon in Stripe first; it appears here once the Hub has seen it.</p>}
  </details>;
}

/**
 * Which products the team markets to new customers. The agents read these switches when each task starts, so a change applies to their
 * next run. Customers' onboarding and support go on whatever is switched off.
 */
function MarketingPanel({ products, busy, onMarketing }: { products: MarketingProduct[]; busy: string; onMarketing: (product: MarketingProduct, marketed: boolean) => void }) {
  return <section className="panel team-marketing" aria-labelledby="team-marketing-title">
    <div className="admin-section-title"><div><h2 id="team-marketing-title">Products we market</h2>
      <p>The team finds prospects, sends cold email, posts, runs ads and writes articles only for the products switched on here. A prospect asking about a product that is off is left for you. Customers' onboarding and support go on either way.</p></div></div>
    <ul className="team-service-list">{products.map(product => <li key={`${product.product}:${product.changedAt}`}>
      <span className="team-service-name">{product.label}</span>
      <Pill good={product.marketed}>{product.marketed ? "Marketed" : "Not marketed"}</Pill>
      <span className="muted">{product.description}</span>
      <span className="button-row">
        <button type="button" className={`button button-small ${product.marketed ? "button-secondary" : "button-primary"}`} disabled={Boolean(busy)}
          aria-label={`${product.marketed ? "Stop marketing" : "Start marketing"} ${product.label}`} onClick={() => onMarketing(product, !product.marketed)}>{product.marketed ? "Stop marketing" : "Start marketing"}</button>
      </span>
    </li>)}</ul>
  </section>;
}

/**
 * Whether the five weekly reports still email the owner beside the Chief of Staff's Monday scorecard. Off by default: the scorecard
 * carries their figures. Run now on any of them still emails that report.
 */
function ReportsPanel({ settings, busy, onReports }: { settings: ScorecardSettings; busy: string; onReports: (send: boolean) => void }) {
  const on = settings.individualReports;
  return <section className="panel team-reports" aria-labelledby="team-reports-title">
    <div className="admin-section-title"><div><h2 id="team-reports-title">Weekly reports</h2>
      <p>The Chief of Staff's Monday scorecard comes at 07:50 Eastern: six numbers per product, what changed and at most three decisions. While the Chief of Staff is working, the accounts, growth, SEO, pipeline and social reports are folded into it. Run now on any of them still emails that report.</p></div></div>
    <ul className="team-service-list"><li key={settings.changedAt}>
      <span className="team-service-name">Send the individual weekly reports</span>
      <Pill good={!on}>{on ? "Sent as well" : "In the scorecard only"}</Pill>
      <span className="muted">{on ? "You get the five weekly reports by email as well as the scorecard." : "You get the scorecard only."}</span>
      <span className="button-row">
        <button type="button" className={`button button-small ${on ? "button-secondary" : "button-primary"}`} disabled={Boolean(busy)}
          onClick={() => onReports(!on)}>{on ? "Stop sending them" : "Send them as well"}</button>
      </span>
    </li></ul>
  </section>;
}

/**
 * The owner's offer menu. The Account Manager offers only what is switched on here, to trials that qualify, once per account and within
 * each offer's monthly cap. Until the "Offers" step above is automatic, the owner approves each one.
 */
function OffersPanel({ menu, busy, onOffer, onAdd }: { menu: NonNullable<TeamOverview["offers"]>; busy: string; onOffer: (offer: MenuOffer, enabled: boolean, monthlyCap: number) => void; onAdd: (offer: NewOffer) => void }) {
  const apps = [...new Set(menu.offers.flatMap(offer => offer.apps))].sort();
  return <section className="panel team-offers" aria-labelledby="team-offers-title">
    <div className="admin-section-title"><div><h2 id="team-offers-title">Offers the Account Manager may make</h2>
      <p>Only what is switched on here, to trials that qualify, once per account and within each offer's monthly cap. Until Offers runs on its own, you approve each one.</p></div></div>
    {menu.offers.length === 0 ? <p className="muted">No offer on the menu yet.</p>
      : <ul className="team-service-list">{menu.offers.map(offer => <OfferRow key={`${offer.key}:${offer.changedAt}`} offer={offer} busy={busy} onOffer={onOffer} />)}</ul>}
    <AddOfferForm coupons={menu.coupons} apps={apps.length > 0 ? apps : ["carebase"]} busy={busy} onAdd={onAdd} />
  </section>;
}

/** A link to the conversation a proposal is about, in the inbox (a plain link where there is no router, as in tests). */
function RecordLink({ reference }: { reference: string }) {
  const href = `/communications?search=${encodeURIComponent(reference)}&status=all`;
  return useInRouterContext() ? <Link to={href}>Open {reference}</Link> : <a href={href}>Open {reference}</a>;
}

function ApprovalCard({ approval, busy, onDecide }: { approval: TeamApproval; busy: string; onDecide: (approval: TeamApproval, decision: "approve" | "reject", note: string) => void }) {
  const [note, setNote] = useState("");
  const email = approval.kind === "email.send" || approval.kind === "email.external";
  // A customer email is named by its account and subject, so two waiting emails never share a name.
  const what = email ? approvalTitle(approval) : actionLabel(approval.kind);
  // Approving a reply or a customer email sends it.
  const sends = ["communication.reply", "communication.answer", "growth.message"].includes(approval.kind) || email;
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
  const pageSize = 10;
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(approvals.length / pageSize));
  const current = Math.min(page, pages - 1);
  const start = current * pageSize;
  const visible = approvals.slice(start, start + pageSize);
  const notLoaded = Math.max(0, count - approvals.length);
  return <section className="panel team-approvals" aria-labelledby="team-approvals-title">
    <div className="admin-section-title"><div><h2 id="team-approvals-title">Waiting for you{count ? ` (${count})` : ""}</h2><p>Nothing here has happened yet. Approve what you want done; reject the rest.</p></div></div>
    {approvals.length === 0
      ? <p className="admin-explanation">Nothing is waiting for your approval.</p>
      : <ul className="team-approval-list">{visible.map(approval => <ApprovalCard key={approval.id} approval={approval} busy={busy} onDecide={onDecide} />)}</ul>}
    {approvals.length > pageSize && <div className="button-row">
      <button type="button" className="button button-secondary button-small" disabled={current === 0} onClick={() => setPage(current - 1)}>Previous proposals</button>
      <span className="muted">Proposals {start + 1}–{start + visible.length} of {approvals.length}</span>
      <button type="button" className="button button-secondary button-small" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>Next proposals</button>
    </div>}
    {notLoaded > 0 && <p className="muted">{notLoaded} newer {notLoaded === 1 ? "proposal is" : "proposals are"} not loaded yet. Decide these, then refresh to see the rest.</p>}
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
        const external = item.kind === "email.external";
        const externalFailure = external && item.status === "failed" ? externalEmailFailure(item.result?.error) : null;
        const failure = externalFailure?.message ?? (item.status === "failed" && typeof item.result?.error === "string" ? failedActionLabel(item.result.error) : "");
        const decision = item.decidedAt ? `${timeLabel(item.decidedAt)}${item.decisionNote ? ` — ${item.decisionNote}` : ""}` : "";
        const target = external ? externalEmailRecipient(item.preview) || "External recipient" : item.targetId ? targetLabel(item.targetKind, item.targetId) : "—";
        const status = externalFailure?.unconfirmed ? "Outcome unknown"
          : external && item.status === "executed" ? "Accepted by email provider" : statusLabel(item.status);
        return <tr key={item.id}><td>{timeLabel(item.createdAt)}</td><td>{who(item.agentKey)}</td><td>{actionLabel(item.kind)}</td><td>{target}</td><td>{status}</td>
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
/** The Creative Director's own screen: its gallery, briefs and brand kits. Its proposals are also listed here under Waiting for you. */
function CreativeLink() {
  return useInRouterContext() ? <Link className="button button-secondary" to="/admin/creative">Creative</Link> : <a className="button button-secondary" href="/admin/creative">Creative</a>;
}

export function Team({ client = teamClient }: { client?: TeamClient }) {
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState("");
  const changing = useRef(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [terminalEmailDecisions, setTerminalEmailDecisions] = useState<Record<string, "rejected" | "expired">>({});
  const reload = useCallback(() => setRefresh(value => value + 1), []);
  const reader = useCallback((signal: AbortSignal) => { void refresh; return client.overview({ signal }); }, [client, refresh]);
  const state = useAdminRead(reader);
  // Keep showing the last roster while a refresh is in flight, so a change never blanks the page.
  const [kept, setKept] = useState<{ data: TeamOverview; receivedAt: Date } | null>(null);
  if (state.status === "ready" && kept?.data !== state.data) setKept({ data: state.data, receivedAt: state.receivedAt });
  const shown = state.status === "ready" ? state : kept;

  const change: Change = async (id, work, success, failure = failureText) => {
    if (changing.current) return;
    changing.current = true;
    setBusy(id); setNotice(null);
    try { await work(); setNotice({ ok: true, text: typeof success === "function" ? success() : success }); }
    catch (error) { setNotice({ ok: false, text: failure(error) }); }
    finally { changing.current = false; setBusy(""); reload(); }
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
  const onOffer = (offer: MenuOffer, enabled: boolean, monthlyCap: number) => void change(`offer:${offer.key}`,
    () => client.setOffer({ key: offer.key, enabled, monthlyCap, expectedChangedAt: offer.changedAt }),
    enabled === offer.enabled ? `${offer.label}: at most ${plural(monthlyCap, "offer")} a month.` : `${offer.label} is switched ${enabled ? "on" : "off"}.`);
  const onAddOffer = (offer: NewOffer) => void change("offer:new", () => client.addOffer(offer), `${offer.label} is on the menu, switched off. Switch it on when you are ready.`);
  const onMarketing = (product: MarketingProduct, marketed: boolean) => void change(`marketing:${product.product}`,
    () => client.setMarketing({ product: product.product, marketed, expectedChangedAt: product.changedAt }),
    marketed ? `The team markets ${product.label} from its next run.` : `The team stops marketing ${product.label} from its next run.`);
  const onReports = (send: boolean) => {
    const settings = shown?.data.reports;
    if (!settings) return;
    void change("reports", () => client.setReports({ send, expectedChangedAt: settings.changedAt }),
      send ? "The five weekly reports are emailed again from their next run, beside the Monday scorecard." : "The five weekly reports are folded into the Monday scorecard from their next run.");
  };
  const onRunWaiting = () => {
    let started = 0;
    let sending = 0;
    void change("waiting", async () => { const result = await client.waiting(); started = result.started; sending = result.actions; },
      () => started === 0 && sending === 0 ? "Nothing was waiting to run." : `${[started > 0 ? `Started ${plural(started, "task")}` : "", sending > 0 ? `${started > 0 ? "checking" : "Checking"} ${plural(sending, "approved message")}` : ""].filter(Boolean).join(" and ")}. Refresh in a minute to see the results.`, waitingFailureText);
  };
  const onDecide = (approval: TeamApproval, decision: "approve" | "reject", note: string) => {
    let outcome: "sent" | "waiting" | "unconfirmed" = "unconfirmed";
    const external = approval.kind === "email.external";
    let finalFailure: string | null = null;
    void change(`decide:${approval.id}`,
    async () => {
      const result = await client.decide({ actionId: approval.id, decision, note: note.trim() || undefined });
      if (external && (result.id !== approval.id || result.kind !== approval.kind)) throw new Error("The action confirmation did not match this email.");
      if (external && (result.status === "rejected" || result.status === "expired")) {
        const status = result.status;
        setTerminalEmailDecisions(previous => ({ ...previous, [result.id]: status }));
      }
      if (!result.decided) throw new TeamApiError(409, "That was already decided or has expired. The list has been refreshed.");
      // A failed reply is final, so "press Run what's waiting" (the label a waiting task gets) would send the owner the wrong way.
      if (result.status === "failed") {
        finalFailure = external ? externalEmailFailure(result.error).message : result.error ? failedActionLabel(result.error) : "It was approved but could not be carried out. See the activity below.";
        throw new TeamApiError(500, finalFailure);
      }
      // Only the server can say a reply was not started. A plain "approved" may be an action whose work was done and whose result could not
      // be recorded, so it is never reported as unsent.
      outcome = result.status === "executed" ? "sent" : result.needsSession ? "waiting" : "unconfirmed";
    }, () => {
      if (decision === "reject") return "Rejected.";
      if (outcome === "sent") return external ? "Accepted by the email provider. Delivery to the recipient is not confirmed." : "Approved.";
      if (outcome === "waiting") return "Approved. It has not been sent yet. Press Run what's waiting while you are signed in.";
      if (external) return "Approved, but the send outcome could not be confirmed. Do not resend this email. Check Proposed actions and the email provider's activity.";
      return "Approved, but the Hub could not confirm what happened next. Check the Proposed actions below, and for a reply open the conversation before answering again.";
    }, error => !external || decision === "reject" ? failureText(error) : finalFailure ?? (error instanceof TeamApiError && error.status < 500 ? error.message
      : "The send outcome could not be confirmed. Do not resend this email. Refresh Proposed actions and check the email provider's activity."));
  };

  return <div className="team">
    <div className="page-heading"><div><span className="eyebrow">CareMetric Admin</span><h1><Bot size={22} aria-hidden="true" /> AI team</h1>
      <p>Your AI agents: what they can use, what waits for your approval, and what they have done. Every agent starts paused.</p></div>
      <div className="button-row"><CreativeLink />
        <button type="button" className="button button-secondary" onClick={reload} disabled={state.status === "loading"}><RefreshCw size={16} aria-hidden="true" /> Refresh</button></div></div>
    {notice && <p role={notice.ok ? "status" : "alert"} className={notice.ok ? "admin-explanation" : "form-message form-error"}>{notice.text}</p>}
    {!shown && state.status === "loading" && <Loading label="Loading the AI team" app="AI team" />}
    {state.status === "error" && !shown && <ReadFailure error={state.error} retry={reload} />}
    {state.status === "error" && shown && <ReadFailure error={state.error} retry={reload} />}
    {shown && <>
      <p className="admin-read-time">Loaded {timeLabel(shown.receivedAt)}.</p>
      <ServicesPanel services={shown.data.services} awaitingSession={shown.data.team.awaitingSessionCount} waitingActions={shown.data.waitingActions} busy={busy} onRunWaiting={onRunWaiting} />
      <MarketingToolkit services={shown.data.services} agents={shown.data.team.agents} />
      {shown.data.marketing && shown.data.marketing.length > 0 && <MarketingPanel products={shown.data.marketing} busy={busy} onMarketing={onMarketing} />}
      {shown.data.reports && <ReportsPanel settings={shown.data.reports} busy={busy} onReports={onReports} />}
      {shown.data.autonomy && shown.data.autonomy.length > 0 && <AutonomyPanel steps={shown.data.autonomy} busy={busy} onStep={onStep} />}
      <EmailComposer client={client} ready={shown.data.services.externalEmail === true && shown.data.services.email} busy={busy} change={change} terminalDecisions={terminalEmailDecisions} />
      {shown.data.offers && <OffersPanel menu={shown.data.offers} busy={busy} onOffer={onOffer} onAdd={onAddOffer} />}
      <ApprovalsPanel approvals={shown.data.team.approvals} count={shown.data.team.approvalCount} busy={busy} onDecide={onDecide} />
      <section aria-labelledby="team-agents-title"><h2 id="team-agents-title" className="team-section-heading">Agents</h2>
        <div className="team-agent-grid">
          {shown.data.team.agents.map(agent => <AgentCard key={`${agent.key}:${agent.updatedAt}`} agent={agent} services={shown.data.services} busy={busy} onStatus={onStatus} onAutonomy={onAutonomy} onBudget={onBudget} onRun={onRun} />)}
        </div></section>
      <ActivityPanel client={client} agents={shown.data.team.agents} refresh={refresh} />
    </>}
  </div>;
}
