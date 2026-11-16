import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generatedMarker, guideBody, guidesMigration, latestGenerated, nextMigrationName } from './self-service-guides.mjs';

const directory = new URL('../supabase/migrations/', import.meta.url);
const guides = JSON.parse(readFileSync(new URL('../docs/self-service/guides.json', import.meta.url)));
const guide = (overrides = {}) => ({ id: 'example', title: 'Example', summary: "It's an example.", apps: ['carebase', 'breathe'], features: ['a.b'],
  prerequisites: ['One'], roles: ['Two'], setup: ['Three', 'Four'], use: ['Five'], problems: ['Six'], faq: ['Seven'], tips: ['Eight'], ...overrides });

describe('the self-service guide migration', () => {
  it('writes each guide once, quoted, with the applications it names and the unpublishing of guides it no longer has', () => {
    const sql = guidesMigration([guide(), guide({ id: 'second', apps: ['carebase'] })]);
    expect(sql.startsWith(generatedMarker)).toBe(true);
    expect(sql.match(/^do \$guide\$$/gm)).toHaveLength(2);
    expect(sql).toContain("v_summary constant text := 'It''s an example.';");
    expect(sql).toContain("v_apps constant text[] := array['carebase','breathe']::text[];");
    expect(sql).toContain("i.content_key<>all(array['self-service.example','self-service.second']::text[])");
    // A new revision only when the text changed, and publications in exactly the named applications.
    expect(sql).toContain('if v_revision is null then');
    expect(sql).toContain('on conflict(item_id,product_id) do update set revision_id=excluded.revision_id');
    expect(sql).toContain('not exists(select 1 from hub.products p where p.id=cp.product_id and p.slug=any(v_apps))');
  });

  it('keeps the article text the first generated migration published, so unchanged guides keep their revision', () => {
    const first = readFileSync(new URL('20261027145524_self_service_guidance.sql', directory), 'utf8');
    for (const item of guides) expect(first, item.id).toContain(guideBody(item).replaceAll("'", "''"));
  });

  it('publishes the current guides in the newest generated migration and never rewrites a migration that has run', () => {
    const names = readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
    const latest = latestGenerated(names.map(name => ({ name, text: readFileSync(new URL(name, directory), 'utf8') })));
    expect(latest?.text).toBe(guidesMigration(guides));
    // The two earlier generators' migrations are released and stay as they were.
    for (const name of ['20261027145524_self_service_guidance.sql', '20261028221000_three_app_self_service_guidance.sql']) {
      expect(readFileSync(new URL(name, directory), 'utf8').startsWith(generatedMarker), name).toBe(false);
    }
  });

  it('finds the newest generated migration by name', () => {
    const files = [{ name: '20261201000000_other.sql', text: '-- other' }, { name: '20261101000000_a.sql', text: `${generatedMarker} a` },
      { name: '20261115000000_b.sql', text: `${generatedMarker} b` }];
    expect(latestGenerated(files)?.name).toBe('20261115000000_b.sql');
    expect(latestGenerated([{ name: 'x.sql', text: '--' }])).toBe(null);
  });

  it('names a new migration after every existing one, even those dated ahead of today', () => {
    const now = new Date('2026-11-16T04:30:00Z');
    expect(nextMigrationName(['20261117100000_settings.sql', '20261020120000_old.sql'], now)).toBe('20261117100100_self_service_guides.sql');
    expect(nextMigrationName(['20261020120000_old.sql'], now)).toBe('20261116043000_self_service_guides.sql');
    expect(nextMigrationName(['20261231235930_late.sql'], now)).toBe('20270101000030_self_service_guides.sql');
  });
});
