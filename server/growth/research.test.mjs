import { describe, expect, it, vi } from 'vitest';
import { growthResearch, searchAllowance, searchResultLimit } from './research.mjs';

const respond = results => vi.fn(async () => new Response(JSON.stringify({ web: { results } })));
const row = (url, description = 'A personal care home in Lancaster, Pennsylvania.') => ({ url, title: 'A home', description });

describe('growth research', () => {
  it('searches the day\'s discovery query and keeps only operators', async () => {
    const fetchImpl = respond([row('https://www.aplaceformom.com/x'), row('https://www.pa.gov/agencies/dhs'), row('https://maplegrovepch.com/about'), row('https://www.indeed.com/jobs')]);
    const rows = await growthResearch({ apiKey: 'k', fetchImpl }).search('carebase', { query: '"personal care home" Lancaster PA' });
    expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get('q')).toBe('"personal care home" Lancaster PA');
    expect(rows.map(item => item.domain)).toEqual(['maplegrovepch.com']);
  });

  it('keeps a domain search to that domain, whatever kind of site it is', async () => {
    const fetchImpl = respond([row('https://maplegrovepch.com/about'), row('https://other.example/about')]);
    const rows = await growthResearch({ apiKey: 'k', fetchImpl }).search('carebase', { domain: 'maplegrovepch.com' });
    expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get('q')).toMatch(/^site:maplegrovepch\.com /);
    expect(rows.map(item => item.domain)).toEqual(['maplegrovepch.com']);
  });

  it('does nothing without a key or for a product it does not sell', async () => {
    const fetchImpl = respond([]);
    expect(await growthResearch({ apiKey: '', fetchImpl }).search('carebase', { query: 'x' })).toEqual([]);
    expect(await growthResearch({ apiKey: 'k', fetchImpl }).search('breathe', { query: 'x' })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('asks for twenty results and a later page only when a discovery search says so, and keeps as many rows as it asked for', async () => {
    const many = Array.from({ length: 25 }, (_, index) => row(`https://operator-${String.fromCharCode(97 + index)}.example/`));
    const fetchImpl = respond(many);
    const research = growthResearch({ apiKey: 'k', fetchImpl });
    expect(await research.search('caremetric-intel', { query: '"hospice agency" Pittsburgh' })).toHaveLength(10);
    expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get('count')).toBe('10');
    expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.has('offset')).toBe(false);
    expect(await research.search('caremetric-intel', { query: '"hospice agency" Pittsburgh', count: searchResultLimit, offset: 2 })).toHaveLength(20);
    const paged = new URL(fetchImpl.mock.calls[1][0]).searchParams;
    expect([paged.get('count'), paged.get('offset')]).toEqual(['20', '2']);
    // Anything outside what the provider serves falls back to the first ten.
    await research.search('caremetric-intel', { query: 'x', count: 500, offset: -1 });
    const refused = new URL(fetchImpl.mock.calls[2][0]).searchParams;
    expect([refused.get('count'), refused.has('offset')]).toEqual(['10', false]);
    expect(research.paceMs).toBe(1100);
  });

  it('reads the key\'s monthly allowance from the provider\'s rate-limit headers, and guesses nothing without them', async () => {
    const headers = pairs => new Headers(pairs);
    expect(searchAllowance(headers({ 'X-RateLimit-Policy': '1;w=1, 2000;w=2592000', 'X-RateLimit-Remaining': '1, 1984' }))).toEqual({ limit: 2000, left: 1984, days: 30 });
    expect(searchAllowance(headers({ 'X-RateLimit-Policy': '50;w=1', 'X-RateLimit-Remaining': '49' }))).toBeNull();
    expect(searchAllowance(headers({ 'X-RateLimit-Policy': '1;w=1, 2000;w=2592000', 'X-RateLimit-Remaining': '1' }))).toBeNull();
    expect(searchAllowance(headers({ 'X-RateLimit-Policy': 'unlimited', 'X-RateLimit-Remaining': 'many' }))).toBeNull();
    expect(searchAllowance(headers({}))).toBeNull();
    expect(searchAllowance(null)).toBeNull();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ web: { results: [] } }), { headers: { 'X-RateLimit-Policy': '1;w=1, 2000;w=2592000', 'X-RateLimit-Remaining': '0, 1500' } }));
    const research = growthResearch({ apiKey: 'k', fetchImpl });
    expect(research.allowance()).toBeNull();
    await research.search('caremetric-intel', { query: 'x' });
    expect(research.allowance()).toEqual({ limit: 2000, left: 1500, days: 30 });
  });
});
