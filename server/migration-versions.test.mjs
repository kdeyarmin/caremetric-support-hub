import { readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// Supabase orders migrations by the version before the first underscore and records each version once, so two files with the same
// version break `supabase db reset`, CI's database job and any fresh database. Two branches can each take the next free number
// (20261117120000 was taken by both ads flights and publication imports), and git merges them without a conflict.
const migrations = new URL('../supabase/migrations/', import.meta.url);
const pattern = /^(\d{14})_[a-z0-9_]+\.sql$/;

describe('migration files', () => {
  it('are named <14-digit version>_<snake_case name>.sql', async () => {
    const names = (await readdir(migrations)).filter(name => name.endsWith('.sql'));
    expect(names.length).toBeGreaterThan(200);
    expect(names.filter(name => !pattern.test(name))).toEqual([]);
  });
  it('each have a version of their own', async () => {
    const names = (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort();
    const first = new Map(), shared = [];
    for (const name of names) {
      const version = pattern.exec(name)?.[1] ?? name;
      if (first.has(version)) shared.push(`${first.get(version)} and ${name}`);
      else first.set(version, name);
    }
    expect(shared).toEqual([]);
  });
});
