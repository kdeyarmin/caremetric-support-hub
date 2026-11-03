import { describe, expect, it } from 'vitest';
import { outboundHosts, sites } from './sites.mjs';

describe('the sites the SEO Analyst checks', () => {
  it('are the company\'s five public sites, each https on its own host, with a product', () => {
    expect(sites.map(site => [site.key, site.origin, site.product])).toEqual([
      ['advisors', 'https://caremetricadvisors.com', 'advisors'],
      ['carebase', 'https://cmcarebase.com', 'carebase'],
      ['intel', 'https://www.caremetricintel.com', 'intel'],
      ['help', 'https://help.caremetric.ai', 'help'],
      ['carebase_home', 'https://home.cmcarebase.com', 'carebase'],
    ]);
    for (const site of sites) {
      for (const address of [site.origin, ...site.variants]) {
        const url = new URL(address);
        expect(url.protocol).toBe('https:');
        expect(`${url.origin}`).toBe(address);
      }
      expect(Object.isFrozen(site)).toBe(true);
      expect(Object.isFrozen(site.variants)).toBe(true);
    }
    expect(Object.isFrozen(sites)).toBe(true);
    expect(new Set(sites.map(site => site.key)).size).toBe(sites.length);
  });

  it('may contact only these hosts: the sites, their other addresses, and Google\'s sign-in and Search Console endpoints', () => {
    expect([...outboundHosts].sort()).toEqual([
      'caremetricadvisors.com', 'caremetricintel.com', 'caremetrictrain.com', 'cmcarebase.com', 'help.caremetric.ai', 'home.cmcarebase.com',
      'oauth2.googleapis.com', 'searchconsole.googleapis.com', 'www.caremetricadvisors.com', 'www.caremetricintel.com',
    ]);
    expect(Object.isFrozen(outboundHosts)).toBe(true);
  });
});
