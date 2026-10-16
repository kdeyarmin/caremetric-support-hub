import { describe, expect, it, vi } from 'vitest';
import { aiAutomation, maxAiAttempts } from './ai-automation.mjs';

const T0 = new Date('2026-10-15T12:00:00Z');
const HOUR = 60 * 60 * 1000;

function memoryStore() {
  const cases = new Map();
  let sequence = 0;
  const store = {
    cases,
    addCase({ id, subject = 'Export never finishes', status = 'open', source = 'portal', messages = [] }) {
      cases.set(id, {
        caseId: id, subject, productId: 'breathe', status, priority: 'normal', source,
        state: null, messages: messages.map((body, index) => ({
          id: `${id}-m${index + 1}`, authorId: 'customer-1', authorName: 'Pat Customer', authorRole: 'customer', body, createdAt: T0.toISOString(),
        })), notes: [], escalated: false, resolved: false,
      });
      return cases.get(id);
    },
    customerSays(id, body) {
      const entry = cases.get(id);
      sequence += 1;
      entry.messages.push({ id: `${id}-x${sequence}`, authorId: 'customer-1', authorName: 'Pat Customer', authorRole: 'customer', body, createdAt: new Date(T0.getTime() + sequence * HOUR).toISOString() });
    },
    staffSays(id, body) {
      const entry = cases.get(id);
      sequence += 1;
      entry.messages.push({ id: `${id}-s${sequence}`, authorId: 'staff-1', authorName: 'Sam Agent', authorRole: 'support_agent', body, createdAt: new Date(T0.getTime() + sequence * HOUR).toISOString() });
    },
    async findNewEligibleCaseIds() {
      return [...cases.values()].filter((entry) => !entry.state && entry.source === 'portal' && ['open', 'in_progress'].includes(entry.status)
        && !entry.messages.some((message) => ['support_agent', 'support_manager', 'platform_admin'].includes(message.authorRole))).map((entry) => entry.caseId);
    },
    async claimCase(caseId) {
      const entry = cases.get(caseId);
      if (!entry || entry.state) return false;
      entry.state = { stage: 'attempt_due', attempts: 0, lastSeenCustomerMessageId: null, lastCustomerResponse: null, followUpDueAt: null, followUpSentAt: null };
      return true;
    },
    async findActiveCaseIds() {
      return [...cases.values()].filter((entry) => entry.state && ['attempt_due', 'awaiting_response', 'escalate_due'].includes(entry.state.stage)).map((entry) => entry.caseId);
    },
    async loadWork(caseId) {
      const entry = cases.get(caseId);
      if (!entry) return null;
      return { caseId, subject: entry.subject, productId: entry.productId, status: entry.status, priority: entry.priority, state: entry.state ? { ...entry.state } : null, messages: [...entry.messages], notes: [...entry.notes] };
    },
    async knowledgeForCase() { return [{ title: 'Exports guide', summary: 'Split large exports by month.', body: 'Open Reports and choose a month.' }]; },
    async postAiMessage(caseId, body) {
      const entry = cases.get(caseId);
      sequence += 1;
      const id = `${caseId}-ai${sequence}`;
      entry.messages.push({ id, authorId: 'a1a00000-a1a0-4000-8000-000000000001', authorName: 'CareMetric AI Assistant', authorRole: 'ai_assistant', body, createdAt: new Date().toISOString() });
      if (['open', 'in_progress'].includes(entry.status)) entry.status = 'waiting_on_customer';
      return id;
    },
    async postAiNote(caseId, body) {
      cases.get(caseId).notes.push({ id: `${caseId}-note`, authorName: 'CareMetric AI Assistant', authorRole: 'ai_assistant', body, createdAt: new Date().toISOString() });
    },
    async escalateCase(caseId) { const entry = cases.get(caseId); entry.escalated = true; entry.status = 'in_progress'; entry.priority = 'high'; },
    async resolveCase(caseId) { const entry = cases.get(caseId); entry.resolved = true; entry.status = 'resolved'; },
    async saveState(caseId, patch) { Object.assign(cases.get(caseId).state, patch); },
  };
  return store;
}

function fakeAi({ classify = 'unclear' } = {}) {
  return {
    configured: true,
    draftReply: vi.fn(async ({ attempt }) => `Automated suggestion number ${attempt}. Did that fix it? — CareMetric AI Assistant (automated reply)`),
    summarizeForEscalation: vi.fn(async () => 'Two automated suggestions were tried; the customer still cannot export.'),
    classifyResolution: vi.fn(async () => classify),
  };
}

function buildLoop(store, ai, overrides = {}) {
  let clock = T0;
  const loop = aiAutomation({ ai, store, enabled: true, followUpDelayMs: 24 * HOUR, now: () => clock, log: () => {}, ...overrides });
  return { loop, advance: (ms) => { clock = new Date(clock.getTime() + ms); } };
}

const aiMessages = (entry) => entry.messages.filter((message) => message.authorRole === 'ai_assistant');

describe('AI auto-resolution loop', () => {
  it('attempt 1 posts on a new portal case, then a portal-style fixed answer resolves it', async () => {
    const store = memoryStore();
    const entry = store.addCase({ id: 'case-1', messages: ['The export spins forever.'] });
    const ai = fakeAi();
    const { loop } = buildLoop(store, ai);
    await loop.tick();
    expect(aiMessages(entry)).toHaveLength(1);
    expect(aiMessages(entry)[0].body).toContain('suggestion number 1');
    expect(entry.state).toMatchObject({ stage: 'awaiting_response', attempts: 1 });
    expect(entry.status).toBe('waiting_on_customer');
    // The customer confirms via the portal RPC in production; here the recorded
    // state mirrors that RPC outcome.
    entry.state.stage = 'resolved';
    await loop.tick();
    expect(aiMessages(entry)).toHaveLength(1);
    expect(ai.draftReply).toHaveBeenCalledTimes(1);
  });

  it('attempt 1 → classified fixed → case resolved and automation stops', async () => {
    const store = memoryStore();
    const entry = store.addCase({ id: 'case-2', messages: ['Export broken.'] });
    const ai = fakeAi({ classify: 'fixed' });
    const { loop } = buildLoop(store, ai);
    await loop.tick();
    store.customerSays('case-2', 'That worked, thanks!');
    await loop.tick();
    expect(entry.resolved).toBe(true);
    expect(entry.state).toMatchObject({ stage: 'resolved', responseSource: 'classification' });
    await loop.tick();
    expect(ai.draftReply).toHaveBeenCalledTimes(1);
  });

  it('not fixed → attempt 2 with failure context → not fixed → escalated loudly and halted', async () => {
    const store = memoryStore();
    const entry = store.addCase({ id: 'case-3', messages: ['Export broken.'] });
    const ai = fakeAi({ classify: 'not_fixed' });
    const { loop } = buildLoop(store, ai);
    await loop.tick();
    store.customerSays('case-3', 'Still spinning.');
    await loop.tick();
    expect(aiMessages(entry)).toHaveLength(2);
    expect(ai.draftReply.mock.calls[1][0]).toMatchObject({ attempt: 2, automated: true, failureContext: 'Still spinning.' });
    expect(entry.state).toMatchObject({ stage: 'awaiting_response', attempts: 2 });
    store.customerSays('case-3', 'Nope, still broken.');
    await loop.tick();
    expect(entry.state.stage).toBe('exhausted');
    expect(entry.escalated).toBe(true);
    expect(entry.priority).toBe('high');
    expect(entry.status).toBe('in_progress');
    expect(entry.notes).toHaveLength(1);
    expect(entry.notes[0].body).toContain('ESCALATED — AI attempts exhausted');
    expect(entry.notes[0].authorRole).toBe('ai_assistant');
    // Permanently halted: further customer messages change nothing.
    store.customerSays('case-3', 'Anyone there?');
    await loop.tick();
    expect(ai.draftReply).toHaveBeenCalledTimes(maxAiAttempts);
    expect(aiMessages(entry)).toHaveLength(2);
  });

  it('sends exactly one follow-up nudge after the configured delay with no reply', async () => {
    const store = memoryStore();
    const entry = store.addCase({ id: 'case-4', messages: ['Export broken.'] });
    const ai = fakeAi();
    const { loop, advance } = buildLoop(store, ai);
    await loop.tick();
    await loop.tick();
    expect(aiMessages(entry)).toHaveLength(1);
    advance(25 * HOUR);
    await loop.tick();
    expect(aiMessages(entry)).toHaveLength(2);
    expect(aiMessages(entry)[1].body).toContain('Just checking in');
    expect(ai.draftReply).toHaveBeenCalledTimes(1);
    advance(48 * HOUR);
    await loop.tick();
    expect(aiMessages(entry)).toHaveLength(2);
  });

  it('does nothing when disabled, unconfigured, or for non-portal cases', async () => {
    const store = memoryStore();
    const portal = store.addCase({ id: 'case-5', messages: ['Help.'] });
    const email = store.addCase({ id: 'case-6', source: 'email', messages: ['Help.'] });
    const ai = fakeAi();
    const disabled = aiAutomation({ ai, store, enabled: false, log: () => {} });
    await disabled.tick();
    expect(aiMessages(portal)).toHaveLength(0);
    const unconfigured = aiAutomation({ ai: { configured: false }, store, enabled: true, log: () => {} });
    await unconfigured.tick();
    expect(aiMessages(portal)).toHaveLength(0);
    const { loop } = buildLoop(store, ai);
    await loop.tick();
    expect(aiMessages(portal)).toHaveLength(1);
    expect(aiMessages(email)).toHaveLength(0);
    expect(email.state).toBeNull();
  });

  it('halts automation when a staff member joins the thread', async () => {
    const store = memoryStore();
    const entry = store.addCase({ id: 'case-7', messages: ['Export broken.'] });
    const ai = fakeAi();
    const { loop } = buildLoop(store, ai);
    await loop.tick();
    store.staffSays('case-7', 'Taking this one over.');
    await loop.tick();
    expect(entry.state).toMatchObject({ stage: 'halted', haltReason: 'staff_engaged' });
    store.customerSays('case-7', 'Still broken.');
    await loop.tick();
    expect(ai.draftReply).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting on an unclear reply without burning an attempt', async () => {
    const store = memoryStore();
    const entry = store.addCase({ id: 'case-8', messages: ['Export broken.'] });
    const ai = fakeAi({ classify: 'unclear' });
    const { loop } = buildLoop(store, ai);
    await loop.tick();
    store.customerSays('case-8', 'I will try this tonight.');
    await loop.tick();
    expect(entry.state).toMatchObject({ stage: 'awaiting_response', attempts: 1 });
    await loop.tick();
    expect(ai.classifyResolution).toHaveBeenCalledTimes(1);
  });

  it('falls back to a template escalation summary if the summary call fails', async () => {
    const store = memoryStore();
    const entry = store.addCase({ id: 'case-9', messages: ['Export broken.'] });
    const ai = fakeAi({ classify: 'not_fixed' });
    ai.summarizeForEscalation = vi.fn(async () => { throw new Error('provider down'); });
    // Portal path: the RPC moves the case to escalate_due after attempt 2 fails.
    entry.state = { stage: 'escalate_due', attempts: 2, lastSeenCustomerMessageId: null, lastCustomerResponse: 'Still broken.', followUpDueAt: null, followUpSentAt: null };
    const { loop } = buildLoop(store, ai);
    await loop.tick();
    expect(entry.state.stage).toBe('exhausted');
    expect(entry.notes[0].body).toContain('Still broken.');
  });
});
