import { readdir, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hubSettings, retiredVariables, settingFromEnv, settingGroups, settingInput, settingsCatalog, settingsFeature } from './hub-settings.mjs';
import { live, rebuilt } from './live.mjs';
import { socialConfig } from './agents/social/index.mjs';
import { appServer } from './http.mjs';

const migrationsDir = new URL('../supabase/migrations/', import.meta.url);
// Every migration that adds settings, in order: the first creates the table, later ones add rows.
const migration = (await Promise.all((await readdir(migrationsDir)).sort().map(name => readFile(new URL(name, migrationsDir), 'utf8'))))
  .filter(text => text.includes('insert into private.hub_settings (key, kind) values')).join('\n');
const contract = await readFile(new URL('../supabase/migrations/20261109150100_hub_settings_contract.sql', import.meta.url), 'utf8');
const quiet = { info: vi.fn(), warn: vi.fn() };
const entry = key => settingsCatalog.find(item => item.key === key);
const declared = new Set([settingsFeature]);

describe('the settings catalog', () => {
  it('holds exactly the keys and kinds the migration creates', () => {
    const rows = [...migration.matchAll(/\('([a-z_]+\.[a-z_]+)', '(flag|text|number|list)'\)/g)].map(match => [match[1], match[2]]);
    expect(settingsCatalog.map(item => [item.key, item.kind]).sort()).toEqual(rows.sort());
    // The release gate refuses a database without the first release's 32 rows.
    expect(rows.length).toBeGreaterThanOrEqual(32);
    expect(contract).toContain('(select count(*) from private.hub_settings) < 32');
  });

  it('gives every setting a group, words, its own Railway variable and a default it would accept', () => {
    const groups = new Set(settingGroups.map(group => group.id));
    // A setting replaces at most one Railway variable, each its own; a setting added after the move to settings replaces none.
    const variables = settingsCatalog.map(item => item.env).filter(Boolean);
    expect(new Set(variables).size).toBe(variables.length);
    for (const item of settingsCatalog) {
      expect(groups.has(item.group), item.key).toBe(true);
      expect(item.label.length, item.key).toBeLessThanOrEqual(80);
      expect(item.help.length, item.key).toBeLessThanOrEqual(400);
      if (item.env !== null) expect(item.env, item.key).toMatch(/^[A-Z][A-Z0-9_]{2,80}$/);
      if (item.kind === 'flag') expect(typeof item.default, item.key).toBe('boolean');
      else if (item.default !== null && !(Array.isArray(item.default) && item.default.length === 0)) expect(item.valid(item.default), item.key).toBe(true);
    }
    // No secret ever becomes a setting: settings are shown on screen and copied into the database.
    for (const item of settingsCatalog) if (item.env) expect(item.env, item.key).not.toMatch(/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS)$/);
    expect(retiredVariables).toEqual(['HUB_BULK_EMAIL_FROM', 'HUB_BOOKING_URL']);
  });
});

describe('reading the old Railway variables', () => {
  it('reads each variable exactly as the server did before settings', () => {
    expect(settingFromEnv(entry('support.chat'), { HUB_CHAT_ENABLED: 'true' })).toBe(true);
    expect(settingFromEnv(entry('support.chat'), { HUB_CHAT_ENABLED: 'yes' })).toBe(false);
    expect(settingFromEnv(entry('support.chat'), { HUB_CHAT_ENABLED: '  ' })).toBeUndefined();
    expect(settingFromEnv(entry('support.ai_draft_tier'), { HUB_AI_DRAFT_TIER: 'quality' })).toBe('quality');
    expect(settingFromEnv(entry('support.ai_draft_tier'), { HUB_AI_DRAFT_TIER: 'fast' })).toBeUndefined();
    expect(settingFromEnv(entry('support.ai_follow_up_hours'), { HUB_AI_FOLLOW_UP_DELAY_HOURS: '48' })).toBe(48);
    expect(settingFromEnv(entry('support.ai_follow_up_hours'), { HUB_AI_FOLLOW_UP_DELAY_HOURS: 'soon' })).toBeUndefined();
    expect(settingFromEnv(entry('billing.intel_price_sync'), { HUB_APP_CATALOG_SYNC: 'off' })).toBe(false);
    expect(settingFromEnv(entry('billing.intel_price_sync'), {})).toBeUndefined();
    expect(settingFromEnv(entry('social.image_urls'), { HUB_SOCIAL_IMAGE_URLS: 'https://a.test/1.png, https://a.test/2.png' })).toEqual(['https://a.test/1.png', 'https://a.test/2.png']);
    expect(settingFromEnv(entry('seo.search_console_sites'), { HUB_SEARCH_CONSOLE_SITES: 'sc-domain:cmcarebase.com https://www.caremetricintel.com/' }))
      .toEqual(['sc-domain:cmcarebase.com', 'https://www.caremetricintel.com/']);
    expect(settingFromEnv(entry('social.max_daily_budget_cents'), { HUB_SOCIAL_AD_MAX_DAILY_BUDGET_CENTS: '0' })).toBeUndefined();
  });

  it('answers from the variables until the settings migration is applied, without touching the database', async () => {
    const call = vi.fn();
    const settings = hubSettings({ features: new Set(), env: { HUB_CHAT_ENABLED: 'true', HUB_OWNER_EMAIL: 'owner@caremetric.test' }, call, log: quiet });
    await settings.start();
    expect(call).not.toHaveBeenCalled();
    expect(settings.get('support.chat')).toBe(true);
    expect(settings.get('agents.owner_email')).toBe('owner@caremetric.test');
    expect(settings.get('billing.intel_price_sync')).toBe(true);
    expect(settings.get('support.ai_follow_up_hours')).toBe(24);
    expect(() => settings.get('support.unknown')).toThrow(/Unknown Hub setting/);
  });
});

describe('settings in the database', () => {
  function harness({ env = {}, values = {}, rows = [] } = {}) {
    const state = { values: { ...values } };
    const call = vi.fn(async (operation, args = []) => {
      if (operation === 'private.hub_settings_import') return Object.keys(args[0]).filter(key => !(key in state.values)).map(key => { state.values[key] = args[0][key].value; return key; });
      if (operation === 'private.hub_settings_values') return { ...state.values };
      throw new Error(operation);
    });
    const queries = [];
    const session = vi.fn(async (token, work) => work({ query: async (text, params) => {
      queries.push({ text, params });
      if (text.startsWith('select hub.get_hub_settings()')) return { rows: [{ result: rows }] };
      if (text.startsWith('select hub.set_hub_setting(')) { state.values[params[0]] = JSON.parse(params[1]); return { rows: [{ result: {} }] }; }
      return { rows: [{}] };
    } }));
    const log = { info: vi.fn(), warn: vi.fn() };
    const settings = hubSettings({ features: declared, env, call, session, log, refreshMs: 60_000 });
    return { settings, call, session, queries, state, log };
  }

  it('copies the usable Railway values in once, then answers from the database', async () => {
    const { settings, call, log } = harness({ env: { HUB_CHAT_ENABLED: 'true', HUB_OWNER_EMAIL: 'not an address', HUB_AI_DRAFT_TIER: 'quality', HUB_BULK_EMAIL_FROM: 'x@y.test' }, values: { 'support.ai_draft_tier': 'draft' } });
    await settings.start();
    settings.stop();
    expect(call).toHaveBeenCalledWith('private.hub_settings_import', [{
      'support.chat': { value: true, from: 'HUB_CHAT_ENABLED' }, 'support.ai_draft_tier': { value: 'quality', from: 'HUB_AI_DRAFT_TIER' },
    }]);
    // A value saved before is kept: the copy only fills settings nobody has set.
    expect(settings.get('support.ai_draft_tier')).toBe('draft');
    expect(settings.get('support.chat')).toBe(true);
    // An unusable variable is not copied, and says so; every variable a setting replaces is listed as deletable.
    expect(settings.get('agents.owner_email')).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/^HUB_OWNER_EMAIL has a value the Hub cannot use/));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('can be deleted: HUB_OWNER_EMAIL, HUB_CHAT_ENABLED, HUB_AI_DRAFT_TIER.'));
    expect(log.warn).toHaveBeenCalledWith('HUB_BULK_EMAIL_FROM is set but no longer used. Remove it from the service.');
  });

  it('keeps the Railway values until they have been copied in, retrying the copy before the database values replace them', async () => {
    const state = { values: {} };
    let failures = 1;
    const call = vi.fn(async (operation, args = []) => {
      if (operation === 'private.hub_settings_import') {
        if (failures-- > 0) throw new Error('down');
        return Object.entries(args[0]).map(([key, item]) => { state.values[key] = item.value; return key; });
      }
      return { ...state.values };
    });
    const settings = hubSettings({ features: declared, env: { HUB_CHAT_ENABLED: 'true', HUB_AGENTS_ENABLED: 'true' }, call, log: quiet, refreshMs: 60_000 });
    await settings.start();
    settings.stop();
    expect(settings.get('support.chat')).toBe(true);
    expect(call.mock.calls.map(([operation]) => operation)).toEqual(['private.hub_settings_import']);
    // The next refresh (the timer's, or a save's) copies first, so chat and the AI team stay on.
    await settings.refresh();
    expect(call.mock.calls.map(([operation]) => operation)).toEqual(['private.hub_settings_import', 'private.hub_settings_import', 'private.hub_settings_values']);
    expect(settings.get('support.chat')).toBe(true);
    expect(settings.get('agents.enabled')).toBe(true);
    // Once copied, a refresh only reads.
    await settings.refresh();
    expect(call.mock.calls.at(-1)[0]).toBe('private.hub_settings_values');
    expect(call.mock.calls.filter(([operation]) => operation === 'private.hub_settings_import')).toHaveLength(2);
  });

  it('uses the default for a stored value it cannot use, and the variables while the database cannot be read', async () => {
    const broken = hubSettings({ features: declared, env: { HUB_CHAT_ENABLED: 'true' }, call: async () => { throw new Error('down'); }, log: quiet });
    await broken.start();
    broken.stop();
    expect(broken.get('support.chat')).toBe(true);
    const { settings } = harness({ values: { 'support.ai_follow_up_hours': 0, 'agents.owner_email': 'owner@caremetric.test' } });
    await settings.refresh();
    expect(settings.get('support.ai_follow_up_hours')).toBe(24);
    expect(settings.get('agents.owner_email')).toBe('owner@caremetric.test');
    expect(settings.get('support.chat')).toBe(false);
  });

  it('shows the owner every setting with where its value came from', async () => {
    const rows = [
      { key: 'support.chat', kind: 'flag', value: true, importedFrom: 'HUB_CHAT_ENABLED', changedAt: '2026-11-09T10:00:00.000001+00:00', savedInHub: false },
      { key: 'agents.owner_email', kind: 'text', value: 'owner@caremetric.test', importedFrom: null, changedAt: '2026-11-09T10:00:00+00:00', savedInHub: true },
    ];
    const { settings } = harness({ rows, env: { HUB_CHAT_ENABLED: 'true' } });
    const view = await settings.admin('token', { action: 'list' });
    expect(view.editable).toBe(true);
    expect(view.groups.map(group => group.id)).toEqual(settingGroups.map(group => group.id));
    const all = view.groups.flatMap(group => group.settings);
    expect(all).toHaveLength(settingsCatalog.length);
    expect(all.find(item => item.key === 'support.chat')).toMatchObject({ value: true, effective: true, source: 'copied', variable: 'HUB_CHAT_ENABLED', variableSet: true, input: 'toggle' });
    expect(all.find(item => item.key === 'agents.owner_email')).toMatchObject({ value: 'owner@caremetric.test', source: 'hub', variableSet: false });
    expect(all.find(item => item.key === 'support.ai_draft_tier')).toMatchObject({ value: null, effective: 'draft', source: 'default', changedAt: null, choices: expect.any(Array) });
  });

  it('saves a checked value, applies it on this server at once, and refuses what the service could not use', async () => {
    const { settings, queries, call } = harness();
    await settings.refresh();
    const version = '2026-11-09T10:00:00.000001+00:00';
    await settings.admin('token', { action: 'save', key: 'agents.owner_email', value: '  owner@caremetric.test ', expectedChangedAt: version });
    expect(queries.find(query => query.text.startsWith('select hub.set_hub_setting('))?.params).toEqual(['agents.owner_email', '"owner@caremetric.test"', version]);
    expect(settings.get('agents.owner_email')).toBe('owner@caremetric.test');
    expect(call.mock.calls.filter(([operation]) => operation === 'private.hub_settings_values').length).toBe(2);
    await settings.save('token', { key: 'social.image_urls', value: [' https://a.test/1.png ', '', 'https://a.test/1.png'], expectedChangedAt: version });
    expect(settings.get('social.image_urls')).toEqual(['https://a.test/1.png']);
    // Clearing a value (null, an empty text or an empty list) returns the setting to its default.
    await settings.save('token', { key: 'agents.owner_email', value: '', expectedChangedAt: version });
    expect(queries.at(-2).params[1]).toBe('null');
    expect(settings.get('agents.owner_email')).toBeNull();
    for (const [key, value] of [['agents.owner_email', 'not an address'], ['support.chat', 'true'], ['support.ai_follow_up_hours', 0.5], ['support.ai_draft_tier', 'fast'],
['social.image_urls', ['http://a.test/1.png']], ['sms.from_number', '2025550100']]) {
      await expect(settings.save('token', { key, value, expectedChangedAt: version }), key).rejects.toMatchObject({ status: 400 });
    }
    await expect(settings.save('token', { key: 'support.unknown', value: true, expectedChangedAt: version })).rejects.toMatchObject({ status: 404 });
    await expect(settings.save('token', { key: 'support.chat', value: true, expectedChangedAt: 'yesterday' })).rejects.toMatchObject({ status: 400 });
    await expect(settings.save('token', { key: 'support.chat', value: true })).rejects.toMatchObject({ status: 400 });
    await expect(settings.admin('token', { action: 'delete', key: 'support.chat' })).rejects.toMatchObject({ status: 400 });
  });

  it('is read-only until the migration is applied', async () => {
    const session = vi.fn(async (token, work) => work({ query: async () => ({ rows: [{}] }) }));
    const settings = hubSettings({ features: new Set(), env: { HUB_CHAT_ENABLED: 'true' }, session, log: quiet });
    const view = await settings.admin('token', { action: 'list' });
    expect(view.editable).toBe(false);
    expect(view.groups.flatMap(group => group.settings).find(item => item.key === 'support.chat')).toMatchObject({ value: true, source: 'railway' });
    await expect(settings.save('token', { key: 'support.chat', value: false, expectedChangedAt: '2026-11-09T10:00:00Z' })).rejects.toMatchObject({ status: 409 });
  });

  it('gives services a reader that follows each change', async () => {
    const { settings } = harness();
    await settings.refresh();
    const chat = settings.reader('support.chat');
    expect(chat()).toBe(false);
    await settings.save('token', { key: 'support.chat', value: true, expectedChangedAt: '2026-11-09T10:00:00Z' });
    expect(chat()).toBe(true);
    expect(() => settings.reader('support.unknown')).toThrow();
  });
});

describe('settings input', () => {
  it('trims text and lists and treats empty as not set', () => {
    expect(settingInput(entry('email.postal_address'), '  123 Main St, Pittsburgh PA  ')).toBe('123 Main St, Pittsburgh PA');
    expect(settingInput(entry('email.postal_address'), '   ')).toBeNull();
    expect(settingInput(entry('seo.search_console_sites'), [])).toBeNull();
    expect(settingInput(entry('support.chat'), null)).toBeNull();
    expect(() => settingInput(entry('email.postal_address'), 'line one\nline two')).toThrow();
  });
});

describe('live values', () => {
  it('reads a function each time and passes a value through', () => {
    let on = false;
    const read = () => on;
    expect(live(read)).toBe(false);
    on = true;
    expect(live(read)).toBe(true);
    expect(live('plain')).toBe('plain');
  });

  it('builds again only when its input changes', () => {
    let input = { id: '1' };
    const build = vi.fn(value => ({ id: value.id, hello() { return `hello ${this.id}`; } }));
    const client = rebuilt(() => input, build);
    expect(client.hello()).toBe('hello 1');
    expect(client.id).toBe('1');
    expect(build).toHaveBeenCalledTimes(1);
    input = { id: '1' };
    expect(client.id).toBe('1');
    expect(build).toHaveBeenCalledTimes(1);
    input = { id: '2' };
    expect(client.hello()).toBe('hello 2');
    expect(build).toHaveBeenCalledTimes(2);
  });
});

describe('the social media configuration', () => {
  it('takes the tokens from Railway and everything else from the settings', () => {
    const values = { 'social.meta_page_id': '123', 'social.image_urls': ['https://a.test/1.png'], 'social.max_daily_budget_cents': null, 'social.target_cost_cents': 2500, 'social.meta_graph_version': 'v23.0', 'social.linkedin_api_version': '202609' };
    const config = socialConfig({ HUB_META_ACCESS_TOKEN: 'token-'.repeat(5), HUB_META_PAGE_ID: '999' }, key => values[key] ?? null);
    expect(config.meta).toMatchObject({ token: 'token-'.repeat(5), pageId: '123', instagramId: '', version: 'v23.0' });
    expect(config.imageUrls).toEqual(['https://a.test/1.png']);
    expect(config.settings).toEqual({ maxDailyBudgetCents: 0, targetCostCents: 2500 });
    // Without settings (tests and older callers), the variables as before.
    expect(socialConfig({ HUB_META_PAGE_ID: '999', HUB_SOCIAL_IMAGE_URLS: 'https://a.test/2.png' }).meta.pageId).toBe('999');
  });
});

describe('the settings route', () => {
  const origin = 'https://support-hub-web-production.up.railway.app';
  const token = 's'.repeat(43);
  const admin = vi.fn(async (session, input) => ({ editable: true, input }));
  let server, base;
  beforeAll(async () => {
    server = appServer({ auth: {}, delegations: {}, gateway: {}, settings: { admin }, origins: [origin] });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise(resolve => server.close(resolve)));
  const post = (body, headers = {}) => fetch(`${base}/api/admin/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: `__Host-caremetric_session=${token}`, ...headers }, body: JSON.stringify(body) });

  it('hands the request to the settings with the session, from the Hub only', async () => {
    const response = await post({ action: 'list' });
    expect(response.status).toBe(200);
    expect(admin).toHaveBeenLastCalledWith(token, { action: 'list' });
    expect((await post({ action: 'list' }, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await fetch(`${base}/api/admin/settings`)).status).toBe(400);
  });
});
