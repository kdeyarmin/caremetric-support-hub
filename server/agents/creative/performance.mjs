/**
 * How creative did, decided by the numbers only. Pure and deterministic, so the weekly refresh and report can be tested without a
 * platform.
 *
 * Results are joined to assets by utm_content: every asset's landing address carries utm_content=<its id>, so an ad whose link carries it
 * is that asset's ad, and a website lead whose utm_content is it came from that asset.
 *
 * Fatigue (`fatigue`): an asset is tired when at least two of three signals agree, week over week, once it has had 1,000 impressions in
 * each week: its click-through rate fell by 20% or more, people saw it more than 3 times on average, or its cost per thousand impressions
 * rose by 20% or more. A tired asset is proposed for retirement; a winner (the best click-through rate of its product and platform, not
 * tired, with 1,000 impressions) gets new variants.
 *
 * Learnings (`learningsFrom`): for each product and platform, each hook, layout, format and video length is compared with the
 * product-and-platform average click-through rate and lead rate. 15% better is a win, 15% worse a loss, anything else neutral; a pattern
 * needs 1,000 impressions before it is judged.
 */
export const performanceVersion = 'creative-performance.1';
export const thresholds = Object.freeze({ minImpressions: 1000, ctrDrop: 0.2, frequency: 3, cpmRise: 0.2, learning: 0.15 });

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The asset id an ad's link carries in utm_content, or null. */
export function assetIdFromLink(link) {
  try {
    const value = new URL(String(link ?? '')).searchParams.get('utm_content');
    return value && uuid.test(value) ? value.toLowerCase() : null;
  } catch { return null; }
}

const empty = () => ({ impressions: 0, clicks: 0, spendCents: 0, results: 0, frequencyWeight: 0 });
const add = (sum, row) => ({
  impressions: sum.impressions + (Number(row.impressions) || 0), clicks: sum.clicks + (Number(row.clicks) || 0), spendCents: sum.spendCents + (Number(row.spendCents) || 0),
  results: sum.results + (Number(row.results) || 0), frequencyWeight: sum.frequencyWeight + (Number(row.frequency) || 0) * (Number(row.impressions) || 0),
});
/** A week's totals with the rates the rules read: click-through rate, cost per thousand impressions and average frequency. */
export function rates(sum) {
  return { impressions: sum.impressions, clicks: sum.clicks, spendCents: sum.spendCents, results: sum.results,
    ctr: sum.impressions ? sum.clicks / sum.impressions : 0, cpmCents: sum.impressions ? Math.round((sum.spendCents / sum.impressions) * 1000) : 0,
    frequency: sum.impressions ? sum.frequencyWeight / sum.impressions : 0 };
}

/**
 * Joins the ad platforms' two seven-day windows (social clients' adsOverview: ads with their copy and insights) to assets by utm_content.
 * `overviews` is [{ platform, overview }]. Returns Map(assetId -> { current, previous, ads }).
 */
export function joinResults(overviews = []) {
  const byAsset = new Map();
  for (const { overview } of overviews) {
    if (!overview) continue;
    const current = new Map((overview.current ?? []).map(row => [row.adId, row]));
    const previous = new Map((overview.previous ?? []).map(row => [row.adId, row]));
    for (const ad of overview.ads ?? []) {
      const id = assetIdFromLink(ad.copy?.link);
      if (!id) continue;
      const entry = byAsset.get(id) ?? { current: empty(), previous: empty(), ads: 0 };
      if (current.has(ad.id)) entry.current = add(entry.current, current.get(ad.id));
      if (previous.has(ad.id)) entry.previous = add(entry.previous, previous.get(ad.id));
      entry.ads += 1;
      byAsset.set(id, entry);
    }
  }
  return new Map([...byAsset].map(([id, entry]) => [id, { current: rates(entry.current), previous: rates(entry.previous), ads: entry.ads }]));
}

/** Which fatigue signals an asset shows, and whether it is tired (two or more). */
export function fatigue(result, rules = thresholds) {
  const { current, previous } = result ?? {};
  if (!current || current.impressions < rules.minImpressions) return { fatigued: false, signals: [] };
  const compared = previous && previous.impressions >= rules.minImpressions;
  const signals = [];
  if (compared && previous.ctr > 0 && current.ctr <= previous.ctr * (1 - rules.ctrDrop)) signals.push('ctr_falling');
  if (current.frequency > rules.frequency) signals.push('frequency_high');
  if (compared && previous.cpmCents > 0 && current.cpmCents >= previous.cpmCents * (1 + rules.cpmRise)) signals.push('cpm_rising');
  return { fatigued: signals.length >= 2, signals };
}

const signalWords = { ctr_falling: 'click-through rate fell 20% or more', frequency_high: 'seen more than 3 times per person', cpm_rising: 'cost per thousand impressions rose 20% or more' };
export const fatigueReason = signals => signals.map(signal => signalWords[signal] ?? signal).join(', ');

/** One scorecard row per asset: its week, its leads and trials (from utm_content), and whether it is tired. */
export function scorecard(assets = [], results = new Map(), leads = []) {
  const leadsBy = new Map(leads.map(row => [String(row.assetId).toLowerCase(), row]));
  return assets.map(asset => {
    const result = results.get(String(asset.id).toLowerCase()) ?? { current: rates(empty()), previous: rates(empty()), ads: 0 };
    const lead = leadsBy.get(String(asset.id).toLowerCase());
    const tired = fatigue(result);
    return { id: asset.id, product: asset.product, platform: asset.platform, placement: asset.placement, kind: asset.kind, layout: asset.layout, hookType: asset.hookType,
      lengthKey: asset.lengthKey ?? null, headline: asset.headline ?? '', variantLabel: asset.variantLabel ?? '', ads: result.ads, ...result.current,
      previous: { ctr: result.previous.ctr, cpmCents: result.previous.cpmCents, impressions: result.previous.impressions },
      leads: Number(lead?.leads ?? 0), trials: Number(lead?.trials ?? 0), fatigued: tired.fatigued, signals: tired.signals };
  });
}

/** What to do this week: retire the tired assets, and make new variants of up to two winners per product. */
export function refreshPlan(rows, rules = thresholds) {
  const retire = rows.filter(row => row.fatigued);
  const winners = [];
  for (const product of [...new Set(rows.map(row => row.product))]) {
    const ranked = rows.filter(row => row.product === product && !row.fatigued && row.impressions >= rules.minImpressions).sort((a, b) => b.ctr - a.ctr || b.leads - a.leads);
    winners.push(...ranked.slice(0, 2));
  }
  return { retire, winners };
}

const patterns = row => [['hook', row.hookType], ['layout', row.layout], ['format', row.placement], ...(row.kind === 'video' && row.lengthKey ? [['length', row.lengthKey]] : [])];

/** The learnings this week's rows support, one per product, platform and pattern. */
export function learningsFrom(rows, rules = thresholds) {
  const out = [];
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.product}|${row.platform}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const [key, members] of groups) {
    const [product, platform] = key.split('|');
    const base = members.reduce((sum, row) => ({ impressions: sum.impressions + row.impressions, clicks: sum.clicks + row.clicks, leads: sum.leads + row.leads }), { impressions: 0, clicks: 0, leads: 0 });
    if (base.impressions < rules.minImpressions) continue;
    const baseCtr = base.clicks / base.impressions;
    const baseLeads = base.leads / base.impressions;
    const byPattern = new Map();
    for (const row of members) for (const [kind, value] of patterns(row)) {
      if (!value) continue;
      const id = `${kind}|${value}`;
      const sum = byPattern.get(id) ?? { kind, value, impressions: 0, clicks: 0, leads: 0, samples: 0 };
      sum.impressions += row.impressions; sum.clicks += row.clicks; sum.leads += row.leads; sum.samples += 1;
      byPattern.set(id, sum);
    }
    for (const sum of byPattern.values()) {
      if (sum.impressions < rules.minImpressions || sum.samples === members.length) continue;
      const ctr = sum.clicks / sum.impressions;
      const leadRate = sum.leads / sum.impressions;
      // Leads count when there are any; otherwise clicks decide.
      const score = base.leads > 0 ? ((leadRate / (baseLeads || Infinity)) - 1) * 0.6 + ((ctr / (baseCtr || Infinity)) - 1) * 0.4 : (ctr / (baseCtr || Infinity)) - 1;
      const verdict = score >= rules.learning ? 'win' : score <= -rules.learning ? 'lose' : 'neutral';
      out.push({ product, platform, kind: sum.kind, value: String(sum.value).slice(0, 120), verdict, samples: sum.samples, score: Number(score.toFixed(3)),
        evidence: { impressions: sum.impressions, clicks: sum.clicks, ctr: Number(ctr.toFixed(4)), leads: sum.leads, baselineCtr: Number(baseCtr.toFixed(4)) } });
    }
  }
  return out;
}
