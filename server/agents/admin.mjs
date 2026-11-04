import { HttpError, withSession } from '../sms-auth.mjs';
import { validExternalEmail } from './external-email.mjs';

/**
 * What the owner can do to the AI team from the Hub: see the roster and what is waiting for
 * approval, pause or resume an agent, change its autonomy or daily budget, run one of its
 * scheduled tasks now, cancel a task, and approve or reject a proposed action. Every call
 * runs inside the owner's SMS session; the database operations authorize that session
 * themselves (administrator for reads, command assurance for changes), so this module adds
 * no authority, only input checks and reviewed error messages.
 *
 * Approving an action also carries it out, which is why changes are routes here and not
 * part of the browser's RPC allowlist.
 */
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const agentKey = /^[a-z][a-z0-9_]{1,40}$/;
const taskKind = /^[a-z][a-z0-9_.]{1,60}$/;
// The database returns an agent's updated_at to the microsecond; the browser hands it back untouched.
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const reviewedErrors = { '22023': 400, '40001': 409, '42501': 403, '28000': 401, P0002: 404, '55000': 409 };
export const agentAdminActions = new Set(['overview', 'status', 'autonomy', 'budget', 'decide', 'run', 'cancel', 'waiting', 'email']);

function reviewed(error) {
  if (error instanceof HttpError) return error;
  // A date the pattern accepts but the calendar does not (2026-02-30) reaches the database, which refuses it. That is the request's
  // fault, and the database's own wording is not shown.
  if (error?.code === '22007' || error?.code === '22008') return new HttpError(400, 'Invalid date or time.');
  const status = reviewedErrors[error?.code];
  return status ? new HttpError(status, error.message) : error;
}
function exactly(input, required, optional = []) {
  const keys = Object.keys(input ?? {});
  if (keys.some(key => !required.includes(key) && !optional.includes(key)) || required.some(key => !keys.includes(key))) throw new HttpError(400, 'Invalid request.');
  return input;
}
function matching(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new HttpError(400, `Invalid ${label}.`);
  return value;
}
function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw new HttpError(400, `Invalid ${label}.`);
  return value;
}

export function agentAdmin({ pool, actions, services = () => ({}), kick = null, waiting = null, session = (token, work) => withSession(pool, token, work) }) {
  const query = (token, operation, args = []) => session(token, async db =>
    (await db.query(`select ${operation}(${args.map((_, index) => `$${index + 1}`).join(', ')}) as result`, args)).rows[0].result).catch(error => { throw reviewed(error); });
  // A queued task starts within a second instead of waiting for the next minute's tick.
  const soon = () => { if (kick) setImmediate(() => { Promise.resolve(kick()).catch(() => {}); }); };
  // Work that needs the owner's session: claim it now, let it finish in the background. The token is only handed on, never kept.
  async function startWaiting(token, only = null) {
    if (!waiting) throw new HttpError(409, 'The AI team is not running on this server.');
    const run = await waiting({ sessionToken: token, only });
    if (run.skipped) throw new HttpError(409, 'The AI team is switched off on this server.');
    run.done.catch(() => {});
    return run.started;
  }

  return {
    /** The roster, what waits for approval, and which services the team can use right now. */
    async overview(token, input = {}) {
      exactly(input, []);
      const team = await query(token, 'hub.get_agent_team');
      // Approved replies that could not be sent yet (a restart, or a session that lapsed) wait for the owner's next press of the button.
      const waitingActions = await Promise.resolve(actions.sessionActions?.()).then(list => list?.length ?? 0, () => 0);
      return { team, services: services(), waitingActions };
    },
    async status(token, input) {
      exactly(input, ['key', 'status', 'expectedUpdatedAt']);
      return query(token, 'hub.set_agent_status', [matching(input.key, agentKey, 'agent'), oneOf(input.status, ['active', 'paused'], 'status'), matching(input.expectedUpdatedAt, instant, 'version')]);
    },
    async autonomy(token, input) {
      exactly(input, ['key', 'autonomy', 'expectedUpdatedAt']);
      return query(token, 'hub.set_agent_autonomy', [matching(input.key, agentKey, 'agent'), oneOf(input.autonomy, ['observe', 'propose', 'act'], 'autonomy'), matching(input.expectedUpdatedAt, instant, 'version')]);
    },
    async budget(token, input) {
      exactly(input, ['key', 'dailyBudgetCents', 'expectedUpdatedAt']);
      if (!Number.isInteger(input.dailyBudgetCents) || input.dailyBudgetCents < 0 || input.dailyBudgetCents > 100000) throw new HttpError(400, 'Invalid budget.');
      return query(token, 'hub.set_agent_budget', [matching(input.key, agentKey, 'agent'), input.dailyBudgetCents, matching(input.expectedUpdatedAt, instant, 'version')]);
    },
    /** Prepare the owner's exact email for review. This operation never approves, queues a task or sends it. */
    async email(token, input) {
      exactly(input, ['to', 'subject', 'body', 'requestKey']);
      if (!validExternalEmail(input)) throw new HttpError(400, 'Enter one email address, a subject of at most 200 characters, and a message of at most 5000 characters.');
      const requestKey = matching(input.requestKey, uuid, 'request key');
      // Authenticate even when the capability is unavailable; the creation operation rechecks command authorization itself.
      await query(token, 'hub.authorize_app_command');
      if (services().externalEmail !== true) throw new HttpError(503, 'Owner-directed email is not available. Check the Hub email setup and database feature.');
      return query(token, 'hub.request_agent_email', [input.to, input.subject, input.body, requestKey]);
    },
    async run(token, input) {
      exactly(input, ['agentKey', 'taskKind']);
      const requested = await query(token, 'hub.request_agent_task', [matching(input.agentKey, agentKey, 'agent'), matching(input.taskKind, taskKind, 'task')]);
      // A task that reads another application waits for the owner's session. They are signed in right now, so run it now.
      if (requested?.status === 'awaiting_session') {
        const started = await startWaiting(token, [requested.id]).catch(() => 0);
        return started > 0 ? { ...requested, status: 'running' } : requested;
      }
      soon();
      return requested;
    },
    /** Runs what was waiting for the owner's sign-in: imports from Advisors and Breathe, and approved replies that never went out. Answers at once; the work continues in the background. */
    async waiting(token, input = {}) {
      exactly(input, []);
      // The same assurance the database asks for any change: a lapsed session gets 401 before anything is claimed.
      await query(token, 'hub.authorize_app_command');
      // Approved replies that never went out are sent now, with this session, one at a time in the background.
      const ready = await Promise.resolve(actions.sessionActions?.()).catch(() => []) ?? [];
      if (ready.length > 0) void actions.executeSessionActions(ready, { sessionToken: token }).catch(() => {});
      // With the scheduler off there are no tasks to start, but the replies above still go out.
      const started = await startWaiting(token).catch(error => { if (ready.length > 0 && error?.status === 409) return 0; throw error; });
      return { started, actions: ready.length };
    },
    async cancel(token, input) {
      exactly(input, ['taskId']);
      return query(token, 'hub.cancel_agent_task', [matching(input.taskId, uuid, 'task')]);
    },
    /**
     * Approve or reject one proposal. An approval is carried out straight away; if that fails the action records it.
     * A status of `approved` after an approval is not proof that nothing happened: a failure after the work was done (recording
     * the result) leaves it too. So `needsSession: true` is the only word that nothing was started, and it is said only when the
     * executor confirmed it skipped or handed the action back for want of the owner's session.
     */
    async decide(token, input) {
      exactly(input, ['actionId', 'decision'], ['note']);
      const note = input.note ?? null;
      if (note !== null && (typeof note !== 'string' || note.length > 1000)) throw new HttpError(400, 'Invalid note.');
      const decided = await query(token, 'hub.decide_agent_action', [matching(input.actionId, uuid, 'action'), oneOf(input.decision, ['approve', 'reject'], 'decision'), note]);
      let status = decided.status;
      let error = null;
      let needsSession = false;
      if (decided.decided && decided.status === 'approved') {
        // The database already holds the approval; a failure here leaves it approved. An action that needs the owner's session
        // runs now, with theirs; one the tick can carry out is picked up on the next tick.
        const outcome = await actions.executeOne(decided.id, { kind: decided.kind, sessionToken: token }).catch(() => null);
        if (outcome?.executed) status = 'executed';
        else if (outcome?.failed) { status = 'failed'; error = outcome.error ?? null; }
        else if (outcome?.skipped === true && outcome.needsSession === true) needsSession = true;
      }
      return { id: decided.id, kind: decided.kind, status, decided: decided.decided, ...(error ? { error } : {}), ...(needsSession ? { needsSession } : {}) };
    },
  };
}
