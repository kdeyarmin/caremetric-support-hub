import { describe, expect, it } from 'vitest';
import { probeTargets } from './targets.mjs';

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
