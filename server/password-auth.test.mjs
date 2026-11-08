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
  it('normalizes emails and existing usernames without accepting malformed or unbounded identifiers', () => {
    expect(normalizeUsername('  Owner.Name-1  ')).toBe('owner.name-1');
    expect(normalizeUsername('  Owner@Example.com  ')).toBe('owner@example.com');
    expect(normalizeUsername("O'Neil+Hub@Mail.Example.com")).toBe("o'neil+hub@mail.example.com");
    const longest = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    expect(longest.length).toBe(254);
    expect(normalizeUsername(longest)).toBe(longest);
    for (const invalid of ['a','with spaces','x'.repeat(65),'owner@','@example.com','owner@example',
      'owner..name@example.com','.owner@example.com','owner.@example.com','owner @example.com',
      'owner@-example.com','owner@example-.com','owner@example..com','owner@example.com\nextra',
      `owner@${'x'.repeat(64)}.com`,`${'x'.repeat(65)}@example.com`,`${longest}x`,{},null]) {
      expect(normalizeUsername(invalid)).toBeNull();
    }
  });
  it('rejects short, common and oversized new passwords before database work', async () => {
    const auth = passwordAuth({ pool:{ connect:() => { throw new Error('Unexpected database call'); } } });
    for (const password of ['H7!mQ2vR8','password12','passwordpassword','a'.repeat(10),'x'.repeat(129)]) {
      await expect(auth.save('session',{ username:'owner',password },'test-client')).rejects.toMatchObject({status:400});
    }
  });
});
