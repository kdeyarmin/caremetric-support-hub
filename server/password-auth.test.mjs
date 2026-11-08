import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword, normalizeUsername, passwordAuth } from './password-auth.mjs';

describe('password verification', () => {
  it('uses independent salts and accepts only the matching password', async () => {
    const password = 'test-only unique long passphrase';
    const first = await hashPassword(password), second = await hashPassword(password);
    expect(first).not.toBe(second);
    expect(first).not.toContain(password);
    expect(await verifyPassword(password, first)).toBe(true);
    expect(await verifyPassword(`${password}x`, first)).toBe(false);
    expect(await verifyPassword(password, null)).toBe(false);
    expect(await verifyPassword(password, first.replace('$32768$', '$999999999$'))).toBe(false);
  });
  it('bounds concurrent password hashing instead of queueing unlimited memory use', async () => {
    const pending = [hashPassword('first test-only passphrase'),hashPassword('second test-only passphrase')];
    await expect(hashPassword('third test-only passphrase')).rejects.toMatchObject({ status:429 });
    await Promise.all(pending);
    expect(await hashPassword('fourth test-only passphrase')).toMatch(/^scrypt\$/);
  });
  it('normalizes usernames without accepting ambiguous or unbounded identifiers', () => {
    expect(normalizeUsername('  Owner.Name-1  ')).toBe('owner.name-1');
    for (const invalid of ['a','with spaces','owner@example.com','x'.repeat(65),{},null]) expect(normalizeUsername(invalid)).toBeNull();
  });
  it('rejects short, common and oversized new passwords before database work', async () => {
    const auth = passwordAuth({ pool:{ connect:() => { throw new Error('Unexpected database call'); } } });
    for (const password of ['short','passwordpassword','a'.repeat(15),'x'.repeat(129)]) {
      await expect(auth.save('session',{ username:'owner',password },'test-client')).rejects.toMatchObject({status:400});
    }
  });
});
