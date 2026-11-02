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

  it('hands a function of handlers the shared services', () => {
    const seen = [];
    agentTeam({ store: store(), publicOrigin: origin, handlers: services => { seen.push(Object.keys(services).sort()); return {}; } });
    expect(seen).toEqual([['actions', 'notifier', 'store']]);
  });

  it('runs nothing unless it is enabled', async () => {
    const fake = store();
    const team = agentTeam({ store: fake, publicOrigin: origin });
    expect(await team.tick()).toMatchObject({ skipped: true });
    expect(fake.claim).not.toHaveBeenCalled();
  });
});
