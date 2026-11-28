import { describe, expect, it, vi } from 'vitest';
import { launchHandlers, stateLaunches, stateLaunchesFeature, webhookEvents } from './launch.mjs';
import { webhookHeader, webhookKeyFor } from './webhook.mjs';

const signingKey = 'k'.repeat(40);
const campaignIds = ['01a22025-ddd5-70e2-97ec-decc9bca9484', '01a22041-dcaa-750b-a51e-3c80d6742fbf', '01a22053-bc99-7100-b2a6-6290fcca0fdc'];
const order = t => (t.segment === 'chain' ? 0 : t.segment === 'regional' ? 1 : t.segment === 'local' ? 2 : 3);

// The database's functions, in memory, as 20261128100000_state_launches.sql defines them.
function memoryStore({ blocked = new Set() } = {}) {
  const launches = new Map(); const targets = []; const forbidden = new Set();
  const copy = value => structuredClone(value);
  return {
    launches, targets, forbidden,
    queue(state) { const id = `00000000-0000-4000-8000-00000000000${launches.size + 1}`; launches.set(id, { id, state, status: 'queued', stage: 'gather', progress: {}, campaigns: {}, summary: {} }); return id; },
    next: async () => {
      const open = [...launches.values()].filter(l => ['queued', 'building', 'launching'].includes(l.status)).sort((a, b) => Number(b.status === 'launching') - Number(a.status === 'launching'));
      const l = open[0];
      if (!l) return null;
      if (l.status === 'queued') Object.assign(l, { status: 'building', stage: 'gather' });
      return copy({ id: l.id, state: l.state, status: l.status, stage: l.stage, progress: l.progress, campaigns: l.campaigns });
    },
    save: async (id, patch) => {
      const l = launches.get(id);
      if (!['building', 'launching'].includes(l.status)) return false;
      for (const key of ['status', 'stage', 'progress', 'summary', 'campaigns', 'error']) if (patch[key] !== undefined) l[key] = copy(patch[key]);
      return true;
    },
    addTargets: async (id, rows) => { for (const row of rows) targets.push({ ...copy(row), id: `t${targets.length + 1}`, launchId: id, status: row.hold ? 'held' : 'pending', note: row.hold ?? null }); return rows.length; },
    pending: async (id, limit) => copy(targets.filter(t => t.launchId === id && t.status === 'pending').sort((a, b) => order(a) - order(b) || (a.size ?? 1e9) - (b.size ?? 1e9)).slice(0, limit)),
    targetSave: async (tid, patch) => { const t = targets.find(x => x.id === tid); Object.assign(t, copy(patch)); if (patch.status !== 'not_found') t.note = null; return true; },
    leads: async id => copy(targets.filter(t => t.launchId === id && t.status === 'found').sort((a, b) => order(a) - order(b))
      .map(t => ({ ...t, blocked: blocked.has(t.email) || forbidden.has(t.email) ? 'do_not_contact' : null }))),
    mark: async (ids, status, note, campaign) => { for (const t of targets) if (ids.includes(t.id) && t.status === 'found') Object.assign(t, { status, note, campaignId: campaign }); return ids.length; },
    event: async (campaign, email, kind) => {
      if (kind === 'opted_out') forbidden.add(email);
      const t = targets.find(x => x.email === email);
      if (!t) return { target: null };
      t.status = kind === 'opted_out' ? 'opted_out' : kind === 'bounced' ? 'bounced' : 'replied';
      return { target: { ...copy(t), reportSent: Boolean(t.reportSentAt), state: launches.get(t.launchId).state } };
    },
    reportClaim: async tid => { const t = targets.find(x => x.id === tid); if (t.reportSentAt) return false; t.reportSentAt = 'now'; return true; },
  };
}

const cmsRows = [
  { cms_certification_number_ccn: '365001', provider_name: 'EDITH LANE OF CINCINNATI', citytown: 'CINCINNATI', state: 'OH', zip_code: '45211', countyparish: 'Hamilton',
    ownership_type: 'For profit - Corporation', number_of_certified_beds: '167', provider_resides_in_hospital: 'N', chain_name: 'ARCADIA CARE', chain_id: '42', number_of_facilities_in_chain: '25' },
  { cms_certification_number_ccn: '365002', provider_name: 'MAPLE GROVE NURSING', citytown: 'AKRON', state: 'OH', zip_code: '44301', countyparish: 'Summit',
    ownership_type: 'Non profit - Church related', number_of_certified_beds: '60', provider_resides_in_hospital: 'N', chain_name: '', chain_id: '', number_of_facilities_in_chain: '' },
  { cms_certification_number_ccn: '365003', provider_name: 'GENERAL HOSPITAL TCU', citytown: 'AKRON', state: 'OH', zip_code: '44301', countyparish: 'Summit',
    ownership_type: 'Non profit - Other', number_of_certified_beds: '20', provider_resides_in_hospital: 'Y' },
];
const feed = {
  configured: true, paceMs: 0,
  counties: vi.fn(async () => ({ counties: [{ county_fips: '39061', county_name: 'Hamilton County', state: 'OH' }, { county_fips: '39153', county_name: 'Summit County', state: 'OH' }] })),
  roster: vi.fn(async () => ({ items: [
    { ccn: '367001', name: 'VALLEY HOSPICE', setting: 'hospice', city: 'Akron', state: 'OH', zip: '44301', county_fips: '39153', control_type: 'Proprietary', signals: [], volume: { medicare_patients: 40 } },
    { ccn: '367002', name: 'BAYADA HOME HEALTH CARE', setting: 'home_health', city: 'Akron', state: 'OH', zip: '44301', county_fips: '39153', control_type: 'Proprietary', signals: [] },
  ], next_cursor: null })),
  agencyFacts: vi.fn(async () => ({ agencies: [] })),
};
const person = (value, position) => { const [first, last] = value.split('@')[0].split('.'); return { value, type: 'personal', confidence: 96, first_name: first, last_name: last, position, verification: { status: 'valid' } }; };
const directory = {
  'Arcadia Care': { result: 'found', domain: 'arcadiacare.com', organization: 'Arcadia Care', charged: 1, emails: [person('lee.vance@arcadiacare.com', 'VP of Business Development')] },
  'Maple Grove Nursing': { result: 'found', domain: 'maplegrovenursing.org', organization: 'Maple Grove', charged: 1, emails: [person('ann.adams@maplegrovenursing.org', 'Administrator')] },
  'Valley Hospice': { result: 'found', domain: 'valleyhospice.com', organization: 'Valley Hospice', charged: 1, emails: [person('mary.smith@valleyhospice.com', 'Owner')] },
};
const hunter = () => ({ configured: true, company: vi.fn(async ({ name }) => directory[name] ?? { result: 'not_found', charged: 0 }), person: vi.fn(async () => ({ result: 'not_found', charged: 0 })) });
function instantlyFake() {
  let made = 0;
  return { configured: true, created: [], leads: [], activated: [], hooks: [],
    async createCampaign(body) { const id = campaignIds[made++]; this.created.push({ id, ...body }); return { id, name: body.name }; },
    async addLeads(id, leads) { this.leads.push({ id, leads }); return { uploaded: leads.length, skipped: 0, remaining: 300, created: leads.map(lead => lead.email) }; },
    async activate(id) { this.activated.push(id); return {}; },
    async webhooks() { return this.hooks; },
    async createWebhook(body) { this.hooks.push({ ...body, status: 1 }); return {}; },
  };
}
const fetchFor = (calls = []) => vi.fn(async (url, init) => {
  calls.push([String(url), init]);
  if (String(url).startsWith('https://data.cms.gov/')) return { ok: true, status: 200, text: async () => JSON.stringify({ count: cmsRows.length, results: cmsRows }) };
  return { ok: true, status: 200, body: null };
});
const notifierFake = () => ({ sent: [], send: vi.fn(async function (message) { this.sent.push(message); return { delivery: 'sent' }; }) });

function setup({ senders = ['kevin@getcaremetricintel.com'], hunterPerLaunch = 400, blocked } = {}) {
  const store = memoryStore({ blocked });
  const instantly = instantlyFake();
  const calls = [];
  const launches = stateLaunches({ store, feed, hunter: hunter(), instantly, features: new Set([stateLaunchesFeature]), senders, signingKey,
    publicOrigin: 'https://hub.example.com', fetchImpl: fetchFor(calls), sleep: async () => {}, paceMs: 0, hunterPerLaunch });
  const notifier = notifierFake();
  const handlers = launchHandlers({ launches, notifier });
  const run = () => handlers['outreach.launch']({ agentKey: 'marketing_manager', id: 'task-1', agent: { autonomy: 'act' } });
  return { store, instantly, launches, notifier, run, calls };
}

describe('a state launch, from the owner\'s choice to Launch', () => {
  it('builds the state in Instantly the way Pennsylvania was built, and sends nothing until Launch', async () => {
    const { store, instantly, notifier, run } = setup({ blocked: new Set(['ann.adams@maplegrovenursing.org']) });
    const id = store.queue('OH');

    expect((await run()).result).toMatchObject({ state: 'OH', stage: 'gather', gathered: 5 });
    const by = Object.fromEntries(store.targets.map(t => [t.ccn, t]));
    expect(by['365001']).toMatchObject({ segment: 'chain', status: 'pending', countyFips: '39061', county: 'Hamilton' });
    expect(by['365003']).toMatchObject({ status: 'held', note: 'hospital_based' });
    expect(by['367002']).toMatchObject({ status: 'held', note: 'national_chain' });
    expect(store.launches.get(id).stage).toBe('contacts');

    expect((await run()).result).toMatchObject({ stage: 'contacts', looked: 3 });
    expect(by['365001']).toBeDefined();
    expect(store.targets.find(t => t.ccn === '365001')).toMatchObject({ status: 'found', email: 'lee.vance@arcadiacare.com', firstName: 'Lee', title: 'VP of Business Development' });
    expect(store.launches.get(id)).toMatchObject({ stage: 'campaigns', progress: { hunterSearches: 3, found: 3 } });

    expect((await run()).result).toMatchObject({ stage: 'campaigns', ready: 2 });
    expect(instantly.created.map(c => c.name)).toEqual(['Ohio – Home health & hospice owners', 'Ohio – Chains – corporate']);
    const agencyCampaign = instantly.created[0];
    expect(agencyCampaign).toMatchObject({ email_list: ['kevin@getcaremetricintel.com'], daily_limit: 30, campaign_schedule: { schedules: [{ timezone: 'America/Detroit' }] } });
    expect(JSON.stringify(agencyCampaign.sequences)).toContain('utm_campaign=oh-starter');
    expect(instantly.leads.flatMap(batch => batch.leads.map(lead => lead.email))).toEqual(['mary.smith@valleyhospice.com', 'lee.vance@arcadiacare.com']);
    // The do-not-contact list wins over a person Hunter found.
    expect(store.targets.find(t => t.ccn === '365002')).toMatchObject({ status: 'skipped', note: 'do_not_contact' });
    expect(store.launches.get(id)).toMatchObject({ status: 'ready', summary: { leads: 2, skipped: { do_not_contact: 1 }, pendingLeft: false } });
    expect(instantly.activated).toEqual([]);
    expect(notifier.sent.at(-1)).toMatchObject({ subject: 'Ohio is ready to launch (2 people)', attention: 'decision' });
    expect(notifier.sent.at(-1).body).toContain('Nothing is sent until you open Growth → State launches and click Launch.');

    // Nothing else happens until the owner clicks Launch.
    expect((await run()).result).toEqual({ idle: true });
    store.launches.get(id).status = 'launching';
    expect((await run()).result).toMatchObject({ stage: 'launch', launched: 2 });
    expect(instantly.activated).toEqual([campaignIds[0], campaignIds[1]]);
    expect(store.launches.get(id).status).toBe('launched');
  });

  it('subscribes Instantly\'s webhook once, with the key made from the growth signing key', async () => {
    const { store, instantly, run } = setup();
    store.queue('OH');
    await run(); await run();
    expect(instantly.hooks.map(hook => hook.event_type)).toEqual([...webhookEvents]);
    expect(instantly.hooks[0]).toMatchObject({ target_hook_url: 'https://hub.example.com/api/growth/instantly', headers: { [webhookHeader]: webhookKeyFor(signingKey) } });
  });

  it('stops looking people up at the state\'s Hunter searches, and says the rest is left', async () => {
    const { store, run } = setup({ hunterPerLaunch: 1 });
    const id = store.queue('OH');
    await run(); await run();
    expect(store.launches.get(id)).toMatchObject({ stage: 'campaigns', progress: { stoppedAt: 'search_limit', hunterSearches: 1 } });
    await run();
    expect(store.launches.get(id)).toMatchObject({ status: 'ready', summary: { leads: 1, pendingLeft: true } });
  });

  it('waits, and says why once, without mailboxes', async () => {
    const { store, instantly, notifier, run } = setup({ senders: [] });
    const id = store.queue('OH');
    await run(); await run();
    expect((await run()).result).toMatchObject({ waiting: 'senders' });
    expect((await run()).result).toMatchObject({ waiting: 'senders' });
    expect(instantly.created).toEqual([]);
    expect(notifier.sent.filter(message => message.subject === 'Ohio is waiting for Instantly')).toHaveLength(1);
    expect(store.launches.get(id).status).toBe('building');
  });

  it('marks a run that cannot go on as failed, with nothing sent', async () => {
    const { store, launches, notifier } = setup();
    const id = store.queue('OH');
    const broken = stateLaunches({ store, feed, hunter: hunter(), instantly: instantlyFake(), features: [stateLaunchesFeature], senders: ['a@b.com'], signingKey,
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'not json' }), sleep: async () => {} });
    broken.useNotifier(notifier);
    expect((await broken.run({ agentKey: 'marketing_manager' })).result).toMatchObject({ failed: 'cms_invalid' });
    expect(store.launches.get(id)).toMatchObject({ status: 'failed' });
    expect(notifier.sent.at(-1).subject).toBe('The Ohio launch stopped');
    expect(launches.declared()).toBe(true);
  });
});

describe('Instantly\'s webhook', () => {
  async function built() {
    const context = setup();
    context.store.queue('OH');
    await context.run(); await context.run(); await context.run();
    return context;
  }
  const headers = { [webhookHeader]: webhookKeyFor(signingKey) };
  const reply = (email, text) => JSON.stringify({ event_type: 'reply_received', lead_email: email, campaign_id: campaignIds[0], campaign_name: 'Ohio – Home health & hospice owners', reply_text: text });

  it('refuses a request without the key', async () => {
    const { launches } = await built();
    await expect(launches.event(reply('mary.smith@valleyhospice.com', 'yes'), {})).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(launches.event('not json', headers)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('sends the county report once for a yes, and tells the owner', async () => {
    const { launches, notifier, calls } = await built();
    expect(await launches.event(reply('mary.smith@valleyhospice.com', 'Yes please!'), headers)).toEqual({ accepted: 1, recorded: 'report_sent' });
    const report = calls.find(([url]) => url.includes('county-report'));
    expect(JSON.parse(report[1].body)).toMatchObject({ state: 'OH', county_fips: '39153', email: 'mary.smith@valleyhospice.com', attribution: { utmCampaign: 'oh-starter' } });
    expect(notifier.sent.at(-1).subject).toBe('Mary Smith (Valley Hospice, Summit County) asked for the county report: sent');
    expect(await launches.event(reply('mary.smith@valleyhospice.com', 'yes'), headers)).toEqual({ accepted: 1, recorded: 'reply' });
    expect(calls.filter(([url]) => url.includes('county-report'))).toHaveLength(1);
  });

  it('puts a "no thanks" and an unsubscribe on the do-not-contact list, from any campaign', async () => {
    const { launches, store } = await built();
    expect(await launches.event(reply('mary.smith@valleyhospice.com', 'No thanks.'), headers)).toEqual({ accepted: 1, recorded: 'opted_out' });
    expect(store.forbidden.has('mary.smith@valleyhospice.com')).toBe(true);
    // A Pennsylvania campaign built by hand: the address still goes on the list.
    expect(await launches.event(JSON.stringify({ event_type: 'lead_unsubscribed', lead_email: 'someone@pa-agency.org', campaign_id: 'f00275f1-631f-4b7f-94e2-c121f78014a8' }), headers))
      .toEqual({ accepted: 1, recorded: 'opted_out' });
    expect(store.forbidden.has('someone@pa-agency.org')).toBe(true);
    expect(await launches.event(JSON.stringify({ event_type: 'email_opened', lead_email: 'x@y.org' }), headers)).toEqual({ accepted: 0 });
  });

  it('tells the owner about any other reply to a launch, and leaves hand-built campaigns\' replies to Instantly', async () => {
    const { launches, notifier } = await built();
    await launches.event(reply('lee.vance@arcadiacare.com', 'What does it cost for 25 buildings?'), headers);
    expect(notifier.sent.at(-1)).toMatchObject({ subject: 'Reply from Lee Vance (Edith Lane Of Cincinnati, Hamilton County)', attention: 'now' });
    expect(notifier.sent.at(-1).body).toContain('What does it cost for 25 buildings?');
    const before = notifier.sent.length;
    expect(await launches.event(reply('owner@pa-agency.org', 'Tell me more'), headers)).toEqual({ accepted: 1, recorded: 'reply' });
    expect(await launches.event(reply('mary.smith@valleyhospice.com', 'I am out of the office until Monday.'), headers)).toEqual({ accepted: 1, recorded: 'auto_reply' });
    expect(notifier.sent.length).toBe(before);
  });
});
