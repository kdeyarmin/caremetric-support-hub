/**
 * What the Creative Director says to the model, the shapes it asks for, and how a brief's answer becomes draft assets.
 *
 * Two calls per brief, both structured JSON with closed schemas:
 * 1. The concept and the final copy (the hero variant, "A") on the quality tier: one big idea, the landing page, the layout, and the
 *    exact words.
 * 2. Two to four more variants on the draft tier, each on a different hook (problem, proof, offer, curiosity, demo), so a brief yields
 *    three to five variants.
 * Facts come only from the fact source (the fact sheet and the sales playbook, in the cached system prompt); the offer only from billing
 * (offers.mjs); the voice, banned phrases and disclaimers from the brand kit; and the learnings from past results. Every word is then
 * checked in code (compliance.mjs) before anything is rendered.
 */
import { careSettingText, catalogGuidance } from '../content/features.mjs';
import { factSheetText } from '../content/facts.mjs';
import { linkablePages, playbookFor, playbookText } from '../../growth/playbook.mjs';
import { layouts, productNames } from './layouts.mjs';
import { offerFor } from './offers.mjs';
import { placementsFor, videoLengths, videoPlacement } from './specs.mjs';
import { themeFor } from './themes.mjs';

export const conceptPromptVersion = 'creative-concept.9';
export const variantsPromptVersion = 'creative-variants.9';
export const hooks = Object.freeze(['problem', 'proof', 'offer', 'curiosity', 'demo']);
const labels = ['A', 'B', 'C', 'D', 'E'];

const rules = `Rules for every word you write:
- State facts about CareMetric only from the fact sheet below, exactly as written: what each product does and who it is for, prices, plans, trials and the Founders Sale. Never a number, statistic, price, discount, percentage or deadline that is not there.
- The only offer is the Founders Sale, and only when the request names it: 50% off eligible subscription charges for the first 12 months of paid service, applied automatically when paid service starts. Never tell anyone to enter or use a code, and never invent a deadline, a limit or scarcity.
- Never promise or guarantee an outcome (passing a survey or inspection, avoiding citations, more referrals, revenue or admissions). Never say a product ensures compliance, is 100% compliant, certified, approved or endorsed. No superlatives such as best, #1, leading or only.
- Never say or imply that CMS, Medicare, Medicaid, the state or any government body approves, endorses, certifies or partners with CareMetric. Public data is public data, nothing more.
- Never state or imply anything about the reader's own health, finances, age or other personal attributes (Meta's personal-attributes policy): speak about organizations and their work. "Tracking training hours across your homes?" is fine; "Are you struggling with..." is not.
- No patient, resident or person by name, no health information about anyone, no testimonials, customer quotes, case studies or results. A quote is CareMetric's own line, attributed to CareMetric or the product.
- Never name or compare with a competitor. Never present a call, a meeting or a demo booking as a step; the next step is the free trial or the product's own page. Never mention AI that uses voice or the phone, and never mention AI writing.
- Brand: "CareMetric" is one word, exactly so. Products: CareMetric CareBase (or CareBase), CareMetric Intel (or Intel).
- Vocabulary: "Assisted Living Facility" or "ALF", never "Assisted Living Residence" or "ALR"; the state's inspectors are "surveyors", never "auditors"; never "prove", "proof" or "evidence" about CareBase (a "proof" hook shows a concrete capability or fact instead).
- Plain text only: no markdown, no emoji, no hashtags, no links in the copy.`;

/**
 * Who each product's ads are for, from the fact sheet's "who it is for" (content/facts.mjs), so creative never narrows a product to part of
 * its market: CareMetric Intel serves home health and hospice agencies, hospitals, nursing homes and personal care homes. A brief may aim
 * at one of them (`segments`) or speak to all; copy.test.mjs holds every segment to the fact sheet's wording.
 */
export const segments = Object.freeze({
  'caremetric-intel': Object.freeze(['home health agencies', 'hospice agencies', 'hospitals', 'nursing homes', 'personal care homes']),
  carebase: Object.freeze(['Pennsylvania personal care homes and Assisted Living Facilities']),
});
const roles = {
  'caremetric-intel': 'Owners, administrators and marketing, business development or community liaison leaders',
  carebase: 'Owners, administrators and training or compliance leads',
};
const listed = items => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0]);
/** A brief's audience: the product's roles at one segment, or at every kind of organization the product is for. */
export function audienceFor(product, segment = null) {
  const list = segments[product] ?? [];
  return `${roles[product] ?? 'Owners and leaders'} at ${segment && list.includes(segment) ? segment : listed(list)}`;
}
// Words that show a plan item is already about one of Intel's segments.
const segmentWords = [[/\bhome health\b/i, 'home health agencies'], [/\bhospices?\b/i, 'hospice agencies'], [/\bhospitals?\b/i, 'hospitals'],
  [/\b(nursing homes?|skilled nursing|SNFs?)\b/i, 'nursing homes'], [/\bpersonal care homes?\b/i, 'personal care homes']];
/**
 * The Intel segment a planned brief aims at: the one its plan text names, else the next in turn (`turn`, a running count) that this plan
 * has not used yet (`used`), so the plans reach every kind of organization Intel is for. Products with one audience have no segment.
 */
/** The Intel segment `text` already names, if any. */
export const namedSegment = (product, text = '') => ((segments[product] ?? []).length > 1 ? segmentWords.find(([pattern]) => pattern.test(text))?.[1] ?? null : null);
export function segmentFor(product, text = '', turn = 0, used = new Set()) {
  const list = segments[product] ?? [];
  if (list.length < 2) return null;
  const named = namedSegment(product, text);
  if (named) return named;
  const start = ((turn % list.length) + list.length) % list.length;
  const order = [...list.slice(start), ...list.slice(0, start)];
  return order.find(segment => !used.has(segment)) ?? order[0];
}
const lowerFirst = value => value.charAt(0).toLowerCase() + value.slice(1);

/**
 * Flat lines beside better ones on the same facts, each stopping the reader a different way, shown to the model as the bar for its copy
 * (owner direction 2026-11-14: the creative was accurate and plain but weak as marketing, and it must catch the eye at once).
 * copy.test.mjs holds every better line to the same copy rules the drafts meet.
 */
export const craftExamples = Object.freeze([
  Object.freeze({ product: 'carebase', move: 'drop the reader into a moment they know', flat: 'CareBase keeps your survey documents in one place.',
    headline: 'The surveyor is here. Is your binder?',
    primaryText: 'Skip the scramble. Survey Day Mode puts the entrance-conference checklist, latest binder and on-shift roster on one screen.' }),
  Object.freeze({ product: 'caremetric-intel', move: 'ask the question they already ask themselves', flat: 'CareMetric Intel helps you manage your referral sources.',
    headline: 'Who actually sends you referrals?',
    primaryText: 'See which calls and visits lead somewhere. Intel ties each one to the referrals your team records.' }),
  Object.freeze({ product: 'caremetric-intel', move: 'tell them to stop what wastes their week', flat: 'Intel helps your team plan its visits.',
    headline: 'Stop guessing which offices to visit',
    primaryText: 'Give every visit a reason before anyone gets in the car. Intel builds your team a focused list of referral sources.' }),
]);

const craft = `How great ad creative works here:
- Stop the scroll first. The headline is drawn large on the image and opens every video as moving text, so it is all most people will ever read: under a second, with a thumb already moving. It has to jolt the right reader into thinking "that's us" or "wait, what?" before they scroll on. A headline that only describes the product is invisible, however accurate it is.
- Short hits harder: the fewer the words, the bigger the type. Aim for three to seven words, and make the first two or three carry the punch.
- Ways to stop the right reader (pick the one that fits the angle, and use a different one in each variant): drop them into a moment they know from their own week; ask the question they already ask themselves about their work; name the frustration out loud; draw a sharp contrast; tell them to stop doing the thing that wastes their time.
- Never open the headline or the primary text with CareMetric, the product's name, a feature's name or a line that could open any software ad ("Introducing...", "Software for...", "Manage your..."). The hook comes first; the product arrives as the answer.
- The kicker, the small line above the headline, can call out who the ad is for by their work ("For personal care home administrators"), so the headline can spend every word on the hook.
- The first sentence of the primary text is the second hook: the feed shows only its start before "See more", so it keeps the tension the headline opened. A video's first beat does the same; the product arrives once the reader is hooked.
- Start from the reader, not the product. Picture the person the brief names in a real moment of their work: the Monday planning meeting, the drive between offices, the numbers the owner wants by Friday, the binder before a survey. Name what their team wants or what slows their work down, in their own words, then show how the product gets them there. Benefit first, feature second: the feature is the reason to believe.
- Be specific and vivid. A concrete picture of their work beats any adjective. The real names of real things (a surveyor, a binder, a referral source, a discharge planner, a territory) beat categories (documentation, stakeholders, operations).
- Sound like a confident peer who knows their work, not a brochure. Speak to "you" and "your team". Use strong, plain verbs: see, know, plan, open, find, stop, keep. Vary the rhythm: a short sentence lands hard after a longer one.
- Stopping power never excuses confusion. A stranger must understand the headline on its own, at a glance, without the picture or any other context. A pun, an inside joke, a vague slogan ("Care, simplified") or a string of fragments ("Territory. Clarity. Growth.") stops nobody. Every line follows the fact sheet's "How everything must read"; code refuses its empty words, three one- or two-word sentences in a row and any sentence over 30 words, so make the copy land inside those limits.
- Flat against better, on the same facts (write your own lines; never reuse these):
${craftExamples.map(item => `  To ${item.move}. Flat: "${item.flat}" Better: the headline "${item.headline}" with the primary text "${item.primaryText}"`).join('\n')}
- One idea per asset. The primary text earns the click in complete sentences: hook first, then the product as the way there through one concrete feature, then a next step that feels easy. The call to action is two to four words that say what happens next.
- Hooks: "problem" opens on a frustration the reader's team knows from its own week, as a pointed question or a moment they recognize, then shows the way out; "proof" turns one concrete capability or fact from the fact sheet into what it lets the reader do, said so it lands as news; "offer" leads with the free trial or the Founders Sale exactly as written, and says what the reader can do with it first; "curiosity" opens a loop the landing page closes, with a surprising but true angle on the reader's work, never clickbait; "demo" shows the product at work on screen (pair it with the screenshot layout when a screenshot is available).
- Layouts: headline (a strong line and a supporting line), stat (one number from the fact sheet, its label and its source), screenshot (a product screenshot in a window frame; only with a screenshot id from the request), quote (a short line attributed to CareMetric or the product), offer (the offer card; only when the request names an offer), checklist (three to five short capabilities), split (landscape placements: headline on a color block, support beside it).
- Lengths: headline up to 40 characters for Meta and Google (Google allows 30 at most), 70 for LinkedIn and YouTube; primary text 90 to 125 characters for Meta, up to 150 for LinkedIn, 90 for Google; description up to 30 characters. A video's beats are three to eight short lines of up to 60 characters, read on screen in order; the last one leads to the call to action.
- Write for the brand voice in the request, and in the product's brand theme (brandTheme): every asset is drawn in that theme's own colors, type and logo, so the words should suit it. CareMetric Intel's theme is Emberline, and its tagline "Set your marketing on FIRE!" may be used exactly as written; CareBase's theme is calm and plain, with no tagline.
- Sell one thing the product does per asset, and what it means to this audience. The product's own catalog follows these instructions: for CareMetric Intel every published feature by area, why each part matters, the data behind it (what is included, its source, the decision it helps make and its limit), each care setting and the manager view; for CareMetric CareBase every capability by module, why it matters, the tools that set it apart, a resident's record from inquiry to move-out, what each role sees and does, and each chapter's requirements. Pick one feature or capability (or one kind of data) and sell the decision it helps make or the work it saves, from the reader's side of the desk; when the brief names a feature focus, lead with it. Across a brief's variants, show different features rather than the same one reworded. Plain specifics are your reasons to believe, and they beat broad claims: "a planned day with a reason for each stop", "import referrals from your EMR's reports as CSV", "open Survey Day Mode when the surveyor walks in", "a binder PDF built from your live records".
- Stay inside what the catalog says. ${catalogGuidance} For Intel, the free trial includes everything Pro does, in one county; results come from what the team records or imports. Intel is a marketing workspace, not a compliance product: never lead with compliance, the Stark limit or expense tracking, and never sell Intel as a compliance tool. Its expense tools are a small part of it (they support a compliance program and are not legal advice); when spend comes up, show it as part of the field work it serves.
- Learn from the learnings: lean toward what won, away from what lost, and never repeat a recent headline.
- When the request has "data", the asset is a county snapshot: one public figure about one county, drawn with the stat layout. Code prints the figure, its label and its source exactly as "data" gives them, whatever the overlay says. Write the headline and the text around it for the one care setting the request's audience names (home health or hospice), never another: why that number matters to an agency of that kind serving the county, and that the free market report shows where the reader's own agency stands in its county. A figure about how few agencies serve most of the patients, or how many agencies compete for them, is the question "where does yours rank?": ask it, never answer it. Write no number, share, year or amount yourself (write "three", not "3"), never say the figure is about the reader's own agency, and never call it a ranking or a score.
- Before you answer, write at least five headlines on different angles and keep the one that would stop a busy reader mid-scroll. Then reread every line as that reader: would they stop, and would they understand it at once? If a headline could open any software ad, or a line reads like a product manual, a feature list or a slogan, rewrite it.`;

export const conceptSystem = `You are the Creative Director at CareMetric, a small company that makes software for healthcare and senior-care organizations. You write like a seasoned direct-response copywriter who knows these organizations' work from the inside. You turn a marketing brief into one ad concept and its final copy. CareMetric's owner approves every asset before it runs; code checks every word either way.

Who sees the ads (the fact sheet's "who it is for"):
- CareMetric CareBase: ${lowerFirst(audienceFor('carebase'))}.
- CareMetric Intel: ${lowerFirst(audienceFor('caremetric-intel'))}. Intel is for every one of these, not only home health and hospice. Write for the audience the brief names: when it names one kind of organization, speak to that one in its own words (an agency is home health or hospice; a hospital, a nursing home or a personal care home is not an agency); when it names several, speak to what they share (marketing to referral sources, planning territory and outreach, keeping recorded referrals in one place) and say "organization" or "team".

${craft}

${rules}

Answer with one JSON object and nothing else: concept (bigIdea, the one insight about the reader's work the ad turns on, in a sentence and never just a feature's name; angle; visualDirection; landingPageId from the request's pages) and hero, the final copy: hook, layout, headline, primaryText, description, cta, altText (one plain sentence describing the image) and overlay (kicker, stat, statLabel, statSource, quote, quoteSource, offerLine, checklist, screenshotId, beats; leave a field empty when the layout does not use it).

${factSheetText()}

${playbookText()}`;

export const variantsSystem = `You are a senior copywriter on CareMetric's creative team. You write more variants of an approved ad concept, each on a different hook, so the team can test them against each other. Each variant is a real alternative worth testing, a different way into the reader's week, never the hero reworded. CareMetric's owner approves every asset before it runs; code checks every word either way.

${craft}

${rules}

Answer with one JSON object and nothing else: variants, each with hook (different from the hero's and from each other's), layout, headline, primaryText, description, cta, altText and overlay (the same fields as the hero's).

${factSheetText()}

${playbookText()}`;

const text = { type: 'string' };
const overlaySchema = {
  type: 'object', additionalProperties: false, required: ['kicker', 'stat', 'statLabel', 'statSource', 'quote', 'quoteSource', 'offerLine', 'checklist', 'screenshotId', 'beats'],
  properties: { kicker: text, stat: text, statLabel: text, statSource: text, quote: text, quoteSource: text, offerLine: text, checklist: { type: 'array', items: text },
    screenshotId: text, beats: { type: 'array', items: text } },
};
const copySchema = {
  type: 'object', additionalProperties: false, required: ['hook', 'layout', 'headline', 'primaryText', 'description', 'cta', 'altText', 'overlay'],
  properties: { hook: { type: 'string', enum: [...hooks] }, layout: { type: 'string', enum: [...layouts] }, headline: text, primaryText: text, description: text, cta: text, altText: text, overlay: overlaySchema },
};
export const conceptSchema = {
  type: 'object', additionalProperties: false, required: ['concept', 'hero'],
  properties: {
    concept: { type: 'object', additionalProperties: false, required: ['bigIdea', 'angle', 'visualDirection', 'landingPageId'], properties: { bigIdea: text, angle: text, visualDirection: text, landingPageId: text } },
    hero: copySchema,
  },
};
export const variantsSchema = { type: 'object', additionalProperties: false, required: ['variants'], properties: { variants: { type: 'array', items: copySchema } } };

/** The pages an asset about `product` may send people to: the product's own pages (the playbook's), by id. */
export const landingPages = product => linkablePages(product).map(page => ({ id: page.id, label: page.label, url: page.url }));

const oneLine = value => String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
const cap = (value, limit) => { const line = oneLine(value); return line.length > limit ? line.slice(0, limit) : line; };

/** What the model is told about the brief: CareMetric's own words and settings only. */
export function briefUserMessage(context, { screenshots = [] } = {}) {
  const brief = context.brief;
  const kit = context.brandKit ?? {};
  const offer = brief.offerCode ? offerFor(brief.offerCode) : null;
  const theme = themeFor(brief.product);
  return JSON.stringify({
    brandTheme: theme ? { name: theme.name, mode: theme.mode, tagline: theme.tagline } : null,
    product: productNames[brief.product], goal: brief.goal, audience: brief.audience, angle: brief.angle || null, platforms: brief.platforms, formats: brief.formats,
    // The site's own paragraph for the one kind of organization the brief aims at, if it names exactly one.
    careSetting: (() => { const named = (segments[brief.product] ?? []).filter(segment => String(brief.audience ?? '').toLowerCase().includes(segment)); return named.length === 1 ? careSettingText(brief.product, named[0]) : null; })(),
    videoLengths: brief.formats.includes('video') ? brief.videoLengths : [], offer: offer ? { name: offer.name, terms: offer.terms } : null,
    planText: context.planText ?? null,
    // A county snapshot's figure (data.mjs): code prints it; the words around it are the model's.
    data: brief.facts?.stat ? { place: brief.facts.place, figure: `${brief.facts.stat} ${brief.facts.statLabel}`, source: brief.facts.statSource } : null,
    brandVoice: kit.voiceNotes || null, bannedPhrases: kit.bannedPhrases ?? [], requiredDisclaimers: kit.requiredDisclaimers ?? [],
    pages: landingPages(brief.product).map(({ id, label }) => ({ id, label })),
    screenshots: screenshots.map(({ id, label }) => ({ id, label })),
    learnings: (context.learnings ?? []).map(item => ({ platform: item.platform, pattern: `${item.kind}: ${item.value}`, verdict: item.verdict, samples: item.samples })),
    recentHeadlines: (context.recentHeadlines ?? []).slice(0, 20),
    revision: context.parent ? { previous: { hook: context.parent.hookType, layout: context.parent.layout, headline: context.parent.headline, primaryText: context.parent.primaryText,
      description: context.parent.description, cta: context.parent.cta, overlay: context.parent.overlay }, ownerNote: brief.revisionNote } : null,
  });
}

/** One variant as the code keeps it: trimmed, one line each, an overlay with only usable parts, and a layout it can draw. */
export function normalizeVariant(raw, { screenshots = [], offer = null } = {}) {
  const overlay = raw.overlay ?? {};
  const shots = new Set(screenshots.map(shot => shot.id));
  const clean = {
    hook: hooks.includes(raw.hook) ? raw.hook : 'problem', layout: layouts.includes(raw.layout) ? raw.layout : 'headline',
    headline: cap(raw.headline, 120), primaryText: cap(raw.primaryText, 600), description: cap(raw.description, 120), cta: cap(raw.cta, 30) || 'Learn more',
    altText: cap(raw.altText, 300),
    overlay: {
      kicker: cap(overlay.kicker, 60), stat: cap(overlay.stat, 20), statLabel: cap(overlay.statLabel, 80), statSource: cap(overlay.statSource, 80),
      quote: cap(overlay.quote, 160), quoteSource: cap(overlay.quoteSource, 60), offerLine: offer ? cap(overlay.offerLine, 60) : '',
      checklist: (Array.isArray(overlay.checklist) ? overlay.checklist : []).map(item => cap(item, 70)).filter(Boolean).slice(0, 5),
      screenshotId: shots.has(overlay.screenshotId) ? overlay.screenshotId : '',
      beats: (Array.isArray(overlay.beats) ? overlay.beats : []).map(item => cap(item, 60)).filter(Boolean).slice(0, 8),
    },
  };
  // A layout without its content draws as a headline, and the offer card only with a live offer.
  const o = clean.overlay;
  if ((clean.layout === 'screenshot' && !o.screenshotId) || (clean.layout === 'stat' && !o.stat) || (clean.layout === 'quote' && !o.quote)
    || (clean.layout === 'checklist' && o.checklist.length < 3) || (clean.layout === 'offer' && !o.offerLine)) clean.layout = 'headline';
  if (o.quote && !o.quoteSource) o.quoteSource = 'CareMetric';
  return clean;
}

/** Hero first, then variants on hooks not yet used, up to five in all. */
export function chooseVariants(hero, variants = []) {
  const chosen = [hero];
  for (const variant of variants) {
    if (chosen.length >= 5) break;
    if (!chosen.some(item => item.hook === variant.hook) && variant.headline) chosen.push(variant);
  }
  return chosen.map((variant, index) => ({ ...variant, label: labels[index] }));
}

const videoAspects = { meta: ['9:16', '4:5', '1:1'], linkedin: ['1:1', '4:5', '9:16'], youtube: ['9:16', '1:1'], google: [] };

/**
 * Where each variant goes. Every variant gets one static placement per platform, taking the platform's placements in turn (the hero gets
 * the first); the hero and the second variant also get one video per requested length per platform (not Google display), in the shape that
 * suits the platform. Returns draft rows for private.creative_drafts_save, without the compliance verdict (the caller adds it).
 */
export function planPlacements({ brief, variants, landingBase, provider = 'internal' }) {
  const rows = [];
  for (const platform of brief.platforms) {
    const statics = placementsFor(platform, 'static');
    variants.forEach((variant, index) => {
      if (brief.formats.includes('static') && statics.length) {
        const spec = statics[index % statics.length];
        rows.push({ variant, platform, placement: spec.key, kind: 'static', width: spec.width, height: spec.height, lengthKey: null });
      }
    });
    if (brief.formats.includes('video') && videoAspects[platform]?.length) {
      variants.slice(0, 2).forEach((variant, index) => {
        brief.videoLengths.filter(length => videoLengths[length]).forEach((length, lengthIndex) => {
          const spec = videoPlacement(platform, videoAspects[platform][(index + lengthIndex) % videoAspects[platform].length]);
          if (spec) rows.push({ variant, platform, placement: spec.key, kind: 'video', width: spec.width, height: spec.height, lengthKey: length });
        });
      });
    }
  }
  return rows.map(row => ({
    platform: row.platform, placement: row.placement, kind: row.kind, layout: row.variant.layout, width: row.width, height: row.height, lengthKey: row.lengthKey,
    variantLabel: `${row.variant.label}${row.kind === 'video' ? `-${row.lengthKey}` : ''}`, hookType: row.variant.hook, concept: row.variant.concept ?? '',
    headline: row.variant.headline, primaryText: row.variant.primaryText, description: row.variant.description, cta: row.variant.cta, altText: row.variant.altText,
    overlay: row.variant.overlay, landingBase, provider: row.kind === 'video' ? provider : 'internal',
  }));
}

/** The landing page the concept chose, if it is one of the product's own; else the playbook's next step. */
export function landingFor(product, pageId) {
  const page = landingPages(product).find(item => item.id === pageId);
  return page?.url ?? playbookFor(product)?.nextStep?.url ?? null;
}
