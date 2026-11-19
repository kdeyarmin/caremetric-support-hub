/**
 * How a county, or what a state has instead of one, is written in text the Hub publishes (county articles, county snapshots).
 * Intel names each of the 3,235 geographies as the Census does: "Allegheny County", "Orleans Parish", "Yukon-Koyukuk Census Area",
 * "Juneau City and Borough", "Capitol Planning Region" (Connecticut), "Adjuntas Municipio" (Puerto Rico), "Richmond city" (a
 * Virginia independent city, a different place from Richmond County), "Carson City" (Nevada), "Doña Ana County", and DC, Guam and the
 * Virgin Islands with no such word at all. A name that arrives bare ("Allegheny") takes its state's word: County, except Parish
 * in Louisiana, Municipio in Puerto Rico and Planning Region in Connecticut.
 */
const kindWords = new Map([
  ['city and borough', 'City and Borough'], ['census area', 'Census Area'], ['planning region', 'Planning Region'],
  ['county', 'County'], ['parish', 'Parish'], ['borough', 'Borough'], ['municipality', 'Municipality'], ['municipio', 'Municipio'],
  ['city', 'City'],
]);
const kindSuffix = new RegExp(`\\s+(${[...kindWords.keys()].join('|')})$`, 'i');
const bareKind = Object.freeze({ LA: 'Parish', PR: 'Municipio', CT: 'Planning Region' });
// Places that are not divided into counties: their name is written as it is, never followed by a word.
const undivided = new Set(['DC', 'GU', 'AS', 'VI', 'MP']);

/**
 * The place a county name stands for: `{ base, kind, label }` ("Doña Ana", "County", "Doña Ana County"; "Richmond", "City",
 * "Richmond City"), or null for no usable name. Letters keep their accents; anything else but a space, period, apostrophe or hyphen
 * is dropped (the name ends up in titles and prompts). DC is Washington, written without a word after it.
 */
export function countyPlace(name, state) {
  const text = String(name ?? '').normalize('NFC').replace(/[‘’]/g, "'").replace(/[^\p{L} .'-]/gu, '').replace(/\s+/g, ' ').trim();
  if (!text || kindWords.has(text.toLowerCase())) return null;
  const match = text.match(kindSuffix);
  if (match) {
    const base = text.slice(0, match.index).trim();
    const kind = kindWords.get(match[1].toLowerCase());
    return base ? { base, kind, label: `${base} ${kind}` } : null;
  }
  if (state === 'DC') return { base: 'Washington', kind: null, label: 'Washington' };
  if (undivided.has(state)) return { base: text, kind: null, label: text };
  const kind = bareKind[state] ?? 'County';
  return { base: text, kind, label: `${text} ${kind}` };
}

/** The place as people write it with its state: "Allegheny County, PA"; null without a name or a two-letter state. */
export function placeName(name, state) {
  if (!/^[A-Z]{2}$/.test(state ?? '')) return null;
  const place = countyPlace(name, state);
  return place ? `${place.label}, ${state}` : null;
}

/** Lower-case ASCII words joined by hyphens, accents folded to their letters: "Doña Ana County" -> "dona-ana-county". */
export const slugWords = text => String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
