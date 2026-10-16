import { describe, expect, it, vi } from 'vitest';
import { aiCaseAssistance } from './ai-case-assistance.mjs';

const caseId = '44444444-4444-4444-8444-444444444444';
const queueRow = { id: caseId, subject: 'Export never finishes', status: 'open' };
const threadRows = [
  { author_name: 'Pat Customer', author_role: 'customer', visibility: 'customer', body: 'The export spins forever.', created_at: '2026-10-15T12:00:00Z' },
  { author_name: 'Sam Agent', author_role: 'support_agent', visibility: 'internal', body: 'Large census tenant.', created_at: '2026-10-15T12:05:00Z' },
];

function harness({ role = 'support_agent', aiOverrides = {} } = {}) {
  const calls = [];
  const rpc = vi.fn(async (name) => {
    calls.push(name);
    if (name === 'get_support_actor_context') return { role, id: 'staff-1' };
    if (name === 'get_support_case_thread') return threadRows;
    if (name === 'list_published_content') return [{ kind: 'article', title: 'Exports', summary: 'Split large exports by month.', body_markdown: 'Open Reports and choose one month.' }];
    throw new Error(`Unexpected RPC ${name}`);
  });
  const rows = vi.fn(async () => [queueRow]);
  const ai = {
    configured: true,
    summarize: vi.fn(async () => 'A summary.'),
    draftReply: vi.fn(async () => 'A draft reply.'),
    suggestTriage: vi.fn(async () => ({ category: 'technical_issue', priority: 'high' })),
    ...aiOverrides,
  };
  return { handlers: aiCaseAssistance({ ai, rpc, rows }), ai, rpc, rows, calls };
}

describe('AI case assistance endpoints', () => {
  it('summarizes a case for staff', async () => {
    const { handlers, ai } = harness();
    await expect(handlers.handle('token', 'summary', caseId, {})).resolves.toEqual({ summary: 'A summary.' });
    expect(ai.summarize.mock.calls[0][0].subject).toBe('Export never finishes');
    expect(ai.summarize.mock.calls[0][0].messages).toHaveLength(2);
  });

  it('drafts a reply with knowledge guides and never mutates the case', async () => {
    const { handlers, ai, calls } = harness();
    await expect(handlers.handle('token', 'draft-reply', caseId, {})).resolves.toEqual({ draft: 'A draft reply.' });
    const draftInput = ai.draftReply.mock.calls[0][0];
    expect(draftInput.knowledge).toHaveLength(1);
    expect(draftInput.knowledge[0].body).toContain('Open Reports and choose one month.');
    // Generation only: reads (actor context, queue, thread, published content) and
    // no mutation RPC of any kind.
    expect(calls).toEqual(['get_support_actor_context', 'get_support_case_thread', 'list_published_content']);
  });

  it('passes the quality tier through to the draft call', async () => {
    const { handlers, ai } = harness();
    await handlers.handle('token', 'draft-reply', caseId, { qualityTier: 'quality' });
    expect(ai.draftReply.mock.calls[0][0].tier).toBe('quality');
  });

  it('returns a triage suggestion without applying it', async () => {
    const { handlers, calls } = harness();
    await expect(handlers.handle('token', 'triage-suggestion', caseId, {})).resolves.toEqual({ category: 'technical_issue', priority: 'high' });
    expect(calls).toEqual(['get_support_actor_context', 'get_support_case_thread']);
  });

  it('refuses non-staff callers', async () => {
    const { handlers } = harness({ role: 'tenant_admin' });
    await expect(handlers.handle('token', 'summary', caseId, {})).rejects.toMatchObject({ status: 403 });
  });

  it('refuses with 503 AI_NOT_CONFIGURED before any database work when unconfigured', async () => {
    const rpc = vi.fn();
    const rows = vi.fn();
    const handlers = aiCaseAssistance({ ai: { configured: false }, rpc, rows });
    await expect(handlers.handle('token', 'summary', caseId, {})).rejects.toMatchObject({ status: 503, code: 'AI_NOT_CONFIGURED' });
    expect(rpc).not.toHaveBeenCalled();
    expect(rows).not.toHaveBeenCalled();
  });

  it('returns 404 for a case outside the caller queue', async () => {
    const { handlers } = harness();
    await expect(handlers.handle('token', 'summary', '99999999-9999-4999-8999-999999999999', {})).rejects.toMatchObject({ status: 404 });
  });
});
