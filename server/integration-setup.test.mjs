import { describe, expect, it, vi } from 'vitest';
import { integrationCatalog, integrationSetup } from './integration-setup.mjs';

const env = {
  ANTHROPIC_API_KEY: 'sk-ant-secret-value', HUB_AI_AUTOMATION_ENABLED: 'false',
  HUB_TWILIO_AUTH_TOKEN: 'twilio-secret-value', HUB_SUPPORT_FROM_EMAIL: 'support@caremetric.ai', HUB_CHAT_ENABLED: '  ',
};
function harness(role = 'platform_admin') {
  const rpc = vi.fn(async (name) => {
    if (name === 'get_support_actor_context') return { role, id: 'admin-1' };
    throw new Error(`Unexpected RPC ${name}`);
  });
  return integrationSetup({ rpc, env, now: () => new Date('2026-10-21T12:00:00.000Z') });
}

describe('integration setup report', () => {
  it('reports presence for secrets and values for settings, in catalog order', async () => {
    const report = await harness().handle('token');
    expect(report.checkedAt).toBe('2026-10-21T12:00:00.000Z');
    expect(report.integrations.map((integration) => integration.id)).toEqual(integrationCatalog.map((integration) => integration.id));
    const anthropic = report.integrations.find((integration) => integration.id === 'anthropic');
    expect(anthropic.ready).toBe(true);
    expect(anthropic.complete).toBe(false);
    expect(anthropic.variables.find((variable) => variable.name === 'ANTHROPIC_API_KEY'))
      .toEqual({ name: 'ANTHROPIC_API_KEY', secret: true, required: true, purpose: expect.any(String), set: true });
    expect(anthropic.variables.find((variable) => variable.name === 'HUB_AI_AUTOMATION_ENABLED')).toMatchObject({ secret: false, set: true, value: 'false' });
    expect(anthropic.variables.find((variable) => variable.name === 'HUB_AI_DRAFT_TIER')).toMatchObject({ secret: false, set: false, value: null });
    const twilio = report.integrations.find((integration) => integration.id === 'twilio-sms');
    expect(twilio.ready).toBe(true);
    expect(twilio.complete).toBe(false);
    const chat = report.integrations.find((integration) => integration.id === 'chat');
    expect(chat.ready).toBe(false);
    expect(chat.variables[0]).toMatchObject({ name: 'HUB_CHAT_ENABLED', set: false, value: null });
    // Secrets contribute a boolean only; their values appear nowhere in the report.
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('sk-ant-secret-value');
    expect(serialized).not.toContain('twilio-secret-value');
  });

  it('refuses every role but the platform administrator', async () => {
    await expect(harness('support_manager').handle('token')).rejects.toThrow('Integration setup is available to the platform administrator only.');
  });

  it('lists each integration variable once and covers every secret the Hub service reads', () => {
    const names = integrationCatalog.flatMap((integration) => integration.variables.map((variable) => variable.name));
    expect(new Set(names).size).toBe(names.length);
    for (const name of ['ANTHROPIC_API_KEY', 'HUB_TWILIO_AUTH_TOKEN', 'HUB_TWILIO_ACCOUNT_SID', 'HUB_SENDGRID_INBOUND_PUBLIC_KEY', 'HUB_SENDGRID_API_KEY',
      'HUB_CHAT_ENABLED', 'HUB_PUBLIC_ORIGIN', 'HUB_TELNYX_API_KEY', 'HUB_TELNYX_VERIFY_PROFILE_ID', 'DOCSTUDIO_WORKER_TOKEN', 'CAREBASE_DISTRIBUTION_OBSERVER_TOKEN']) {
      expect(names).toContain(name);
    }
    for (const integration of integrationCatalog) expect(integration.docs).toMatch(/^docs\/[A-Z0-9_]+\.md$/);
  });
});
