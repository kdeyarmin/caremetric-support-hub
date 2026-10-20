import { describe, expect, it, vi } from 'vitest';
import { aiAutomation, automatedSignature, fitAutomatedReply, maxAiAttempts, maxAiMessageCharacters, maxConsecutiveFailures } from './ai-automation.mjs';

const T0 = new Date('2026-10-15T12:00:00Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function memoryStore() {
  const cases = new Map();
  let sequence = 0;
  // Mirrors the database limit on automated message and note bodies.
  const checkBody = (body) => {
    if (body.length > maxAiMessageCharacters) throw Object.assign(new Error('An automated reply of 1 to 5000 characters is required.'), { code: '22023' });
  };
  const store = {
    cases,
    patches: [],
    now: () => T0,
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
      entry.state = { stage: 'attempt_due', attempts: 0, lastSeenCustomerMessageId: null, lastCustomerResponse: null, followUpDueAt: null, followUpSentAt: null, consecutiveFailures: 0, retryAt: null };
      return true;
    },
    async findActiveCaseIds() {
      return [...cases.values()].filter((entry) => entry.state && ['attempt_due', 'awaiting_response', 'escalate_due'].includes(entry.state.stage)
        && (!entry.state.retryAt || new Date(entry.state.retryAt).getTime() <= store.now().getTime())).map((entry) => entry.caseId);
    },
    async loadWork(caseId) {
      const entry = cases.get(caseId);
      if (!entry) return null;
      return { caseId, subject: entry.subject, productId: entry.productId, status: entry.status, priority: entry.priority, state: entry.state ? { ...entry.state } : null, messages: [...entry.messages], notes: [...entry.notes] };
    },
    async knowledgeForCase() { return [{ title: 'Exports guide', summary: 'Split large exports by month.', body: 'Open Reports and choose a month.' }]; },
    async postAiMessage(caseId, body) {
      checkBody(body);
      const entry = cases.get(caseId);
      sequence += 1;
      const id = `${caseId}-ai${sequence}`;
      entry.messages.push({ id, authorId: 'a1a00000-a1a0-4000-8000-000000000001', authorName: 'CareMetric AI Assistant', authorRole: 'ai_assistant', body, createdAt: new Date().toISOString() });
      if (['open', 'in_progress'].includes(entry.status)) entry.status = 'waiting_on_customer';
      return id;
    },
    async postAiNote(caseId, body) {
      checkBody(body);
      cases.get(caseId).notes.push({ id: `${caseId}-note`, authorName: 'CareMetric AI Assistant', authorRole: 'ai_assistant', body, createdAt: new Date().toISOString() });
    },
    async escalateCase(caseId) { const entry = cases.get(caseId); entry.escalated = true; entry.status = 'in_progress'; entry.priority = 'high'; },
    async resolveCase(caseId) { const entry = cases.get(caseId); entry.resolved = true; entry.status = 'resolved'; },
    async saveState(caseId, patch) { store.patches.push(patch); Object.assign(cases.get(caseId).state, patch); },
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
  const logs = [];
  store.now = () => clock;
  const loop = aiAutomation({ ai, store, enabled: true, followUpDelayMs: 24 * HOUR, now: () => clock, log: (line) => logs.push(JSON.parse(line)), ...overrides });
  return { loop, logs, advance: (ms) => { clock = new Date(clock.getTime() + ms); } };
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
    // Without a failure the loop never writes the failure fields.
    expect(store.patches.some((patch) => 'consecutiveFailures' in patch || 'retryAt' in patch)).toBe(false);
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

  it('posts an oversize draft cut to the limit instead of failing on every sweep', async () => {
    const store = memoryStore();
    const entry = store.addCase({ id: 'case-10', messages: ['Export broken.'] });
    const ai = fakeAi();
    const steps = Array.from({ length: 60 }, (_, index) => `Step ${index + 1}: open Reports, choose one month, and export it again before you try the next month.`);
    ai.draftReply = vi.fn(async () => `${steps.join('\n\n')}\n\nDid that fix it?\n\n${automatedSignature}`);
    const { loop, logs } = buildLoop(store, ai);
    await loop.tick();
    const [reply] = aiMessages(entry);
    expect(reply.body.length).toBeLessThanOrEqual(maxAiMessageCharacters);
    expect(reply.body.endsWith(`\n\nDid these steps fix the problem? Reply here and let us know.\n\n${automatedSignature}`)).toBe(true);
    expect(entry.state).toMatchObject({ stage: 'awaiting_response', attempts: 1 });
    expect(logs).toEqual([]);
    await loop.tick();
    expect(ai.draftReply).toHaveBeenCalledTimes(1);
  });

  it('backs off a persistently failing case, then hands it to staff instead of retrying for ever', async () => {
    const store = memoryStore();
    const entry = store.addCase({ id: 'case-11', messages: ['Export broken.'] });
    const ai = fakeAi();
    ai.draftReply = vi.fn(async () => { throw Object.assign(new Error('AI assistance is temporarily unavailable.'), { status: 502, code: 'AI_PROVIDER_ERROR' }); });
    const { loop, logs, advance } = buildLoop(store, ai);
    await loop.tick();
    expect(entry.state).toMatchObject({ stage: 'attempt_due', attempts: 0, consecutiveFailures: 1, retryAt: new Date(T0.getTime() + 5 * MINUTE) });
    // Backing off: sweeps before the retry time leave the case alone.
    await loop.tick();
    advance(4 * MINUTE);
    await loop.tick();
    expect(ai.draftReply).toHaveBeenCalledTimes(1);
    advance(MINUTE);
    await loop.tick();
    expect(entry.state).toMatchObject({ stage: 'attempt_due', consecutiveFailures: 2, retryAt: new Date(T0.getTime() + 15 * MINUTE) });
    advance(10 * MINUTE);
    await loop.tick();
    expect(ai.draftReply).toHaveBeenCalledTimes(maxConsecutiveFailures);
    expect(entry.state).toMatchObject({ stage: 'exhausted', consecutiveFailures: maxConsecutiveFailures });
    expect(entry).toMatchObject({ escalated: true, status: 'in_progress', priority: 'high' });
    expect(entry.notes).toHaveLength(1);
    expect(entry.notes[0].body).toMatch(/^ESCALATED — AI automation could not complete\./);
    expect(entry.notes[0].body).toContain('The customer has not received an automated reply.');
    expect(ai.summarizeForEscalation).not.toHaveBeenCalled();
    expect(aiMessages(entry)).toHaveLength(0);
    expect(logs.filter((line) => line.event === 'hub_ai_automation_error')).toHaveLength(maxConsecutiveFailures);
    expect(logs.at(-1)).toEqual({ event: 'hub_ai_automation_escalated_after_failures', case_id: 'case-11', consecutive_failures: maxConsecutiveFailures });
    advance(24 * HOUR);
    await loop.tick();
    expect(ai.draftReply).toHaveBeenCalledTimes(maxConsecutiveFailures);
  });

  it('keeps retrying a provider outage with growing backoff, then answers once the provider recovers', async () => {
    const store = memoryStore();
    const entry = store.addCase({ id: 'case-12', messages: ['Export broken.'] });
    const ai = fakeAi();
    const working = ai.draftReply;
    let outage = true;
    ai.draftReply = vi.fn(async (input) => {
      if (outage) throw Object.assign(new Error('AI assistance is temporarily unavailable.'), { transient: true });
      return working(input);
    });
    const { loop, advance } = buildLoop(store, ai);
    const delays = [];
    for (let failure = 1; failure <= 6; failure += 1) {
      const sweptAt = store.now().getTime();
      await loop.tick();
      expect(entry.state).toMatchObject({ stage: 'attempt_due', consecutiveFailures: failure });
      delays.push((new Date(entry.state.retryAt).getTime() - sweptAt) / MINUTE);
      advance(new Date(entry.state.retryAt).getTime() - sweptAt);
    }
    expect(delays).toEqual([5, 10, 20, 30, 30, 30]);
    expect(entry.escalated).toBe(false);
    outage = false;
    await loop.tick();
    expect(aiMessages(entry)).toHaveLength(1);
    expect(entry.state).toMatchObject({ stage: 'awaiting_response', attempts: 1, consecutiveFailures: 0, retryAt: null });
  });

  it('applies the same policy while awaiting the customer', async () => {
    const store = memoryStore();
    const entry = store.addCase({ id: 'case-13', messages: ['Export broken.'] });
    const ai = fakeAi();
    ai.classifyResolution = vi.fn(async () => { throw new Error('classification failed'); });
    const { loop, advance } = buildLoop(store, ai);
    await loop.tick();
    store.customerSays('case-13', 'Something else happened this time.');
    for (let sweep = 0; sweep < maxConsecutiveFailures; sweep += 1) {
      await loop.tick();
      advance(HOUR);
    }
    expect(ai.classifyResolution).toHaveBeenCalledTimes(maxConsecutiveFailures);
    expect(entry.state.stage).toBe('exhausted');
    expect(entry.escalated).toBe(true);
    expect(entry.notes[0].body).toContain('It had sent 1 automated attempt(s) to the customer.');
  });

  it('only backs off a failing escalation, and stops paying for its summary once the streak is long', async () => {
    const store = memoryStore();
    const entry = store.addCase({ id: 'case-14', messages: ['Export broken.'] });
    entry.state = { stage: 'escalate_due', attempts: 2, lastSeenCustomerMessageId: null, lastCustomerResponse: 'Still broken.', followUpDueAt: null, followUpSentAt: null, consecutiveFailures: 0, retryAt: null };
    const ai = fakeAi();
    const postAiNote = store.postAiNote;
    let notesFail = true;
    store.postAiNote = async (caseId, body) => {
      if (notesFail) throw new Error('note refused');
      return postAiNote(caseId, body);
    };
    const { loop, advance } = buildLoop(store, ai);
    for (let sweep = 0; sweep < maxConsecutiveFailures + 1; sweep += 1) {
      await loop.tick();
      advance(HOUR);
    }
    expect(entry.state).toMatchObject({ stage: 'escalate_due', consecutiveFailures: maxConsecutiveFailures + 1 });
    expect(ai.summarizeForEscalation).toHaveBeenCalledTimes(maxConsecutiveFailures);
    notesFail = false;
    await loop.tick();
    expect(entry.state.stage).toBe('exhausted');
    expect(entry.notes[0].body).toMatch(/^ESCALATED — AI automation could not complete\./);
    expect(ai.summarizeForEscalation).toHaveBeenCalledTimes(maxConsecutiveFailures);
  });
});

describe('fitting automated drafts to the reply limit', () => {
  const closing = `\n\nDid these steps fix the problem? Reply here and let us know.\n\n${automatedSignature}`;

  it('leaves a draft within the limit exactly as written', () => {
    const draft = `Open Reports and choose one month.\n\nDid that fix it?\n\n${automatedSignature}`;
    expect(fitAutomatedReply(draft)).toBe(draft);
    const atLimit = 'a'.repeat(maxAiMessageCharacters);
    expect(fitAutomatedReply(atLimit)).toBe(atLimit);
    // Over the limit only through padding before the signature: nothing is cut.
    const padded = `Open Reports.\n\nChoose one month.${' '.repeat(maxAiMessageCharacters)}${automatedSignature}`;
    expect(fitAutomatedReply(padded)).toBe(`Open Reports.\n\nChoose one month.\n\nDid these steps fix the problem? Reply here and let us know.\n\n${automatedSignature}`);
  });

  it('cuts at the last whole paragraph and keeps one closing signature', () => {
    const paragraphs = Array.from({ length: 80 }, (_, index) => `Step ${index + 1}: open Reports, choose a single month and export again. Wait for it to finish.`);
    const fitted = fitAutomatedReply(`${paragraphs.join('\n\n')}\n\nDid that fix it?\n\n${automatedSignature}`);
    expect(fitted.length).toBeLessThanOrEqual(maxAiMessageCharacters);
    expect(fitted.endsWith(closing)).toBe(true);
    expect(fitted.split(automatedSignature)).toHaveLength(2);
    const body = fitted.slice(0, -closing.length);
    expect(body.endsWith('Wait for it to finish.')).toBe(true);
    expect(paragraphs.join('\n\n').startsWith(body)).toBe(true);
    expect(body.length).toBeGreaterThan(maxAiMessageCharacters - closing.length - 200);
  });

  it('falls back to a sentence end, never a list number, then a word break', () => {
    const sentences = Array.from({ length: 200 }, (_, index) => `Sentence ${index + 1} adds one more detail about the export.`).join(' ');
    const bySentence = fitAutomatedReply(sentences);
    expect(bySentence.length).toBeLessThanOrEqual(maxAiMessageCharacters);
    expect(bySentence.slice(0, -closing.length)).toMatch(/about the export\.$/);
    const list = Array.from({ length: 200 }, (_, index) => `${index + 1}. Open Reports and export month ${index + 1} on its own`).join('\n');
    expect(fitAutomatedReply(list).slice(0, -closing.length)).toMatch(/on its own$/);
    const byWord = fitAutomatedReply('export '.repeat(1000));
    expect(byWord.length).toBeLessThanOrEqual(maxAiMessageCharacters);
    expect(byWord.endsWith(`export…${closing}`)).toBe(true);
  });

  it('never splits a character when nothing else breaks the text', () => {
    const fitted = fitAutomatedReply(`x${'🙂'.repeat(3000)}`);
    expect(fitted.length).toBeLessThanOrEqual(maxAiMessageCharacters);
    expect(fitted).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(fitted.endsWith(`🙂…${closing}`)).toBe(true);
  });
});
