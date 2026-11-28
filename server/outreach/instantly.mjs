/**
 * Instantly's API (v2) for state launches: create a campaign as a draft, add its leads, start it when the owner clicks Launch, and keep the
 * Hub's webhook subscribed so replies and opt-outs reach the Hub. INSTANTLY_API_KEY (Railway; an API key with all scopes from Instantly's
 * Settings → Integrations) goes in a header, never a URL, a log, an error or a result.
 */
import { live } from '../live.mjs';

const base = 'https://api.instantly.ai/api/v2';
const timeoutMs = 30_000;
const maxBytes = 2_000_000;
/** Instantly takes at most 1,000 leads in one request. */
export const leadsPerRequest = 500;

/**
 * A draft campaign as Pennsylvania's were set up by hand: the owner's sequence, his Instantly mailboxes, weekdays 8:00 to 16:00 in the
 * state's time zone, ten minutes between emails, at most `dailyLimit` a day from each mailbox, stopping for a lead who replies (an
 * automatic reply does not stop it), no open or link tracking.
 */
export function campaignBody({ name, sequences, senders, dailyLimit = 30, timezone = 'America/Detroit' }) {
  return {
    name: String(name).slice(0, 200), sequences, email_list: senders, daily_limit: dailyLimit, email_gap: 10,
    stop_on_reply: true, stop_on_auto_reply: false, open_tracking: false, link_tracking: false, text_only: false,
    campaign_schedule: { schedules: [{ name: 'Weekdays', timing: { from: '08:00', to: '16:00' },
      days: { 0: false, 1: true, 2: true, 3: true, 4: true, 5: true, 6: false }, timezone }] },
  };
}

/** A facility's person as an Instantly lead: the names and variables the copy fills ({{firstName}}, {{county}}, {{companyName}}). */
export function leadFor(person, { state } = {}) {
  return {
    email: person.email, first_name: person.firstName ?? '', last_name: person.lastName ?? '',
    company_name: person.segment === 'chain' || person.segment === 'regional' ? (person.chainName ?? person.name) : person.name,
    website: person.domain ? `https://${person.domain}` : undefined,
    custom_variables: { county: person.county ?? '', state: state ?? '', setting: person.setting, ccn: person.ccn, title: person.title ?? '',
      facility: person.name },
  };
}

export function instantlyClient({ apiKey = '', fetchImpl = globalThis.fetch } = {}) {
  const key = () => String(live(apiKey) ?? '').trim();
  async function call(method, path, body = undefined, { signal } = {}) {
    if (!key()) throw Object.assign(new Error('Instantly is not configured'), { code: 'instantly_not_configured' });
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, { method, redirect: 'error', cache: 'no-store',
        headers: { accept: 'application/json', authorization: `Bearer ${key()}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw Object.assign(new Error('Instantly could not be reached'), { code: 'instantly_unavailable', retryable: true });
    }
    const text = await response.text();
    if (!response.ok) {
      const code = [401, 403].includes(response.status) ? 'instantly_refused' : response.status === 429 ? 'instantly_limited' : response.status === 402 ? 'instantly_plan'
        : response.status >= 500 ? 'instantly_unavailable' : 'instantly_rejected';
      // Instantly's own words for a rejected request (a field it refused), never the request itself.
      let reason = '';
      try { reason = String(JSON.parse(text)?.message ?? '').slice(0, 200); } catch { /* Not JSON. */ }
      throw Object.assign(new Error(`Instantly answered ${response.status}${reason ? `: ${reason}` : ''}`), { code, retryable: code === 'instantly_unavailable' || code === 'instantly_limited' });
    }
    if (text.length > maxBytes) throw Object.assign(new Error('Instantly answered too much'), { code: 'instantly_invalid' });
    try { return text ? JSON.parse(text) : {}; } catch { throw Object.assign(new Error('Instantly answered something else'), { code: 'instantly_invalid' }); }
  }
  return {
    get configured() { return key().length > 0 && typeof fetchImpl === 'function'; },
    async createCampaign(body, { signal } = {}) {
      const created = await call('POST', '/campaigns', body, { signal });
      if (!/^[0-9a-f-]{36}$/.test(String(created?.id ?? ''))) throw Object.assign(new Error('Instantly gave no campaign id'), { code: 'instantly_invalid' });
      return { id: created.id, name: created.name ?? body.name };
    },
    /** Adds up to 1,000 leads, skipping any already anywhere in the workspace (and on its blocklist): { uploaded, skipped, remaining }. */
    async addLeads(campaignId, leads, { signal } = {}) {
      const answer = await call('POST', '/leads/add', { campaign_id: campaignId, skip_if_in_workspace: true, skip_if_in_campaign: true,
        verify_leads_on_import: false, leads }, { signal });
      const uploaded = Number(answer?.leads_uploaded ?? answer?.created_leads?.length ?? 0);
      return { uploaded, skipped: Math.max(0, leads.length - uploaded), remaining: Number.isFinite(Number(answer?.remaining_in_plan)) ? Number(answer.remaining_in_plan) : null,
        created: Array.isArray(answer?.created_leads) ? answer.created_leads.map(lead => String(lead?.email ?? '').toLowerCase()).filter(Boolean) : null };
    },
    activate: (campaignId, { signal } = {}) => call('POST', `/campaigns/${campaignId}/activate`, {}, { signal }),
    /** The campaign's status in Instantly: 0 draft, 1 active, 2 paused, 3 completed (or another number Instantly adds). */
    async campaignStatus(campaignId, { signal } = {}) { const campaign = await call('GET', `/campaigns/${campaignId}`, undefined, { signal }); return Number(campaign?.status); },
    async webhooks({ signal } = {}) { const answer = await call('GET', '/webhooks?limit=100', undefined, { signal }); return Array.isArray(answer?.items) ? answer.items : []; },
    createWebhook: (body, { signal } = {}) => call('POST', '/webhooks', body, { signal }),
  };
}
