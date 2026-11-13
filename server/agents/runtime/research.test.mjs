import { describe, expect, it, vi } from 'vitest';
import { aiModels } from '../../ai-assistance.mjs';
import { anthropicClient } from './client.mjs';
import { costCents, searchCents } from './pricing.mjs';
import { modelRunner } from './run.mjs';
import { serverTools, sourcesOf } from './tools.mjs';

const usage = (over = {}) => ({ input_tokens: 2000, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 }, ...over });
const searchBlock = { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://valleyhospice.org/services', title: 'Services', encrypted_content: 'x' }] };
const fetchBlock = { type: 'web_fetch_tool_result', tool_use_id: 'srvtoolu_2', content: { type: 'web_fetch_result', url: 'https://valleyhospice.org/careers', content: { type: 'document', title: 'Careers', source: { type: 'text', media_type: 'text/plain', data: 'Hiring a community liaison.' } } } };
const message = (over = {}) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: aiModels.draft,
  content: [searchBlock, fetchBlock, { type: 'text', text: 'Valley Hospice serves Philadelphia. https://valleyhospice.org/services' }], stop_reason: 'end_turn', stop_sequence: null, usage: usage(), ...over });
const reply = body => ({ body, status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_r1' } });
const request = (over = {}) => ({ promptVersion: 'research.1', system: [{ text: 'Research one organization.', cache: true }], user: '{"organization":"Valley Hospice"}',
  tools: ['web_search', 'web_fetch'], maxSearches: 4, maxFetches: 3, maxRounds: 3, maxTokens: 3000, ceilingCents: 30, ...over });
const task = (over = {}) => ({ id: 't1', agentKey: 'marketing_manager', kind: 'growth.research', attempts: 1, agent: { modelTier: 'draft', toolAllowlist: ['growth_research', 'web_search', 'web_fetch'] }, ...over });

function fixture({ remaining = 300, steps = [reply(message())] } = {}) {
  const seen = [], runs = [];
  const fetchImpl = async (url, init) => {
    seen.push(JSON.parse(init.body));
    const step = steps[Math.min(seen.length - 1, steps.length - 1)];
    return new Response(JSON.stringify(step.body), { status: step.status, headers: step.headers });
  };
  const store = {
    budget: vi.fn(async () => ({ remainingCents: remaining })),
    startRun: vi.fn(async () => { runs.push({ id: `run-${runs.length + 1}` }); return runs.at(-1).id; }),
    finishRun: vi.fn(async (id, outcome, used, summary, errorCode) => { Object.assign(runs.find(run => run.id === id), { outcome, usage: used, summary, errorCode }); }),
  };
  const runner = modelRunner({ client: anthropicClient({ apiKey: 'sk-test-key', fetchImpl }), store, log: () => {}, now: () => new Date('2026-11-13T15:00:00Z') });
  return { runner, store, seen, runs };
}

describe('server tools', () => {
  it('uses the current web tools on Sonnet and Opus 5.5 and the basic ones on Haiku, capped per request', () => {
    expect(serverTools('claude-sonnet-5-5', { tools: ['web_search', 'web_fetch'], maxSearches: 4, maxFetches: 3 })).toEqual([
      { type: 'web_search_20260209', name: 'web_search', max_uses: 4 },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 3, max_content_tokens: 8000 }]);
    expect(serverTools('claude-haiku-5-5', { tools: ['web_search'], maxSearches: 2, maxFetches: 0 })).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }]);
  });
  it('collects every address a response saw', () => {
    expect(sourcesOf(message().content).map(source => source.url)).toEqual(['https://valleyhospice.org/services', 'https://valleyhospice.org/careers']);
    expect(sourcesOf([{ type: 'text', text: 'x', citations: [{ url: 'http://insecure.example/' }, { url: 'https://cited.example/a', title: 'A' }] }])).toEqual([{ url: 'https://cited.example/a', title: 'A' }]);
  });
});

describe('a research run', () => {
  it('sends the allowed tools without a schema, and books one run with its rounds, tool calls, tokens and search fees', async () => {
    const f = fixture();
    const result = await f.runner.research(task(), request());
    expect(f.seen[0].tools.map(tool => tool.name)).toEqual(['web_search', 'web_fetch']);
    expect(f.seen[0].output_config).toEqual({ effort: 'medium' });
    expect(f.seen[0]).not.toHaveProperty('output_config.format');
    const cents = costCents(aiModels.draft, { inputTokens: 2000, outputTokens: 300 }) + 2 * searchCents;
    expect(result).toMatchObject({ outcome: 'completed', searches: 2, fetches: 1, rounds: 1, text: expect.stringContaining('Philadelphia') });
    expect(result.costCents).toBeCloseTo(cents, 4);
    expect(result.sources).toHaveLength(2);
    expect(f.runs[0]).toMatchObject({ outcome: 'completed', usage: { rounds: 1, toolCalls: 3, inputTokens: 2000, outputTokens: 300 } });
    expect(f.runs[0].usage.costCents).toBeCloseTo(cents, 4);
  });

  it('continues a paused turn by sending it back unchanged, without a new user message', async () => {
    const paused = message({ stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 'srvtoolu_9', name: 'web_search', input: { query: 'valley hospice' } }] });
    const f = fixture({ steps: [reply(paused), reply(message())] });
    const result = await f.runner.research(task(), request());
    expect(result).toMatchObject({ outcome: 'completed', rounds: 2, searches: 4 });
    expect(f.seen[1].messages).toHaveLength(2);
    expect(f.seen[1].messages[1]).toEqual({ role: 'assistant', content: paused.content });
  });

  it('stops at the round limit or before a round that could pass the ceiling, keeping what it found', async () => {
    const paused = message({ stop_reason: 'pause_turn' });
    const rounds = fixture({ steps: [reply(paused)] });
    expect(await rounds.runner.research(task(), request({ maxRounds: 2 }))).toMatchObject({ outcome: 'stopped', stopped: 'rounds', rounds: 2 });
    const ceiling = fixture({ steps: [reply(paused)] });
    const capped = await ceiling.runner.research(task(), request({ ceilingCents: 6 }));
    expect(capped).toMatchObject({ outcome: 'stopped', stopped: 'ceiling', rounds: 1 });
    expect(capped.sources.length).toBeGreaterThan(0);
  });

  it('refuses a tool the agent\'s allowlist does not name, and spends nothing past the day\'s budget', async () => {
    const f = fixture();
    await expect(f.runner.research(task({ agent: { modelTier: 'draft', toolAllowlist: ['growth_research'] } }), request())).rejects.toMatchObject({ code: 'tool_not_allowed' });
    await expect(f.runner.research(task(), request({ tools: ['code_execution'] }))).rejects.toMatchObject({ code: 'request_rejected' });
    expect(f.seen).toHaveLength(0);
    const poor = fixture({ remaining: 10 });
    expect(await poor.runner.research(task(), request())).toMatchObject({ outcome: 'budget_exhausted', neededCents: 30 });
    expect(poor.seen).toHaveLength(0);
  });
});
