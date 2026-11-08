import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { appServer, reviewedDatabaseError } from './http.mjs';

const origin = 'https://support-hub-web-production.up.railway.app';
// The shape node-postgres gives a database error: a code, a severity and the message the function raised.
const databaseError = (code, message) => Object.assign(new Error(message), { code, severity: 'ERROR' });
const gateway = { rpc: vi.fn() };
let server, base;
beforeAll(async () => {
  server = appServer({ gateway, auth: {}, delegations: {}, origins: [origin] });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise(resolve => server.close(resolve)));
const rpc = async error => {
  gateway.rpc.mockRejectedValueOnce(error);
  const response = await fetch(`${base}/api/rpc/request_human_support`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}' });
  return [response.status, (await response.json()).error];
};

describe('database errors reaching the browser', () => {
  it('shows the message a database function wrote for the person, with a matching status', async () => {
    expect(await rpc(databaseError('22023', 'This case is already closed'))).toEqual([400, 'This case is already closed']);
    expect(await rpc(databaseError('40001', 'This draft changed. Reload it before saving.'))).toEqual([409, 'This draft changed. Reload it before saving.']);
    expect(await rpc(databaseError('55000', 'This imported CareBase course cannot publish: its credited duration differs from the imported source.')))
      .toEqual([409, 'This imported CareBase course cannot publish: its credited duration differs from the imported source.']);
    expect(await rpc(databaseError('P0001', 'Support intake is not enabled. Use the central phone or email listed in Help.')))
      .toEqual([422, 'Support intake is not enabled. Use the central phone or email listed in Help.']);
    expect(await rpc(databaseError('P0002', 'Course draft unavailable.'))).toEqual([404, 'Course draft unavailable.']);
    expect(await rpc(databaseError('P4090', 'Import already committed.'))).toEqual([409, 'Import already committed.']);
  });

  it('keeps sign-in, permission and unexpected errors generic', async () => {
    expect(await rpc(databaseError('42501', 'permission denied for table private.sms_sessions'))).toEqual([403, 'You do not have access to this action.']);
    expect(await rpc(databaseError('28000', 'Sign in to continue'))).toEqual([401, 'Sign in to continue.']);
    const [status, message] = await rpc(databaseError('23514', 'new row for relation "billing_customers" violates check constraint "billing_customers_email_check"'));
    expect(status).toBe(500);
    expect(message).not.toMatch(/billing_customers/);
    expect((await rpc(new Error('connect ECONNREFUSED 10.0.0.5:5432')))[1]).toBe('The service is temporarily unavailable.');
  });

  it('shows only the first line, and only for an error that came from the database', () => {
    expect(reviewedDatabaseError(databaseError('22023', 'Choose a course.\nDETAIL: internal'))).toEqual({ status: 400, message: 'Choose a course.' });
    expect(reviewedDatabaseError(Object.assign(new Error('Looks like one'), { code: '22023' }))).toBeNull();
    expect(reviewedDatabaseError(databaseError('22023', ''))).toBeNull();
  });
});
