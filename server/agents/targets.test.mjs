import { describe, expect, it } from 'vitest';
import { formTargets, probeTargets } from './targets.mjs';

const hubOrigin = 'https://support-hub-web-production.up.railway.app';

describe('probe targets', () => {
  it('lists the Hub first and then each product, by fixed address', () => {
    expect(probeTargets({ publicOrigin: hubOrigin }).map(({ key, url }) => [key, url])).toEqual([
      ['hub', `${hubOrigin}/api/health`],
      ['carebase', 'https://cmcarebase.com/health'],
      ['intel', 'https://www.caremetricintel.com/api/ready'],
      ['advisors', 'https://caremetricadvisors.com/health'],
    ]);
  });

  it('only probes https addresses, never the apex that redirects', () => {
    for (const target of probeTargets({ publicOrigin: hubOrigin })) {
      expect(new URL(target.url).protocol).toBe('https:');
      expect(target.url).not.toMatch(/\/\/caremetricintel\.com/);
    }
  });

  it('leaves the Hub out rather than probe an address it cannot trust', () => {
    for (const origin of [undefined, '', 'not a url', 'http://hub.example.test', 'https://user:pass@hub.example.test', 'https://hub.example.test:8443',
      'https://hub.example.test/path', 'https://hub.example.test/?x=1', 'https://hub.example.test/#frag']) {
      expect(probeTargets({ publicOrigin: origin }).map(target => target.key), String(origin)).toEqual(['carebase', 'intel', 'advisors']);
    }
  });

  it('is frozen, so nothing can add an address at run time', () => {
    const targets = probeTargets({ publicOrigin: hubOrigin });
    expect(Object.isFrozen(targets)).toBe(true);
    expect(targets.every(target => Object.isFrozen(target))).toBe(true);
    expect(() => targets.push({ key: 'x', label: 'X', url: 'https://evil.example.test' })).toThrow();
  });

  it('uses keys the database accepts', () => {
    for (const target of probeTargets({ publicOrigin: hubOrigin })) expect(target.key).toMatch(/^[a-z][a-z0-9_]{1,40}$/);
  });
});

describe('lead form targets', () => {
  it('names one fixed https endpoint per product, the one behind its main lead form', () => {
    expect(formTargets.map(({ key, source, url }) => [key, source, url])).toEqual([
      ['carebase_forms', 'carebase', 'https://xsqobvvreaovwibxwyvv.supabase.co/functions/v1/request-demo'],
      ['intel_forms', 'intel', 'https://www.caremetricintel.com/api/public/demo-request'],
      ['advisors_forms', 'advisors', 'https://caremetricadvisors.com/api/inquiries'],
    ]);
    for (const target of formTargets) {
      expect(new URL(target.url).protocol).toBe('https:');
      expect(target.key).toMatch(/^[a-z][a-z0-9_]{1,40}$/);
      expect(target).toMatchObject({ form: true, every: 'every six hours', staleMs: 7 * 3_600_000, timeoutSeconds: 20 });
    }
  });

  it('sends plainly invented values that can never reach a person, and says why it was sent', () => {
    for (const target of formTargets) {
      expect(target.body.email).toBe('probe@caremetric.invalid');
      expect(target.body.name).toBe('CareMetric Form Check');
      expect(target.body.message).toMatch(/^Automated end-to-end check of this form from the CareMetric Support Hub\./);
      expect(JSON.stringify(target.body)).not.toMatch(/\bALR\b|auditor|\bcall\b/i);
    }
  });

  it('is frozen through and through, and none of it is part of the health sweep', () => {
    expect(Object.isFrozen(formTargets)).toBe(true);
    for (const target of formTargets) expect([Object.isFrozen(target), Object.isFrozen(target.body)]).toEqual([true, true]);
    expect(() => { formTargets[0].body.email = 'someone@example.test'; }).toThrow();
    const health = probeTargets({ publicOrigin: hubOrigin }).map(target => target.key);
    expect(formTargets.some(target => health.includes(target.key))).toBe(false);
  });
});
