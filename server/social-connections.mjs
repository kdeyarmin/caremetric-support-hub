import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { HttpError, transaction, withSession } from './sms-auth.mjs';
import { settingsCatalog, settingInput } from './hub-settings.mjs';
import { socialConfig } from './agents/social/index.mjs';
import { metaClient } from './agents/social/meta.mjs';
import { adAccountRoles, linkedinClient } from './agents/social/linkedin.mjs';

export const socialConnectionsFeature = 'platform.social-connections.v1';
export const connectionFields = {
  meta: { pageId: 'social.meta_page_id', instagramId: 'social.instagram_id', adAccountId: 'social.meta_ad_account_id' },
  linkedin: { organizationId: 'social.linkedin_organization_id', adAccountId: 'social.linkedin_ad_account_id', clientId: 'social.linkedin_client_id', adsClientId: 'social.linkedin_ads_client_id' },
};
const secretFields = {
  meta: { token: 'HUB_META_ACCESS_TOKEN' },
  linkedin: { token: 'HUB_LINKEDIN_ACCESS_TOKEN', refreshToken: 'HUB_LINKEDIN_REFRESH_TOKEN', clientSecret: 'HUB_LINKEDIN_CLIENT_SECRET',
    adsToken: 'HUB_LINKEDIN_ADS_ACCESS_TOKEN', adsRefreshToken: 'HUB_LINKEDIN_ADS_REFRESH_TOKEN', adsClientSecret: 'HUB_LINKEDIN_ADS_CLIENT_SECRET',
    // The founder's own profile ("Share on LinkedIn"): posts the owner approves one by one (20261113220000_founder_posts.sql).
    memberToken: 'HUB_LINKEDIN_MEMBER_ACCESS_TOKEN' },
};
// Secrets added after a connection may have been saved: a stored set without them still opens, and reads them as empty.
const laterSecrets = { meta: [], linkedin: ['memberToken'] };
const providers = Object.keys(connectionFields);
const accountSettings = new Set(Object.values(connectionFields).flatMap(Object.values));
const variables = Object.values(secretFields).flatMap(Object.values);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const catalog = new Map(settingsCatalog.map(entry => [entry.key, entry]));
const unavailable = () => new HttpError(503, 'Social connection storage is unavailable. Refresh and try again.');

function keyBytes(key) {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/i.test(key)) throw unavailable();
  return Buffer.from(key, 'hex');
}
export function sealConnection(provider, value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(key), iv);
  cipher.setAAD(Buffer.from(`caremetric-social:v1:${provider}`));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}
export function openConnection(provider, ciphertext, key) {
  try {
    if (typeof ciphertext !== 'string' || ciphertext.length > 90000 || !/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(ciphertext)) throw unavailable();
    const [, nonce, tag, data] = ciphertext.split('.').map((part, i) => i ? Buffer.from(part, 'base64url') : part);
    if (nonce.length !== 12 || tag.length !== 16) throw unavailable();
    const cipher = createDecipheriv('aes-256-gcm', keyBytes(key), nonce);
    cipher.setAAD(Buffer.from(`caremetric-social:v1:${provider}`)); cipher.setAuthTag(tag);
    const value = JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8'));
    const keys = Object.keys(secretFields[provider]);
    if (!object(value) || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key) && !laterSecrets[provider].includes(key))
      || Object.values(value).some(item => typeof item !== 'string' || item.length > 8192)) throw unavailable();
    return Object.fromEntries(keys.map(key => [key, value[key] ?? '']));
  } catch { throw unavailable(); }
}

/** Accept the numeric Page id, LinkedIn organization URN or numeric admin URL. Never fetch a pasted URL. */
export function connectionValue(provider, field, value) {
  if (typeof value !== 'string' || value.length > 1000) throw new HttpError(400, 'Enter an account ID or supported Page link.');
  let text = value.trim();
  if (((provider === 'linkedin' && field === 'organizationId') || (provider === 'meta' && field === 'pageId')) && /^[^\s/@]+@[^\s/@]+$/.test(text)) {
    throw new HttpError(400, provider === 'linkedin'
      ? 'That looks like an email address. Enter the Company Page’s numeric ID or admin link. Your LinkedIn email and password are only for signing in to LinkedIn.'
      : 'That looks like an email address. Enter the Facebook Page’s numeric ID. Your Facebook email and password are only for signing in to Facebook.');
  }
  if (provider === 'linkedin' && field === 'organizationId') {
    text = text.replace(/^urn:li:organization:/, '');
    if (/^https:\/\//i.test(text)) {
      let url; try { url = new URL(text); } catch { /* Invalid URL is rejected by the setting validator. */ }
      if (url && ['www.linkedin.com', 'linkedin.com'].includes(url.hostname) && !url.username && !url.password && !url.port) {
        text = /^\/company\/(\d{1,30})(?:\/|$)/.exec(url.pathname)?.[1] ?? text;
      }
    }
  }
  if (provider === 'meta' && field === 'pageId' && /^https:\/\//i.test(text)) {
    let url; try { url = new URL(text); } catch { /* See validator below. */ }
    if (url && ['facebook.com', 'www.facebook.com', 'm.facebook.com'].includes(url.hostname) && !url.username && !url.password && !url.port && url.pathname === '/profile.php') text = url.searchParams.get('id') ?? text;
  }
  return settingInput(catalog.get(connectionFields[provider][field]), text);
}

// What the ads person's role on a LinkedIn ad account allows: only a Campaign manager, Account manager or Billing admin creates campaigns.
const roleMessage = account => ({ role, canCreateCampaigns }) => {
  const where = /^[0-9]{1,30}$/.test(String(account ?? '')) ? ` ${account}` : '';
  if (!role) return { ok: false, message: `Ad account role: the person who authorized the advertising connection has no role on ad account${where}. In Campaign Manager → Account settings → Manage access, add them as a Campaign manager or Account manager, then reconnect.` };
  if (!canCreateCampaigns) return { ok: false, message: `Ad account role: ${adAccountRoles[role]} on ad account${where}, which cannot create campaigns. In Campaign Manager → Account settings → Manage access, make them a Campaign manager or Account manager.` };
  return { ok: true, message: `Ad account role: ${adAccountRoles[role]} on ad account${where}, which can create campaigns.` };
};

const failureMessage = (code, advertising = false) => {
  if (/token_invalid$/.test(code)) {
    const provider = code.startsWith('linkedin_') ? 'LinkedIn' : 'Meta';
    return `${provider} rejected the access token. It may be invalid, expired or revoked. Follow step 4 of the ${provider} setup instructions to generate a replacement ${provider === 'LinkedIn' ? 'in OAuth Token Tools' : 'under Business Suite → Settings → Users → System users'}, then save it here. Your sign-in password cannot be used as an access token.`;
  }
  if (advertising && /permission$/.test(code)) return code.startsWith('linkedin_')
    ? 'LinkedIn denied advertising access. Check Advertising API approval, the ad account assignment for a Development app, account roles, and r_ads, rw_ads, r_ads_reporting, r_organization_social and w_organization_social. Conversion reporting also needs Conversions API approval and rw_conversions. A Page connection alone does not establish ad access.'
    : 'Meta denied advertising access. Check the system user’s ad account assignment, ads_read and ads_management permissions, and the app’s Marketing API access. A Page connection alone does not establish ad access.';
  if (/permission$/.test(code)) return code.startsWith('linkedin_')
    ? 'LinkedIn denied access. Check your app’s Community Management API approval, the token’s permissions, and that the person who authorized it is an administrator of this Company Page. See setup steps 2–4.'
    : 'Meta denied access. Check that the system user has both the Page and app assigned, and that the token includes the app’s approved Page permissions. See setup steps 2–4.';
  if (/rate_limited$/.test(code)) return 'The provider is limiting requests. Try the connection check again later.';
  if (/invalid_request$/.test(code)) return 'The provider could not read this account. Check the numeric account ID, app access and API version.';
  return 'The provider could not be reached or the check did not finish. Your saved details are unchanged; try again.';
};

export function socialConnections({ pool, features, settings, env = process.env, fetchImpl = fetch, log = console, refreshMs = 30000,
  session = (token, work) => withSession(pool, token, work),
  // One SQL statement gives credentials and account settings the same MVCC snapshot.
  read = () => transaction(pool, async db => (await db.query("select jsonb_build_object('connections', private.social_connection_values(), 'settings', private.hub_settings_values()) as result")).rows[0].result),
}) {
  const declared = features?.has(socialConnectionsFeature) === true;
  let cached = null, timer = null, refreshing = null;
  const fallback = provider => Object.fromEntries(Object.entries(secretFields[provider]).map(([field, variable]) => [field, env[variable] ?? '']));
  const decode = rows => {
    if (!Array.isArray(rows) || rows.length !== 2 || providers.some(provider => rows.filter(row => row.provider === provider).length !== 1)) throw unavailable();
    return Object.fromEntries(rows.map(row => [row.provider, { revision: row.revision,
      secrets: row.ciphertext === null ? fallback(row.provider) : openConnection(row.provider, row.ciphertext, env.HUB_SOCIAL_CREDENTIALS_KEY) }]));
  };
  // Never continue using cached/replaced credentials after a failed read or decryption.
  async function refresh() {
    if (!declared) return;
    if (!refreshing) refreshing = (async () => {
      try {
        const snapshot = await read();
        if (!object(snapshot?.settings)) throw unavailable();
        cached = { connections: decode(snapshot.connections), settings: snapshot.settings };
      } catch { cached = null; throw unavailable(); } finally { refreshing = null; }
    })();
    return refreshing;
  }
  function resolvedEnv() {
    if (!declared) return env;
    const next = { ...env };
    for (const variable of variables) next[variable] = '';
    if (cached) for (const provider of providers) for (const [field, variable] of Object.entries(secretFields[provider])) next[variable] = cached.connections[provider].secrets[field];
    return next;
  }
  // Workers consume the paired account IDs/client IDs, even if the general settings
  // cache is refreshed earlier or later. Other settings retain their usual live reader.
  function getSetting(key) {
    if (!declared || !accountSettings.has(key)) return settings.get(key);
    return cached?.settings[key] ?? catalog.get(key)?.default;
  }
  async function start() {
    if (!declared) return;
    await refresh().catch(() => log.warn?.('Social credentials unavailable; social provider access is paused until storage recovers.'));
    timer = setInterval(() => { void refresh().catch(() => log.warn?.('Social credentials unavailable; social provider access is paused until storage recovers.')); }, refreshMs);
    timer.unref?.();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  async function snapshot(token, command = false) {
    return session(token, async db => {
      await db.query(command ? 'select hub.authorize_app_command()' : 'select hub.authorize_app_admin()');
      if (!declared) return null;
      const values = (await db.query('select hub.get_hub_settings() as result')).rows[0].result;
      await db.query('reset role');
      const connections = decode((await db.query('select private.social_connection_values() as result')).rows[0].result);
      return { connections, values: new Map(values.map(row => [row.key, row])) };
    });
  }
  function view(state) {
    const editable = declared && /^[a-f0-9]{64}$/i.test(env.HUB_SOCIAL_CREDENTIALS_KEY ?? '');
    return { editable, message: editable ? null : 'Secure credential storage is not enabled yet. Contact the Hub administrator.',
      connections: state ? providers.map(provider => ({ provider, revision: state.connections[provider].revision,
        fields: Object.fromEntries(Object.entries(connectionFields[provider]).map(([field, key]) => [field, { value: state.values.get(key)?.value ?? '', changedAt: state.values.get(key)?.changedAt }])),
        secrets: Object.fromEntries(Object.entries(state.connections[provider].secrets).map(([field, value]) => [field, Boolean(value)])),
      })) : [] };
  }
  async function list(token) { return view(await snapshot(token)); }

  async function save(token, input) {
    if (!exact(input, ['action','provider','revision','fields','secrets']) || !providers.includes(input.provider) || typeof input.revision !== 'string' || !uuid.test(input.revision)
      || !exact(input.fields, Object.keys(connectionFields[input.provider])) || !object(input.secrets)
      || Object.keys(input.secrets).some(key => !Object.hasOwn(secretFields[input.provider], key))) throw new HttpError(400, 'Invalid social connection.');
    if (!declared) throw unavailable();
    keyBytes(env.HUB_SOCIAL_CREDENTIALS_KEY);
    const changes = Object.entries(connectionFields[input.provider]).map(([field, key]) => {
      const item = input.fields[field];
      if (!exact(item, ['value','changedAt']) || typeof item.changedAt !== 'string' || !instant.test(item.changedAt) || !Number.isFinite(Date.parse(item.changedAt))) throw new HttpError(400, 'Refresh these account details before saving.');
      return { key, value: connectionValue(input.provider, field, item.value), changedAt: item.changedAt };
    });
    const patch = {};
    for (const [field, value] of Object.entries(input.secrets)) {
      if (value === null) { patch[field] = ''; continue; }
      if (typeof value !== 'string') throw new HttpError(400, 'Paste the token or secret as plain text.');
      const tidy = value.trim();
      if (!tidy) continue; // Blank means keep, null explicitly clears a secret.
      if (tidy.length < (field.toLowerCase().includes('token') ? 20 : 4) || tidy.length > 8192 || /\s|[\u0000-\u001f\u007f]/.test(tidy)) throw new HttpError(400, 'The token or secret is incomplete. Paste its full value without spaces.');
      patch[field] = tidy;
    }
    await session(token, async db => {
      await db.query('select hub.authorize_app_command()');
      await db.query('reset role');
      const current = decode((await db.query('select private.social_connection_values() as result')).rows[0].result);
      const secrets = { ...current[input.provider].secrets, ...patch };
      const ciphertext = sealConnection(input.provider, secrets, env.HUB_SOCIAL_CREDENTIALS_KEY);
      await db.query('select private.save_social_connection($1,$2,$3,$4::jsonb)', [input.provider, input.revision, ciphertext, JSON.stringify(changes)]);
    });
    // Do not report a committed save as failed if the next refresh has a transient failure.
    await refresh().catch(() => {});
    await settings.refresh().catch(() => {});
    return { saved: true };
  }

  async function check(token, provider) {
    const state = await snapshot(token, true);
    if (!state) throw unavailable();
    const supplied = { ...env };
    for (const [field, variable] of Object.entries(secretFields[provider])) supplied[variable] = state.connections[provider].secrets[field];
    const config = socialConfig(supplied, key => state.values.get(key)?.value ?? catalog.get(key)?.default);
    const client = provider === 'meta' ? metaClient({ ...config.meta, fetchImpl }) : linkedinClient({ ...config.linkedin, fetchImpl });
    const pageConfigured = provider === 'meta' ? client.configured.pages : client.configured.page;
    if (!pageConfigured && !client.configured.ads) return { ok: false, message: 'Save a Page or ad account ID and access token before checking the connection.' };
    const signal = AbortSignal.timeout(20000);
    // LinkedIn: the role on the ad account of the person whose token the ads connection uses (review 2026-11-19), read only.
    const roleCheck = provider === 'linkedin' && client.configured.ads && typeof client.adAccountRole === 'function';
    const checks = await Promise.all([
      ...(pageConfigured ? [{ label: 'Page', advertising: false, read: () => client.checkConnection({ signal, includeAds: false }) }] : []),
      ...(client.configured.ads ? [{ label: 'Advertising data', advertising: true, read: () => client.adsOverview({ signal }) }] : []),
      ...(roleCheck ? [{ label: 'Ad account role', advertising: true, read: () => client.adAccountRole({ signal }), describe: roleMessage(client.ids?.account) }] : []),
    ].map(async ({ label, advertising, read, describe }) => {
      try { const result = await read(); return describe ? describe(result) : { ok: true, message: `${label} read access verified.` }; }
      catch (error) { return { ok: false, message: `${label}: ${failureMessage(String(error?.code ?? ''), advertising)}` }; }
    }));
    return { ok: checks.every(check => check.ok), message: [
      ...checks.map(check => check.message),
      ...(!client.configured.ads ? ['Advertising is not configured.'] : []),
      `Publishing permission, ${roleCheck ? 'the token\'s own ' : ''}campaign-write permission${roleCheck ? ' (rw_ads)' : ''}, conversion reporting and ad delivery are not verified by this read-only check. No content was published and no campaign was created or changed.`,
    ].join(' ') };
  }
  async function admin(token, input) {
    if (exact(input, ['action']) && input.action === 'list') return list(token);
    if (input?.action === 'save') return save(token, input);
    if (exact(input, ['action','provider']) && input.action === 'check' && providers.includes(input.provider)) return check(token, input.provider);
    throw new HttpError(400, 'Invalid social connection request.');
  }
  return { start, stop, refresh, resolvedEnv, getSetting, admin, list, save, check };
}
