import { describe, expect, it, vi } from 'vitest';
import { growthResearch } from './research.mjs';

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
});
