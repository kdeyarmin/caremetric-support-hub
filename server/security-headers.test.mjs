import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appServer, securityHeaders } from './http.mjs';

// Production runs this Node server (Dockerfile: CMD ["node", "server/main.mjs"]); no other web server sits in front of it, so
// these are the headers every visitor receives.
const root = new URL('../', import.meta.url);
const dockerfile = await readFile(new URL('Dockerfile', root), 'utf8');
const viteConfig = await readFile(new URL('vite.config.ts', root), 'utf8');
const railway = await readFile(new URL('railway.json', root), 'utf8');
const origin = 'https://support-hub-web-production.up.railway.app';
const directives = Object.fromEntries(securityHeaders['Content-Security-Policy'].split(';').map(part => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));

let server, base, dist;
beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), 'hub-dist-'));
  await mkdir(join(dist, 'assets'));
  await writeFile(join(dist, 'index.html'), '<!doctype html><title>Hub</title>');
  await writeFile(join(dist, 'assets', 'app.js'), 'export {};');
  server = appServer({ auth: {}, gateway: {}, delegations: {}, origins: [origin], dist, health: async () => {} });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); await rm(dist, { recursive: true, force: true }); });

describe('production web-server contract', () => {
  it('sends HSTS, framing, sniffing, referrer and permission protections', () => {
    expect(securityHeaders['Strict-Transport-Security']).toBe('max-age=31536000; includeSubDomains');
    expect(securityHeaders['X-Content-Type-Options']).toBe('nosniff');
    expect(securityHeaders['X-Frame-Options']).toBe('SAMEORIGIN');
    expect(securityHeaders['Referrer-Policy']).toBe('no-referrer');
    expect(securityHeaders['Permissions-Policy']).toBe('camera=(), microphone=(), geolocation=(), payment=()');
  });

  it('allows scripts and connections to the Hub only, and media only from the Hub and its private storage', () => {
    expect(directives['default-src']).toEqual(["'self'"]);
    expect(directives['script-src']).toEqual(["'self'"]);
    expect(directives['connect-src']).toEqual(["'self'"]);
    expect(directives['media-src']).toEqual(["'self'", 'blob:', 'https://xgauehtwksmnoqhgqegm.supabase.co']);
    // The applications' own image hosts, for Billing's preview of an invitation email (its iframe inherits this policy).
    expect(directives['img-src']).toEqual(["'self'", 'data:', 'https://cmcarebase.com', 'https://www.caremetricintel.com']);
    for (const name of ['frame-ancestors', 'base-uri', 'form-action', 'font-src']) expect(directives[name], name).toEqual(["'self'"]);
    expect(securityHeaders['Content-Security-Policy']).not.toMatch(/unsafe-eval|\*/);
  });

  it('sets every header on the app, its assets, its fallback route, the API and an error', async () => {
    for (const [path, status] of [['/', 200], ['/assets/app.js', 200], ['/admin/apps', 200], ['/api/health', 200], ['/missing.js', 404]]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status, path).toBe(status);
      for (const [name, value] of Object.entries(securityHeaders)) expect(response.headers.get(name), `${path} ${name}`).toBe(value);
    }
    expect((await fetch(`${base}/assets/app.js`)).headers.get('Cache-Control')).toBe('public,max-age=604800,immutable');
    expect((await fetch(`${base}/admin/apps`)).headers.get('Cache-Control')).toBe('no-store');
  });

  it('feeds connected-mode variables into the validated production build and runs this server', () => {
    for (const name of ['VITE_DEMO_MODE', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY']) {
      expect(dockerfile).toContain(`ARG ${name}`);
      expect(dockerfile).toContain(`ENV ${name}=\${${name}}`);
    }
    expect(dockerfile).toContain('RUN npm run build');
    expect(dockerfile).toContain('CMD ["node", "server/main.mjs"]');
    expect(viteConfig).toContain('if (command === "build")');
    expect(viteConfig).toContain('validateBuildRuntimeConfig(');
    expect(railway).toContain('"builder": "DOCKERFILE"');
  });
});
