import { describe, expect, it, vi } from 'vitest';
import { automationServerOperations, goLiveReadiness } from './go-live-readiness.mjs';

const fullContract = { api_version: 4, features: ['support.ai-assistance.v1', 'support.ai-automation.v1', 'support.ai-automation-server.v1'] };
const appliedEvidence = {
  automation_table: true,
  resolution_function: true,
  queue_ai_stage: true,
  author_role_ai_assistant: true,
  automation_server_operations: true,
};

function harness({
  role = 'platform_admin',
  evidence = appliedEvidence,
  contract = fullContract,
  env = { ANTHROPIC_API_KEY: 'sk-ant-fixture-value', HUB_AI_AUTOMATION_ENABLED: 'true' },
  targets = ['support-hub-web-production.up.railway.app'],
} = {}) {
  const rpc = vi.fn(async (name) => {
    if (name === 'get_support_actor_context') return { role, id: 'admin-1' };
    if (name === 'get_backend_contract') return contract;
    throw new Error(`Unexpected RPC ${name}`);
  });
  const pool = { query: vi.fn(async () => ({ rows: [evidence] })) };
  const lookup = vi.fn(async () => targets);
  const handlers = goLiveReadiness({ pool, rpc, env, lookup, now: () => new Date('2026-10-17T20:00:00.000Z') });
  return { handlers, rpc, pool, lookup };
}

describe('go-live readiness evaluation', () => {
  it('reports every prerequisite complete when the live evidence supports it', async () => {
    const { handlers, lookup } = harness();
    const report = await handlers.handle('token');
    expect(report).toEqual({
      checkedAt: '2026-10-17T20:00:00.000Z',
      migrations: {
        complete: true,
        items: [
          { version: '20261015120000', name: 'AI case assistance', applied: true },
          { version: '20261015120100', name: 'AI case assistance contract', applied: true },
          { version: '20261020120000', name: 'AI automation server boundary', applied: true },
          { version: '20261020120100', name: 'AI automation server contract', applied: true },
        ],
      },
      anthropicKey: { present: true },
      aiAutomation: { enabled: true },
      helpDomain: { hostname: 'help.caremetric.ai', resolves: true, targets: ['support-hub-web-production.up.railway.app'] },
    });
    expect(lookup).toHaveBeenCalledWith('help.caremetric.ai');
    // The key contributes a boolean only; its value appears nowhere in the report.
    expect(JSON.stringify(report)).not.toContain('sk-ant-fixture-value');
  });

  it('reports each migration separately from the database evidence', async () => {
    const { handlers } = harness({ contract: { api_version: 4, features: [] } });
    const report = await handlers.handle('token');
    expect(report.migrations.items).toEqual([
      { version: '20261015120000', name: 'AI case assistance', applied: true },
      { version: '20261015120100', name: 'AI case assistance contract', applied: false },
      { version: '20261020120000', name: 'AI automation server boundary', applied: true },
      { version: '20261020120100', name: 'AI automation server contract', applied: false },
    ]);
    expect(report.migrations.complete).toBe(false);
  });

  it('reads the backend contract through the gateway, never with the server role directly', async () => {
    const { handlers, rpc, pool } = harness();
    await handlers.handle('token');
    // hub.get_backend_contract() is executable by anon/authenticated only; the
    // gateway runs public calls as anon, as the startup contract check does.
    expect(rpc).toHaveBeenCalledWith('get_backend_contract', {});
    expect(pool.query.mock.calls[0][0]).not.toContain('get_backend_contract');
    expect(pool.query.mock.calls[0][1]).toEqual([automationServerOperations]);
  });

  it('reports the automation server boundary separately from its contract', async () => {
    const { handlers } = harness({
      evidence: { ...appliedEvidence, automation_server_operations: false },
      contract: { api_version: 4, features: ['support.ai-assistance.v1', 'support.ai-automation.v1'] },
    });
    const report = await handlers.handle('token');
    expect(report.migrations.items.slice(2)).toEqual([
      { version: '20261020120000', name: 'AI automation server boundary', applied: false },
      { version: '20261020120100', name: 'AI automation server contract', applied: false },
    ]);
    expect(report.migrations.items.slice(0, 2).every((item) => item.applied)).toBe(true);
    expect(report.migrations.complete).toBe(false);
  });

  it('requires every object the first migration creates before calling it applied', async () => {
    for (const missing of ['automation_table', 'resolution_function', 'queue_ai_stage', 'author_role_ai_assistant']) {
      const { handlers } = harness({ evidence: { ...appliedEvidence, [missing]: false } });
      const report = await handlers.handle('token');
      expect(report.migrations.items[0].applied).toBe(false);
      expect(report.migrations.complete).toBe(false);
    }
  });

  it('treats a missing, empty, or whitespace-only key as absent, matching the AI service', async () => {
    for (const env of [{}, { ANTHROPIC_API_KEY: '' }, { ANTHROPIC_API_KEY: '   ' }]) {
      const { handlers } = harness({ env });
      const report = await handlers.handle('token');
      expect(report.anthropicKey.present).toBe(false);
    }
  });

  it('requires the automation toggle to be exactly true', async () => {
    for (const [value, expected] of [['true', true], ['false', false], ['TRUE', false], [undefined, false]]) {
      const { handlers } = harness({ env: { HUB_AI_AUTOMATION_ENABLED: value } });
      const report = await handlers.handle('token');
      expect(report.aiAutomation.enabled).toBe(expected);
    }
  });

  it('reports the help hostname as unresolved when DNS returns no targets', async () => {
    const { handlers } = harness({ targets: [] });
    const report = await handlers.handle('token');
    expect(report.helpDomain).toEqual({ hostname: 'help.caremetric.ai', resolves: false, targets: [] });
  });

  it('refuses non-platform-administrators before any evaluation', async () => {
    const { handlers, pool, lookup } = harness({ role: 'support_manager' });
    await expect(handlers.handle('token')).rejects.toMatchObject({ status: 403 });
    expect(pool.query).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('evaluates live on every call rather than remembering an earlier result', async () => {
    const { handlers, pool } = harness();
    await handlers.handle('token');
    await handlers.handle('token');
    expect(pool.query).toHaveBeenCalledTimes(2);
  });
});
