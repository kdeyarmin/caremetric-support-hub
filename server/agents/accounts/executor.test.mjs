import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { lifecycleExecutor, lifecycleExecutors } from './executor.mjs';
import { lifecycleFeature, lifecycleInput, lifecycleWording, unsubscribeLabel } from './lifecycle.mjs';

const canary = 'canary.billing@example.test';
const postal = 'CareMetric, 100 Example Street, Altoona, PA 16601';
const origin = 'https://hub.example.test';
const fact = (over = {}) => ({
  tenant: 'maple-grove', tenantName: 'Maple Grove Senior Living', product: 'carebase', productName: 'CareMetric CareBase', status: 'trialing',
  trialStart: '2026-11-02T12:00:00Z', trialEnd: '2026-12-02T12:00:00Z', created: '2026-11-02T12:00:00Z', firstPaidAt: null, cancelling: false,
  hasEmail: true, suppressed: false, hasUsage: false, openUrgentCases: 0, emails: {}, ...over,
});
const input = (template = 'welcome', over = {}) => lifecycleInput(fact(over), template, { bookingUrl: 'https://cal.example.com/owner' });
const execution = (over = {}) => ({
  id: '11111111-1111-4111-8111-111111111111', agentKey: 'account_manager', taskId: '22222222-2222-4222-8222-222222222222', kind: 'email.send',
  targetKind: 'billing_account', targetId: 'maple-grove', input: input(), requestKey: '44444444-4444-4444-8444-444444444444', autoApproved: false, execution: 1, ...over,
});

const fixture = ({ facts = [fact()], earlier = { state: 'unrecorded' }, begun = { state: 'ready', to: canary }, delivery = { delivery: 'sent', id: 'msg-1' }, lifecycle = {} } = {}) => {
  const logs = [];
  const sent = [];
  const mail = { configured: true, send: vi.fn(async message => { sent.push(message); return typeof delivery === 'function' ? delivery() : delivery; }) };
  const store = {
    lifecycleSnapshot: vi.fn(async () => ({ mode: 'live', total: facts.length, truncated: false, accounts: facts })),
    lifecycleBeginSend: vi.fn(async ({ unsubscribeHash }) => (unsubscribeHash === null ? earlier : begun)),
    lifecycleFinishSend: vi.fn(async () => true),
  };
  const send = lifecycleExecutor({ store, lifecycle: { mail, postalAddress: postal, publicOrigin: origin, ...lifecycle }, log: line => logs.push(line) });
  return { store, mail, sent, logs, send };
};
const refusal = code => error => { expect(error.code).toBe(code); return true; };

describe('sending an approved customer email', () => {
  it('sends the approved wording once, from the database\'s one address, with a personal one-click unsubscribe link', async () => {
    const { send, store, mail, sent } = fixture();
    expect(await send(execution())).toEqual({ outcome: 'sent', template: 'welcome' });
    expect(store.lifecycleSnapshot).toHaveBeenCalledWith({ limit: 1, tenant: 'maple-grove', product: 'carebase' });
    expect(store.lifecycleBeginSend.mock.calls.map(call => call[0].unsubscribeHash === null)).toEqual([true, false]);
    const { unsubscribeHash } = store.lifecycleBeginSend.mock.calls[1][0];
    expect(store.lifecycleBeginSend.mock.calls[1][0]).toEqual({ actionId: execution().id, execution: 1, unsubscribeHash });
    expect(mail.send).toHaveBeenCalledTimes(1);
    const [message] = sent;
    expect(message.to).toBe(canary);
    expect(message.subject).toBe('Welcome to CareMetric CareBase');
    const token = /\/api\/email\/unsubscribe\/([0-9a-f]{64})$/.exec(message.unsubscribeUrl)[1];
    expect(message.unsubscribeUrl).toBe(`${origin}/api/email/unsubscribe/${token}`);
    expect(unsubscribeHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(message.text.startsWith(lifecycleWording(input()).replace(/^Subject: [^\n]+\n\n/, ''))).toBe(true);
    expect(message.text).toContain(`${unsubscribeLabel}: ${message.unsubscribeUrl}`);
    expect(message.text).toContain(postal);
    expect(message.html).toContain(`href="${message.unsubscribeUrl}"`);
    expect(store.lifecycleFinishSend).toHaveBeenCalledWith({ actionId: execution().id, delivery: 'sent', providerMessageId: 'msg-1' });
  });

  it('makes a fresh unsubscribe link for every send', async () => {
    const a = fixture();
    const b = fixture();
    await a.send(execution());
    await b.send(execution());
    expect(a.sent[0].unsubscribeUrl).not.toBe(b.sent[0].unsubscribeUrl);
  });

  it('settles a send an earlier attempt recorded, whatever has changed since, and never sends it twice', async () => {
    for (const [status, expected] of [['sent', { outcome: 'sent', template: 'welcome', replay: true }], ['failed', 'delivery_failed'], ['sending', 'email_unconfirmed'], ['unknown', 'email_unconfirmed']]) {
      // The trial has converted and the Hub has lost its SendGrid key since: the record still decides.
      const { send, mail, store } = fixture({ earlier: { state: 'recorded', status }, facts: [fact({ status: 'active' })], lifecycle: { mail: { configured: false, send: vi.fn() } } });
      if (typeof expected === 'string') await expect(send(execution())).rejects.toSatisfy(refusal(expected));
      else expect(await send(execution())).toEqual(expected);
      expect(mail.send).not.toHaveBeenCalled();
      expect(store.lifecycleSnapshot).not.toHaveBeenCalled();
      expect(store.lifecycleFinishSend).not.toHaveBeenCalled();
    }
    // A record that appears between the first look and the second (another worker) is settled the same way.
    const raced = fixture({ begun: { state: 'recorded', status: 'sent' } });
    expect(await raced.send(execution())).toEqual({ outcome: 'sent', template: 'welcome', replay: true });
    expect(raced.mail.send).not.toHaveBeenCalled();
  });

  it('sends nothing when the account changed since the email was proposed', async () => {
    for (const [template, facts] of [
      ['welcome', []], ['welcome', [fact({ status: 'active' })]], ['trial_checkin', [fact({ cancelling: true })]], ['setup_nudge', [fact({ hasUsage: true })]],
      ['testimonial_ask', [fact({ status: 'past_due' })]], ['testimonial_ask', [fact({ status: 'active', openUrgentCases: 1 })]],
      ['welcome', [fact({ product: 'caremetric-intel' })]],
    ]) {
      const { send, mail, store } = fixture({ facts });
      await expect(send(execution({ input: input(template) })), template).rejects.toSatisfy(refusal('no_longer_applies'));
      expect(mail.send).not.toHaveBeenCalled();
      expect(store.lifecycleBeginSend.mock.calls.filter(call => call[0].unsubscribeHash !== null)).toEqual([]);
    }
    expect(await fixture({ facts: [fact({ status: 'active' })] }).send(execution({ input: input('testimonial_ask') }))).toEqual({ outcome: 'sent', template: 'testimonial_ask' });
  });

  it('refuses what the database refuses: no address, an unsubscribed address, the day\'s cap and an auto-approval the owner no longer allows', async () => {
    for (const [state, code] of [['no_address', 'no_address'], ['suppressed', 'suppressed'], ['daily_limit', 'daily_limit'], ['auto_send_off', 'auto_send_off'], ['surprise', 'executor_error']]) {
      const { send, mail, store } = fixture({ begun: { state } });
      await expect(send(execution()), state).rejects.toSatisfy(refusal(code));
      expect(mail.send).not.toHaveBeenCalled();
      expect(store.lifecycleFinishSend).not.toHaveBeenCalled();
    }
    // An answer of "ready" without an address is not an address.
    await expect(fixture({ begun: { state: 'ready' } }).send(execution())).rejects.toSatisfy(refusal('executor_error'));
  });

  it('refuses before asking for an address when the Hub cannot send customer email', async () => {
    for (const lifecycle of [{ postalAddress: '' }, { postalAddress: '   ' }, { publicOrigin: 'http://hub.example.test' }, { mail: { configured: false, send: vi.fn() } }, { mail: null }]) {
      const { send, store } = fixture({ lifecycle });
      await expect(send(execution()), JSON.stringify(lifecycle)).rejects.toSatisfy(refusal('not_configured'));
      expect(store.lifecycleBeginSend.mock.calls.filter(call => call[0].unsubscribeHash !== null)).toEqual([]);
    }
  });

  it('never sends words other than the ones the owner approved', async () => {
    const approved = input();
    const { send, mail } = fixture();
    await expect(send(execution({ input: { ...approved, tenantName: 'Someone Else' } }))).rejects.toSatisfy(refusal('wording_changed'));
    await expect(send(execution({ input: { ...approved, textHash: 'f'.repeat(64) } }))).rejects.toSatisfy(refusal('wording_changed'));
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('refuses an action whose facts are out of shape, before anything else', async () => {
    for (const broken of [null, {}, { ...input(), template: 'improvised' }, { ...input(), periodKey: 'account:welcome:someone-else:carebase' }]) {
      const { send, store } = fixture();
      await expect(send(execution({ input: broken }))).rejects.toSatisfy(refusal('invalid_email'));
      expect(store.lifecycleBeginSend).not.toHaveBeenCalled();
    }
  });

  it('reports a refused delivery as failed and an unanswered one as unconfirmed, and never sends either again', async () => {
    for (const [delivery, code, recorded] of [
      [{ delivery: 'failed', id: null }, 'delivery_failed', 'failed'], [{ delivery: 'unknown', id: null }, 'email_unconfirmed', 'unknown'],
      [() => { throw new Error(`SendGrid refused ${canary}`); }, 'email_unconfirmed', 'unknown'], [{ delivery: 'maybe' }, 'email_unconfirmed', 'unknown'], [null, 'email_unconfirmed', 'unknown'],
    ]) {
      const { send, mail, store, logs } = fixture({ delivery });
      await expect(send(execution())).rejects.toSatisfy(refusal(code));
      expect(mail.send).toHaveBeenCalledTimes(1);
      expect(store.lifecycleFinishSend).toHaveBeenCalledWith({ actionId: execution().id, delivery: recorded, providerMessageId: null });
      expect(logs).toEqual([]);
    }
  });

  it('keeps an odd provider id out of the record, and does not fail a sent email whose record could not be settled', async () => {
    const odd = fixture({ delivery: { delivery: 'sent', id: 'not an id; drop table' } });
    await odd.send(execution());
    expect(odd.store.lifecycleFinishSend).toHaveBeenCalledWith({ actionId: execution().id, delivery: 'sent', providerMessageId: null });
    const unsettled = fixture();
    unsettled.store.lifecycleFinishSend.mockRejectedValue(new Error(`could not record ${canary}`));
    expect(await unsettled.send(execution())).toEqual({ outcome: 'sent', template: 'welcome' });
    expect(unsettled.logs).toEqual([JSON.stringify({ event: 'hub_agent_email_unsettled', action_id: execution().id })]);
  });

  it('works against a database without numbered executions', async () => {
    const { send, store } = fixture();
    await send(execution({ execution: undefined }));
    expect(store.lifecycleBeginSend.mock.calls.map(call => call[0].execution)).toEqual([null, null]);
  });

  it('never puts the address or the email\'s text in its result, its errors or its log', async () => {
    const outcomes = [];
    for (const options of [{}, { delivery: { delivery: 'failed' } }, { delivery: () => { throw new Error(canary); } }, { begun: { state: 'suppressed' } }]) {
      const { send, logs, store } = fixture(options);
      store.lifecycleFinishSend.mockRejectedValueOnce(new Error(canary));
      outcomes.push(await send(execution()).then(result => result, error => ({ code: error.code, message: error.message })), logs);
    }
    const kept = JSON.stringify(outcomes);
    for (const secret of [canary, 'Thank you for starting', 'unsubscribe/']) expect(kept, secret).not.toContain(secret);
  });
});

describe('registering the customer email action', () => {
  it('happens only when the database declares the feature', () => {
    for (const features of [undefined, null, new Set(), new Set(['platform.agents.accounts.v1']), lifecycleFeature]) {
      expect(lifecycleExecutors({ store: {}, features }), String(features)).toEqual({});
    }
    for (const features of [new Set([lifecycleFeature]), [lifecycleFeature]]) {
      const executors = lifecycleExecutors({ store: {}, features });
      expect(Object.keys(executors)).toEqual(['email.send']);
      // It reads nothing but the Hub's own mirror, so it never needs (or gets) the owner's session.
      expect(executors['email.send'].requiresSession).toBeUndefined();
    }
  });
});
