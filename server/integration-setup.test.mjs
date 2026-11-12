import { describe, expect, it, vi } from 'vitest';
import { integrationCatalog, integrationSetup } from './integration-setup.mjs';
import { retiredVariables, settingsCatalog } from './hub-settings.mjs';

const env = {
  ANTHROPIC_API_KEY: 'sk-ant-secret-value', HUB_AI_AUTOMATION_ENABLED: 'true',
  HUB_TWILIO_AUTH_TOKEN: 'twilio-secret-value', HUB_SUPPORT_FROM_EMAIL: 'support@caremetric.ai', HUB_CHAT_ENABLED: 'true',
};
function harness(role = 'platform_admin', environment = env) {
  const rpc = vi.fn(async (name) => {
    if (name === 'get_support_actor_context') return { role, id: 'admin-1' };
    throw new Error(`Unexpected RPC ${name}`);
  });
  return integrationSetup({ rpc, env: environment, now: () => new Date('2026-10-21T12:00:00.000Z') });
}

describe('integration setup report', () => {
  it('reads live social credentials without returning their values', async () => {
    let current = {};
    const report = harness('platform_admin', () => current);
    expect((await report.handle('owner')).integrations.find(item => item.id === 'social-media').ready).toBe(false);
    current = { HUB_META_ACCESS_TOKEN: 'stored-encrypted-social-token-for-tests' };
    const next = await report.handle('owner');
    expect(next.integrations.find(item => item.id === 'social-media').ready).toBe(true);
    expect(JSON.stringify(next)).not.toContain(current.HUB_META_ACCESS_TOKEN);
  });
  it('reports presence for secrets and values for wiring, in catalog order', async () => {
    const report = await harness().handle('token');
    expect(report.checkedAt).toBe('2026-10-21T12:00:00.000Z');
    expect(report.integrations.map((integration) => integration.id)).toEqual(integrationCatalog.map((integration) => integration.id));
    const anthropic = report.integrations.find((integration) => integration.id === 'anthropic');
    expect(anthropic).toMatchObject({ ready: true, complete: true });
    expect(anthropic.variables).toEqual([{ name: 'ANTHROPIC_API_KEY', secret: true, required: true, purpose: expect.any(String), set: true, satisfied: true }]);
    const twilio = report.integrations.find((integration) => integration.id === 'twilio-sms');
    expect(twilio.ready).toBe(true);
    expect(twilio.complete).toBe(false);
    const telnyx = (await harness('platform_admin', { ...env, HUB_TELNYX_VERIFY_PROFILE_ID: ' profile-1 ' }).handle('token')).integrations.find((integration) => integration.id === 'telnyx-signin');
    expect(telnyx.variables.find((variable) => variable.name === 'HUB_TELNYX_VERIFY_PROFILE_ID')).toMatchObject({ secret: false, set: true, satisfied: true, value: 'profile-1' });
    // Secrets contribute a boolean only; their values appear nowhere in the report.
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('sk-ant-secret-value');
    expect(serialized).not.toContain('twilio-secret-value');
  });

  it('lists only what stays in Railway: no switch, address or id that is a Hub setting', () => {
    const names = integrationCatalog.flatMap((integration) => integration.variables.map((variable) => variable.name));
    for (const entry of settingsCatalog) expect(names, entry.key).not.toContain(entry.env);
    for (const name of retiredVariables) expect(names).not.toContain(name);
    // A setting reported here as a variable would send the owner to Railway for something they now change on the Settings page.
    const report = JSON.stringify(integrationCatalog);
    for (const name of ['HUB_CHAT_ENABLED', 'HUB_AGENTS_ENABLED', 'HUB_OWNER_EMAIL', 'HUB_SUPPORT_FROM_EMAIL', 'HUB_META_PAGE_ID']) expect(report).not.toContain(`"${name}"`);
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

  it('does not call a secret ready when it is shorter than the service accepts', async () => {
    const short = 'short-secret';
    const report = await harness('platform_admin', { ...env, HUB_LEAD_SECRET_CAREBASE: short, HUB_LEAD_SECRET_INTEL: 'i'.repeat(32), HUB_GROWTH_SIGNING_KEY: 'tooshort' }).handle('token');
    const leads = report.integrations.find((integration) => integration.id === 'website-leads');
    expect(leads.variables.map((variable) => [variable.name, variable.set, variable.satisfied])).toEqual([
      ['HUB_LEAD_SECRET_CAREBASE', true, false], ['HUB_LEAD_SECRET_INTEL', true, true], ['HUB_LEAD_SECRET_ADVISORS', false, false],
    ]);
    const growth = report.integrations.find((integration) => integration.id === 'customer-growth');
    expect(growth.variables.find((variable) => variable.name === 'HUB_GROWTH_SIGNING_KEY')).toMatchObject({ set: true, satisfied: false });
    expect(growth.ready).toBe(false);
    // Still booleans only: neither the value nor its length is reported.
    expect(JSON.stringify(report)).not.toContain(short);
    expect(JSON.stringify(report)).not.toMatch(/"(length|minLength)"/);
  });

  it('no longer offers a booking page: CareMetric does no personal demos with anyone (owner decision 2026-11-09)', async () => {
    const report = await harness('platform_admin', { ...env, HUB_BOOKING_URL: 'https://cal.example.test/caremetric/intro' }).handle('token');
    expect(JSON.stringify(report)).not.toContain('HUB_BOOKING_URL');
    expect(JSON.stringify(report)).not.toContain('cal.example.test');
  });

  it('refuses every role but the platform administrator', async () => {
    await expect(harness('support_manager').handle('token')).rejects.toThrow('Integration setup is available to the platform administrator only.');
  });

  it('lists each integration variable once and covers every secret the Hub service reads', () => {
    const names = integrationCatalog.flatMap((integration) => integration.variables.map((variable) => variable.name));
    expect(new Set(names).size).toBe(names.length);
    for (const name of ['ANTHROPIC_API_KEY', 'HUB_TWILIO_AUTH_TOKEN', 'HUB_TWILIO_ACCOUNT_SID', 'HUB_SENDGRID_INBOUND_PUBLIC_KEY', 'HUB_SENDGRID_API_KEY',
      'HUB_PUBLIC_ORIGIN', 'HUB_TELNYX_API_KEY', 'HUB_TELNYX_VERIFY_PROFILE_ID', 'CAREBASE_DISTRIBUTION_OBSERVER_TOKEN', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
      'HUB_LEAD_SECRET_CAREBASE', 'HUB_LEAD_SECRET_INTEL', 'HUB_LEAD_SECRET_ADVISORS', 'HUB_GROWTH_SIGNING_KEY', 'HUB_META_ACCESS_TOKEN', 'HUB_LINKEDIN_ACCESS_TOKEN',
      'HUB_SEARCH_CONSOLE_CREDENTIALS', 'HUB_SES_ACCESS_KEY_ID', 'HUB_SES_SECRET_ACCESS_KEY']) {
      expect(names).toContain(name);
    }
    for (const integration of integrationCatalog) expect(integration.docs).toMatch(/^docs\/[A-Z0-9_]+\.md$/);
  });

  it('reports the Search Console key by presence only, with the owner\'s steps in plain words', async () => {
    const key = JSON.stringify({ type: 'service_account', client_email: 'seo@project.iam.gserviceaccount.com', private_key: 'fixture-key-search-console-secret' });
    const report = await harness('platform_admin', { ...env, HUB_SEARCH_CONSOLE_CREDENTIALS: key, HUB_SEARCH_CONSOLE_SITES: 'sc-domain:cmcarebase.com' }).handle('token');
    const searchConsole = report.integrations.find((integration) => integration.id === 'search-console');
    expect(searchConsole).toMatchObject({ ready: true, complete: true, docs: 'docs/GOOGLE_SEARCH_CONSOLE_SETUP.md' });
    expect(searchConsole.variables.map((variable) => [variable.name, variable.secret, variable.set])).toEqual([['HUB_SEARCH_CONSOLE_CREDENTIALS', true, true]]);
    expect(searchConsole.variables[0]).not.toHaveProperty('value');
    expect(JSON.stringify(report)).not.toContain('search-console-secret');
    for (const step of ['service account', 'Google Search Console API', 'as a user on each property', 'Settings → Search']) expect(searchConsole.purpose).toContain(step);
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
