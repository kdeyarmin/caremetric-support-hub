import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { guidesMigration, latestGenerated, nextMigrationName } from './self-service-guides.mjs';

// npm run generate:guides writes a new migration publishing docs/self-service/guides.json when the newest generated one does not
// already state it; --check (npm run check:docs) fails until it does. Migrations already written are never changed.
const directory = new URL('../supabase/migrations/', import.meta.url);
const guides = JSON.parse(readFileSync(new URL('../docs/self-service/guides.json', import.meta.url)));
const sql = guidesMigration(guides);
const names = readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
const latest = latestGenerated(names.map(name => ({ name, text: readFileSync(new URL(name, directory), 'utf8') })));

if (process.argv.includes('--check')) {
  if (latest?.text !== sql) {
    throw new Error(`The self-service guides published by ${latest ? `supabase/migrations/${latest.name}` : 'no generated migration'} differ from `
      + 'docs/self-service/guides.json. Run npm run generate:guides: it adds a new migration, because one that has run is never run again.');
  }
} else if (latest?.text === sql) {
  console.log(`The self-service guides are already published by supabase/migrations/${latest.name}.`);
} else {
  const name = nextMigrationName(names);
  writeFileSync(new URL(name, directory), sql);
  console.log(`Wrote supabase/migrations/${name}. Apply it to publish the changed guides.`);
}
