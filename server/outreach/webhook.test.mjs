import { describe, expect, it, vi } from 'vitest';
import { classifyReply, keyMatches, ownWords, readEvent, sendCountyReport, webhookKeyFor } from './webhook.mjs';
import { campaignBody, instantlyClient, leadFor } from './instantly.mjs';

describe('what a reply says', () => {
  it('reads only the sender\'s own words', () => {
    expect(ownWords('Yes please\n\nOn Tue, Dec 1, 2026 at 9:00 AM Kevin wrote:\n> Want a free report? Just reply "no thanks"')).toBe('Yes please');
    expect(ownWords('Sure!\n-----Original Message-----\nFrom: Kevin')).toBe('Sure!');
  });

  it('tells a yes from a no and from everything else', () => {
    for (const text of ['Yes', 'yes please!', 'Sure, send it', 'Please send', 'ok', 'Yes, I would like the Hamilton report']) expect(classifyReply(text), text).toBe('yes');
    for (const text of ['No thanks', 'not interested', 'Please remove me from your list', 'Unsubscribe', 'STOP', 'no']) expect(classifyReply(text), text).toBe('no');
    for (const text of ['Who are you?', 'Yes but not now', 'Can we talk next week?', '', 'Call me']) expect(classifyReply(text), text).toBe('other');
    for (const text of ['I am out of the office until Monday', 'Automatic reply: thank you for your email', 'Jane is no longer with the company']) expect(classifyReply(text), text).toBe('auto');
    // A quoted "no thanks" from the email itself is never the sender's answer.
    expect(classifyReply('What does it cost?\n\nOn Mon Kevin wrote:\n> Not a fit? Reply "no thanks"')).toBe('other');
  });

  it('reads Instantly\'s events the Hub acts on, and leaves the rest', () => {
    const campaign = '01a22025-ddd5-70e2-97ec-decc9bca9484';
    expect(readEvent({ event_type: 'reply_received', lead_email: 'Jane@Valley.org', campaign_id: campaign, reply_text: 'Yes please' }))
      .toMatchObject({ kind: 'reply', email: 'jane@valley.org', campaign, answer: 'yes' });
    expect(readEvent({ event_type: 'reply_received', lead_email: 'jane@valley.org', reply_text_snippet: 'no thanks' })).toMatchObject({ answer: 'no', campaign: null });
    expect(readEvent({ event_type: 'lead_unsubscribed', lead_email: 'jane@valley.org' })).toMatchObject({ kind: 'opted_out' });
    expect(readEvent({ event_type: 'lead_not_interested', lead_email: 'jane@valley.org' })).toMatchObject({ kind: 'opted_out' });
    expect(readEvent({ event_type: 'email_bounced', lead_email: 'jane@valley.org' })).toMatchObject({ kind: 'bounced' });
    expect(readEvent({ event_type: 'email_sent', lead_email: 'jane@valley.org' })).toBeNull();
    expect(readEvent({ event_type: 'lead_out_of_office', lead_email: 'jane@valley.org' })).toBeNull();
    expect(readEvent({ event_type: 'reply_received', lead_email: 'not an address' })).toBeNull();
    expect(readEvent([])).toBeNull();
  });

  it('checks the key Instantly carries, made from the growth signing key', () => {
    const key = webhookKeyFor('s'.repeat(40));
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(webhookKeyFor('short')).toBeNull();
    expect(keyMatches(key, key)).toBe(true);
    expect(keyMatches(`${key.slice(0, -1)}0`, key)).toBe(key.endsWith('0'));
    expect(keyMatches(undefined, key)).toBe(false);
  });

  it('asks Intel for the county report as the Pennsylvania workflows do', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: null }));
    expect(await sendCountyReport({ state: 'OH', countyFips: '39061', email: 'jane@valley.org', utmCampaign: 'oh-snf', fetchImpl })).toEqual({ sent: true });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://www.caremetricintel.com/api/public/county-report');
    expect(JSON.parse(init.body)).toEqual({ state: 'OH', county_fips: '39061', email: 'jane@valley.org',
      attribution: { utmSource: 'cold-email', utmMedium: 'email', utmCampaign: 'oh-snf', utmContent: 'reply-yes' } });
    expect(await sendCountyReport({ state: 'OH', countyFips: null, email: 'x@y.org', fetchImpl })).toEqual({ sent: false, why: 'no_county' });
  });
});

describe('Instantly', () => {
  it('builds a draft campaign as Pennsylvania\'s were set up', () => {
    const body = campaignBody({ name: 'Ohio – Skilled nursing administrators', sequences: [{ steps: [] }], senders: ['kevin@getcaremetricintel.com'], dailyLimit: 30, timezone: 'America/Detroit' });
    expect(body).toMatchObject({ email_list: ['kevin@getcaremetricintel.com'], daily_limit: 30, email_gap: 10, stop_on_reply: true, open_tracking: false, link_tracking: false });
    expect(body.campaign_schedule.schedules[0]).toEqual({ name: 'Weekdays', timing: { from: '08:00', to: '16:00' },
      days: { 0: false, 1: true, 2: true, 3: true, 4: true, 5: true, 6: false }, timezone: 'America/Detroit' });
  });

  it('fills the copy\'s variables from each person', () => {
    expect(leadFor({ email: 'jane@valley.org', firstName: 'Jane', lastName: 'Doe', name: 'Valley Hospice', segment: 'agency', county: 'Summit', setting: 'hospice',
      ccn: '361001', title: 'Owner', domain: 'valley.org' }, { state: 'OH' })).toEqual({ email: 'jane@valley.org', first_name: 'Jane', last_name: 'Doe', company_name: 'Valley Hospice',
      website: 'https://valley.org', custom_variables: { county: 'Summit', state: 'OH', setting: 'hospice', ccn: '361001', title: 'Owner', facility: 'Valley Hospice' } });
    expect(leadFor({ email: 'lee@arcadia.com', name: 'Edith Lane', chainName: 'Arcadia Care', segment: 'chain' }).company_name).toBe('Arcadia Care');
  });

  it('sends the key as a bearer header and reads Instantly\'s answers', async () => {
    const fetchImpl = vi.fn(async (url, init) => ({ ok: true, status: 200, text: async () => JSON.stringify(String(url).endsWith('/campaigns') ? { id: '01a22025-ddd5-70e2-97ec-decc9bca9484', name: 'x' }
      : { leads_uploaded: 1, remaining_in_plan: 400, created_leads: [{ email: 'Jane@Valley.org' }] }) }));
    const client = instantlyClient({ apiKey: 'inst-key', fetchImpl });
    expect(await client.createCampaign({ name: 'x' })).toEqual({ id: '01a22025-ddd5-70e2-97ec-decc9bca9484', name: 'x' });
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe('Bearer inst-key');
    expect(String(fetchImpl.mock.calls[0][0])).not.toContain('inst-key');
    expect(await client.addLeads('01a22025-ddd5-70e2-97ec-decc9bca9484', [{ email: 'jane@valley.org' }, { email: 'old@valley.org' }]))
      .toEqual({ uploaded: 1, skipped: 1, remaining: 400, created: ['jane@valley.org'] });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toMatchObject({ campaign_id: '01a22025-ddd5-70e2-97ec-decc9bca9484', skip_if_in_workspace: true });
    const refused = instantlyClient({ apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 401, text: async () => '{"message":"Invalid API key"}' }) });
    await expect(refused.activate('01a22025-ddd5-70e2-97ec-decc9bca9484')).rejects.toMatchObject({ code: 'instantly_refused' });
    await expect(instantlyClient({ apiKey: '' }).webhooks()).rejects.toMatchObject({ code: 'instantly_not_configured' });
  });
});
