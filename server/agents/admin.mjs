import { HttpError, withSession } from '../sms-auth.mjs';

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
export const agentAdminActions = new Set(['overview', 'status', 'autonomy', 'budget', 'decide', 'run', 'cancel']);

function reviewed(error) {
  if (error instanceof HttpError) return error;
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

export function agentAdmin({ pool, actions, services = () => ({}), kick = null, session = (token, work) => withSession(pool, token, work) }) {
  const query = (token, operation, args = []) => session(token, async db =>
    (await db.query(`select ${operation}(${args.map((_, index) => `$${index + 1}`).join(', ')}) as result`, args)).rows[0].result).catch(error => { throw reviewed(error); });
  // A queued task starts within a second instead of waiting for the next minute's tick.
  const soon = () => { if (kick) setImmediate(() => { Promise.resolve(kick()).catch(() => {}); }); };

  return {
    /** The roster, what waits for approval, and which services the team can use right now. */
    async overview(token, input = {}) {
      exactly(input, []);
      return { team: await query(token, 'hub.get_agent_team'), services: services() };
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
    async run(token, input) {
      exactly(input, ['agentKey', 'taskKind']);
      const requested = await query(token, 'hub.request_agent_task', [matching(input.agentKey, agentKey, 'agent'), matching(input.taskKind, taskKind, 'task')]);
      soon();
      return requested;
    },
    async cancel(token, input) {
      exactly(input, ['taskId']);
      return query(token, 'hub.cancel_agent_task', [matching(input.taskId, uuid, 'task')]);
    },
    /** Approve or reject one proposal. An approval is carried out straight away; if that fails the action records it. */
    async decide(token, input) {
      exactly(input, ['actionId', 'decision'], ['note']);
      const note = input.note ?? null;
      if (note !== null && (typeof note !== 'string' || note.length > 1000)) throw new HttpError(400, 'Invalid note.');
      const decided = await query(token, 'hub.decide_agent_action', [matching(input.actionId, uuid, 'action'), oneOf(input.decision, ['approve', 'reject'], 'decision'), note]);
      let status = decided.status;
      if (decided.decided && decided.status === 'approved') {
        // The database already holds the approval; a failure here leaves it ready for the next tick to carry out.
        const outcome = await actions.executeOne(decided.id).catch(() => null);
        if (outcome?.executed) status = 'executed';
        else if (outcome?.failed) status = 'failed';
      }
      return { id: decided.id, kind: decided.kind, status, decided: decided.decided };
    },
  };
}
