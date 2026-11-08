/**
 * How the Social Media Manager judges ads and posts. Pure and deterministic: the numbers decide, and every recommendation carries the
 * plain-words reason the owner sees. A model only writes new ad copy once these rules ask for it.
 *
 * An ad is judged only after it has had a fair chance: it is past the learning days and has enough impressions or spend in the last
 * seven days. Then, per active ad set:
 * - pause an ad that has spent with no result, costs more than twice the target per result, or draws clicks at under half the ad set's
 *   typical rate; never the last active ad of an ad set (that one is refreshed instead);
 * - refresh (add new copy) when an ad set has fewer than two active ads, or an ad is tiring: seen more than 3.5 times per person on
 *   average with its click rate down by 30% or more on the week before;
 * - raise a daily budget by at most 20%, never past the owner's cap, when the ad set beats the target cost by 30% on three or more
 *   results. With no cap set (the default), no budget is ever raised.
 */
export const rulesVersion = 'social-rules.1';
const day = 86_400_000;
export const defaults = Object.freeze({ minImpressions: 1000, minSpendCents: 2000, learningDays: 3, fatigueFrequency: 3.5, fatigueDrop: 0.3, budgetStep: 0.2, maxDailyBudgetCents: 0, targetCostCents: null });

const money = cents => `$${(cents / 100).toFixed(2)}`;
const pct = value => `${(value * 100).toFixed(1)}%`;
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0; };
const metric = rows => {
  const sum = rows.reduce((total, row) => ({ impressions: total.impressions + row.impressions, clicks: total.clicks + row.clicks, spendCents: total.spendCents + row.spendCents, results: total.results + row.results }), { impressions: 0, clicks: 0, spendCents: 0, results: 0 });
  return { ...sum, ctr: sum.impressions ? sum.clicks / sum.impressions : 0, costPerResult: sum.results ? Math.round(sum.spendCents / sum.results) : null };
};

/** @returns {{ recommendations: object[], adsets: object[] }} */
export function evaluateAds({ adsets = [], ads = [], current = [], previous = [], now = new Date(), settings = {} }) {
  const s = { ...defaults, ...Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)) };
  const byAd = rows => new Map(rows.map(row => [row.adId, row]));
  const thisWeek = byAd(current), lastWeek = byAd(previous);
  const recommendations = [];
  const summaries = [];
  for (const adset of adsets) {
    const members = ads.filter(ad => ad.adsetId === adset.id);
    const total = metric(members.map(ad => thisWeek.get(ad.id)).filter(Boolean));
    summaries.push({ id: adset.id, name: adset.name, active: adset.active, dailyBudget: adset.dailyBudget, activeAds: members.filter(ad => ad.active).length, ...total });
    if (!adset.active) continue;
    const active = members.filter(ad => ad.active);
    const judged = active.filter(ad => {
      const row = thisWeek.get(ad.id);
      const age = now.getTime() - (Date.parse(ad.createdAt ?? '') || now.getTime());
      return row && age >= s.learningDays * day && (row.impressions >= s.minImpressions || row.spendCents >= s.minSpendCents);
    });
    const typical = median(judged.map(ad => { const row = thisWeek.get(ad.id); return row.impressions ? row.clicks / row.impressions : 0; }));
    let remaining = active.length;
    let refresh = null;
    const best = [...active].sort((a, b) => score(thisWeek.get(b.id)) - score(thisWeek.get(a.id)))[0] ?? members[0] ?? null;
    for (const ad of judged) {
      const row = thisWeek.get(ad.id);
      const ctr = row.impressions ? row.clicks / row.impressions : 0;
      const cost = row.results ? Math.round(row.spendCents / row.results) : null;
      let reason = null;
      if (row.results === 0 && row.spendCents >= Math.max(s.minSpendCents, 2 * (s.targetCostCents ?? 0))) reason = `spent ${money(row.spendCents)} in 7 days with no result`;
      else if (s.targetCostCents && cost !== null && cost > 2 * s.targetCostCents) reason = `costs ${money(cost)} per result, more than twice the ${money(s.targetCostCents)} target`;
      else if (judged.length >= 2 && typical > 0 && ctr < 0.5 * typical) reason = `click rate ${pct(ctr)} is under half the ad set's typical ${pct(typical)}`;
      if (reason) {
        if (remaining > 1) {
          recommendations.push({ kind: 'pause', adId: ad.id, adName: ad.name, adsetId: adset.id, adsetName: adset.name, reason });
          remaining -= 1;
        } else refresh ??= { reason: `its only active ad ${reason}` };
        continue;
      }
      const before = lastWeek.get(ad.id);
      const beforeCtr = before?.impressions ? before.clicks / before.impressions : null;
      if (row.frequency >= s.fatigueFrequency && before && before.impressions >= s.minImpressions && beforeCtr && ctr <= (1 - s.fatigueDrop) * beforeCtr) {
        refresh ??= { reason: `"${ad.name}" is tiring: seen ${row.frequency.toFixed(1)} times per person, click rate down from ${pct(beforeCtr)} to ${pct(ctr)}` };
      }
    }
    if (remaining < 2) refresh ??= { reason: remaining === 0 ? 'it has no active ad' : 'it has only one active ad to test against' };
    if (refresh && best) recommendations.push({ kind: 'refresh', adsetId: adset.id, adsetName: adset.name, basedOn: best.id, reason: refresh.reason });
    if (s.targetCostCents && s.maxDailyBudgetCents > 0 && adset.dailyBudget && total.results >= 3 && total.costPerResult !== null
      && total.costPerResult <= 0.7 * s.targetCostCents && adset.dailyBudget < s.maxDailyBudgetCents) {
      const to = Math.min(Math.round(adset.dailyBudget * (1 + s.budgetStep)), s.maxDailyBudgetCents);
      if (to > adset.dailyBudget) {
        recommendations.push({ kind: 'budget', adsetId: adset.id, adsetName: adset.name, from: adset.dailyBudget, to,
          reason: `${total.results} results at ${money(total.costPerResult)} each, beating the ${money(s.targetCostCents)} target` });
      }
    }
  }
  return { recommendations, adsets: summaries };
}

// An ad's standing for picking the one new copy is based on: results first, then clicks.
const score = row => (row ? row.results * 1000 + (row.impressions ? row.clicks / row.impressions : 0) : -1);

/** Engagement of a post: reactions, comments (twice) and shares (three times), the public counts every platform gives. */
export const engagement = post => Number(post.reactions ?? 0) + 2 * Number(post.comments ?? 0) + 3 * Number(post.shares ?? 0);

/** Posts from the last `days` days, ranked by engagement, best first. */
export function rankPosts(posts = [], { now = new Date(), days = 28 } = {}) {
  const since = now.getTime() - days * day;
  return posts.filter(post => (Date.parse(post.at ?? '') || 0) >= since).map(post => ({ ...post, engagement: engagement(post) })).sort((a, b) => b.engagement - a.engagement);
}
