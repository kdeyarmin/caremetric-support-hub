import { describe, expect, it, vi } from 'vitest';
import { lifecycleInput, lifecyclePreview, lifecycleSaveFeature, parseLifecycleInput, wordingHash } from '../accounts/lifecycle.mjs';
import { lifecycleFeature, lifecycleHandlers, pageLimit, pageSize } from './lifecycle.mjs';

const now = new Date('2026-11-03T13:20:00Z');
const day = 86_400_000;
const ago = days => new Date(now.getTime() - days * day).toISOString();
const ahead = days => new Date(now.getTime() + days * day).toISOString();
const emails = (over = {}) => ({ welcome: null, setup_nudge: null, trial_checkin: null, testimonial_ask: null, ...over });
const fact = (tenant, over = {}) => ({
  tenant, tenantName: `Canary ${tenant} Home`, product: 'carebase', productName: 'CareMetric CareBase', status: 'trialing', trialStart: ago(1), trialEnd: ahead(29),
  created: ago(1), firstPaidAt: null, cancelling: false, hasEmail: true, suppressed: false, hasUsage: false, openUrgentCases: 0, emails: emails(), ...over,
});
const postal = 'CareMetric, 100 Example Street, Altoona, PA 16601';
const ready = { mail: { configured: true, send: vi.fn() }, postalAddress: postal, publicOrigin: 'https://hub.example.test' };
const task = (over = {}) => ({ id: 't1', agentKey: 'account_manager', kind: 'accounts.lifecycle', sourceKind: 'schedule', attempts: 1, agent: { autonomy: 'propose', config: {} }, ...over });

const fixture = ({ accounts = [fact('alpha')], lifecycle = ready, features = new Set([lifecycleFeature]), propose = null, snapshot = {} } = {}) => {
  const logs = [];
  const store = {
    // Pages of the facts as the database gives them: newest first, `limit` rows from `offset`, saying whether more follow.
    lifecycleSnapshot: vi.fn(async ({ limit = 200, offset = 0 } = {}) => ({
      generatedAt: now.toISOString(), mode: 'live', total: accounts.length, truncated: accounts.length > offset + limit, accounts: accounts.slice(offset, offset + limit), ...snapshot,
    })),
    proposeAction: vi.fn(propose ?? (async ({ targetId }) => ({ id: `a-${targetId}`, status: 'proposed', requestKey: '44444444-4444-4444-8444-444444444444', created: true }))),
    startRun: vi.fn(async () => 'run-1'),
    finishRun: vi.fn(async () => undefined),
  };
  const handlers = lifecycleHandlers({ store, features, lifecycle, log: line => logs.push(line) });
  return { store, logs, handlers, run: (over = {}, context = {}) => handlers['accounts.lifecycle'](task(over), { now: () => now, ...context }) };
};
const summary = store => store.finishRun.mock.calls.at(-1)[3];

describe('the cancellation and win-back emails', () => {
  const accounts = [fact('leaving', { cancelling: true }), fact('ended', { status: 'canceled', trialStart: ago(35), trialEnd: ago(5) }), fact('alpha')];
  it('are proposed only with their database feature and the owner\'s switch on', async () => {
    for (const [features, saveEmails] of [[new Set([lifecycleFeature]), true], [new Set([lifecycleFeature, lifecycleSaveFeature]), false],
      [new Set([lifecycleFeature, lifecycleSaveFeature]), () => false]]) {
      const { run, store } = fixture({ accounts, features, lifecycle: { ...ready, saveEmails } });
      const outcome = await run();
      expect(store.proposeAction.mock.calls.map(call => call[0].targetId)).toEqual(['alpha']);
      expect(Object.keys(outcome.result.byTemplate)).toEqual(['welcome', 'setup_nudge', 'trial_checkin', 'testimonial_ask']);
    }
    const { run, store } = fixture({ accounts, features: new Set([lifecycleFeature, lifecycleSaveFeature]), lifecycle: { ...ready, saveEmails: () => true } });
    const outcome = await run();
    expect(store.proposeAction.mock.calls.map(call => `${call[0].targetId}:${call[0].input.template}`).sort()).toEqual(['alpha:welcome', 'ended:trial_ended', 'leaving:cancel_save']);
    expect(outcome.result.byTemplate).toEqual({ welcome: 1, setup_nudge: 0, trial_checkin: 0, testimonial_ask: 0, cancel_save: 1, trial_ended: 1 });
    expect(summary(store)).toContain('1 cancellation check-in, 1 ended-trial check-in');
  });
});

describe('the customer email run', () => {
  it('is registered only when the database declares the feature', () => {
    for (const features of [undefined, null, new Set(), new Set(['platform.agents.accounts.v1']), ['platform.agents.v1'], lifecycleFeature]) {
      expect(Object.keys(lifecycleHandlers({ store: {}, features })), String(features)).toEqual([]);
    }
    for (const features of [new Set([lifecycleFeature]), [lifecycleFeature]]) expect(Object.keys(fixture({ features }).handlers)).toEqual(['accounts.lifecycle']);
  });

  it('proposes each due email with its exact text as the preview and the facts that rebuild it, never an address', async () => {
    const { run, store } = fixture({ accounts: [fact('alpha'), fact('beta', { trialStart: ago(25), trialEnd: ahead(4) })] });
    const outcome = await run();
    expect(store.lifecycleSnapshot.mock.calls).toEqual([[{ limit: 200, offset: 0 }]]);
    expect(store.proposeAction).toHaveBeenCalledTimes(2);
    const [first, second] = store.proposeAction.mock.calls.map(call => call[0]);
    const expected = lifecycleInput(fact('alpha'), 'welcome');
    expect(first).toEqual({ taskId: 't1', kind: 'email.send', targetKind: 'billing_account', targetId: 'alpha', input: expected, preview: lifecyclePreview(expected, { postalAddress: postal }) });
    expect(first.preview.startsWith('Subject: Welcome to CareMetric CareBase\n\nWelcome to CareMetric CareBase\n\nHello,')).toBe(true);
    expect(parseLifecycleInput(first.input)).toEqual(first.input);
    expect(first.input.textHash).toBe(wordingHash(first.input));
    expect([second.targetId, second.input.template, second.input.periodKey]).toEqual(['beta', 'trial_checkin', 'account:trial_checkin:beta:carebase']);
    // No address of the customer's: the only ones are CareMetric's own, in the theme's footer.
    expect(JSON.stringify(store.proposeAction.mock.calls).replace(/\bsupport@caremetric\.ai\b/g, '')).not.toContain('@');
    expect(outcome).toEqual({ result: {
      mode: 'live', read: 2, due: 2, deferred: 0, noAddress: 0, suppressed: 0, truncated: false, outcome: 'proposed', proposed: 2, autoApproved: 0, alreadyProposed: 0,
      byTemplate: { welcome: 1, setup_nudge: 0, trial_checkin: 1, testimonial_ask: 0 },
    } });
    expect(outcome.status).toBeUndefined();
    expect(store.startRun).toHaveBeenCalledWith('t1', 'none', 'lifecycle.1');
    expect(store.finishRun).toHaveBeenCalledWith('run-1', 'completed', {}, 'Proposed 2 customer emails (1 welcome, 1 trial check-in) for your approval.', null);
  });

  it('finishes once it has proposed, so its proposals never hold back the next morning\'s run', async () => {
    const outcome = await fixture().run();
    expect(outcome.status).toBeUndefined();
    expect(outcome.result.proposed).toBe(1);
  });

  it('proposes nothing in Observe and records what it would have proposed, as counts', async () => {
    const { run, store } = fixture({ accounts: [fact('alpha'), fact('beta')] });
    const outcome = await run({ agent: { autonomy: 'observe', config: { auto_send_templates: ['welcome'] } } });
    expect(store.proposeAction).not.toHaveBeenCalled();
    expect(outcome.result).toMatchObject({ outcome: 'observe_only', proposed: 0, due: 2, byTemplate: { welcome: 2, setup_nudge: 0, trial_checkin: 0, testimonial_ask: 0 } });
    expect(summary(store)).toBe('Observe only: 2 customer emails would be proposed (2 welcome). Nothing was proposed.');
  });

  it('proposes at most 20 in a run and one per account; the rest wait for the next run', async () => {
    const accounts = Array.from({ length: 25 }, (_, index) => fact(`home-${String(index).padStart(2, '0')}`));
    accounts.push(fact('home-00', { product: 'caremetric-intel', productName: 'CareMetric Intel' }));
    const { run, store } = fixture({ accounts });
    const outcome = await run();
    expect(store.proposeAction).toHaveBeenCalledTimes(20);
    expect(new Set(store.proposeAction.mock.calls.map(call => call[0].targetId)).size).toBe(20);
    expect(outcome.result).toMatchObject({ due: 25, proposed: 20, deferred: 6 });
    expect(summary(store)).toBe('Proposed 20 customer emails (20 welcome) for your approval. 6 more wait for the next run.');
  });

  it('reads every page before it plans, so 200 newer trials never hide an older account whose email is due', async () => {
    // 250 accounts, newest first: 240 trials on their tenth day (nothing due), then an account paying for 50 days, then older trials.
    const accounts = [
      ...Array.from({ length: 240 }, (_, index) => fact(`trial-${String(index).padStart(3, '0')}`, { trialStart: ago(10), trialEnd: ahead(20) })),
      fact('paying', { status: 'active', trialStart: ago(80), trialEnd: ago(50), created: ago(80), firstPaidAt: ago(50) }),
      ...Array.from({ length: 9 }, (_, index) => fact(`older-${index}`, { trialStart: ago(12), trialEnd: ahead(18) })),
    ];
    const { run, store } = fixture({ accounts });
    const outcome = await run();
    expect(store.lifecycleSnapshot.mock.calls.map(call => call[0])).toEqual([{ limit: pageSize, offset: 0 }, { limit: pageSize, offset: pageSize }]);
    expect(store.proposeAction.mock.calls.map(call => [call[0].targetId, call[0].input.template])).toEqual([['paying', 'testimonial_ask']]);
    expect(outcome.result).toMatchObject({ read: 250, due: 1, proposed: 1, truncated: false });
  });

  it('keeps the 20-proposal cap across pages, and stops after ten pages, saying the rest were not read', async () => {
    const due = Array.from({ length: 30 }, (_, index) => fact(`due-${String(index).padStart(2, '0')}`));
    const spread = [...Array.from({ length: 150 }, (_, index) => fact(`quiet-${index}`, { trialStart: ago(10) })), ...due];
    const capped = fixture({ accounts: spread });
    expect((await capped.run()).result).toMatchObject({ read: 180, due: 30, proposed: 20, deferred: 10 });
    expect(capped.store.proposeAction).toHaveBeenCalledTimes(20);

    const endless = Array.from({ length: pageSize * pageLimit + 5 }, (_, index) => fact(`row-${String(index).padStart(4, '0')}`, { trialStart: ago(10) }));
    const bounded = fixture({ accounts: endless });
    const outcome = await bounded.run();
    expect(bounded.store.lifecycleSnapshot).toHaveBeenCalledTimes(pageLimit);
    expect(outcome.result).toMatchObject({ read: pageSize * pageLimit, truncated: true, outcome: 'nothing_due' });
    expect(summary(bounded.store)).toBe(`No customer email is due. Read the newest ${pageSize * pageLimit} of ${pageSize * pageLimit + 5} trials and new paying accounts; the rest were not considered.`);
  });

  it('reads an account that moves to the next page while the run reads only once', async () => {
    const accounts = Array.from({ length: pageSize + 1 }, (_, index) => fact(`home-${String(index).padStart(3, '0')}`, { trialStart: ago(10) }));
    accounts[pageSize] = fact('home-due');
    const { run, store } = fixture({ accounts });
    // A newer subscription arrives after the first page is read: the second page starts with the first page's last row again.
    store.lifecycleSnapshot.mockImplementationOnce(async () => ({ mode: 'live', total: pageSize + 1, truncated: true, accounts: accounts.slice(0, pageSize) }));
    store.lifecycleSnapshot.mockImplementationOnce(async () => ({ mode: 'live', total: pageSize + 2, truncated: false, accounts: [accounts[pageSize - 1], accounts[pageSize]] }));
    const outcome = await run();
    expect(outcome.result).toMatchObject({ read: pageSize + 1, proposed: 1 });
  });

  it('stops reading once the scheduler has stopped waiting for it', async () => {
    const controller = new AbortController();
    controller.abort();
    const { run, store } = fixture();
    await expect(run({}, { signal: controller.signal })).rejects.toMatchObject({ code: 'task_timeout', transient: true });
    expect(store.lifecycleSnapshot).not.toHaveBeenCalled();
  });

  it('never proposes to an account with no usable address or one that unsubscribed, and says so', async () => {
    const { run, store } = fixture({ accounts: [fact('alpha', { hasEmail: false }), fact('beta', { suppressed: true }), fact('gamma')] });
    const outcome = await run();
    expect(store.proposeAction.mock.calls.map(call => call[0].targetId)).toEqual(['gamma']);
    expect(outcome.result).toMatchObject({ noAddress: 1, suppressed: 1, proposed: 1 });
    expect(summary(store)).toBe('Proposed 1 customer email (1 welcome) for your approval. Skipped 1 account with no billing email. Skipped 1 account that unsubscribed.');
  });

  it('counts the emails the database approved on its own, which it does only for the templates listed in auto_send_templates', async () => {
    // The database decides (private.agent_action_propose); the run reports what it recorded, never what it hoped for.
    const listed = ['welcome'];
    const propose = async ({ input }) => ({ id: `a-${input.tenant}`, status: listed.includes(input.template) ? 'auto_approved' : 'proposed', created: true });
    const accounts = [fact('alpha'), fact('beta', { trialStart: ago(25), trialEnd: ahead(4) }), fact('gamma', { trialStart: ago(4) })];
    const { run, store } = fixture({ accounts, propose });
    const outcome = await run({ agent: { autonomy: 'act', config: { auto_send_templates: listed, auto_approve_kinds: ['email.send'] } } });
    expect(outcome.result).toMatchObject({ proposed: 3, autoApproved: 1, byTemplate: { welcome: 1, setup_nudge: 1, trial_checkin: 1, testimonial_ask: 0 } });
    expect(summary(store)).toBe('Proposed 3 customer emails (1 welcome, 1 setup help, 1 trial check-in); 1 approved on its own, by the templates you listed.');
  });

  it('treats a period another run already proposed as proposed, and stops if the agent is switched to Observe mid-run', async () => {
    const taken = Object.assign(new Error('duplicate key'), { code: '23505' });
    const propose = vi.fn(async ({ targetId }) => {
      if (targetId === 'alpha') throw taken;
      if (targetId === 'beta') return { id: 'a-beta', status: 'proposed', created: false };
      if (targetId === 'delta') throw Object.assign(new Error('observe'), { code: '42501' });
      return { id: `a-${targetId}`, status: 'proposed', created: true };
    });
    const { run, store } = fixture({ accounts: ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map(tenant => fact(tenant)), propose });
    const outcome = await run();
    expect(propose).toHaveBeenCalledTimes(4);
    expect(outcome.result).toMatchObject({ proposed: 1, alreadyProposed: 2 });
    expect(store.finishRun).toHaveBeenCalledWith('run-1', 'completed', {}, expect.stringMatching(/^Proposed 1 customer email \(1 welcome\)/), null);
  });

  it('lets any other failure reach the scheduler, which retries the task (the periods already proposed are not proposed again)', async () => {
    const broken = fixture({ propose: async () => { throw Object.assign(new Error('database'), { code: '57014' }); } });
    await expect(broken.run()).rejects.toMatchObject({ code: '57014' });
    const unreadable = fixture();
    unreadable.store.lifecycleSnapshot.mockRejectedValue(Object.assign(new Error('database'), { code: '08006' }));
    await expect(unreadable.run()).rejects.toMatchObject({ code: '08006' });
  });

  it('proposes nothing while the Hub cannot send customer email, and says what is missing', async () => {
    for (const [lifecycle, missing, words] of [
      [{ ...ready, postalAddress: '' }, ['postal_address'], 'no postal address (Settings → Email)'],
      [{ ...ready, mail: { configured: false, send: vi.fn() } }, ['mail'], 'no SendGrid sender'],
      [{ ...ready, publicOrigin: 'http://hub.example.test' }, ['public_origin'], 'no bare https public origin (HUB_PUBLIC_ORIGIN)'],
      [{ ...ready, publicOrigin: 'https://hub.example.test#mail' }, ['public_origin'], 'no bare https public origin (HUB_PUBLIC_ORIGIN)'],
      [{}, ['mail', 'postal_address', 'public_origin'], 'no SendGrid sender, no postal address (Settings → Email), no bare https public origin (HUB_PUBLIC_ORIGIN)'],
    ]) {
      const { run, store } = fixture({ lifecycle });
      const outcome = await run();
      expect(store.proposeAction).not.toHaveBeenCalled();
      expect(outcome.result).toMatchObject({ outcome: 'not_configured', proposed: 0, due: 1, missing });
      expect(store.finishRun).toHaveBeenCalledWith('run-1', 'failed', {}, `1 customer email due, but customer email is not set up (${words}), so none was proposed.`, 'not_configured');
    }
  });

  it('says so when nothing is due, and records its pulse', async () => {
    const { run, store } = fixture({ accounts: [fact('alpha', { trialStart: ago(10) }), fact('beta', { emails: emails({ welcome: 'executed' }) })] });
    expect((await run()).result).toMatchObject({ outcome: 'nothing_due', proposed: 0, due: 0 });
    expect(store.proposeAction).not.toHaveBeenCalled();
    expect(summary(store)).toBe('No customer email is due.');
  });

  it('stops proposing once the scheduler has stopped waiting for it', async () => {
    const controller = new AbortController();
    const propose = vi.fn(async () => { controller.abort(); return { id: 'a', status: 'proposed', created: true }; });
    const { run } = fixture({ accounts: [fact('alpha'), fact('beta')], propose });
    await expect(run({}, { signal: controller.signal })).rejects.toMatchObject({ code: 'task_timeout', transient: true });
    expect(propose).toHaveBeenCalledTimes(1);
  });

  it('keeps names and slugs out of the result, the run summary and the log', async () => {
    const { run, store, logs } = fixture({ accounts: [fact('alpha'), fact('beta', { hasEmail: false })] });
    store.startRun.mockRejectedValueOnce(new Error('database'));
    const outcome = await run();
    const kept = JSON.stringify([outcome, store.startRun.mock.calls, store.finishRun.mock.calls, logs]);
    for (const secret of ['Canary', 'alpha', 'beta', '@']) expect(kept, secret).not.toContain(secret);
    expect(logs).toEqual([JSON.stringify({ event: 'hub_agent_run_unrecorded', agent: 'account_manager', kind: 'accounts.lifecycle' })]);
  });
});
