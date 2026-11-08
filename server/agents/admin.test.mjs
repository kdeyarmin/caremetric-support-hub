import { describe, expect, it, vi } from 'vitest';
import { agentAdmin } from './admin.mjs';
import { HttpError } from '../sms-auth.mjs';

const actionId = '11111111-1111-4111-8111-111111111111';
const version = '2026-11-02T12:00:00.123456+00:00';
const fixture = ({ results = {}, execution = { executed: true, failed: false }, waiting = vi.fn(async () => ({ skipped: false, started: 2, done: Promise.resolve([]) })), ready = [], externalEmail = false, externalReady = null } = {}) => {
  const queries = [];
  const db = { query: vi.fn(async (sql, args) => { queries.push([sql, args]); const name = /select (\S+)\(/.exec(sql)[1]; const value = results[name]; if (value instanceof Error) throw value; return { rows: [{ result: value ?? {} }] }; }) };
  const session = vi.fn(async (token, work) => { if (!token) throw new HttpError(401, 'Sign in with an SMS code to continue.'); return work(db); });
  const actions = { executeOne: vi.fn(async () => execution), sessionActions: vi.fn(async () => ready), executeSessionActions: vi.fn(async () => ({ executed: ready.length, failed: 0 })) };
  const kick = vi.fn();
  return { queries, session, actions, kick, waiting, admin: agentAdmin({ session, actions, kick, waiting, externalEmailReady: externalReady, services: () => ({ enabled: true, handlers: ['probe.sweep'], ...(externalEmail ? { externalEmail: true } : {}) }) }) };
};
const databaseError = (code, message) => Object.assign(new Error(message), { code });

describe('agent administration', () => {
  describe('owner-directed email proposals', () => {
    const email = { to: 'data.support@example.test', subject: 'CareMetric source access', body: 'Hello,\n\nPlease investigate.\n', requestKey: actionId };

    it('authorizes a command and prepares the exact message without approving, executing or queuing any task', async () => {
      const proposal = { id: actionId, kind: 'email.external', status: 'proposed', created: true, requestKey: actionId };
      const { admin, queries, actions, kick } = fixture({ externalEmail: true, results: { 'hub.request_agent_email': proposal } });
      expect(await admin.email('token', email)).toEqual(proposal);
      expect(queries).toEqual([
        ['select hub.authorize_app_command() as result', []],
        ['select hub.request_agent_email($1, $2, $3, $4) as result', [email.to, email.subject, email.body, actionId]],
      ]);
      expect(actions.executeOne).not.toHaveBeenCalled();
      expect(kick).not.toHaveBeenCalled();
    });

    it('returns an existing request unchanged without sending it again and preserves the request key on a conflict', async () => {
      const recorded = { id: actionId, kind: 'email.external', status: 'executed', created: false, requestKey: actionId };
      const { admin, actions } = fixture({ externalEmail: true, results: { 'hub.request_agent_email': recorded } });
      expect(await admin.email('token', email)).toEqual(recorded);
      expect(actions.executeOne).not.toHaveBeenCalled();
      const conflict = fixture({ externalEmail: true, results: { 'hub.request_agent_email': databaseError('40001', 'This request key was used for a different email.') } });
      await expect(conflict.admin.email('token', { ...email, body: 'Changed text' })).rejects.toMatchObject({ status: 409 });
    });

    it('rejects extra routing or approval fields, invalid keys and message headers before querying', async () => {
      const { admin, session } = fixture({ externalEmail: true });
      for (const bad of [
        { ...email, bcc: 'another@example.test' }, { ...email, approve: true }, { ...email, from: 'owner@example.test' },
        { ...email, requestKey: 'not-a-uuid' }, { ...email, to: 'data.support@example.test\nCc: another@example.test' },
        { ...email, subject: 'Subject\r\nBcc: another@example.test' }, { ...email, body: 'x'.repeat(5001) },
        { to: email.to, subject: email.subject, requestKey: actionId },
      ]) await expect(admin.email('token', bad)).rejects.toMatchObject({ status: 400 });
      expect(session).not.toHaveBeenCalled();
    });

    it('requires current owner command authorization even when email is unavailable', async () => {
      for (const [code, status] of [['28000', 401], ['42501', 403]]) {
        const { admin, queries } = fixture({ results: { 'hub.authorize_app_command': databaseError(code, 'Current owner command required.') } });
        await expect(admin.email('token', email)).rejects.toMatchObject({ status });
        expect(queries).toHaveLength(1);
      }
      const { admin, queries } = fixture({ externalEmail: true });
      await expect(admin.email(null, email)).rejects.toMatchObject({ status: 401 });
      expect(queries).toEqual([]);
    });

    it('does not create a draft until both the feature and sender are ready', async () => {
      const { admin, queries } = fixture();
      await expect(admin.email('token', email)).rejects.toMatchObject({ status: 503 });
      expect(queries).toEqual([['select hub.authorize_app_command() as result', []]]);
    });

    it('uses the existing approval path and reports provider acceptance only after a successful execution', async () => {
      const approved = { id: actionId, kind: 'email.external', status: 'approved', decided: true };
      const { admin, actions } = fixture({ results: { 'hub.decide_agent_action': approved } });
      expect(await admin.decide('token', { actionId, decision: 'approve' })).toEqual({ id: actionId, kind: 'email.external', status: 'executed', decided: true });
      expect(actions.executeOne).toHaveBeenCalledWith(actionId, { kind: 'email.external', sessionToken: 'token' });
      const unknown = fixture({ results: { 'hub.decide_agent_action': approved }, execution: { executed: false, failed: true, error: 'external_email_unconfirmed' } });
      expect(await unknown.admin.decide('token', { actionId, decision: 'approve' })).toEqual({ id: actionId, kind: 'email.external', status: 'failed', decided: true, error: 'external_email_unconfirmed' });
    });
  });

  it('returns the roster with the services the team can use', async () => {
    const steps = [{ category: 'account_emails', status: 'supervised' }];
    const menu = { offers: [{ key: 'trial_extension_14', enabled: false }], coupons: [] };
    const marketing = [{ product: 'caremetric-intel', marketed: true }, { product: 'carebase', marketed: false }];
    const { admin, queries } = fixture({ results: { 'hub.get_agent_team': { agents: [], approvalCount: 0 }, 'hub.get_agent_autonomy': steps, 'hub.get_agent_offers': menu, 'hub.get_marketing_products': marketing } });
    expect(await admin.overview('token', {})).toEqual({ team: { agents: [], approvalCount: 0 }, services: { enabled: true, handlers: ['probe.sweep'] }, waitingActions: 0, autonomy: steps, offers: menu, marketing });
    expect(queries.map(([sql]) => sql)).toEqual(['select hub.get_agent_team() as result', 'select hub.get_agent_autonomy() as result', 'select hub.get_agent_offers() as result', 'select hub.get_marketing_products() as result']);
  });

  it('shows no autonomy steps against a database that does not have them yet, and passes any other failure on', async () => {
    const missing = fixture({ results: { 'hub.get_agent_team': { agents: [] }, 'hub.get_agent_autonomy': databaseError('42883', 'function hub.get_agent_autonomy() does not exist') } });
    expect((await missing.admin.overview('token', {})).autonomy).toBeNull();
    const noMenu = fixture({ results: { 'hub.get_agent_team': { agents: [] }, 'hub.get_agent_autonomy': [], 'hub.get_agent_offers': databaseError('42883', 'function hub.get_agent_offers() does not exist') } });
    expect((await noMenu.admin.overview('token', {})).offers).toBeNull();
    const noSwitches = fixture({ results: { 'hub.get_agent_team': { agents: [] }, 'hub.get_agent_autonomy': [], 'hub.get_agent_offers': null, 'hub.get_marketing_products': databaseError('42883', 'function hub.get_marketing_products() does not exist') } });
    expect((await noSwitches.admin.overview('token', {})).marketing).toBeNull();
    const refused = fixture({ results: { 'hub.get_agent_team': { agents: [] }, 'hub.get_agent_autonomy': databaseError('28000', 'Current administrator session required.') } });
    await expect(refused.admin.overview('token', {})).rejects.toMatchObject({ status: 401 });
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
    await admin.step('token', { category: 'account_emails', action: 'hold', expectedChangedAt: version });
    await admin.offer('token', { key: 'trial_extension_14', enabled: true, monthlyCap: 4, expectedChangedAt: version });
    await admin.addOffer('token', { label: ' 20% off ', kind: 'coupon', couponId: 'SPRING20', apps: ['carebase'], windowDays: 7, monthlyCap: 5 });
    await admin.addOffer('token', { label: 'Two more weeks', kind: 'trial_extension', trialDays: 14, apps: ['carebase', 'caremetric-intel'], windowDays: 5, monthlyCap: 3 });
    await admin.marketing('token', { product: 'carebase', marketed: true, expectedChangedAt: version });
    expect(queries.map(([sql]) => /select (\S+)\(/.exec(sql)[1])).toEqual(['hub.set_agent_status', 'hub.set_agent_autonomy', 'hub.set_agent_budget', 'hub.cancel_agent_task', 'hub.set_agent_autonomy_step',
      'hub.set_agent_offer', 'hub.add_agent_offer', 'hub.add_agent_offer', 'hub.set_marketing_product']);
    expect(queries[8][1]).toEqual(['carebase', true, version]);
    expect(queries[4][1]).toEqual(['account_emails', 'hold', version]);
    expect(queries[5][1]).toEqual(['trial_extension_14', true, 4, version]);
    expect(queries[6][1]).toEqual(['20% off', 'coupon', null, 'SPRING20', ['carebase'], 7, 5]);
    expect(queries[7][1]).toEqual(['Two more weeks', 'trial_extension', 14, null, ['carebase', 'caremetric-intel'], 5, 3]);
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
      () => admin.step('token', { category: 'account_emails', action: 'always', expectedChangedAt: version }),
      () => admin.step('token', { category: 'Account Emails', action: 'hold', expectedChangedAt: version }),
      () => admin.step('token', { category: 'account_emails', action: 'hold' }),
      () => admin.step('token', { category: 'account_emails', action: 'hold', expectedChangedAt: version, now: true }),
      () => admin.offer('token', { key: 'trial_extension_14', enabled: 'yes', monthlyCap: 4, expectedChangedAt: version }),
      () => admin.offer('token', { key: 'trial_extension_14', enabled: true, monthlyCap: 51, expectedChangedAt: version }),
      () => admin.offer('token', { key: 'Trial', enabled: true, monthlyCap: 4, expectedChangedAt: version }),
      () => admin.offer('token', { key: 'trial_extension_14', enabled: true, monthlyCap: 4 }),
      () => admin.addOffer('token', { label: 'ab', kind: 'coupon', couponId: 'X', apps: ['carebase'], windowDays: 7, monthlyCap: 5 }),
      () => admin.addOffer('token', { label: 'Coupon', kind: 'coupon', apps: ['carebase'], windowDays: 7, monthlyCap: 5 }),
      () => admin.addOffer('token', { label: 'Coupon', kind: 'coupon', couponId: 'X', trialDays: 3, apps: ['carebase'], windowDays: 7, monthlyCap: 5 }),
      () => admin.addOffer('token', { label: 'Days', kind: 'trial_extension', trialDays: 31, apps: ['carebase'], windowDays: 7, monthlyCap: 5 }),
      () => admin.addOffer('token', { label: 'Days', kind: 'trial_extension', trialDays: 7, apps: [], windowDays: 7, monthlyCap: 5 }),
      () => admin.addOffer('token', { label: 'Days', kind: 'trial_extension', trialDays: 7, apps: ['Care Base'], windowDays: 7, monthlyCap: 5 }),
      () => admin.addOffer('token', { label: 'Days', kind: 'discount', trialDays: 7, apps: ['carebase'], windowDays: 7, monthlyCap: 5 }),
      () => admin.marketing('token', { product: 'breathe', marketed: true, expectedChangedAt: version }),
      () => admin.marketing('token', { product: 'carebase', marketed: 'on', expectedChangedAt: version }),
      () => admin.marketing('token', { product: 'carebase', marketed: true }),
      () => admin.marketing('token', { product: 'carebase', marketed: true, expectedChangedAt: version, all: true }),
    ];
    for (const attempt of bad) await expect(attempt()).rejects.toMatchObject({ status: 400 });
    expect(session).not.toHaveBeenCalled();
  });

  it('turns the database\'s reviewed errors into the right status and keeps its message', async () => {
    for (const [code, status] of [['40001', 409], ['P0002', 404], ['22023', 400], ['55000', 409], ['28000', 401], ['42501', 403]]) {
      const { admin } = fixture({ results: { 'hub.set_agent_status': databaseError(code, 'Reviewed message.') } });
      await expect(admin.status('token', { key: 'platform_engineer', status: 'active', expectedUpdatedAt: version })).rejects.toMatchObject({ status, message: 'Reviewed message.' });
    }
    // A day that is not on the calendar passes the shape check and is refused by the database: a bad request, not a server error.
    for (const code of ['22007', '22008']) {
      const bad = fixture({ results: { 'hub.set_agent_status': databaseError(code, 'date/time field value out of range: "2026-02-30T12:00:00Z"') } });
      await expect(bad.admin.status('token', { key: 'platform_engineer', status: 'active', expectedUpdatedAt: '2026-02-30T12:00:00Z' })).rejects.toMatchObject({ status: 400, message: 'Invalid date or time.' });
    }
    const { admin } = fixture({ results: { 'hub.set_agent_status': databaseError('XX000', 'internal detail') } });
    await expect(admin.status('token', { key: 'platform_engineer', status: 'active', expectedUpdatedAt: version })).rejects.not.toBeInstanceOf(HttpError);
  });

  it('carries out an approval straight away, once', async () => {
    const { admin, actions } = fixture({ results: { 'hub.decide_agent_action': { id: actionId, kind: 'communication.reply', status: 'approved', decided: true } } });
    expect(await admin.decide('token', { actionId, decision: 'approve', note: 'Looks right' })).toEqual({ id: actionId, kind: 'communication.reply', status: 'executed', decided: true });
    expect(actions.executeOne).toHaveBeenCalledWith(actionId, { kind: 'communication.reply', sessionToken: 'token' });
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
    expect(await failed.admin.decide('token', { actionId, decision: 'approve' })).toEqual({ id: actionId, kind: 'communication.reply', status: 'failed', decided: true });
    const why = fixture({ results: { 'hub.decide_agent_action': approved }, execution: { executed: false, failed: true, error: 'thread_changed' } });
    expect(await why.admin.decide('token', { actionId, decision: 'approve' })).toEqual({ id: actionId, kind: 'communication.reply', status: 'failed', decided: true, error: 'thread_changed' });
    const crashed = fixture({ results: { 'hub.decide_agent_action': approved } });
    crashed.actions.executeOne.mockRejectedValue(new Error('db down'));
    // Approved is all that can be said: the work may have been done and only its record lost, so nothing claims it was not sent.
    expect(await crashed.admin.decide('token', { actionId, decision: 'approve' })).toEqual({ id: actionId, kind: 'communication.reply', status: 'approved', decided: true });
  });

  it('says an approval is waiting for the owner\'s session only when the executor confirmed it was not started', async () => {
    const approved = { id: actionId, kind: 'communication.reply', status: 'approved', decided: true };
    const handedBack = fixture({ results: { 'hub.decide_agent_action': approved }, execution: { executed: false, failed: false, skipped: true, needsSession: true } });
    expect(await handedBack.admin.decide('token', { actionId, decision: 'approve' })).toEqual({ id: actionId, kind: 'communication.reply', status: 'approved', decided: true, needsSession: true });
    // Someone else already started it, or the database would not start it: skipped, but not for want of a session.
    const taken = fixture({ results: { 'hub.decide_agent_action': approved }, execution: { executed: false, failed: false, skipped: true } });
    expect(await taken.admin.decide('token', { actionId, decision: 'approve' })).toEqual({ id: actionId, kind: 'communication.reply', status: 'approved', decided: true });
  });

  it('starts a task it queued without waiting for the next tick', async () => {
    const { admin, kick, waiting } = fixture({ results: { 'hub.request_agent_task': { id: actionId, status: 'queued' } } });
    expect(await admin.run('token', { agentKey: 'platform_engineer', taskKind: 'probe.sweep' })).toEqual({ id: actionId, status: 'queued' });
    await new Promise(resolve => setImmediate(resolve));
    expect(kick).toHaveBeenCalledTimes(1);
    expect(waiting).not.toHaveBeenCalled();
  });

  it('counts the approved replies that are waiting for a session, and never lets that count break the overview', async () => {
    const waitingReplies = fixture({ results: { 'hub.get_agent_team': { agents: [] } }, ready: [{ id: 'a1', kind: 'communication.reply' }, { id: 'a2', kind: 'communication.reply' }] });
    expect((await waitingReplies.admin.overview('token', {})).waitingActions).toBe(2);
    const broken = fixture({ results: { 'hub.get_agent_team': { agents: [] } } });
    broken.actions.sessionActions.mockRejectedValue(new Error('db down'));
    expect((await broken.admin.overview('token', {})).waitingActions).toBe(0);
    const bare = agentAdmin({ session: fixture({ results: { 'hub.get_agent_team': { agents: [] } } }).session, actions: {} });
    expect((await bare.overview('token', {})).waitingActions).toBe(0);
  });

  describe('work that waits for the owner\'s session', () => {
    it('returns autonomy steps and counts approved or stale external emails without changing either during overview', async () => {
      const externalReady = vi.fn(async () => [{ id: actionId, kind: 'email.external' }]);
      const steps = [{ category: 'account_emails', status: 'supervised' }];
      const { admin, queries, actions } = fixture({ externalReady, ready: [{ id: 'reply1', kind: 'communication.reply' }], results: { 'hub.get_agent_autonomy': steps } });
      expect(await admin.overview('token', {})).toMatchObject({ waitingActions: 2, autonomy: steps });
      // Read-only: the team, the autonomy steps, the offer menu and the marketing switches, nothing else.
      expect(queries).toEqual([['select hub.get_agent_team() as result', []], ['select hub.get_agent_autonomy() as result', []], ['select hub.get_agent_offers() as result', []],
        ['select hub.get_marketing_products() as result', []]]);
      expect(externalReady).toHaveBeenCalledExactlyOnceWith(false);
      expect(actions.executeOne).not.toHaveBeenCalled();
      expect(actions.executeSessionActions).not.toHaveBeenCalled();
    });

    it('recovers only explicitly approved external messages with the scheduler off, after command authorization', async () => {
      const externalReady = vi.fn(async () => [{ id: actionId, kind: 'email.external' }]);
      const waiting = vi.fn(async () => ({ skipped: true, started: 0, done: Promise.resolve([]) }));
      const { admin, queries, session, actions, kick } = fixture({ externalReady, waiting });
      expect(await admin.waiting('token', {})).toEqual({ started: 0, actions: 1 });
      expect(queries).toEqual([['select hub.authorize_app_command() as result', []]]);
      expect(externalReady).toHaveBeenCalledExactlyOnceWith(true);
      expect(session.mock.invocationCallOrder[0]).toBeLessThan(externalReady.mock.invocationCallOrder[0]);
      expect(actions.executeOne).toHaveBeenCalledExactlyOnceWith(actionId, { kind: 'email.external' });
      expect(actions.executeSessionActions).not.toHaveBeenCalled();
      expect(kick).not.toHaveBeenCalled();
    });

    it('keeps recovery asynchronous and counts it alongside the existing approved replies', async () => {
      let finish;
      const pending = new Promise(resolve => { finish = resolve; });
      const externalReady = vi.fn(async () => [{ id: actionId, kind: 'email.external' }]);
      const ready = [{ id: 'reply1', kind: 'communication.reply' }];
      const { admin, actions } = fixture({ externalReady, ready });
      actions.executeOne.mockReturnValue(pending);
      expect(await admin.waiting('token', {})).toEqual({ started: 2, actions: 2 });
      expect(actions.executeSessionActions).toHaveBeenCalledWith(ready, { sessionToken: 'token' });
      expect(actions.executeOne).toHaveBeenCalledWith(actionId, { kind: 'email.external' });
      finish({ executed: true, failed: false });
    });

    it('does not recover or execute any message when command authorization fails', async () => {
      for (const [token, error, status] of [[null, null, 401], ['token', databaseError('28000', 'Current command required.'), 401], ['token', databaseError('42501', 'Not an administrator.'), 403]]) {
        const externalReady = vi.fn(async () => [{ id: actionId, kind: 'email.external' }]);
        const { admin, actions, waiting } = fixture({ externalReady, results: error ? { 'hub.authorize_app_command': error } : {} });
        await expect(admin.waiting(token, {})).rejects.toMatchObject({ status });
        expect(externalReady).not.toHaveBeenCalled();
        expect(actions.executeOne).not.toHaveBeenCalled();
        expect(actions.executeSessionActions).not.toHaveBeenCalled();
        expect(waiting).not.toHaveBeenCalled();
      }
    });

    it('fails conservatively on a recovery lookup failure before launching any replies or tasks', async () => {
      const externalReady = vi.fn(async () => { throw new Error('database unavailable'); });
      const { admin, actions, waiting } = fixture({ externalReady, ready: [{ id: 'reply1', kind: 'communication.reply' }] });
      await expect(admin.waiting('token', {})).rejects.toMatchObject({ status: 503, message: expect.stringContaining('Do not resend') });
      expect(actions.executeOne).not.toHaveBeenCalled();
      expect(actions.executeSessionActions).not.toHaveBeenCalled();
      expect(waiting).not.toHaveBeenCalled();
      await expect(admin.overview('token', {})).rejects.toMatchObject({ status: 503 });
    });

    it('never broadens the manual drain to another action kind or malformed candidate', async () => {
      for (const list of [null, {}, [{ id: actionId, kind: 'incident.open' }], [{ id: 'invalid', kind: 'email.external' }]]) {
        const { admin, actions, waiting } = fixture({ externalReady: vi.fn(async () => list) });
        await expect(admin.waiting('token', {})).rejects.toMatchObject({ status: 503 });
        expect(actions.executeOne).not.toHaveBeenCalled();
        expect(actions.executeSessionActions).not.toHaveBeenCalled();
        expect(waiting).not.toHaveBeenCalled();
      }
    });

    it('leaves a lost action-start response to durable recovery and continues other approved emails', async () => {
      const next = '22222222-2222-4222-8222-222222222222';
      const externalReady = vi.fn(async () => [{ id: actionId, kind: 'email.external' }, { id: next, kind: 'email.external' }]);
      const { admin, actions } = fixture({ externalReady });
      actions.executeOne.mockRejectedValueOnce(new Error('response lost before execution outcome known'));
      expect(await admin.waiting('token', {})).toEqual({ started: 2, actions: 2 });
      await new Promise(resolve => setImmediate(resolve));
      expect(actions.executeOne.mock.calls).toEqual([[actionId, { kind: 'email.external' }], [next, { kind: 'email.external' }]]);
    });

    it('runs a task that reads another application the moment the owner asks for it', async () => {
      const { admin, kick, waiting } = fixture({ results: { 'hub.request_agent_task': { id: actionId, status: 'awaiting_session' } } });
      expect(await admin.run('token', { agentKey: 'support_concierge', taskKind: 'import.advisors' })).toEqual({ id: actionId, status: 'running' });
      expect(waiting).toHaveBeenCalledWith({ sessionToken: 'token', only: [actionId] });
      await new Promise(resolve => setImmediate(resolve));
      expect(kick).not.toHaveBeenCalled();
    });

    it('still reports the queued task when nothing could be started or the scheduler is off', async () => {
      const requested = { 'hub.request_agent_task': { id: actionId, status: 'awaiting_session' } };
      const idle = fixture({ results: requested, waiting: vi.fn(async () => ({ skipped: false, started: 0, done: Promise.resolve([]) })) });
      expect(await idle.admin.run('token', { agentKey: 'support_concierge', taskKind: 'import.advisors' })).toEqual({ id: actionId, status: 'awaiting_session' });
      const off = fixture({ results: requested, waiting: vi.fn(async () => ({ skipped: true, started: 0, done: Promise.resolve([]) })) });
      expect(await off.admin.run('token', { agentKey: 'support_concierge', taskKind: 'import.advisors' })).toEqual({ id: actionId, status: 'awaiting_session' });
      const broken = fixture({ results: requested, waiting: vi.fn(async () => { throw new Error('db down'); }) });
      expect(await broken.admin.run('token', { agentKey: 'support_concierge', taskKind: 'import.advisors' })).toEqual({ id: actionId, status: 'awaiting_session' });
    });

    it('sends the replies the owner approved but that never went out, with their session, in the background', async () => {
      let finish;
      const sending = new Promise(resolve => { finish = resolve; });
      const ready = [{ id: 'a1', kind: 'communication.reply' }, { id: 'a2', kind: 'communication.reply' }];
      const { admin, actions, waiting } = fixture({ ready });
      actions.executeSessionActions.mockReturnValue(sending);
      expect(await admin.waiting('token', {})).toEqual({ started: 2, actions: 2 });
      expect(actions.executeSessionActions).toHaveBeenCalledWith(ready, { sessionToken: 'token' });
      expect(waiting).toHaveBeenCalledTimes(1);
      finish({ executed: 2, failed: 0 });
    });

    it('still sends approved replies when the scheduler is off, and refuses only when there is nothing to send', async () => {
      const off = () => vi.fn(async () => ({ skipped: true, started: 0, done: Promise.resolve([]) }));
      const sends = fixture({ waiting: off(), ready: [{ id: 'a1', kind: 'communication.reply' }] });
      expect(await sends.admin.waiting('token', {})).toEqual({ started: 0, actions: 1 });
      expect(sends.actions.executeSessionActions).toHaveBeenCalledTimes(1);
      await expect(fixture({ waiting: off() }).admin.waiting('token', {})).rejects.toMatchObject({ status: 409 });
    });

    it('starts what is waiting, after the database confirms the owner\'s current session, and answers at once', async () => {
      let finish;
      const done = new Promise(resolve => { finish = resolve; });
      const { admin, queries, waiting } = fixture({ waiting: vi.fn(async () => ({ skipped: false, started: 2, done })) });
      expect(await admin.waiting('token', {})).toEqual({ started: 2, actions: 0 });
      expect(queries.map(([sql]) => sql)).toEqual(['select hub.authorize_app_command() as result']);
      expect(waiting).toHaveBeenCalledWith({ sessionToken: 'token', only: null });
      finish([]);
    });

    it('claims nothing for a lapsed session or a caller who is not signed in', async () => {
      const lapsed = fixture({ results: { 'hub.authorize_app_command': databaseError('28000', 'Current administrator session required.') } });
      await expect(lapsed.admin.waiting('token', {})).rejects.toMatchObject({ status: 401, message: 'Current administrator session required.' });
      const denied = fixture({ results: { 'hub.authorize_app_command': databaseError('42501', 'Administrator access is required.') } });
      await expect(denied.admin.waiting('token', {})).rejects.toMatchObject({ status: 403 });
      const anonymous = fixture();
      await expect(anonymous.admin.waiting(undefined, {})).rejects.toMatchObject({ status: 401 });
      for (const { waiting } of [lapsed, denied, anonymous]) expect(waiting).not.toHaveBeenCalled();
    });

    it('says so when the AI team is not running on this server', async () => {
      const off = fixture({ waiting: vi.fn(async () => ({ skipped: true, started: 0, done: Promise.resolve([]) })) });
      await expect(off.admin.waiting('token', {})).rejects.toMatchObject({ status: 409 });
      const none = agentAdmin({ session: fixture().session, actions: {} });
      await expect(none.waiting('token', {})).rejects.toMatchObject({ status: 409 });
    });

    it('takes no input', async () => {
      const { admin, session } = fixture();
      await expect(admin.waiting('token', { all: true })).rejects.toMatchObject({ status: 400 });
      expect(session).not.toHaveBeenCalled();
    });
  });
});
