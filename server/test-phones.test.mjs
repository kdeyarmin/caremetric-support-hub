import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { testPhoneRegistry, testPhones } from './test-phones.mjs';

const here = new URL('./', import.meta.url);
const scripts = readdirSync(here).filter(name => name === 'integration.mjs' || name.endsWith('-integration.mjs'));
const source = name => readFileSync(new URL(name, here), 'utf8');
const listed = Object.entries(testPhoneRegistry)
  .flatMap(([script, phones]) => Object.values(phones).flat().map(phone => ({ script, phone })));

describe('integration test phones', () => {
  it('gives every number to one script only', () => {
    const holder = new Map();
    for (const { script, phone } of listed) {
      expect(holder.get(phone), `${phone} is listed for both ${holder.get(phone)} and ${script}`).toBeUndefined();
      holder.set(phone, script);
    }
  });

  it('keeps every number in the 202-555-0100 to 202-555-0999 test range', () => {
    for (const { script, phone } of listed) expect(phone, script).toMatch(/^\+12025550[1-9]\d\d$/);
  });

  it('lists only scripts that exist', () => {
    for (const script of Object.keys(testPhoneRegistry)) expect(scripts, script).toContain(`${script}.mjs`);
  });

  it('leaves no script to type or draw a 555 number of its own', () => {
    for (const name of scripts) {
      const text = source(name);
      expect(text, `${name} types a 555 number; take it from server/test-phones.mjs`).not.toMatch(/\+1\d{3}555\d{4}/);
      expect(text, `${name} builds a phone at run time; take it from server/test-phones.mjs`).not.toMatch(/['"`]\+1\d*['"`]\s*\+|`\+1\d*\$\{/);
    }
  });

  it('has every script that creates SMS identities use its own phones and delete the identities', () => {
    const creators = scripts.filter(name => /insert into private\.sms_identities/.test(source(name)));
    expect(creators.length).toBeGreaterThan(40);
    for (const name of creators) {
      const text = source(name);
      expect(text, name).toContain('testPhones(import.meta.url)');
      expect(text, `${name} must delete its SMS identities in its finally`).toMatch(/delete from private\.sms_identities|removeTestIdentities\(/);
    }
  });

  it('refuses a script that has no entry', () => {
    expect(() => testPhones(new URL('./unlisted-integration.mjs', import.meta.url))).toThrow(/has no test phones/);
  });
});
