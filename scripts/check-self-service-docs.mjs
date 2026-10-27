import { readFileSync } from 'node:fs';
const features = JSON.parse(readFileSync(new URL('../docs/self-service/features.json', import.meta.url)));
const guides = JSON.parse(readFileSync(new URL('../docs/self-service/guides.json', import.meta.url)));
const covered = new Set();
for (const guide of guides) {
  for (const field of ['id', 'title', 'summary']) if (typeof guide[field] !== 'string' || !guide[field].trim()) throw new Error(`Guide ${guide.id}: ${field} required`);
  for (const field of ['apps', 'features', 'prerequisites', 'roles', 'setup', 'use', 'problems', 'faq', 'tips']) {
    if (!Array.isArray(guide[field]) || !guide[field].length || guide[field].some(value => typeof value !== 'string' || !value.trim())) throw new Error(`Guide ${guide.id}: ${field} required`);
  }
  for (const feature of guide.features) { if (!features.includes(feature)) throw new Error(`Unregistered feature ${feature}`); covered.add(feature); }
}
const missing = features.filter(feature => !covered.has(feature));
if (missing.length) throw new Error(`Features missing documentation: ${missing.join(', ')}`);
console.log(`Self-service documentation covers ${features.length} registered features in ${guides.length} maintained guides.`);
