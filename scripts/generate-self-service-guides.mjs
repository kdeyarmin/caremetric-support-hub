import { readFileSync, writeFileSync } from 'node:fs';
const guides = JSON.parse(readFileSync(new URL('../docs/self-service/guides.json', import.meta.url)));
const destination = new URL('../supabase/migrations/20261027145524_self_service_guidance.sql', import.meta.url);
const literal = value => `'${value.replaceAll("'", "''")}'`;
const sections = { prerequisites: 'Prerequisites', roles: 'Permitted roles', setup: 'Setup', use: 'Normal use', problems: 'Common problems', faq: 'FAQ', tips: 'Helpful tips' };
const chunks = ['-- Generated from docs/self-service/guides.json. Run npm run check:docs after changing maintained guidance.\n'];
for (const guide of guides) {
  const key = `self-service.${guide.id}`;
  const body = Object.entries(sections).map(([field, heading]) => `## ${heading}\n\n${guide[field].map((value, index) => `${field === 'setup' || field === 'use' ? `${index + 1}.` : '-'} ${value}`).join('\n')}`).join('\n\n');
  chunks.push(`insert into hub.content_items(id,content_key,kind,status,access_level,source_system,owner_team)
values(md5(${literal(key)})::uuid,${literal(key)},'article','published','customer','support_hub','CareMetric Support') on conflict(id) do nothing;
insert into hub.content_revisions(id,item_id,revision_no,locale,title,summary,body_markdown,body_text,variables,source_version,review_state,approved_at)
values(md5(${literal(`${key}:revision:1`)})::uuid,md5(${literal(key)})::uuid,1,'en-US',${literal(guide.title)},${literal(guide.summary)},${literal(body)},${literal(body)},${literal(JSON.stringify({ features: guide.features }))}::jsonb,'self-service.v1','approved',now()) on conflict(id) do nothing;
insert into hub.content_publications(id,item_id,revision_id,product_id,audience)
select md5(${literal(`${key}:publication:`)}||slug)::uuid,md5(${literal(key)})::uuid,md5(${literal(`${key}:revision:1`)})::uuid,id,array['all']::text[] from hub.products where slug in (${guide.apps.map(literal).join(',')})
on conflict(item_id,product_id) do nothing;\n`);
}
const sql = chunks.join('\n');
if (process.argv.includes('--check')) {
  if (readFileSync(destination, 'utf8') !== sql) throw new Error('Published self-service guidance migration differs from maintained content. Run npm run generate:guides.');
} else writeFileSync(destination, sql);
