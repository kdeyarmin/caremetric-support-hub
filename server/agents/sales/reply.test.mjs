import { describe, expect, it, vi } from 'vitest';
import { salesReplyHandler } from './reply.mjs';

// Fake data only: example.test addresses, "Pat Example", 555-01xx numbers.
const ids = { communication: '11111111-1111-4111-8111-111111111111', message: '22222222-2222-4222-8222-222222222222', earlier: '33333333-3333-4333-8333-333333333333' };
const canary = 'CANARY-5be2c0';
const snapshotOf = (body, overrides = {}) => ({
  id: ids.communication, reference: 2048, channel: 'email', status: 'new', inquiryType: 'sales', sourceSystem: 'carebase.web', productSlug: 'carebase',
  canEmail: true, canText: false, subject: null, headMessageId: ids.message, latestInboundId: ids.message, answered: false, inboundCount: 1, outboundCount: 0,
  messages: [{ id: ids.message, direction: 'inbound', at: '2026-11-08T14:55:00Z', body }], ...overrides,
});
const taskOf = (payload = {}, overrides = {}) => ({
  id: 't1', agentKey: 'sales_executive', kind: 'sales.reply', attempts: 1,
  payload: { communicationId: ids.communication, messageId: ids.message, product: 'carebase', ...payload }, agent: { autonomy: 'propose', config: {} }, ...overrides,
});
const now = () => new Date('2026-11-08T15:00:00Z');
const answer = (over = {}) => ({ outcome: 'completed', output: { intent: 'pricing', possiblePhi: false, needsOwner: false, nextStep: 'start_trial',
  reply: 'CareBase Core is $199 per facility per month, with unlimited residents and staff.\n\nYou can start a 30-day free trial here:\nhttps://cmcarebase.com/signup', ...over } });

const fixture = ({ snapshot = snapshotOf(`How much is CareBase? ${canary}`), model = null, bookingUrl = null, answers = false, guides = null, status = 'proposed', marketed = null } = {}) => {
  const sent = [];
  const store = {
    communicationSnapshot: vi.fn(async () => snapshot),
    notificationCount: vi.fn(async () => 0),
    startRun: vi.fn(async () => 'run-1'),
    finishRun: vi.fn(async () => undefined),
    proposeAction: vi.fn(async () => ({ id: 'action-1', status, requestKey: 'k1', created: true })),
  };
  const notifier = { send: vi.fn(async input => { sent.push(input); return [{ channel: 'email', delivery: 'sent' }]; }) };
  const handler = salesReplyHandler({ store, notifier, drafting: model ? { model, guides } : null, bookingUrl, answers, marketed, log: () => {} });
  return { store, notifier, sent, run: (task = taskOf()) => handler(task, { now }) };
};
const modelOf = (result = answer()) => ({ configured: true, run: vi.fn(async () => (typeof result === 'function' ? result() : result)) });
const kept = harness => JSON.stringify([harness.sent, harness.store.finishRun.mock.calls, harness.store.startRun.mock.calls, harness.store.proposeAction.mock.calls.map(([input]) => ({ ...input, preview: null, input: { ...input.input, body: null } }))]);

describe('the Sales Executive answering a prospect', () => {
  it('drafts nothing for a product the team is not marketing (CareBase in its pilot): it acknowledges and tells the owner the prospect is theirs', async () => {
    const model = modelOf();
    const harness = fixture({ model, marketed: ['caremetric-intel'] });
    const outcome = await harness.run();
    expect(model.run).not.toHaveBeenCalled();
    expect(harness.store.proposeAction).toHaveBeenCalledWith(expect.objectContaining({ kind: 'communication.reply', input: expect.objectContaining({ template: 'sales' }) }));
    expect(harness.sent).toEqual([expect.objectContaining({ subject: 'CM-2048: a CareMetric CareBase inquiry for you', dedupeKey: `sales:not-marketed:${ids.communication}` })]);
    expect(harness.sent[0].body).toContain('join the pilot');
    expect(outcome.result).toMatchObject({ draft: 'not_marketed', reply: 'sales', alert: 'email:sent' });
    expect(kept(harness)).not.toContain(canary);
    // Intel is marketed: its prospects still get a drafted answer.
    const intel = fixture({ model: modelOf(answer({ reply: 'You can start a 30-day free trial here:\nhttps://www.caremetricintel.com/' })), marketed: ['caremetric-intel'], snapshot: snapshotOf('How does the trial work?', { productSlug: 'caremetric-intel', sourceSystem: 'intel.web' }) });
    expect((await intel.run(taskOf({ product: 'caremetric-intel' }))).result.draft).toBe('drafted');
  });

  it('drafts a fact-checked answer, proposes it for approval and tells the owner, keeping no prospect text', async () => {
    const model = modelOf();
    const harness = fixture({ model });
    const outcome = await harness.run();
    const request = model.run.mock.calls[0][1];
    expect(request.promptVersion).toBe('sales.2');
    expect(request.user).toContain(`How much is CareBase? ${canary}`);
    expect(request.system[0].text).not.toContain(canary);
    expect(harness.store.proposeAction).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 't1', kind: 'communication.reply', targetKind: 'communication', targetId: 'CM-2048',
      input: expect.objectContaining({ communicationId: ids.communication, basedOnMessageId: ids.message, route: 'email', template: 'drafted', intent: 'pricing', product: 'carebase',
        classification: { category: 'sales', phi: false, drafted: true } }),
    }));
    expect(harness.store.proposeAction.mock.calls[0][0].preview).toMatch(/^Hello,\n\nCareBase Core is \$199 per facility per month/);
    expect(harness.sent).toEqual([expect.objectContaining({ severity: 'info', subject: 'Reply drafted for CM-2048, a CareMetric CareBase prospect', dedupeKey: `sales:draft:${ids.message}`, communicationReference: 2048 })]);
    expect(outcome).toEqual({ status: 'awaiting_approval', result: { outcome: 'proposed', reference: 2048, product: 'carebase', reply: 'drafted', draft: 'drafted', intent: 'pricing', alert: 'email:sent' } });
    expect(kept(harness)).not.toContain(canary);
  });

  it('tells the model the stage, whether CareMetric wrote first, the word limit and the allowed links', async () => {
    const model = modelOf();
    const harness = fixture({ model, bookingUrl: 'https://cal.example.com/caremetric', snapshot: snapshotOf('Thanks. How does the trial work?', { outboundCount: 1, inquiryType: 'unclassified', sourceSystem: 'hub.email' }),
      guides: { top: vi.fn(async () => [{ title: 'Build a provider list', url: 'https://help.caremetric.ai/help/articles/build-a-provider-list' }, { title: 'Private guide' }]) } });
    await harness.run(taskOf({ product: 'caremetric-intel', opportunity: { stage: 'contacted', contacted: true } }));
    const user = model.run.mock.calls[0][1].user;
    expect(user).toContain('product: CareMetric Intel');
    expect(user).toContain('stage: CareMetric has emailed them');
    expect(user).toContain('caremetric_wrote_first: yes');
    expect(user).toContain('first_message_in_this_conversation: no');
    expect(user).toContain('word_limit: 170');
    expect(user).not.toContain('cal.example.com');
    expect(user).toContain('- Build a provider list: https://help.caremetric.ai/help/articles/build-a-provider-list');
    expect(user).not.toContain('Private guide');
    expect(user).toContain('https://www.caremetricintel.com/#pricing');
    expect(user).not.toContain('cmcarebase.com');
  });

  it('offers the fixed sales acknowledgment when prospect text may not go to the model, so nobody waits', async () => {
    const harness = fixture({ bookingUrl: 'https://cal.example.com/caremetric' });
    const outcome = await harness.run();
    expect(harness.store.proposeAction.mock.calls[0][0]).toMatchObject({ kind: 'communication.reply', input: { template: 'sales', classification: { category: 'sales', phi: false } } });
    expect(harness.store.proposeAction.mock.calls[0][0].preview).toContain('We have your request and will reply here with the information you need.');
    expect(harness.sent).toEqual([]);
    expect(outcome.result).toMatchObject({ reply: 'sales', draft: 'off' });
  });

  it('falls back to the acknowledgment when a draft fails a check, and records only the check', async () => {
    const harness = fixture({ model: modelOf(answer({ reply: `We guarantee you will pass your next survey. ${canary}` })) });
    const outcome = await harness.run();
    expect(outcome.result).toMatchObject({ reply: 'sales', draft: 'rejected', draftReason: 'guarantee' });
    expect(harness.store.finishRun.mock.calls[0][3]).toContain('draft not used (guarantee)');
    expect(kept(harness)).not.toContain(canary);
  });

  it('acknowledges a first message the owner must answer, and leaves a later one to the owner', async () => {
    const model = modelOf(answer({ intent: 'question', needsOwner: true, reply: '' }));
    expect((await fixture({ model }).run()).result).toMatchObject({ reply: 'sales', draft: 'needs_owner' });
    const later = fixture({ model, snapshot: snapshotOf('Can you send your security questionnaire answers?', { outboundCount: 1 }) });
    expect(await later.run()).toMatchObject({ status: 'done', result: { reply: 'owner_only', draft: 'needs_owner' } });
    expect(later.store.proposeAction).not.toHaveBeenCalled();
  });

  it('proposes nothing for a request not to be contacted, a no or a wrong person', async () => {
    for (const intent of ['unsubscribe', 'not_interested', 'wrong_person']) {
      const harness = fixture({ model: modelOf(answer({ intent, needsOwner: true, reply: '' })) });
      expect((await harness.run()).result, intent).toMatchObject({ reply: 'owner_only', draft: 'owner_only', intent });
      expect(harness.store.proposeAction).not.toHaveBeenCalled();
    }
  });

  it('answers a support question that reached the sales desk with the plain acknowledgment', async () => {
    const harness = fixture({ model: modelOf(answer({ intent: 'support', needsOwner: true, reply: '' })) });
    expect((await harness.run()).result).toMatchObject({ reply: 'standard' });
    expect(harness.store.proposeAction.mock.calls[0][0].input.classification).toEqual({ category: 'general', phi: false });
  });

  it('asks a sender with identifiers to resend without them, before any model call', async () => {
    const model = modelOf();
    const harness = fixture({ model, snapshot: snapshotOf('Her SSN is 000-12-3456, can CareBase hold it?') });
    expect((await harness.run()).result).toMatchObject({ reply: 'phi', draft: 'phi' });
    expect(model.run).not.toHaveBeenCalled();
    const read = fixture({ model: modelOf(answer({ possiblePhi: true, reply: '' })) });
    expect((await read.run()).result).toMatchObject({ reply: 'phi' });
  });

  it('retries a transient model failure, then falls back to the acknowledgment', async () => {
    const failing = { configured: true, run: vi.fn(async () => { throw Object.assign(new Error('busy'), { code: 'provider_overloaded', transient: true }); }) };
    await expect(fixture({ model: failing }).run()).rejects.toMatchObject({ code: 'provider_overloaded' });
    expect((await fixture({ model: failing }).run(taskOf({}, { attempts: 3 }))).result).toMatchObject({ reply: 'sales', draft: 'unavailable', draftReason: 'provider_overloaded' });
    expect((await fixture({ model: modelOf({ outcome: 'budget_exhausted' }) }).run()).result).toMatchObject({ reply: 'sales', draft: 'budget' });
    expect((await fixture({ model: modelOf({ outcome: 'refused' }) }).run()).result).toMatchObject({ reply: 'owner_only', draft: 'refused' });
  });

  it('skips a conversation that moved on, was answered or closed, and refuses a bad task', async () => {
    for (const [overrides, reason] of [[{ latestInboundId: ids.earlier }, 'superseded'], [{ answered: true }, 'answered'], [{ status: 'closed' }, 'closed'], [{ canEmail: false }, 'no_route']]) {
      const harness = fixture({ snapshot: snapshotOf('Pricing?', overrides) });
      expect((await harness.run()).result, reason).toMatchObject({ outcome: 'skipped', reason });
      expect(harness.store.proposeAction).not.toHaveBeenCalled();
    }
    await expect(fixture().run(taskOf({ product: 'breathe' }))).rejects.toMatchObject({ code: 'invalid_payload' });
    await expect(fixture().run(taskOf({ messageId: 'nope' }))).rejects.toMatchObject({ code: 'invalid_payload' });
  });

  it('stops alerting the owner about drafts after twenty a day, but still proposes them', async () => {
    const harness = fixture({ model: modelOf() });
    harness.store.notificationCount.mockResolvedValue(20);
    expect((await harness.run()).result).toMatchObject({ reply: 'drafted', alert: 'capped' });
    expect(harness.sent).toEqual([]);
    expect(harness.store.notificationCount).toHaveBeenCalledWith({ prefix: 'sales:draft:', channel: 'email', since: new Date('2026-11-08T05:00:00Z') });
  });
});

describe('answering on its own once handed over', () => {
  const withGuide = answer({ reply: 'CareBase keeps staff training in one place. This guide walks through assigning annual training:\nhttps://help.caremetric.ai/help/articles/assign-annual-training\n\nYou can start a 30-day free trial here:\nhttps://cmcarebase.com/signup' });
  const guides = { top: vi.fn(async () => [{ title: 'Assign annual training', url: 'https://help.caremetric.ai/help/articles/assign-annual-training' }]) };

  it('proposes a session-less answer with exactly the fields the database admits, citing the guide it links', async () => {
    const harness = fixture({ model: modelOf(withGuide), answers: true, guides });
    const outcome = await harness.run();
    const proposal = harness.store.proposeAction.mock.calls[0][0];
    expect(proposal.kind).toBe('communication.answer');
    expect(Object.keys(proposal.input).sort()).toEqual(['basedOnMessageId', 'body', 'channel', 'classification', 'communicationId', 'reference', 'route', 'sources', 'template']);
    expect(proposal.input).toMatchObject({ template: 'drafted', classification: { category: 'sales', phi: false, drafted: true }, sources: ['CareMetric fact sheet', 'Sales playbook', 'Assign annual training'] });
    expect(outcome.result).toMatchObject({ outcome: 'proposed', reply: 'drafted' });
    expect(harness.sent[0].subject).toBe('Reply drafted for CM-2048, a CareMetric CareBase prospect');
  });

  it('tells the owner it answered on its own when "Sales answers" is handed over', async () => {
    const harness = fixture({ model: modelOf(withGuide), answers: true, guides, status: 'auto_approved' });
    const outcome = await harness.run();
    expect(outcome).toMatchObject({ status: 'awaiting_approval', result: { outcome: 'proposed', reply: 'drafted' } });
    expect(harness.sent[0]).toMatchObject({ subject: 'Answered CM-2048, a CareMetric CareBase prospect' });
    expect(harness.sent[0].body).toContain('on its own');
    expect(harness.store.finishRun.mock.calls[0][3]).toContain('answer approved to send');
  });

  it('keeps a text message, and a database without answers, on the owner-approved reply', async () => {
    const sms = fixture({ model: modelOf(answer({ reply: 'CareBase has a 30-day free trial: https://cmcarebase.com/signup' })), answers: true, guides, snapshot: snapshotOf('How much?', { channel: 'sms', canEmail: false, canText: true }) });
    await sms.run();
    expect(sms.store.proposeAction.mock.calls[0][0].kind).toBe('communication.reply');
    const older = fixture({ model: modelOf(withGuide), answers: false, guides });
    await older.run();
    expect(older.store.proposeAction.mock.calls[0][0].kind).toBe('communication.reply');
  });

  it('refuses a link to a guide it was not given', async () => {
    const harness = fixture({ model: modelOf(answer({ reply: 'See https://help.caremetric.ai/help/articles/made-up-guide' })), answers: true, guides });
    expect((await harness.run()).result).toMatchObject({ draft: 'rejected', draftReason: 'link', reply: 'sales' });
  });
});
