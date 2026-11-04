import { describe, expect, it, vi } from 'vitest';
import { externalEmailAvailable, externalEmailExecutor, externalEmailExecutors, externalEmailFeature, externalEmailRecovery, validExternalEmail } from './external-email.mjs';
import { actionExecutor } from './actions.mjs';
import { sendgridMail } from '../communications.mjs';

const actionId = '11111111-1111-4111-8111-111111111111';
const requestKey = '22222222-2222-4222-8222-222222222222';
const message = { to: 'data.support@example.test', subject: 'CareMetric: public data access', body: 'Hello support,\n\nPlease investigate this source.\n\nThank you.\n' };
const execution = (over = {}) => ({ id: actionId, agentKey: 'chief_of_staff', kind: 'email.external', autoApproved: false, execution: 1, input: { requestKey }, ...over });
const fixture = ({ earlier = { state: 'unrecorded' }, begun = { state: 'ready', ...message }, delivery = { delivery: 'sent', id: 'provider-1' }, configured = true } = {}) => {
  const log = vi.fn();
  const email = { configured, send: vi.fn(async () => typeof delivery === 'function' ? delivery() : delivery) };
  const store = {
    externalEmailBeginSend: vi.fn(async ({ claim }) => claim ? begun : earlier),
    externalEmailFinishSend: vi.fn(async () => true),
  };
  return { email, store, log, send: externalEmailExecutor({ store, email, log }) };
};

describe('owner-directed external email', () => {
  it('validates one mailbox and bounded text without rewriting the approved message', () => {
    expect(validExternalEmail(message)).toBe(true);
    expect(validExternalEmail({ ...message, to: 'operations+data@example.test', subject: ' Subject with spaces ', body: '\n\tExact text\r\n' })).toBe(true);
    expect(validExternalEmail({ ...message, subject: '🙂'.repeat(200), body: '🙂'.repeat(5000) })).toBe(true);
    expect(validExternalEmail({ ...message, subject: '🙂'.repeat(201) })).toBe(false);
    expect(validExternalEmail({ ...message, body: '🙂'.repeat(5001) })).toBe(false);
    for (const changed of [
      null, [], {}, { ...message, to: '' }, { ...message, to: 'a@example.test,b@example.test' }, { ...message, to: 'Name <a@example.test>' },
      { ...message, to: ' a@example.test' }, { ...message, to: 'a@example.test\r\nBcc: b@example.test' }, { ...message, to: 'a'.repeat(309) + '@example.test' },
      { ...message, subject: '' }, { ...message, subject: '   ' }, { ...message, subject: 'x'.repeat(201) }, { ...message, subject: 'Hello\r\nBcc: other@example.test' },
      { ...message, body: '' }, { ...message, body: '\n\t ' }, { ...message, body: 'x'.repeat(5001) }, { ...message, body: 'hello\u0000world' },
    ]) expect(validExternalEmail(changed)).toBe(false);
  });

  it('claims the exact owner-approved payload before using the transactional sender once', async () => {
    const { send, store, email } = fixture();
    expect(await send(execution())).toEqual({ outcome: 'accepted', providerMessageId: 'provider-1' });
    expect(store.externalEmailBeginSend.mock.calls).toEqual([
      [{ actionId, execution: 1, claim: false }], [{ actionId, execution: 1, claim: true }],
    ]);
    expect(email.send).toHaveBeenCalledExactlyOnceWith(message.to, message.subject, message.body);
    expect(store.externalEmailFinishSend).toHaveBeenCalledExactlyOnceWith({ actionId, execution: 1, delivery: 'sent', providerMessageId: 'provider-1' });
    expect(store.externalEmailBeginSend.mock.invocationCallOrder[1]).toBeLessThan(email.send.mock.invocationCallOrder[0]);
  });

  it('uses the configured support sender and exact plain text, without a test prefix or campaign footer', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202, headers: { 'x-message-id': 'accepted-id' } }));
    const email = sendgridMail({ apiKey: 'SG.test-only', from: 'support@example.test', fetchImpl });
    const { store } = fixture();
    const send = externalEmailExecutor({ store, email });
    expect(await send(execution())).toEqual({ outcome: 'accepted', providerMessageId: 'accepted-id' });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.sendgrid.com/v3/mail/send');
    expect(JSON.parse(options.body)).toEqual({
      personalizations: [{ to: [{ email: message.to }] }], from: { email: 'support@example.test', name: 'CareMetric Support' }, subject: message.subject,
      tracking_settings: { click_tracking: { enable: false, enable_text: false } }, content: [{ type: 'text/plain', value: message.body }],
    });
  });

  it.each([
    ['sent', null], ['failed', 'external_email_refused'], ['sending', 'external_email_unconfirmed'], ['unknown', 'external_email_unconfirmed'],
  ])('settles a previous %s attempt without sending again even when the sender is no longer configured', async (status, error) => {
    const { send, store, email } = fixture({ earlier: { state: 'recorded', status, providerMessageId: 'old-provider-id' }, configured: false });
    if (error) await expect(send(execution())).rejects.toMatchObject({ code: error });
    else expect(await send(execution())).toEqual({ outcome: 'accepted', providerMessageId: 'old-provider-id', replay: true });
    expect(store.externalEmailBeginSend).toHaveBeenCalledTimes(1);
    expect(store.externalEmailFinishSend).not.toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
  });

  it('does not resend when another execution claimed the message after the initial read', async () => {
    const { send, email } = fixture({ begun: { state: 'recorded', status: 'sending' } });
    await expect(send(execution())).rejects.toMatchObject({ code: 'external_email_unconfirmed' });
    expect(email.send).not.toHaveBeenCalled();
  });

  it.each([
    [{ delivery: 'failed' }, 'failed', 'external_email_refused'],
    [{ delivery: 'failed', id: 'refusal-reference' }, 'failed', 'external_email_refused'],
    [{ delivery: 'unknown' }, 'unknown', 'external_email_unconfirmed'],
    [{ delivery: 'unknown', id: 'uncertain-reference' }, 'unknown', 'external_email_unconfirmed'],
    [null, 'unknown', 'external_email_unconfirmed'],
    [{ delivery: 'unexpected' }, 'unknown', 'external_email_unconfirmed'],
    [() => { throw new Error(`Untrusted provider error containing ${message.to}`); }, 'unknown', 'external_email_unconfirmed'],
  ])('records refused or uncertain provider outcomes and does not infer safe retry', async (delivery, status, error) => {
    const { send, store, email, log } = fixture({ delivery });
    await expect(send(execution())).rejects.toMatchObject({ code: error });
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(store.externalEmailFinishSend).toHaveBeenCalledExactlyOnceWith({ actionId, execution: 1, delivery: status, providerMessageId: null });
    expect(log).not.toHaveBeenCalled();
  });

  it('keeps the execution fence when settling, and a lost settlement cannot cause another provider request', async () => {
    let recorded = false;
    const { send, store, email, log } = fixture();
    store.externalEmailBeginSend.mockImplementation(async ({ claim }) => {
      if (recorded) return { state: 'recorded', status: 'sending' };
      if (!claim) return { state: 'unrecorded' };
      recorded = true;
      return { state: 'ready', ...message };
    });
    store.externalEmailFinishSend.mockRejectedValue(new Error('database unavailable'));
    expect(await send(execution({ execution: 4 }))).toEqual({ outcome: 'accepted', providerMessageId: 'provider-1' });
    expect(store.externalEmailFinishSend).toHaveBeenCalledWith({ actionId, execution: 4, delivery: 'sent', providerMessageId: 'provider-1' });
    await expect(send(execution({ execution: 5 }))).rejects.toMatchObject({ code: 'external_email_unconfirmed' });
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: 'hub_agent_external_email_unsettled', action_id: actionId }));
  });

  it('fails closed before a claim or send for malformed or automatically approved actions', async () => {
    for (const over of [{ kind: 'email.send' }, { autoApproved: true }, { autoApproved: undefined }, { execution: undefined }, { execution: 0 },
      { input: {} }, { input: { requestKey: 'bad' } }, { input: { requestKey, to: message.to } }]) {
      const { send, store, email } = fixture();
      await expect(send(execution(over))).rejects.toMatchObject({ code: 'invalid_external_email' });
      expect(store.externalEmailBeginSend).not.toHaveBeenCalled();
      expect(email.send).not.toHaveBeenCalled();
    }
  });

  it('does not claim a new send when the transport is unavailable', async () => {
    const { send, store, email } = fixture({ configured: false });
    await expect(send(execution())).rejects.toMatchObject({ code: 'external_email_not_configured' });
    expect(store.externalEmailBeginSend).toHaveBeenCalledExactlyOnceWith({ actionId, execution: 1, claim: false });
    expect(email.send).not.toHaveBeenCalled();
  });

  it('does not send if the database refuses the claim or returns an invalid payload', async () => {
    for (const begun of [null, { state: 'refused' }, { state: 'ready' }, { state: 'ready', ...message, to: 'two@example.test,three@example.test' }]) {
      const { send, email } = fixture({ begun });
      await expect(send(execution())).rejects.toMatchObject({ code: 'external_email_unconfirmed' });
      expect(email.send).not.toHaveBeenCalled();
    }
    const denied = fixture({ earlier: { state: 'refused' } });
    await expect(denied.send(execution())).rejects.toMatchObject({ code: 'external_email_unconfirmed' });
    expect(denied.email.send).not.toHaveBeenCalled();
    expect(denied.store.externalEmailBeginSend).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('records uncertainty when the ledger lookup fails (claim=%s), without exposing provider details or sending', async claimFailure => {
    const { store, email, log } = fixture();
    store.beginExecution = vi.fn(async () => execution({ execution: 2 }));
    store.completeExecution = vi.fn(async () => true);
    store.externalEmailBeginSend.mockImplementation(async ({ claim }) => {
      if (claim === claimFailure) throw new Error(`Database response lost for ${message.to}: ${message.body}`);
      return { state: 'unrecorded' };
    });
    const actions = actionExecutor({ store, executors: { 'email.external': externalEmailExecutor({ store, email, log }) }, log });
    expect(await actions.executeOne(actionId, { kind: 'email.external' })).toEqual({ executed: false, failed: true, skipped: false, error: 'external_email_unconfirmed' });
    expect(store.completeExecution).toHaveBeenCalledWith(actionId, false, { error: 'external_email_unconfirmed' }, 2);
    expect(email.send).not.toHaveBeenCalled();
    expect(store.externalEmailFinishSend).not.toHaveBeenCalled();
    expect(store.externalEmailBeginSend).toHaveBeenCalledTimes(claimFailure ? 2 : 1);
    expect(JSON.stringify(log.mock.calls)).not.toContain(message.to);
    expect(JSON.stringify(log.mock.calls)).not.toContain(message.body);
    await expect(externalEmailExecutor({ store, email, log })(execution())).rejects.toMatchObject({ code: 'external_email_unconfirmed', message: expect.stringContaining('Do not resend') });
  });

  it('does not execute a rejected, expired or already claimed action', async () => {
    const { store, email, log } = fixture();
    store.beginExecution = vi.fn(async () => null);
    store.completeExecution = vi.fn();
    const actions = actionExecutor({ store, executors: { 'email.external': externalEmailExecutor({ store, email, log }) }, log });
    expect(await actions.executeOne(actionId, { kind: 'email.external' })).toEqual({ executed: false, failed: false, skipped: true });
    expect(email.send).not.toHaveBeenCalled();
    expect(store.externalEmailBeginSend).not.toHaveBeenCalled();
  });

  it('records provider acceptance or refusal through the existing approved action executor', async () => {
    for (const [delivery, ok, code] of [['sent', true, null], ['failed', false, 'external_email_refused'], ['unknown', false, 'external_email_unconfirmed']]) {
      const { store, email, log } = fixture({ delivery: { delivery, id: delivery === 'sent' ? 'accepted-id' : null } });
      store.beginExecution = vi.fn(async () => execution());
      store.completeExecution = vi.fn(async () => true);
      const actions = actionExecutor({ store, executors: { 'email.external': externalEmailExecutor({ store, email, log }) }, log });
      const result = await actions.executeOne(actionId, { kind: 'email.external' });
      expect(result).toMatchObject({ executed: ok, failed: !ok });
      expect(store.completeExecution).toHaveBeenCalledWith(actionId, ok, ok ? { outcome: 'accepted', providerMessageId: 'accepted-id' } : { error: code }, 1);
      expect(JSON.stringify(log.mock.calls)).not.toContain(message.to);
      expect(JSON.stringify(log.mock.calls)).not.toContain(message.body);
    }
  });

  it('ignores an unsafe provider id and reports a refused settlement without including message details', async () => {
    const { send, store, log } = fixture({ delivery: { delivery: 'sent', id: 'unsafe\nprovider id' } });
    store.externalEmailFinishSend.mockResolvedValue(false);
    expect(await send(execution())).toEqual({ outcome: 'accepted', providerMessageId: null });
    expect(store.externalEmailFinishSend).toHaveBeenCalledWith({ actionId, execution: 1, delivery: 'sent', providerMessageId: null });
    expect(JSON.stringify(log.mock.calls)).not.toContain(message.to);
  });

  it('registers the executor only after the database declares its feature and advertises sender readiness separately', () => {
    const { store, email } = fixture();
    for (const features of [undefined, new Set(), new Set(['platform.agents.v1']), externalEmailFeature]) {
      expect(externalEmailExecutors({ store, email, features })).toEqual({});
      expect(externalEmailAvailable({ features, email })).toBe(false);
    }
    for (const features of [new Set([externalEmailFeature]), [externalEmailFeature]]) {
      expect(typeof externalEmailExecutors({ store, email, features })['email.external']).toBe('function');
      expect(externalEmailAvailable({ features, email })).toBe(true);
      expect(externalEmailAvailable({ features, email: { configured: false } })).toBe(false);
      expect(externalEmailAvailable({ features, email: { configured: true } })).toBe(false);
    }
  });

  it('offers feature-gated recovery independently of sender readiness, while leaving approved email background eligible', async () => {
    const ready = [{ id: actionId, kind: 'email.external' }];
    const store = { externalEmailReady: vi.fn(async () => ready) };
    for (const features of [undefined, new Set(), externalEmailFeature]) expect(externalEmailRecovery({ store, features })).toBeNull();
    const features = new Set([externalEmailFeature]);
    const recover = externalEmailRecovery({ store, features });
    expect(await recover()).toEqual(ready);
    expect(await recover(true)).toEqual(ready);
    expect(store.externalEmailReady.mock.calls).toEqual([[{ recover: false }], [{ recover: true }]]);
    expect(externalEmailExecutors({ store, features, email: null })['email.external'].requiresSession).not.toBe(true);
  });
});
