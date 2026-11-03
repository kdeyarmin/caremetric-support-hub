import { describe, expect, it, vi } from 'vitest';
import { integrationCatalog, integrationSetup } from './integration-setup.mjs';

const env = {
  ANTHROPIC_API_KEY: 'sk-ant-secret-value', HUB_AI_AUTOMATION_ENABLED: 'false',
  HUB_TWILIO_AUTH_TOKEN: 'twilio-secret-value', HUB_SUPPORT_FROM_EMAIL: 'support@caremetric.ai', HUB_CHAT_ENABLED: 'false',
};
function harness(role = 'platform_admin', environment = env) {
  const rpc = vi.fn(async (name) => {
    if (name === 'get_support_actor_context') return { role, id: 'admin-1' };
    throw new Error(`Unexpected RPC ${name}`);
  });
  return integrationSetup({ rpc, env: environment, now: () => new Date('2026-10-21T12:00:00.000Z') });
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
      .toEqual({ name: 'ANTHROPIC_API_KEY', secret: true, required: true, purpose: expect.any(String), set: true, satisfied: true });
    expect(anthropic.variables.find((variable) => variable.name === 'HUB_AI_AUTOMATION_ENABLED')).toMatchObject({ secret: false, set: true, value: 'false', satisfied: false });
    expect(anthropic.variables.find((variable) => variable.name === 'HUB_AI_DRAFT_TIER')).toMatchObject({ secret: false, set: false, value: null });
    const twilio = report.integrations.find((integration) => integration.id === 'twilio-sms');
    expect(twilio.ready).toBe(true);
    expect(twilio.complete).toBe(false);
    // A flag that is present but not exactly "true" is set, not satisfied: the runtime keeps that integration off.
    const chat = report.integrations.find((integration) => integration.id === 'chat');
    expect(chat.ready).toBe(false);
    expect(chat.variables[0]).toMatchObject({ name: 'HUB_CHAT_ENABLED', set: true, value: 'false', satisfied: false });
    const chatOn = (await harness('platform_admin', { ...env, HUB_CHAT_ENABLED: 'true' }).handle('token')).integrations.find((integration) => integration.id === 'chat');
    expect(chatOn).toMatchObject({ ready: true, complete: true });
    const chatBlank = (await harness('platform_admin', { ...env, HUB_CHAT_ENABLED: '  ' }).handle('token')).integrations.find((integration) => integration.id === 'chat');
    expect(chatBlank.variables[0]).toMatchObject({ set: false, value: null, satisfied: false });
    // Secrets contribute a boolean only; their values appear nowhere in the report.
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('sk-ant-secret-value');
    expect(serialized).not.toContain('twilio-secret-value');
  });

  it('reports each product\'s lead secret by presence only, none of them required on its own', async () => {
    const secret = 'lead-secret-value-'.repeat(3);
    const report = await harness('platform_admin', { ...env, HUB_LEAD_SECRET_INTEL: secret }).handle('token');
    const leads = report.integrations.find((integration) => integration.id === 'website-leads');
    expect(leads.docs).toBe('docs/LEAD_INTAKE.md');
    expect(leads.variables.map((variable) => [variable.name, variable.secret, variable.required, variable.set]))
      .toEqual([['HUB_LEAD_SECRET_CAREBASE', true, false, false], ['HUB_LEAD_SECRET_INTEL', true, false, true], ['HUB_LEAD_SECRET_ADVISORS', true, false, false]]);
    for (const variable of leads.variables) expect(variable).not.toHaveProperty('value');
    expect(leads).toMatchObject({ ready: true, complete: false });
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it('refuses every role but the platform administrator', async () => {
    await expect(harness('support_manager').handle('token')).rejects.toThrow('Integration setup is available to the platform administrator only.');
  });

  it('lists each integration variable once and covers every secret the Hub service reads', () => {
    const names = integrationCatalog.flatMap((integration) => integration.variables.map((variable) => variable.name));
    expect(new Set(names).size).toBe(names.length);
    for (const name of ['ANTHROPIC_API_KEY', 'HUB_TWILIO_AUTH_TOKEN', 'HUB_TWILIO_ACCOUNT_SID', 'HUB_SENDGRID_INBOUND_PUBLIC_KEY', 'HUB_SENDGRID_API_KEY',
      'HUB_CHAT_ENABLED', 'HUB_PUBLIC_ORIGIN', 'HUB_TELNYX_API_KEY', 'HUB_TELNYX_VERIFY_PROFILE_ID', 'CAREBASE_DISTRIBUTION_OBSERVER_TOKEN',
      'HUB_LEAD_SECRET_CAREBASE', 'HUB_LEAD_SECRET_INTEL', 'HUB_LEAD_SECRET_ADVISORS']) {
      expect(names).toContain(name);
    }
    for (const integration of integrationCatalog) expect(integration.docs).toMatch(/^docs\/[A-Z0-9_]+\.md$/);
  });

  it('reports the Search Console key by presence only and shows the properties, with the owner\'s steps in plain words', async () => {
    const key = JSON.stringify({ type: 'service_account', client_email: 'seo@project.iam.gserviceaccount.com', private_key: 'fixture-key-search-console-secret' });
    const report = await harness('platform_admin', { ...env, HUB_SEARCH_CONSOLE_CREDENTIALS: key, HUB_SEARCH_CONSOLE_SITES: 'sc-domain:cmcarebase.com' }).handle('token');
    const searchConsole = report.integrations.find((integration) => integration.id === 'search-console');
    expect(searchConsole).toMatchObject({ ready: true, complete: true, docs: 'docs/AI_TEAM.md' });
    expect(searchConsole.variables.map((variable) => [variable.name, variable.secret, variable.set])).toEqual([['HUB_SEARCH_CONSOLE_CREDENTIALS', true, true], ['HUB_SEARCH_CONSOLE_SITES', false, true]]);
    expect(searchConsole.variables[0]).not.toHaveProperty('value');
    expect(searchConsole.variables[1].value).toBe('sc-domain:cmcarebase.com');
    expect(JSON.stringify(report)).not.toContain('search-console-secret');
    for (const step of ['service account', 'Google Search Console API', 'as a user on each property']) expect(searchConsole.purpose).toContain(step);
    // The browser's schema refuses a longer purpose, which would empty the whole setup panel.
    for (const integration of integrationCatalog) {
      expect(integration.purpose.length, integration.id).toBeLessThanOrEqual(400);
      expect(integration.name.length, integration.id).toBeLessThanOrEqual(120);
      for (const variable of integration.variables) expect(variable.purpose.length, variable.name).toBeLessThanOrEqual(300);
    }
    const unset = (await harness().handle('token')).integrations.find((integration) => integration.id === 'search-console');
    expect(unset).toMatchObject({ ready: false, complete: false });
  });
});
