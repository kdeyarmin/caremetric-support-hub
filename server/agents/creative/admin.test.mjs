import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { appServer } from '../../http.mjs';
import { creativeAdmin, imageKind } from './admin.mjs';
import { syntheticMp4, syntheticPng } from './fixtures.mjs';

const token = 'a'.repeat(43);
// A fake session: records each operation and its arguments, as the hub.* operations would receive them.
function harness() {
  const calls = [];
  const session = vi.fn(async (sessionToken, work) => work({ query: async (sql, args) => {
    calls.push({ sql, args, sessionToken });
    if (sql.includes('get_creative_file')) return { rows: [{ content_type: 'image/png', bytes: Buffer.from('png-bytes'), file_name: 'caremetric-carebase-meta.feed_square-1234.png' }] };
    return { rows: [{ result: { ok: true } }] };
  } }));
  const kick = vi.fn();
  return { calls, kick, admin: creativeAdmin({ pool: null, kick, session }) };
}

describe('the Creative screen\'s operations', () => {
  it('passes a filtered studio read to the owner operation', async () => {
    const { admin, calls } = harness();
    const studio = await admin.studio(token, { product: 'carebase', status: 'proposed', limit: 24 });
    expect(calls[0].sql).toContain('hub.get_creative_studio');
    // Each product's brand theme comes with it, for the brand kit editor.
    expect(studio.themes.map(theme => theme.name).sort()).toEqual(['CareBase', 'Emberline']);
    expect(JSON.parse(calls[0].args[0])).toEqual({ product: 'carebase', status: 'proposed', limit: 24 });
    await expect(admin.studio(token, { status: 'blocked' })).rejects.toMatchObject({ status: 400 });
    await expect(admin.studio(token, { product: 'advisors' })).rejects.toMatchObject({ status: 400 });
    await expect(admin.studio(token, { extra: 1 })).rejects.toMatchObject({ status: 400 });
  });

  it('checks a brand kit edit before the database sees it', async () => {
    const { admin, calls } = harness();
    await admin.brandKit(token, { product: 'carebase', expectedVersion: 2, kit: { primaryColor: '#0B5394', headingFont: 'Inter', bannedPhrases: [' game changer ', ''], captionsDefault: true } });
    expect(calls[0].args).toEqual(['carebase', JSON.stringify({ primaryColor: '#0B5394', headingFont: 'Inter', bannedPhrases: ['game changer'], captionsDefault: true }), 2]);
    await expect(admin.brandKit(token, { product: 'carebase', expectedVersion: 2, kit: { primaryColor: 'blue' } })).rejects.toMatchObject({ status: 400 });
    await expect(admin.brandKit(token, { product: 'carebase', expectedVersion: 2, kit: { headingFont: 'Papyrus' } })).rejects.toMatchObject({ status: 400 });
    await expect(admin.brandKit(token, { product: 'carebase', expectedVersion: 2, kit: { brandName: 'Care Metric' } })).rejects.toMatchObject({ status: 400 });
  });

  it('takes only real PNG or JPEG files, and a screenshot only with the attestation', async () => {
    const { admin, calls } = harness();
    const data = syntheticPng().toString('base64');
    await admin.brandFile(token, { product: 'carebase', kind: 'screenshot', data, attested: true, label: 'Training dashboard' });
    expect(calls[0].args.slice(0, 3)).toEqual(['carebase', 'screenshot', 'image/png']);
    await expect(admin.brandFile(token, { product: 'carebase', kind: 'screenshot', data, attested: false })).rejects.toMatchObject({ status: 400 });
    await expect(admin.brandFile(token, { product: 'carebase', kind: 'logo', data: Buffer.from('<svg/>').toString('base64'), attested: false })).rejects.toMatchObject({ status: 400 });
    expect(imageKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
  });

  it('starts an owner brief once per request key and wakes the team', async () => {
    const { admin, calls, kick } = harness();
    const brief = { product: 'caremetric-intel', goal: 'Drive trials', audience: 'Agency owners', platforms: ['meta', 'linkedin'], formats: ['static', 'video'], requestKey: '11111111-1111-4111-8111-111111111111', offerCode: 'FOUNDERS50' };
    await admin.brief(token, brief);
    expect(JSON.parse(calls[0].args[0])).toMatchObject({ videoLengths: ['15s'], offerCode: 'FOUNDERS50' });
    expect(calls[0].args[1]).toBe(brief.requestKey);
    await new Promise(resolve => setImmediate(resolve));
    expect(kick).toHaveBeenCalled();
    await expect(admin.brief(token, { ...brief, offerCode: 'SPRING20' })).rejects.toMatchObject({ status: 400 });
    await expect(admin.brief(token, { ...brief, audience: 'Patients with diabetes' })).rejects.toMatchObject({ status: 400 });
    await expect(admin.brief(token, { ...brief, platforms: ['tiktok'] })).rejects.toMatchObject({ status: 400 });
  });
});

describe('the owner\'s own finished videos', () => {
  const requestKey = '44444444-4444-4444-8444-444444444444';
  it('reads the size and length from the file and stores it for each placement it fits, one per platform', async () => {
    const { admin, calls } = harness();
    const bytes = syntheticMp4({ width: 1080, height: 1920, seconds: 30 });
    await admin.video(token, { product: 'caremetric-intel', placements: ['meta.video_vertical', 'linkedin.video_vertical'], label: ' 30-second commercial ', attested: true, requestKey, bytes });
    expect(calls[0].sql).toContain('hub.add_creative_video');
    expect(calls[0].args).toEqual(['caremetric-intel', ['meta.video_vertical', 'linkedin.video_vertical'], '30-second commercial', bytes, 30, 1080, 1920, true, requestKey]);
  });

  it('refuses what a placement cannot take before the database sees it', async () => {
    const { admin, calls } = harness();
    const vertical = syntheticMp4({ width: 1080, height: 1920, seconds: 30 });
    const input = { product: 'caremetric-intel', placements: ['linkedin.video_vertical'], label: 'Intro', attested: true, requestKey, bytes: vertical };
    await expect(admin.video(token, { ...input, attested: false })).rejects.toMatchObject({ status: 400 });
    await expect(admin.video(token, { ...input, placements: ['linkedin.video_landscape'] })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('1920 x 1080') });
    await expect(admin.video(token, { ...input, placements: ['linkedin.video_vertical', 'linkedin.video_square'] })).rejects.toMatchObject({ status: 400 });
    await expect(admin.video(token, { ...input, placements: ['meta.feed_square'] })).rejects.toMatchObject({ status: 400 });
    await expect(admin.video(token, { ...input, placements: ['meta.video_vertical'], bytes: syntheticMp4({ width: 1080, height: 1920, seconds: 93 }) })).rejects.toMatchObject({ status: 400 });
    await expect(admin.video(token, { ...input, bytes: syntheticMp4({ width: 1920, height: 1080, seconds: 150 }) })).rejects.toMatchObject({ status: 400 });
    await expect(admin.video(token, { ...input, bytes: Buffer.from('not a video file at all') })).rejects.toMatchObject({ status: 400 });
    await expect(admin.video(token, { ...input, product: 'advisors' })).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });
});

describe('creative routes', () => {
  const origin = 'https://support-hub-web-production.up.railway.app';
  const token64 = 'b'.repeat(64);
  const creative = {
    admin: { studio: vi.fn(async () => ({ assets: [] })), brandKit: vi.fn(), brandFile: vi.fn(async () => ({ ok: true })), removeBrandFile: vi.fn(), brief: vi.fn(async () => ({ ok: true })),
      video: vi.fn(async () => ({ briefId: '11111111-1111-4111-8111-111111111111', already: false, assets: [] })),
      file: vi.fn(async () => ({ contentType: 'video/mp4', bytes: Buffer.from('0123456789'), fileName: 'caremetric-video.mp4' })) },
    publicFile: vi.fn(async value => (value === token64 ? { contentType: 'image/png', bytes: Buffer.from('png') } : null)),
  };
  let server, base;
  beforeAll(async () => {
    server = appServer({ creative, origins: [origin], gateway: {}, delegations: {}, auth: {}, health: async () => undefined });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise(resolve => server.close(resolve)));
  const post = (path, body = {}, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: `__Host-caremetric_session=${token}`, ...headers }, body: JSON.stringify(body) });

  it('serves an approved asset under its token only, and nothing else there', async () => {
    const ok = await fetch(`${base}/api/creative/a/${token64}.png`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect((await fetch(`${base}/api/creative/a/${'c'.repeat(64)}.png`)).status).toBe(404);
    expect((await fetch(`${base}/api/creative/a/${token64}.mp4`)).status).toBe(404);
    expect((await fetch(`${base}/api/creative/a/${token64}.png?x=1`)).status).toBe(404);
  });

  it('runs the owner\'s actions as same-origin POSTs with the session', async () => {
    expect((await post('/api/admin/creative/studio', { product: 'carebase' })).status).toBe(200);
    expect(creative.admin.studio).toHaveBeenCalledWith(token, { product: 'carebase' });
    expect((await post('/api/admin/creative/brief', {}, { Origin: 'https://attacker.test' })).status).toBe(403);
    expect((await post('/api/admin/creative/approve', {})).status).toBe(404);
    expect((await post('/api/admin/creative/studio?x=1', {})).status).toBe(400);
  });

  it('takes an uploaded video as the raw MP4 with its details in headers', async () => {
    const bytes = syntheticMp4();
    const upload = (headers = {}) => fetch(`${base}/api/admin/creative/video`, { method: 'POST', body: bytes, headers: { 'Content-Type': 'video/mp4', Origin: origin, Cookie: `__Host-caremetric_session=${token}`,
      'X-Creative-Product': 'caremetric-intel', 'X-Creative-Placements': 'meta.video_vertical,linkedin.video_vertical', 'X-Creative-Label': encodeURIComponent('Intro · 30 s'),
      'X-Creative-Attested': 'true', 'X-Creative-Request': '44444444-4444-4444-8444-444444444444', ...headers } });
    expect((await upload()).status).toBe(200);
    expect(creative.admin.video).toHaveBeenCalledWith(token, { product: 'caremetric-intel', placements: ['meta.video_vertical', 'linkedin.video_vertical'], label: 'Intro · 30 s',
      attested: true, requestKey: '44444444-4444-4444-8444-444444444444', bytes });
    expect((await upload({ 'Content-Type': 'application/octet-stream' })).status).toBe(415);
    expect((await upload({ Origin: 'https://attacker.test' })).status).toBe(403);
    expect((await upload({ 'X-Creative-Label': '%E0%A4%A' })).status).toBe(400);
  });

  it('streams a file for preview with byte ranges, and as a download', async () => {
    const id = '22222222-2222-4222-8222-222222222222';
    const whole = await fetch(`${base}/api/admin/creative/file/${id}`, { headers: { Cookie: `__Host-caremetric_session=${token}` } });
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-disposition')).toContain('inline');
    const part = await fetch(`${base}/api/admin/creative/file/${id}`, { headers: { Cookie: `__Host-caremetric_session=${token}`, Range: 'bytes=2-5' } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe('2345');
    expect(part.headers.get('content-range')).toBe('bytes 2-5/10');
    const download = await fetch(`${base}/api/admin/creative/file/${id}?download=1`, { headers: { Cookie: `__Host-caremetric_session=${token}` } });
    expect(download.headers.get('content-disposition')).toContain('attachment');
    expect((await fetch(`${base}/api/admin/creative/file/${id}?raw=1`)).status).toBe(400);
  });
});
