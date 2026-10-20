import { describe, expect, it, vi } from 'vitest';
import { aiAssistance, aiModels, formatThread } from './ai-assistance.mjs';

const thread = {
  subject: 'Export button spins forever',
  messages: [
    { authorName: 'Pat Customer', authorRole: 'customer', body: 'The monthly export never finishes.', createdAt: '2026-10-15T12:00:00Z', visibility: 'customer' },
    { authorName: 'Sam Agent', authorRole: 'support_agent', body: 'Their tenant has a very large census.', createdAt: '2026-10-15T12:05:00Z', visibility: 'internal' },
  ],
};

function providerFetch(text, { ok = true, usage = { input_tokens: 120, output_tokens: 45 } } = {}) {
  return vi.fn(async () => ({
    ok,
    status: ok ? 200 : 500,
    async text() {
      return JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage });
    },
  }));
}

describe('AI assistance provider', () => {
  it('summarizes with the fast model and logs token usage without content', async () => {
    const logs = [];
    const fetchImpl = providerFetch('The export stalls on large tenants.');
    const ai = aiAssistance({ apiKey: 'test-key', fetchImpl, log: (line) => logs.push(line), now: () => 1000 });
    await expect(ai.summarize(thread)).resolves.toBe('The export stalls on large tenants.');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('test-key');
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(init.body);
    expect(body.model).toBe(aiModels.fast);
    expect(body.messages[0].content).toContain('Export button spins forever');
    expect(logs).toHaveLength(1);
    const entry = JSON.parse(logs[0]);
    expect(entry).toMatchObject({ event: 'hub_ai_call', feature: 'case_summary', model: aiModels.fast, input_tokens: 120, output_tokens: 45 });
    expect(logs[0]).not.toContain('export stalls');
  });

  it('drafts with the draft model by default and honors the quality tier', async () => {
    const fetchImpl = providerFetch('Try splitting the export by month.');
    const ai = aiAssistance({ apiKey: 'test-key', fetchImpl, log: () => {} });
    await ai.draftReply({ ...thread, knowledge: [{ title: 'Exports', summary: 'Large exports are split by month.', body: 'Open Reports.' }] });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).model).toBe(aiModels.draft);
    expect(fetchImpl.mock.calls[0][1].body).toContain('Large exports are split by month.');
    await ai.draftReply({ ...thread, tier: 'quality' });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).model).toBe(aiModels.quality);
  });

  it('validates triage suggestions against the case enums', async () => {
    const ai = aiAssistance({ apiKey: 'test-key', fetchImpl: providerFetch('{"category":"technical_issue","priority":"high"}'), log: () => {} });
    await expect(ai.suggestTriage(thread)).resolves.toEqual({ category: 'technical_issue', priority: 'high' });
    const invalid = aiAssistance({ apiKey: 'test-key', fetchImpl: providerFetch('{"category":"surprise","priority":"whenever"}'), log: () => {} });
    await expect(invalid.suggestTriage(thread)).rejects.toMatchObject({ status: 502, code: 'AI_PROVIDER_ERROR' });
    const prose = aiAssistance({ apiKey: 'test-key', fetchImpl: providerFetch('This looks technical and urgent.'), log: () => {} });
    await expect(prose.suggestTriage(thread)).rejects.toMatchObject({ status: 502 });
  });

  it('classifies resolution replies and degrades to unclear on bad output', async () => {
    const fixed = aiAssistance({ apiKey: 'test-key', fetchImpl: providerFetch('{"outcome":"fixed"}'), log: () => {} });
    await expect(fixed.classifyResolution({ text: 'That worked, thanks!' })).resolves.toBe('fixed');
    const garbage = aiAssistance({ apiKey: 'test-key', fetchImpl: providerFetch('maybe'), log: () => {} });
    await expect(garbage.classifyResolution({ text: 'hmm' })).resolves.toBe('unclear');
  });

  it('fails closed with AI_NOT_CONFIGURED when the key is unset', async () => {
    const fetchImpl = vi.fn();
    const ai = aiAssistance({ apiKey: undefined, fetchImpl });
    expect(ai.configured).toBe(false);
    await expect(ai.summarize(thread)).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' });
    await expect(ai.draftReply(thread)).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps provider failures to a 502 without leaking detail', async () => {
    const ai = aiAssistance({ apiKey: 'test-key', fetchImpl: providerFetch('provider secret detail', { ok: false }), log: () => {} });
    await expect(ai.summarize(thread)).rejects.toMatchObject({ status: 502, code: 'AI_PROVIDER_ERROR' });
    const unreachable = aiAssistance({ apiKey: 'test-key', fetchImpl: async () => { throw new Error('network down'); }, log: () => {} });
    await expect(unreachable.summarize(thread)).rejects.toMatchObject({ status: 502 });
  });

  it('marks provider outages transient and per-request rejections not', async () => {
    const reply = (status, body) => async () => ({ ok: status === 200, status, async text() { return JSON.stringify(body); } });
    const failure = async (fetchImpl) => aiAssistance({ apiKey: 'test-key', fetchImpl, log: () => {} }).summarize(thread).catch((error) => error);
    for (const status of [408, 429, 500, 529]) {
      expect(await failure(reply(status, { type: 'error' }))).toMatchObject({ status: 502, code: 'AI_PROVIDER_ERROR', transient: true });
    }
    expect(await failure(async () => { throw new Error('network down'); })).toMatchObject({ transient: true });
    for (const fetchImpl of [reply(400, { type: 'error' }), reply(200, { content: [], stop_reason: 'refusal' })]) {
      const error = await failure(fetchImpl);
      expect(error).toMatchObject({ status: 502, code: 'AI_PROVIDER_ERROR' });
      expect(error.transient).toBeUndefined();
    }
  });

  it('renders threads with staff notes marked internal', () => {
    const text = formatThread(thread);
    expect(text).toContain('Internal note by Sam Agent');
    expect(text).toContain('Pat Customer (customer)');
  });
});
