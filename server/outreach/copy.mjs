/**
 * The owner's cold email copy for a state launch (docs/STATE_LAUNCHES.md): the five sequences written with the owner for Pennsylvania on
 * 2026-11-28, word for word, as Instantly `sequences` arrays. Only each link's utm_campaign names the state ("oh-snf"); for Pennsylvania the
 * copy equals the campaigns built by hand (copy.test.mjs pins it).
 *
 * The owner's rules for this copy: his own voice and story; his signature, with "Dr." for everyone but his local nursing homes, who know
 * him; never a telephone number (his cell phone is never used on anything); the trial is 30 days free with no credit card; discounts are
 * never given as a number ("Founders discounts", discounts for more than one building). Instantly fills {{firstName}}, {{county}} and
 * {{companyName}} from each lead.
 */

const SIG = '<div>Dr. Kevin Deyarmin, ND, MSW, CHPCA, NCG<br />Founder, CareMetric Intel<br />'
  + 'CareMetric Healthcare Advisors<br />117 Jennings Rd, South Fork, PA 15956</div>';
// Local referral sources know him: no "Dr." (owner, 2026-11-28).
const SIG_LOCAL = SIG.replace('Dr. Kevin Deyarmin', 'Kevin Deyarmin');
const OPT = '<div>Not a fit? Reply "no thanks" and I won\'t write again.</div>';
const BR = '<div><br /></div>';
const HI = 'Hi {{firstName}},';

function body(paras, { ps = null, sig = SIG } = {}) {
  const out = [];
  for (const p of [HI, ...paras]) out.push(`<div>${p}</div>`, BR);
  out.push(sig, BR);
  if (ps) out.push(`<div>${ps}</div>`, BR);
  out.push(OPT);
  return out.join('');
}

const link = (campaign, content, text = 'caremetricintel.com') => '<a href="https://www.caremetricintel.com/login?signup=true&amp;utm_source=cold-email'
  + `&amp;utm_medium=email&amp;utm_campaign=${campaign}&amp;utm_content=${content}">${text}</a>`;

const seq = (...steps) => [{ steps: steps.map(([delay, subject, text]) => ({ type: 'email', delay, variants: [{ subject, body: text }] })) }];

const PS_SINGLE = 'P.S. Prefer to look around yourself? Intel is free for 30 days at caremetricintel.com, '
  + 'no credit card required. New accounts also get Founders discounts.';
const TRIAL_SINGLE = 'You can also try Intel free for 30 days at caremetricintel.com, no credit card required. '
  + 'New accounts also get Founders discounts.';
const REPORT_AGAIN = 'The free {{county}} County report is still yours if you want it. Just reply "yes."';
const LAST = 'Last note from me.';
const QUESTION = "Or reply here with any question and I'll answer it.";
const PRIVATE_SNF = 'Your data stays private. No other facility or agency, mine included, can see it.';
const PRIVATE_CORP = 'Your data stays private. No other company, mine included, can see it.';

/** The utm_campaign of each segment's links in `state` ("pa-starter", "oh-snf", ...). */
export function utmCampaigns(state) {
  const code = String(state ?? '').trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(code)) throw Object.assign(new Error('A state is two letters'), { code: 'state' });
  return { agency: `${code}-starter`, snf: `${code}-snf`, local: `${code}-snf-local`, chain: `${code}-chain`, regional: `${code}-regional` };
}

// Home health and hospice owners.
const agency = utm => seq(
  [0, "the tool I wished I'd had", body([
    "I've worked in post-acute care for almost 20 years. I started as marketing director and then administrator of a skilled nursing facility, moved to hospice as an account manager and worked up to Executive Director, and today I'm COO of a home health and hospice agency.",
    "In every one of those jobs I had the same problem. I couldn't see what my marketers were doing without making them fill out reports that took time away from marketing. And I had no good way to point a new marketer in the right direction.",
    "So I built the tool I wished I'd had, and I'm opening it up to other agencies. CareMetric Intel maps every potential referral source in your territory, shows how your competitors compare, and puts your own quality data in your marketers' hands. You see their sales calls, referrals and expenses without the paperwork. It runs on millions of records that update regularly.",
    'Your data stays private. No other agency, mine included, can see it.',
    'Want a free {{county}} County report? It shows which hospitals residents use, the county\'s Medicare population, and every home health agency, hospice and nursing home there. Just reply "yes" and I\'ll send it.',
  ], { ps: PS_SINGLE })],
  [3, '', body([
    'One more thing I learned running marketing teams: the referral source that quietly stops sending patients is usually the one nobody notices until the census drops.',
    "Intel keeps every referral source's visits and referrals in one place and flags the ones that are slipping, so your marketers know who to see next. A new marketer starts on day one with a list of every potential referral source in their territory, instead of guessing.",
    REPORT_AGAIN, TRIAL_SINGLE])],
  [5, '', body([LAST,
    "When I was an Executive Director, I wanted to know right away when a competitor's star rating dropped, its owner changed, or it started serving my counties. Intel watches for all of that and tells you, and it shows each agency's share of every county, so your marketers know where to push.",
    `If you'd rather look around yourself, you can try it on {{county}} County free for 30 days, no credit card required: ${link(utm, 'e3-competitors')}`,
    'New accounts also get Founders discounts.', QUESTION])],
);

// Skilled nursing administrators, and the owner's local ones (an opener, and his signature without "Dr.").
const nursingHome = (utm, { opener = null, sig = SIG } = {}) => {
  const first = [
    "I started my career in a nursing home, first as sales and marketing director and then as administrator. From there I moved to hospice as an account manager and worked up to Executive Director, and today I'm COO of a home health and hospice agency.",
    "The problem I had in that first job followed me everywhere. I couldn't see what my liaisons were doing at the hospitals without making them fill out reports that took time away from marketing. And I had no good way to point a new liaison in the right direction.",
    "So I built the tool I wished I'd had, and I'm opening it up to other facilities. CareMetric Intel maps every potential referral source in your territory, shows how every nursing home around you compares on star ratings, staffing and inspections, and puts your own quality data in your team's hands. You see their sales calls, referrals and expenses without the paperwork. It runs on millions of records that update regularly.",
    PRIVATE_SNF,
    'Want a free {{county}} County report? It shows which hospitals residents use, the county\'s Medicare population, and every nursing home, home health agency and hospice there. Just reply "yes" and I\'ll send it.',
  ];
  if (opener) first.unshift(opener);
  return seq(
    [0, 'one nursing home administrator to another', body(first, { ps: PS_SINGLE, sig })],
    [3, '', body([
      'One more thing I learned as an administrator: the case manager who quietly stops sending you patients is usually the one nobody notices until the census drops.',
      "Intel keeps every referral source's visits and referrals in one place and flags the ones that are slipping, so your liaisons know who to see next. A new liaison starts on day one with a list of every potential referral source in their territory, instead of guessing.",
      REPORT_AGAIN, TRIAL_SINGLE], { sig })],
    [5, '', body([LAST,
      "When I ran a nursing home, I always wanted to know how the facilities around me really stacked up. Intel ranks every competing nursing home on star ratings, staffing, inspections and Medicare share, and alerts you when a competitor's share changes, so your team knows where to push.",
      `If you'd rather look around yourself, you can try it on {{county}} County free for 30 days, no credit card required: ${link(utm, 'e3-competitors')}`,
      'New accounts also get Founders discounts.', QUESTION], { sig })],
  );
};
const LOCAL_OPENER = "We may already know each other. I've worked alongside the nursing homes in our area for years through hospice and home health, and I wanted you to hear about this from me directly.";

// Corporate: large chains (many buildings, usually in several states).
const chain = utm => seq(
  [0, 'one view of every liaison', body([
    "I've spent almost 20 years in post-acute care. I started as a nursing home sales and marketing director and then administrator, moved to hospice as an account manager and worked up to Executive Director, and today I'm COO of a home health and hospice agency.",
    "In every one of those roles I had the same problem. I couldn't see what my liaisons were doing without making them fill out reports that took time away from marketing, and I had no good way to point a new liaison in the right direction. Across a company with buildings in many markets, that problem multiplies.",
    "So I built CareMetric Intel. For each building, it maps every potential referral source in the territory and shows how that building compares with the nursing homes it competes against on star ratings, staffing, inspections and Medicare share. Leadership gets one view of every liaison's sales calls, referrals and expenses, without the paperwork. It runs on millions of records that update regularly.",
    PRIVATE_CORP,
    'Want a free {{county}} County report, where {{companyName}} has a building? It shows which hospitals residents use, the county\'s Medicare population, and every nursing home, home health agency and hospice there. Just reply "yes" and I\'ll send it.',
  ], { ps: 'P.S. Intel is free for 30 days, no credit card required. Companies with multiple buildings get discounts, and new accounts also get Founders discounts.' })],
  [3, '', body([
    'One thing I learned managing marketing teams: the referral source that quietly stops sending patients is usually the one nobody notices until the census drops. Across a portfolio, those slips are easy to miss.',
    'Intel flags the referral sources that are slipping at each building, so every liaison knows who to see next, and a new liaison starts on day one with a list of every potential referral source in their territory. You see every building\'s referrals in one place.',
    REPORT_AGAIN,
    'You can also try Intel free for 30 days at caremetricintel.com, no credit card required. Companies with multiple buildings get discounts.'])],
  [5, '', body([LAST,
    `If it's easier, start with one market. You can try Intel on {{county}} County free for 30 days, no credit card required: ${link(utm, 'e3-pilot')}`,
    "If it earns its keep there, we'll set up the rest of your buildings, with discounts for multiple buildings and Founders discounts for new accounts.",
    "Or, if someone else owns liaison and referral tracking at {{companyName}}, reply with their name and I'll reach out to them instead."])],
);

// Corporate: regional groups (2 to 19 buildings, nonprofits included).
const regional = utm => seq(
  [0, "the tool I wished I'd had", body([
    "I started my career in a nursing home, first as sales and marketing director and then as administrator. From there I moved to hospice as an account manager and worked up to Executive Director, and today I'm COO of a home health and hospice agency.",
    "Through all of it I had the same problem. I couldn't see what my liaisons were doing without making them fill out reports that took time away from marketing, and I had no good way to point a new liaison in the right direction. With more than one building, you're chasing that at every location.",
    "So I built the tool I wished I'd had. CareMetric Intel maps every potential referral source around each of your buildings, shows how each one compares with the nursing homes nearby on star ratings, staffing and inspections, and puts your own quality data in your team's hands. You see every liaison's sales calls, referrals and expenses in one place, without the paperwork. It runs on millions of records that update regularly.",
    'Your data stays private. No other organization, mine included, can see it.',
    'Want a free {{county}} County report? It shows which hospitals residents use, the county\'s Medicare population, and every nursing home, home health agency and hospice there. Just reply "yes" and I\'ll send it.',
  ], { ps: 'P.S. Intel is free for 30 days, no credit card required. Organizations with more than one building get discounts, and new accounts also get Founders discounts.' })],
  [3, '', body([
    "One more thing I learned as an administrator: the case manager who quietly stops sending you patients is usually the one nobody notices until the census drops. With several buildings, it can happen at one while you're looking at another.",
    'Intel flags the referral sources that are slipping at each building, so your liaisons know who to see next. A new liaison starts on day one with a list of every potential referral source in their territory, instead of guessing.',
    REPORT_AGAIN,
    'You can also try Intel free for 30 days at caremetricintel.com, no credit card required. Organizations with more than one building get discounts.'])],
  [5, '', body([LAST,
    "When I ran a nursing home, I always wanted to know how the facilities around me really stacked up. Intel ranks every competing nursing home around each of your buildings on star ratings, staffing, inspections and Medicare share, and alerts you when a competitor's share changes.",
    `If you'd rather look around yourself, you can try it on {{county}} County free for 30 days, no credit card required: ${link(utm, 'e3-competitors')}`,
    'Organizations with more than one building get discounts, and new accounts also get Founders discounts.',
    "Or reply with the best person to talk to about liaison and referral tracking, and I'll reach out to them."])],
);

export const segments = Object.freeze(['agency', 'snf', 'local', 'chain', 'regional']);

/** The five sequences for `state`, by segment: { agency, snf, local, chain, regional }. */
export function launchSequences(state) {
  const utm = utmCampaigns(state);
  return {
    agency: agency(utm.agency),
    snf: nursingHome(utm.snf),
    local: nursingHome(utm.local, { opener: LOCAL_OPENER, sig: SIG_LOCAL }),
    chain: chain(utm.chain),
    regional: regional(utm.regional),
  };
}

/** Each segment's campaign name in Instantly, as the owner named Pennsylvania's. */
export function campaignName(state, segment, stateName = state) {
  const names = { agency: 'Home health & hospice owners', snf: 'Skilled nursing administrators', local: 'Local nursing homes',
    chain: 'Chains – corporate', regional: 'Regional groups – leadership' };
  return `${stateName} – ${names[segment] ?? segment}`;
}
