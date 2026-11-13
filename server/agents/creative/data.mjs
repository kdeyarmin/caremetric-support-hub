/**
 * County snapshots (20261113210000_creative_data.sql): one public figure about one county, from Intel's marketing feed (county_figures),
 * for the Creative Director's stat images. The figure, its label and its source are fixed here, by code, and travel on the brief
 * (`facts`); the model writes only the words around them (copy.mjs), and compliance.mjs `checkData` refuses a draft that changes the
 * figure or writes any other number. Counties are those where the Medicare roster's prospects are (creative_data_counties).
 */
export const dataBriefSources = Object.freeze(['data.county', 'data.release', 'observance']);
const statMax = 20, labelMax = 80, sourceMax = 80;

// The figures worth a picture, in turn: a different one leads each week. Each label reads after the number.
const figures = Object.freeze({
  beneficiaries_85_plus: { label: 'Medicare beneficiaries aged 85+', format: 'count' },
  home_health_users: { label: 'Medicare FFS beneficiaries used home health', format: 'count' },
  hospice_users: { label: 'Medicare FFS beneficiaries used hospice', format: 'count' },
  population_65_plus_growth_since_2020: { label: 'more residents aged 65+ than in April 2020', format: 'growth' },
  medicare_advantage_share: { label: 'of Medicare beneficiaries are in Medicare Advantage', format: 'share' },
  home_health_users_pct: { label: 'of Medicare FFS beneficiaries used home health', format: 'percent' },
  medicare_beneficiaries: { label: 'people on Medicare', format: 'count' },
  population_65_plus: { label: 'residents aged 65 and over', format: 'count' },
});
export const figureOrder = Object.freeze(Object.keys(figures));
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
 * The snapshot for one county from its feed answer: the week's figure in turn (`turn`), else the next one it has. Null when none fits.
 * `county` is one entry of the feed's `counties` ({ county_fips, county_name, state, figures }).
 */
export function countySnapshot(county, turn = 0) {
  const place = placeName(county?.county_name, county?.state);
  if (!place || !/^\d{5}$/.test(county?.county_fips ?? '')) return null;
  const byKey = new Map((county.figures ?? []).map(figure => [figure.key, figure]));
  for (let i = 0; i < figureOrder.length; i += 1) {
    const key = figureOrder[(turn + i) % figureOrder.length];
    const figure = byKey.get(key);
    if (!figure) continue;
    const stat = formatFigure(figure.value, figures[key].format);
    const statLabel = `${figures[key].label} in ${place}`;
    const statSource = String(figure.short_source ?? `${figure.dataset}${figure.data_year ? `, ${figure.data_year}` : ''}`).trim();
    if (!stat || statLabel.length > labelMax || !statSource || statSource.length > sourceMax) continue;
    return { kind: 'county', countyFips: county.county_fips, place, state: county.state, figure: key, value: Number(figure.value), unit: figure.unit,
      dataYear: figure.data_year ?? null, stat, statLabel, statSource, sourceLine: String(figure.source_line ?? '').slice(0, 1000) };
  }
  return null;
}

/** The brief for one county snapshot (creative_brief_create), keyed to the county and the week so a rerun opens nothing new. */
export function countyBrief(snapshot, week) {
  return {
    product: 'caremetric-intel', source: 'data.county', requestKey: `data:county:${snapshot.countyFips}:${week}`,
    goal: `Show home health and hospice teams in ${snapshot.place} one public number about their market, and send them to the free county report`,
    audience: `Owners, administrators and marketers at home health agencies and hospices in ${snapshot.place}`,
    platforms: ['meta', 'linkedin'], formats: ['static'], videoLengths: [],
    angle: `County snapshot: ${snapshot.stat} ${snapshot.statLabel} (${snapshot.statSource}). The free county report shows the rest of the county's market.`.slice(0, 500),
    facts: snapshot,
  };
}

/** A variant drawn as the snapshot: the stat layout, with the figure, label and source exactly as the data gives them. */
export function withFacts(variant, facts) {
  if (!facts?.stat) return variant;
  return { ...variant, layout: 'stat', overlay: { ...(variant.overlay ?? {}), stat: facts.stat, statLabel: facts.statLabel, statSource: facts.statSource } };
}
