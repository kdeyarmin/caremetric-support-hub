import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { marketingToolkit } from './toolkit.mjs';
import { growthService } from '../growth/service.mjs';
import { socialConfig, socialTeam } from './social/index.mjs';
import { creativeConfig, creativeTeam } from './creative/index.mjs';
import { agentTeam } from './index.mjs';
import { servicesSchema } from '../../src/admin/teamProtocol.ts';

const secret = 'synthetic-credential-that-must-not-leak';
const features = new Set(['platform.agents.customer-growth.v1', 'platform.agents.social.v1', 'platform.agents.creative.v1',
  'platform.agents.sales-executive.v1', 'platform.agents.lifecycle.v1', 'platform.agents.content.v1', 'content.public-articles.v1', 'support.leads.v1']);
const model = { configured: true, run: vi.fn() };
const mail = { configured: true, send: vi.fn() };
const row = (rows, key) => rows.find(item => item.key === key);

describe('marketing toolkit configuration', () => {
  it('recognizes a Google-only campaign and conversion setup without requiring unrelated social accounts', () => {
    const sendClickConversion = vi.fn();
    let configured = true;
    const adsWork = { config: () => ({ monthlyBudgetCents: 5000, serverConversions: true, googleConversionAction: '123456789' }),
      google: () => ({ configured, sendClickConversion }) };
    const options = { features: new Set(['platform.agents.ads.v1']), adsWork };
    expect(row(marketingToolkit(options), 'paid_campaigns').configured).toBe(true);
    expect(row(marketingToolkit(options), 'ad_conversions').configured).toBe(true);
    expect(row(marketingToolkit(options), 'ad_conversions').detail).toContain('does not confirm upload permissions');
    configured = false;
    expect(row(marketingToolkit(options), 'paid_campaigns').configured).toBe(false);
    expect(row(marketingToolkit(options), 'ad_conversions').configured).toBe(false);
    expect(sendClickConversion).not.toHaveBeenCalled();
  });

  it.each(['meta', 'linkedin'])('requires the matching %s account for conversion setup and keeps Google optional', platform => {
    const sendConversion = vi.fn();
    const adsWork = { config: () => ({ monthlyBudgetCents: 5000, serverConversions: true,
      metaPixelId: platform === 'meta' ? '1234567' : '', linkedinConversionId: platform === 'linkedin' ? '123456' : '' }) };
    const options = { features: new Set(['platform.agents.ads.v1']), adsWork };
    expect(row(marketingToolkit(options), 'ad_conversions').configured).toBe(false);
    const socialWork = { [platform]: { configured: { ads: true }, sendConversion } };
    expect(row(marketingToolkit({ ...options, socialWork }), 'paid_campaigns').configured).toBe(true);
    expect(row(marketingToolkit({ ...options, socialWork }), 'ad_conversions').configured).toBe(true);
    const otherPlatform = platform === 'meta' ? 'linkedin' : 'meta';
    expect(row(marketingToolkit({ ...options, socialWork: { [otherPlatform]: socialWork[platform] } }), 'ad_conversions').configured).toBe(false);
    expect(sendConversion).not.toHaveBeenCalled();
  });

  it('shows concrete configuration gaps without making any network request', () => {
    const result = marketingToolkit();
    expect(result.every(tool => tool.configured === false)).toBe(true);
    expect(row(result, 'prospect_research').missing.join(' ')).toContain('HUB_GROWTH_SEARCH_API_KEY');
    expect(row(result, 'prospect_roster').missing.join(' ')).toContain('HUNTER_API_KEY');
    expect(row(result, 'growth_email').missing.join(' ')).toContain('Mailing address in email footers');
    expect(row(result, 'content_publication').missing.join(' ')).toContain('public articles');
    expect(row(result, 'visitor_conversion_analytics')).toMatchObject({ configured: false });
    expect(row(result, 'visitor_conversion_analytics').missing.join(' ')).toContain('HUB_VISITOR_METRICS_KEY');
    expect(row(result, 'website_leads_carebase')).toBeUndefined();
    expect(row(result, 'website_leads_intel').configured).toBe(false);
  });

  it('uses live sending, sender and footer checks and never leaks signing keys', () => {
    let enabled = true;
    let postalAddress = '1 Example Street';
    const growth = growthService({ enabled: () => enabled, signingKey: secret, eventKeys: { 'caremetric-intel': secret },
      postalAddress: () => postalAddress, publicOrigin: 'https://help.example.test', research: { configured: true } });
    const options = { features, growth, growthMail: mail, model, leadSecrets: { intel: secret } };
    const initial = marketingToolkit(options);
    expect(row(initial, 'growth_email').configured).toBe(true);
    expect(row(initial, 'product_events_intel').configured).toBe(true);
    expect(row(initial, 'website_leads_intel').configured).toBe(true);
    expect(JSON.stringify(initial)).not.toContain(secret);
    enabled = false;
    postalAddress = '';
    expect(row(marketingToolkit(options), 'growth_email').missing).toEqual(expect.arrayContaining([
      expect.stringContaining('Send growth email'), expect.stringContaining('Mailing address'),
    ]));
    expect(row(marketingToolkit({ ...options, growthMail: { configured: false, send: vi.fn() } }), 'growth_email').missing.join(' ')).toContain('Settings → Email → Email service');
  });

  it('does not confuse a present malformed feedback key or a short event key with a working verifier', () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1', publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const invalid = growthService({ webhookPublicKey: 'not-a-public-key', eventKeys: { carebase: 'short', 'caremetric-intel': secret } });
    expect(invalid.readiness()).toMatchObject({ deliveryFeedback: false, events: { carebase: false, 'caremetric-intel': true } });
    expect(growthService({ webhookPublicKey: publicKey }).readiness().deliveryFeedback).toBe(true);
    expect(JSON.stringify(invalid.readiness())).not.toContain(secret);
  });

  it('recognizes the existing Intel billing activity endpoint without claiming producer delivery', () => {
    const declared = new Set([...features, 'platform.agents.app-growth.v1']);
    const growth = growthService({ features: declared });
    const result = marketingToolkit({ features: declared, growth });
    expect(row(result, 'product_events_intel').configured).toBe(true);
    expect(row(result, 'product_events_intel').detail).toContain('does not confirm the native producer is delivering');
    expect(row(result, 'product_events_intel').missing).toEqual([]);
  });

  it('reuses Meta and LinkedIn client validation, including refresh-only LinkedIn credentials and live settings', () => {
    const setting = { 'social.meta_page_id': '123', 'social.linkedin_organization_id': '456', 'social.linkedin_client_id': 'client',
      'social.meta_ad_account_id': 'act_789', 'social.image_urls': ['https://example.test/image.png'] };
    const social = () => socialConfig({ HUB_META_ACCESS_TOKEN: secret, HUB_LINKEDIN_REFRESH_TOKEN: secret, HUB_LINKEDIN_CLIENT_SECRET: secret }, key => setting[key]);
    const fetchImpl = vi.fn(() => { throw new Error('No provider request expected'); });
    const socialWork = socialTeam({ social, features, fetchImpl });
    const options = { features, social, socialWork, model };
    let tools = marketingToolkit(options);
    expect(row(tools, 'facebook').configured).toBe(true);
    expect(row(tools, 'instagram').configured).toBe(false);
    expect(row(tools, 'linkedin').configured).toBe(true);
    expect(row(tools, 'ad_optimization').configured).toBe(true);
    expect(row(marketingToolkit({ ...options, model: null }), 'ad_optimization').configured).toBe(true);
    expect(row(tools, 'ad_budget_increases').configured).toBe(false);
    setting['social.meta_page_id'] = '';
    setting['social.linkedin_client_id'] = '';
    tools = marketingToolkit(options);
    expect(row(tools, 'facebook').configured).toBe(false);
    expect(row(tools, 'linkedin').configured).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(tools)).not.toContain(secret);
  });

  it('validates Search Console credentials and property syntax without claiming remote access', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { format: 'pem', type: 'pkcs8' } });
    const credentials = JSON.stringify({ type: 'service_account', client_email: 'synthetic@example.test', private_key: privateKey });
    let sites = ['sc-domain:example.test'];
    const options = { searchConsoleCredentials: credentials, searchConsoleSites: () => sites };
    expect(row(marketingToolkit(options), 'search_performance').configured).toBe(true);
    sites = ['not a property'];
    expect(row(marketingToolkit(options), 'search_performance').configured).toBe(false);
    expect(row(marketingToolkit({ searchConsoleCredentials: '{bad', searchConsoleSites: ['sc-domain:example.test'] }), 'search_performance').configured).toBe(false);
    expect(JSON.stringify(marketingToolkit(options))).not.toContain(privateKey);
  });

  it('keeps video publishing unavailable until both its migration and a publishing account are configured', () => {
    const socialWork = { meta: { configured: { pages: true } } };
    expect(row(marketingToolkit({ features, socialWork }), 'social_video').configured).toBe(false);
    const declared = new Set([...features, 'platform.agents.social-video.v1']);
    expect(row(marketingToolkit({ features: declared, socialWork }), 'social_video').configured).toBe(true);
    expect(row(marketingToolkit({ features: declared }), 'social_video').configured).toBe(false);
  });

  it('requires the model, customer-text switch and reply service for sales; creative switches and caps stay live', () => {
    const options = { features, model, email: mail, communications: { reply: vi.fn() }, customerTextToAi: false };
    expect(row(marketingToolkit(options), 'sales_answers').configured).toBe(false);
    expect(row(marketingToolkit({ ...options, customerTextToAi: true }), 'sales_answers').configured).toBe(true);
    expect(row(marketingToolkit({ ...options, customerTextToAi: true, email: { configured: false } }), 'sales_answers').configured).toBe(false);
    const settings = { 'creative.enabled': true, 'creative.daily_render_cap': 4 };
    const creativeWork = creativeTeam({ features, creative: () => creativeConfig({}, key => settings[key]) });
    expect(row(marketingToolkit({ features, model, creativeWork }), 'creative_production').configured).toBe(true);
    settings['creative.daily_render_cap'] = 0;
    expect(row(marketingToolkit({ features, model, creativeWork }), 'creative_production').configured).toBe(false);
  });

  it('keeps released database features separate from credentials and reflects product scope', () => {
    const options = { model, leadSecrets: { carebase: secret, intel: secret, advisors: secret }, marketed: ['carebase', 'advisors'] };
    const tools = marketingToolkit(options);
    expect(row(tools, 'website_leads_intel')).toBeUndefined();
    expect(row(tools, 'website_leads_carebase').configured).toBe(false);
    expect(row(marketingToolkit({ ...options, features }), 'website_leads_carebase').configured).toBe(true);
    expect(row(tools, 'product_events_advisors')).toBeUndefined();
  });

  it('wires real team overview output through the browser contract and current product switches', async () => {
    let marketing = [{ product: 'carebase', marketed: true }, { product: 'caremetric-intel', marketed: false }];
    const db = { release: vi.fn(), query: vi.fn(async sql => {
      if (sql.includes('from private.sms_sessions')) return { rows: [{ id: 'session', user_id: 'owner', auth_method: 'sms' }] };
      if (sql.includes('hub.get_agent_team')) return { rows: [{ result: { agents: [], approvalCount: 0 } }] };
      if (sql.includes('hub.get_marketing_products')) {
        if (marketing === null) throw Object.assign(new Error('Missing function'), { code: '42883' });
        return { rows: [{ result: marketing }] };
      }
      return { rows: [{ result: null }] };
    }) };
    const team = agentTeam({ pool: { connect: async () => db }, store: { readyActions: async () => [] }, publicOrigin: 'https://help.example.test',
      features, model, leadSecrets: { carebase: secret, intel: secret } });
    const first = await team.admin.overview('test-session');
    const parsed = servicesSchema.parse(first.services);
    expect(row(parsed.marketingTools, 'website_leads_carebase').configured).toBe(true);
    expect(row(parsed.marketingTools, 'website_leads_intel')).toBeUndefined();
    marketing = [{ product: 'carebase', marketed: false }, { product: 'caremetric-intel', marketed: true }];
    expect(row((await team.admin.overview('test-session')).services.marketingTools, 'website_leads_intel').configured).toBe(true);
    marketing = null;
    expect(row((await team.admin.overview('test-session')).services.marketingTools, 'website_leads_intel').configured).toBe(true);
    expect(model.run).not.toHaveBeenCalled();
  });
});
