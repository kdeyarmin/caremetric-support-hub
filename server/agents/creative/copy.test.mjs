import { describe, expect, it, vi } from 'vitest';
import { schemaDefects } from '../runtime/schema.mjs';
import { briefUserMessage, chooseVariants, conceptSchema, conceptSystem, landingFor, normalizeVariant, planPlacements, variantsSchema, variantsSystem } from './copy.mjs';
import { heygenClient, heygenScript } from './heygen.mjs';

const variant = (hook, layout = 'headline', over = {}) => ({ hook, layout, headline: `A ${hook} headline`, primaryText: 'Primary text.', description: 'Desc', cta: 'Start free trial', altText: 'Alt',
  overlay: { kicker: '', stat: '', statLabel: '', statSource: '', quote: '', quoteSource: '', offerLine: '', checklist: [], screenshotId: '', beats: [] }, ...over });

describe('creative copy', () => {
  it('asks for closed JSON with the fact sheet and the rules in cached system prompts', () => {
    expect(schemaDefects(conceptSchema)).toEqual([]);
    expect(schemaDefects(variantsSchema)).toEqual([]);
    for (const system of [conceptSystem, variantsSystem]) {
      expect(system).toContain('CareMetric fact sheet');
      expect(system).toContain('Never tell anyone to enter or use a code');
      expect(system).toContain('CMS, Medicare, Medicaid');
    }
  });

  it('keeps a layout only when its content exists, and the offer card only with a live offer', () => {
    expect(normalizeVariant(variant('proof', 'stat')).layout).toBe('headline');
    expect(normalizeVariant(variant('demo', 'screenshot', { overlay: { ...variant().overlay, screenshotId: 'nope' } }), { screenshots: [{ id: 's1' }] }).layout).toBe('headline');
    expect(normalizeVariant(variant('demo', 'screenshot', { overlay: { ...variant().overlay, screenshotId: 's1' } }), { screenshots: [{ id: 's1' }] }).layout).toBe('screenshot');
    expect(normalizeVariant(variant('offer', 'offer', { overlay: { ...variant().overlay, offerLine: '50% off your first 12 months' } })).layout).toBe('headline');
    expect(normalizeVariant(variant('offer', 'offer', { overlay: { ...variant().overlay, offerLine: '50% off your first 12 months' } }), { offer: { code: 'FOUNDERS50' } }).layout).toBe('offer');
  });

  it('chooses three to five variants on different hooks, the hero first', () => {
    const chosen = chooseVariants(variant('problem'), [variant('problem'), variant('proof'), variant('offer'), variant('curiosity'), variant('demo'), variant('demo')]);
    expect(chosen.map(item => `${item.label}:${item.hook}`)).toEqual(['A:problem', 'B:proof', 'C:offer', 'D:curiosity', 'E:demo']);
  });

  it('places each variant once per platform, and videos for the first two in each length', () => {
    const brief = { platforms: ['meta', 'linkedin', 'google'], formats: ['static', 'video'], videoLengths: ['15s', '30s'] };
    const rows = planPlacements({ brief, variants: chooseVariants(variant('problem'), [variant('proof'), variant('offer')]), landingBase: 'https://cmcarebase.com/' });
    expect(rows.filter(row => row.kind === 'static').map(row => `${row.variantLabel}:${row.placement}`)).toEqual([
      'A:meta.feed_square', 'B:meta.feed_portrait', 'C:meta.story', 'A:linkedin.single_image', 'B:linkedin.square', 'C:linkedin.single_image',
      'A:google.landscape', 'B:google.square', 'C:google.rectangle']);
    const videos = rows.filter(row => row.kind === 'video');
    expect(videos.map(row => row.variantLabel)).toEqual(['A-15s', 'A-30s', 'B-15s', 'B-30s', 'A-15s', 'A-30s', 'B-15s', 'B-30s']);
    expect(videos.every(row => !row.placement.startsWith('google'))).toBe(true);
    expect(new Set(rows.map(row => `${row.variantLabel}|${row.placement}`)).size).toBe(rows.length);
  });

  it('sends people only to the product\'s own pages', () => {
    expect(landingFor('carebase', 'carebase-signup')).toBe('https://cmcarebase.com/signup');
    expect(landingFor('carebase', 'intel-home')).toBe('https://cmcarebase.com/signup');
    const message = JSON.parse(briefUserMessage({ brief: { product: 'carebase', goal: 'g', audience: 'a', angle: '', platforms: ['meta'], formats: ['static'], videoLengths: [], offerCode: 'FOUNDERS50' }, brandKit: { voiceNotes: 'Warm' }, learnings: [] }));
    expect(message.offer.name).toBe('Founders Sale');
    expect(message.pages.every(page => page.id.startsWith('carebase-'))).toBe(true);
  });
});

describe('the HeyGen adapter', () => {
  it('is off without a key and sends nothing', async () => {
    const fetchImpl = vi.fn();
    const client = heygenClient({ apiKey: '', fetchImpl });
    expect(client.configured).toBe(false);
    await expect(client.submit({ script: 'x', avatarId: 'a', voiceId: 'v', width: 1080, height: 1080, background: '#FFFFFF' })).rejects.toMatchObject({ code: 'heygen_not_configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('submits a captioned render, reads its status, records usage, and downloads only from HeyGen\'s hosts', async () => {
    const record = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async (url, init) => {
      if (String(url).endsWith('/v2/video/generate')) {
        const body = JSON.parse(init.body);
        expect(body.caption).toBe(true);
        expect(init.headers['X-Api-Key']).toBe('k'.repeat(20));
        return new Response(JSON.stringify({ error: null, data: { video_id: 'vid_1' } }), { status: 200 });
      }
      if (String(url).includes('video_status.get')) return new Response(JSON.stringify({ data: { status: 'completed', video_url: 'https://files.heygen.ai/v.mp4', video_url_caption: 'https://files.heygen.ai/vc.mp4', duration: 15.2 } }), { status: 200 });
      return new Response(Buffer.from('0000ftypisom0000'), { status: 200 });
    });
    const client = heygenClient({ apiKey: 'k'.repeat(20), fetchImpl, record });
    expect(await client.submit({ script: 'Hello.', avatarId: 'a', voiceId: 'v', width: 1080, height: 1920, background: '#FFFFFF' })).toEqual({ videoId: 'vid_1' });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ feature: 'agent_creative_director', model: 'heygen', outcome: 'completed' }));
    expect(await client.status('vid_1')).toEqual({ state: 'done', url: 'https://files.heygen.ai/vc.mp4', captioned: true, durationSeconds: 15.2 });
    expect((await client.download('https://files.heygen.ai/vc.mp4')).length).toBeGreaterThan(8);
    await expect(client.download('https://evil.example.com/v.mp4')).rejects.toMatchObject({ code: 'heygen_download_refused' });
  });

  it('writes a script that fits the length', () => {
    const script = heygenScript({ headline: 'One two three', overlay: { beats: Array.from({ length: 20 }, () => 'four five six seven') }, cta: 'Start free trial' }, 6);
    expect(script.split(/\s+/).length).toBeLessThanOrEqual(15);
    expect(script.endsWith('.')).toBe(true);
  });
});
