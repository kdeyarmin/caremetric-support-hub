import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { assertAdvertisingRelease, missingAdvertisingPrerequisites } from './advertising-release.mjs';

const fixture = () => [
  { signature: 'private.creative_live_assets(text[])', definition: readFileSync(new URL('../supabase/migrations/20261118010000_campaign_creative_validation.sql', import.meta.url), 'utf8'), server_execute: true, browser_execute: false },
  { signature: 'private.creative_brief_create(jsonb)', definition: readFileSync(new URL('../supabase/migrations/20261118005317_creative_brief_queue_atomic.sql', import.meta.url), 'utf8'), server_execute: true, browser_execute: false },
];

describe('advertising release prerequisites', () => {
  it('accepts the reviewed definitions without depending on a migration-ledger version', async () => {
    const pool = { query: vi.fn(async () => ({ rows: fixture() })) };
    await assertAdvertisingRelease(pool);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][0].trim()).toMatch(/^select /);
  });
  it.each(['definition', 'server_execute', 'browser_execute'])('blocks missing or unsafe %s', field => {
    const rows = fixture();
    rows[0][field] = field === 'definition' ? null : field === 'browser_execute';
    expect(missingAdvertisingPrerequisites(rows)).toContain('campaign_creative_validation');
  });
  it('rejects an older snapshot without the exact approved copy and image fields', () => {
    for (const field of ['id', 'product', 'platform', 'placement', 'kind', 'headline', 'primaryText', 'description', 'cta', 'landingUrl', 'token', 'status']) {
      const rows = fixture();
      rows[0].definition = rows[0].definition.replace(`'${field}'`, "'old'");
      expect(missingAdvertisingPrerequisites(rows)).toContain('campaign_creative_validation');
    }
  });
  it('rejects non-atomic brief creation and reports missing functions', async () => {
    const rows = fixture();
    rows[1].definition = rows[1].definition.replace('private.agent_task_enqueue', 'private.old_enqueue');
    expect(missingAdvertisingPrerequisites(rows)).toEqual(['creative_brief_queue_atomic']);
    await expect(assertAdvertisingRelease({ query: async () => ({ rows: [] }) })).rejects.toThrow('Apply the reviewed migrations');
  });
});
