/**
 * County snapshots (20261113210000_creative_data.sql, 20261116130000_creative_review.sql): one public figure about one county, from
 * Intel's marketing feed (county_figures), for the Creative Director's stat images. The figure, its label and its source are fixed here,
 * by code, and travel on the brief (`facts`); the model writes only the words around them (copy.mjs), and compliance.mjs `checkData`
 * refuses a draft that changes the figure or writes any other number.
 *
 * Each snapshot is about one care setting (owner decision 2026-11-16: keep it in the agency's own industry): a home health snapshot shows
 * a home health figure (or a general one about the county's people) to home health agencies, a hospice snapshot a hospice figure to
 * hospices, never another setting's. Its figures lead with how crowded and how concentrated the county's market is, and every snapshot
 * sends the reader to the free market report for their own agency. Counties are every county in the roster's states, the least recently
 * pictured first (creative_data_counties), so a county with no agency located in it is pictured too.
 */
export const dataBriefSources = Object.freeze(['data.county', 'data.release', 'observance']);
export const snapshotSettings = Object.freeze(['home_health', 'hospice']);
const statMax = 20, labelMax = 100, sourceMax = 80;
// Where every snapshot sends people: the free market report for the reader's own agency (content/facts.mjs).
export const snapshotLanding = 'intel-market-review';

const settingWords = {
  home_health: { name: 'home health', agencies: 'home health agencies', who: 'home health agencies' },
  hospice: { name: 'hospice', agencies: 'hospices', who: 'hospices' },
};

// Each figure: which setting it may be shown for (`general`: either), how it is printed, and its label, which reads after the number and
// names the place. Labels say exactly what the feed's figure is: billing counts include agencies located in other counties; the
// concentration is among the agencies located in the county, not the county's residents.
const figures = Object.freeze({
  home_health_top3_share: { setting: 'home_health', format: 'share', label: place => `of the Medicare patients of ${place} home health agencies went to the 3 largest` },
  home_health_agencies_billing: { setting: 'home_health', format: 'count', label: place => `home health agencies billed Medicare for ${place} residents` },
  home_health_users: { setting: 'home_health', format: 'count', label: place => `Medicare FFS beneficiaries in ${place} used home health` },
  home_health_users_pct: { setting: 'home_health', format: 'percent', label: place => `of Medicare FFS beneficiaries in ${place} used home health` },
  hospice_top3_share: { setting: 'hospice', format: 'share', label: place => `of the Medicare patients of ${place} hospices went to the 3 largest` },
  hospices_billing: { setting: 'hospice', format: 'count', label: place => `hospices billed Medicare for ${place} residents` },
  hospice_users: { setting: 'hospice', format: 'count', label: place => `Medicare FFS beneficiaries in ${place} used hospice` },
  hospice_users_pct: { setting: 'hospice', format: 'percent', label: place => `of Medicare FFS beneficiaries in ${place} used hospice` },
  beneficiaries_85_plus: { setting: 'general', format: 'count', label: place => `Medicare beneficiaries aged 85+ in ${place}` },
  population_65_plus_growth_since_2020: { setting: 'general', format: 'growth', label: place => `more residents aged 65+ in ${place} than in April 2020` },
  medicare_advantage_share: { setting: 'general', format: 'share', label: place => `of Medicare beneficiaries in ${place} are in Medicare Advantage` },
  medicare_beneficiaries: { setting: 'general', format: 'count', label: place => `people on Medicare in ${place}` },
  population_65_plus: { setting: 'general', format: 'count', label: place => `residents aged 65 and over in ${place}` },
});

/** The figures a setting's snapshot may show, in turn: its market's concentration and crowding first, then its patients, then the county's people. */
export const figureOrders = Object.freeze(Object.fromEntries(snapshotSettings.map(setting => [setting, Object.freeze([
  ...Object.keys(figures).filter(key => figures[key].setting === setting),
  ...Object.keys(figures).filter(key => figures[key].setting === 'general'),
])])));
const placeWords = /\b(County|Parish|Borough|Census Area|Municipality|Region|City and Borough|city)\b/;

/** The county as people write it: "Allegheny County, PA"; a parish, borough or planning region keeps its own word. */
export function placeName(name, state) {
  const base = String(name ?? '').trim();
  if (!base) return null;
  return `${placeWords.test(base) ? base : `${base} County`}, ${state}`;
}

/** The figure as printed, or null when it would mislead or not fit: no zeros, no declines shown as growth. */
export function formatFigure(value, format) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const text = format === 'count' ? Math.round(n).toLocaleString('en-US')
    : format === 'share' ? (n < 1 ? `${Math.round(n * 100)}%` : null)
      : format === 'growth' ? (n < 1 ? `+${Math.round(n * 100)}%` : null)
        : format === 'percent' ? (n <= 100 ? `${Number(n.toFixed(1))}%` : null) : null;
  return text && text !== '0%' && text !== '+0%' && text.length <= statMax ? text : null;
}

/**
 * Which setting a county's snapshot is about: the only one with roster agencies located there, else the one it was not pictured with
 * last time, else by `turn`. `county` is one creative_data_counties entry ({ homeHealth, hospice, lastSetting }).
 */
export function settingFor(county, turn = 0) {
  const homeHealth = Number(county?.homeHealth ?? 0), hospice = Number(county?.hospice ?? 0);
  if (homeHealth > 0 && hospice === 0) return 'home_health';
  if (hospice > 0 && homeHealth === 0) return 'hospice';
  if (county?.lastSetting === 'home_health') return 'hospice';
  if (county?.lastSetting === 'hospice') return 'home_health';
  return snapshotSettings[Math.abs(turn) % snapshotSettings.length];
}

/**
 * The snapshot for one county from its feed answer: the setting's figure in turn (`turn`), else the next one it has; if the setting has
 * none that fits, the other setting's. Null when none fits. `county` is one entry of the feed's `counties`
 * ({ county_fips, county_name, state, figures }).
 */
export function countySnapshot(county, turn = 0, setting = 'home_health') {
  const place = placeName(county?.county_name, county?.state);
  if (!place || !/^\d{5}$/.test(county?.county_fips ?? '')) return null;
  const byKey = new Map((county.figures ?? []).map(figure => [figure.key, figure]));
  const settings = [setting, ...snapshotSettings.filter(other => other !== setting)].filter(item => figureOrders[item]);
  for (const chosen of settings) {
    const order = figureOrders[chosen];
    for (let i = 0; i < order.length; i += 1) {
      const key = order[(Math.abs(turn) + i) % order.length];
      const figure = byKey.get(key);
      // A figure the feed tags with another setting is never shown, whatever its key.
      if (!figure || (figure.setting && figure.setting !== 'general' && figure.setting !== chosen)) continue;
      const stat = formatFigure(figure.value, figures[key].format);
      const statLabel = figures[key].label(place);
      const statSource = String(figure.short_source ?? `${figure.dataset}${figure.data_year ? `, ${figure.data_year}` : ''}`).trim();
      if (!stat || statLabel.length > labelMax || !statSource || statSource.length > sourceMax) continue;
      return { kind: 'county', setting: chosen, countyFips: county.county_fips, place, state: county.state, figure: key, value: Number(figure.value), unit: figure.unit,
        dataYear: figure.data_year ?? null, stat, statLabel, statSource, sourceLine: String(figure.source_line ?? '').slice(0, 1000), landing: snapshotLanding };
    }
  }
  return null;
}

/** The brief for one county snapshot (creative_brief_create), keyed to the county and the week so a rerun opens nothing new. */
export function countyBrief(snapshot, week) {
  const words = settingWords[snapshot.setting] ?? settingWords.home_health;
  return {
    product: 'caremetric-intel', source: 'data.county', requestKey: `data:county:${snapshot.countyFips}:${week}`,
    goal: `Show ${words.who} serving ${snapshot.place} one public number about their market, and send them to the free market report for their own agency`,
    audience: `Owners, administrators and marketers at ${words.agencies} serving ${snapshot.place}`,
    platforms: ['meta', 'linkedin'], formats: ['static'], videoLengths: [],
    angle: `County snapshot, ${words.name} only: ${snapshot.stat} ${snapshot.statLabel} (${snapshot.statSource}). Say nothing about any other care setting. The free market report shows where the reader's own agency stands in its county.`.slice(0, 500),
    facts: snapshot,
  };
}

/** A variant drawn as the snapshot: the stat layout, with the figure, label and source exactly as the data gives them. */
export function withFacts(variant, facts) {
  if (!facts?.stat) return variant;
  return { ...variant, layout: 'stat', overlay: { ...(variant.overlay ?? {}), stat: facts.stat, statLabel: facts.statLabel, statSource: facts.statSource } };
}
