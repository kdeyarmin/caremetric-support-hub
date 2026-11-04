import { describe, expect, it, vi } from 'vitest';
import { directEmailExecutors } from './direct-email.mjs';

const feature = new Set(['platform.agents.direct-email.v1']);
const action = { id: '11111111-1111-4111-8111-111111111111', execution: 1 };
const draft = { state: 'ready', to: 'support@example.invalid', subject: 'Source access', body: 'A synthetic technical request.' };

function fixture({ begin = draft, delivery = { delivery: 'sent', id: 'test-provider-id' }, settle = true, configured = true } = {}) {
  const store = {
    directEmailBeginSend: vi.fn(async () => begin),
    directEmailFinishSend: vi.fn(async () => settle),
  };
  const email = { configured, send: vi.fn(async () => delivery) };
  const execute = directEmailExecutors({ store, email, features: feature })['email.direct'];
  return { store, email, execute };
}

describe('owner-approved direct mail', () => {
  it('does not register unless the database declares the closed send boundary', () => {
    expect(directEmailExecutors({ features: new Set(), store: {}, email: {} })).toEqual({});
    expect(directEmailExecutors({ features: null, store: {}, email: {} })).toEqual({});
  });
  it('sends the exact database-reserved text once through the existing mail sender', async () => {
    const { store, email, execute } = fixture();
    await expect(execute(action)).resolves.toEqual({ delivery: 'sent', replay: false });
    expect(store.directEmailBeginSend).toHaveBeenCalledWith(action.id, 1);
    expect(email.send).toHaveBeenCalledExactlyOnceWith(draft.to, draft.subject, draft.body);
    expect(store.directEmailFinishSend).toHaveBeenCalledWith({
      actionId: action.id, execution: 1, delivery: 'sent', providerMessageId: 'test-provider-id',
    });
  });
  it('never reaches the provider if email is not configured', async () => {
    const { store, email, execute } = fixture({ configured: false });
    await expect(execute(action)).rejects.toMatchObject({ code: 'direct_email_not_configured' });
    expect(store.directEmailBeginSend).not.toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
  });
  it('does not send an unapproved or changed email', async () => {
    for (const state of ['approval_required', 'wording_changed']) {
      const { email, execute } = fixture({ begin: { state } });
      await expect(execute(action)).rejects.toMatchObject({ code: state });
      expect(email.send).not.toHaveBeenCalled();
    }
  });
  it('replays a recorded success without delivering again', async () => {
    const { email, execute } = fixture({ begin: { state: 'recorded', status: 'sent' } });
    await expect(execute(action)).resolves.toEqual({ delivery: 'sent', replay: true });
    expect(email.send).not.toHaveBeenCalled();
  });
  it('never retries sending or unknown delivery, even after the action is restarted', async () => {
    for (const status of ['sending', 'unknown']) {
      const { email, execute } = fixture({ begin: { state: 'recorded', status } });
      await expect(execute(action)).rejects.toMatchObject({ code: 'email_unconfirmed' });
      expect(email.send).not.toHaveBeenCalled();
    }
  });
  it('records a provider refusal but does not retry the rejected message', async () => {
    const { store, execute } = fixture({ delivery: { delivery: 'failed', id: null } });
    await expect(execute(action)).rejects.toMatchObject({ code: 'delivery_failed' });
    expect(store.directEmailFinishSend).toHaveBeenCalledWith({
      actionId: action.id, execution: 1, delivery: 'failed', providerMessageId: null,
    });
  });
  it('records a network uncertainty, never silently sending it again', async () => {
    const { store, execute } = fixture({ delivery: { delivery: 'unknown', id: null } });
    await expect(execute(action)).rejects.toMatchObject({ code: 'email_unconfirmed' });
    expect(store.directEmailFinishSend).toHaveBeenCalledWith({
      actionId: action.id, execution: 1, delivery: 'unknown', providerMessageId: null,
    });
  });
  it('treats loss of the delivery ledger acknowledgment as uncertain', async () => {
    const { execute } = fixture({ settle: false });
    await expect(execute(action)).rejects.toMatchObject({ code: 'email_unconfirmed' });
  });
});
