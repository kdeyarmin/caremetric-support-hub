import { describe, expect, it, vi } from 'vitest';
import { agentAdmin } from './admin.mjs';
import { HttpError } from '../sms-auth.mjs';

const actionId = '11111111-1111-4111-8111-111111111111';
const version = '2026-11-02T12:00:00.123456+00:00';
const fixture = ({ results = {}, execution = { executed: true, failed: false } } = {}) => {
  const queries = [];
  const db = { query: vi.fn(async (sql, args) => { queries.push([sql, args]); const name = /select (\S+)\(/.exec(sql)[1]; const value = results[name]; if (value instanceof Error) throw value; return { rows: [{ result: value ?? {} }] }; }) };
  const session = vi.fn(async (token, work) => { if (!token) throw new HttpError(401, 'Sign in with an SMS code to continue.'); return work(db); });
  const actions = { executeOne: vi.fn(async () => execution) };
  const kick = vi.fn();
  return { queries, session, actions, kick, admin: agentAdmin({ session, actions, kick, services: () => ({ enabled: true, handlers: ['probe.sweep'] }) }) };
};
const databaseError = (code, message) => Object.assign(new Error(message), { code });

describe('agent administration', () => {
  it('returns the roster with the services the team can use', async () => {
    const { admin, queries } = fixture({ results: { 'hub.get_agent_team': { agents: [], approvalCount: 0 } } });
    expect(await admin.overview('token', {})).toEqual({ team: { agents: [], approvalCount: 0 }, services: { enabled: true, handlers: ['probe.sweep'] } });
    expect(queries[0][0]).toBe('select hub.get_agent_team() as result');
  });

  it('requires a signed-in session', async () => {
    const { admin } = fixture();
    await expect(admin.overview(undefined, {})).rejects.toMatchObject({ status: 401 });
  });

  it('passes a valid change to the database operation that authorizes it', async () => {
    const { admin, queries } = fixture({ results: { 'hub.set_agent_status': { key: 'platform_engineer', status: 'active' } } });
    expect(await admin.status('token', { key: 'platform_engineer', status: 'active', expectedUpdatedAt: version })).toEqual({ key: 'platform_engineer', status: 'active' });
    expect(queries[0]).toEqual(['select hub.set_agent_status($1, $2, $3) as result', ['platform_engineer', 'active', version]]);
    await admin.autonomy('token', { key: 'support_concierge', autonomy: 'propose', expectedUpdatedAt: version });
    await admin.budget('token', { key: 'support_concierge', dailyBudgetCents: 250, expectedUpdatedAt: version });
    await admin.cancel('token', { taskId: actionId });
    expect(queries.map(([sql]) => /select (\S+)\(/.exec(sql)[1])).toEqual(['hub.set_agent_status', 'hub.set_agent_autonomy', 'hub.set_agent_budget', 'hub.cancel_agent_task']);
  });

  it('rejects input it did not expect before touching the database', async () => {
    const { admin, session } = fixture();
    const bad = [
      () => admin.status('token', { key: 'platform_engineer', status: 'sleeping', expectedUpdatedAt: version }),
      () => admin.status('token', { key: 'Platform Engineer', status: 'active', expectedUpdatedAt: version }),
      () => admin.status('token', { key: 'platform_engineer', status: 'active' }),
      () => admin.status('token', { key: 'platform_engineer', status: 'active', expectedUpdatedAt: 'yesterday' }),
      () => admin.status('token', { key: 'platform_engineer', status: 'active', expectedUpdatedAt: version, extra: true }),
      () => admin.autonomy('token', { key: 'platform_engineer', autonomy: 'root', expectedUpdatedAt: version }),
      () => admin.budget('token', { key: 'platform_engineer', dailyBudgetCents: -1, expectedUpdatedAt: version }),
      () => admin.budget('token', { key: 'platform_engineer', dailyBudgetCents: 100001, expectedUpdatedAt: version }),
      () => admin.budget('token', { key: 'platform_engineer', dailyBudgetCents: 1.5, expectedUpdatedAt: version }),
      () => admin.budget('token', { key: 'platform_engineer', dailyBudgetCents: '50', expectedUpdatedAt: version }),
      () => admin.cancel('token', { taskId: 'not-a-uuid' }),
      () => admin.run('token', { agentKey: 'platform_engineer', taskKind: 'wire money' }),
      () => admin.decide('token', { actionId: 'nope', decision: 'approve' }),
      () => admin.decide('token', { actionId, decision: 'maybe' }),
      () => admin.decide('token', { actionId, decision: 'approve', note: 'x'.repeat(1001) }),
      () => admin.decide('token', { actionId, decision: 'approve', note: 5 }),
      () => admin.overview('token', { all: true }),
    ];
    for (const attempt of bad) await expect(attempt()).rejects.toMatchObject({ status: 400 });
    expect(session).not.toHaveBeenCalled();
  });

  it('turns the database\'s reviewed errors into the right status and keeps its message', async () => {
    for (const [code, status] of [['40001', 409], ['P0002', 404], ['22023', 400], ['55000', 409], ['28000', 401], ['42501', 403]]) {
      const { admin } = fixture({ results: { 'hub.set_agent_status': databaseError(code, 'Reviewed message.') } });
      await expect(admin.status('token', { key: 'platform_engineer', status: 'active', expectedUpdatedAt: version })).rejects.toMatchObject({ status, message: 'Reviewed message.' });
    }
    const { admin } = fixture({ results: { 'hub.set_agent_status': databaseError('XX000', 'internal detail') } });
    await expect(admin.status('token', { key: 'platform_engineer', status: 'active', expectedUpdatedAt: version })).rejects.not.toBeInstanceOf(HttpError);
  });

  it('carries out an approval straight away, once', async () => {
    const { admin, actions } = fixture({ results: { 'hub.decide_agent_action': { id: actionId, kind: 'communication.reply', status: 'approved', decided: true } } });
    expect(await admin.decide('token', { actionId, decision: 'approve', note: 'Looks right' })).toEqual({ id: actionId, kind: 'communication.reply', status: 'executed', decided: true });
    expect(actions.executeOne).toHaveBeenCalledWith(actionId);
  });

  it('does not carry out a rejection, an expired proposal or a decision made before', async () => {
    for (const result of [
      { id: actionId, kind: 'communication.reply', status: 'rejected', decided: true },
      { id: actionId, kind: 'communication.reply', status: 'expired', decided: false },
      { id: actionId, kind: 'communication.reply', status: 'approved', decided: false },
    ]) {
      const { admin, actions } = fixture({ results: { 'hub.decide_agent_action': result } });
      expect(await admin.decide('token', { actionId, decision: 'approve' })).toEqual({ id: actionId, kind: result.kind, status: result.status, decided: result.decided });
      expect(actions.executeOne).not.toHaveBeenCalled();
    }
  });

  it('reports a failed or interrupted execution without losing the approval', async () => {
    const approved = { id: actionId, kind: 'communication.reply', status: 'approved', decided: true };
    const failed = fixture({ results: { 'hub.decide_agent_action': approved }, execution: { executed: false, failed: true } });
    expect((await failed.admin.decide('token', { actionId, decision: 'approve' })).status).toBe('failed');
    const crashed = fixture({ results: { 'hub.decide_agent_action': approved } });
    crashed.actions.executeOne.mockRejectedValue(new Error('db down'));
    expect((await crashed.admin.decide('token', { actionId, decision: 'approve' })).status).toBe('approved');
  });

  it('starts a task it queued without waiting for the next tick', async () => {
    const { admin, kick } = fixture({ results: { 'hub.request_agent_task': { id: actionId, status: 'queued' } } });
    expect(await admin.run('token', { agentKey: 'platform_engineer', taskKind: 'probe.sweep' })).toEqual({ id: actionId, status: 'queued' });
    await new Promise(resolve => setImmediate(resolve));
    expect(kick).toHaveBeenCalledTimes(1);
  });
});
