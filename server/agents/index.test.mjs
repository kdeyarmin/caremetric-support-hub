import { describe, expect, it, vi } from 'vitest';
import { agentTeam } from './index.mjs';

const store = (tasks = []) => ({
  maintenance: vi.fn(async () => ({})), fireSchedules: vi.fn(async () => []), claim: vi.fn(async () => tasks),
  heartbeat: vi.fn(async () => true), finish: vi.fn(async (id, status) => status), readyActions: vi.fn(async () => []),
});
const origin = 'https://support-hub-web-production.up.railway.app';

describe('the AI team', () => {
  it('ships the on-call agent\'s handlers without being asked', () => {
    const team = agentTeam({ store: store(), publicOrigin: origin, enabled: true });
    expect(team.scheduler.kinds()).toEqual(['brief.daily', 'probe.incident', 'probe.recovery', 'probe.sweep', 'seo.weekly']);
  });

  it('adds the caller\'s handlers beside them, and lets the caller replace one', async () => {
    const custom = vi.fn(async () => ({ result: { custom: true } }));
    const fake = store([{ id: 't1', agentKey: 'platform_engineer', kind: 'probe.sweep', attempts: 1, payload: {} }]);
    const team = agentTeam({ store: fake, publicOrigin: origin, enabled: true, handlers: { 'probe.sweep': custom, 'brief.daily': async () => ({}) } });
    expect(team.scheduler.kinds()).toEqual(['brief.daily', 'probe.incident', 'probe.recovery', 'probe.sweep', 'seo.weekly']);
    await team.tick();
    expect(custom).toHaveBeenCalledTimes(1);
    expect(fake.finish).toHaveBeenCalledWith('t1', 'done', { result: { custom: true }, errorCode: null, retryAt: null });
  });

  it('can copy other applications\' messages only when the inbox service is given', async () => {
    const without = agentTeam({ store: store(), publicOrigin: origin, enabled: true });
    expect(without.scheduler.kinds()).not.toContain('import.advisors');
    const sync = vi.fn(async () => ({ read: 1, created: 1, skipped: 0, nextOffset: null }));
    const fake = { ...store(), sessionTasks: vi.fn(async () => [{ id: 's1', agentKey: 'support_concierge', kind: 'import.breathe', priority: 5, createdAt: '2026-11-02T12:00:00Z' }]),
      claimSessionTask: vi.fn(async () => ({ id: 's1', agentKey: 'support_concierge', kind: 'import.breathe', attempts: 1, requiresSession: true, payload: {} })) };
    const team = agentTeam({ store: fake, publicOrigin: origin, enabled: true, communications: { sync } });
    expect(team.scheduler.kinds()).toEqual(['brief.daily', 'import.advisors', 'import.breathe', 'probe.incident', 'probe.recovery', 'probe.sweep', 'seo.weekly']);
    const run = await team.runWaiting({ sessionToken: 'T'.repeat(43) });
    await run.done;
    expect(sync).toHaveBeenCalledWith('T'.repeat(43), { source: 'breathe.phone', offset: 0 });
    expect(fake.finish).toHaveBeenCalledWith('s1', 'done', expect.objectContaining({ result: expect.objectContaining({ source: 'breathe.phone', created: 1 }) }));
  });

  it('triages new conversations only when the database declares the Concierge\'s feature', () => {
    for (const features of [undefined, null, new Set(), new Set(['platform.agents.v1']), ['platform.agents.v1'], 'platform.agents.concierge.v1']) {
      expect(agentTeam({ store: store(), publicOrigin: origin, enabled: true, features }).scheduler.kinds(), String(features)).not.toContain('concierge.sweep');
    }
    for (const features of [new Set(['platform.agents.v1', 'platform.agents.concierge.v1']), ['platform.agents.concierge.v1']]) {
      expect(agentTeam({ store: store(), publicOrigin: origin, enabled: true, features }).scheduler.kinds()).toEqual(
        ['brief.daily', 'concierge.communication', 'concierge.sweep', 'probe.incident', 'probe.recovery', 'probe.sweep', 'seo.weekly']);
    }
  });

  it('sends approved replies only when the inbox service and the Concierge\'s feature are both there', async () => {
    const feature = new Set(['platform.agents.concierge.v1']);
    const reply = vi.fn(async () => ({ delivery: 'sent', deliveryChannel: 'email', replay: false }));
    const execution = { id: 'a1', agentKey: 'support_concierge', taskId: 't1', kind: 'communication.reply', requestKey: '44444444-4444-4444-8444-444444444444', autoApproved: false,
      input: { communicationId: '11111111-1111-4111-8111-111111111111', reference: 1, basedOnMessageId: '22222222-2222-4222-8222-222222222222', body: 'Hello' } };
    const fake = () => ({ ...store(), readyActions: vi.fn(async () => [{ id: 'a1', kind: 'communication.reply' }]), beginExecution: vi.fn(async () => execution), completeExecution: vi.fn(async () => undefined),
      communicationSnapshot: vi.fn(async () => ({ status: 'new', headMessageId: '22222222-2222-4222-8222-222222222222' })) });
    const token = 'T'.repeat(43);
    const ready = fake();
    const team = agentTeam({ store: ready, publicOrigin: origin, enabled: true, communications: { reply }, features: feature });
    // The tick leaves the reply alone: it needs the owner's session.
    expect(await team.tick()).toMatchObject({ executedActions: 0 });
    expect(ready.beginExecution).not.toHaveBeenCalled();
    expect(await team.actions.sessionActions()).toEqual([{ id: 'a1', kind: 'communication.reply' }]);
    expect(await team.actions.executeOne('a1', { kind: 'communication.reply', sessionToken: token })).toEqual({ executed: true, failed: false, skipped: false });
    expect(reply).toHaveBeenCalledWith(token, { id: '11111111-1111-4111-8111-111111111111', body: 'Hello', requestKey: '44444444-4444-4444-8444-444444444444' });
    for (const options of [{ communications: { reply } }, { features: feature }, { communications: {}, features: feature }]) {
      const bare = agentTeam({ store: fake(), publicOrigin: origin, enabled: true, ...options });
      expect(await bare.actions.sessionActions()).toEqual([]);
      expect(await bare.actions.executeOne('a1', { kind: 'communication.reply', sessionToken: token })).toMatchObject({ failed: true, error: 'no_executor' });
    }
  });

  it('hands a function of handlers the shared services', () => {
    const seen = [];
    agentTeam({ store: store(), publicOrigin: origin, handlers: services => { seen.push(Object.keys(services).sort()); return {}; } });
    expect(seen).toEqual([['actions', 'model', 'notifier', 'store']]);
  });

  it('shares one model runtime, built from the key it is given, and says whether a key is there', () => {
    const none = agentTeam({ store: store(), publicOrigin: origin });
    expect(none.model.configured).toBe(false);
    expect(typeof none.model.run).toBe('function');
    const keyed = agentTeam({ store: store(), publicOrigin: origin, anthropicApiKey: 'sk-test-key' });
    expect(keyed.model.configured).toBe(true);
    const given = { configured: true, run: vi.fn() };
    const shared = [];
    const injected = agentTeam({ store: store(), publicOrigin: origin, model: given, anthropicApiKey: 'sk-test-key', handlers: services => { shared.push(services.model); return {}; } });
    expect(injected.model).toBe(given);
    expect(shared).toEqual([given]);
  });

  it('registers no work that uses the model, with or without a key', () => {
    const keyed = agentTeam({ store: store(), publicOrigin: origin, enabled: true, anthropicApiKey: 'sk-test-key' });
    expect(keyed.scheduler.kinds()).toEqual(agentTeam({ store: store(), publicOrigin: origin, enabled: true }).scheduler.kinds());
  });

  it('runs nothing unless it is enabled', async () => {
    const fake = store();
    const team = agentTeam({ store: fake, publicOrigin: origin });
    expect(await team.tick()).toMatchObject({ skipped: true });
    expect(fake.claim).not.toHaveBeenCalled();
  });
});
