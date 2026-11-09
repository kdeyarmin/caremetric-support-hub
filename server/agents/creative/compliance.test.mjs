import { describe, expect, it } from 'vitest';
import { badgeText, checkCopy, checkPlatform, checkText, checkVideo, checkVisual, rules, verdictOf } from './compliance.mjs';

// Copy that passes every rule, for both products: the fact sheet's own words.
const clean = {
  headline: 'Territory plans from public data',
  primaryText: 'CareMetric Intel brings targeted marketing and territory analysis into one place. Start a free trial.',
  description: 'Free trial', cta: 'Start free trial', altText: 'A headline on a light background',
  overlay: { checklist: ['Territory analysis', 'A marketing CRM', 'Referrals in one place'] },
};
const intel = (copy = {}, more = {}) => checkCopy({ product: 'caremetric-intel', platform: 'meta', copy: { ...clean, ...copy }, ...more });
const carebase = (copy = {}, more = {}) => checkCopy({ product: 'carebase', platform: 'meta', copy: { ...clean, headline: 'Training records in one place', primaryText: 'CareMetric CareBase keeps staff training, resident records and survey documentation in one place.', ...copy }, ...more });
const rulesOf = findings => [...new Set(findings.map(item => `${item.level}:${item.rule}`))];

describe('copy compliance', () => {
  it('passes clean copy for both products', () => {
    expect(intel()).toEqual([]);
    expect(carebase()).toEqual([]);
    expect(rules).toContain('government_endorsement');
  });

  it('phi: blocks identifiers, named people and a person\'s health', () => {
    expect(rulesOf(intel({ primaryText: 'Member ID 4433221 and MRN 99887766 are on file.' }))).toContain('block:phi');
    expect(rulesOf(intel({ headline: 'Resident Mary Jones finished her training' }))).toContain('block:phi');
    expect(rulesOf(intel({ primaryText: 'Track her diagnosis and her medications in one place.' }))).toContain('block:phi');
    expect(rulesOf(carebase({ primaryText: 'Keep resident records in one place for your homes.' }))).not.toContain('block:phi');
  });

  it('personal_attributes: blocks on Meta, warns elsewhere, and allows talking about organizations', () => {
    const copy = { headline: 'Are you struggling with your health?' };
    expect(rulesOf(intel(copy))).toContain('block:personal_attributes');
    expect(rulesOf(checkCopy({ product: 'caremetric-intel', platform: 'linkedin', copy: { ...clean, ...copy } }))).toContain('warn:personal_attributes');
    expect(rulesOf(intel({ headline: 'Tracking referrals across your branches?' }))).not.toContain('block:personal_attributes');
  });

  it('unsubstantiated_claim: blocks guarantees, compliance assurances, certifications and superlatives the fact source lacks', () => {
    expect(rulesOf(carebase({ headline: 'Guaranteed survey results' }))).toContain('block:unsubstantiated_claim');
    expect(rulesOf(carebase({ headline: 'Stay 100% compliant every day' }))).toContain('block:unsubstantiated_claim');
    expect(rulesOf(carebase({ primaryText: 'CareBase is HIPAA-certified and keeps resident records in one place.' }))).toContain('block:unsubstantiated_claim');
    expect(rulesOf(intel({ headline: 'The #1 marketing platform for hospice' }))).toContain('block:unsubstantiated_claim');
    expect(rulesOf(intel({ headline: 'Double your referrals this quarter' }))).toContain('block:unsubstantiated_claim');
  });

  it('unsubstantiated_claim: allows a claim the fact source states word for word', () => {
    // "Free onboarding." and "Unlimited residents and staff" are on the fact sheet; neither is a guarantee, but the exemption is the same.
    expect(rulesOf(carebase({ primaryText: 'Unlimited residents and staff; nobody is counted per person.' }))).not.toContain('block:unsubstantiated_claim');
  });

  it('government_endorsement: blocks implied CMS, Medicare or government approval and allows public data', () => {
    expect(rulesOf(intel({ headline: 'The CMS-approved marketing platform' }))).toContain('block:government_endorsement');
    expect(rulesOf(intel({ primaryText: 'Endorsed by Medicare for hospice agencies.' }))).toContain('block:government_endorsement');
    expect(rulesOf(intel({ primaryText: 'Built in partnership with CMS.' }))).toContain('block:government_endorsement');
    expect(rulesOf(intel({ primaryText: 'Territory analysis from public healthcare and demographic data.' }))).not.toContain('block:government_endorsement');
  });

  it('offer_mismatch: only the live offer, its own terms, for its products, with no code to type and no deadline', () => {
    expect(intel({ overlay: { offerLine: '50% off your first 12 months' } }, { offerCode: 'FOUNDERS50' })).toEqual([]);
    expect(rulesOf(intel({}, { offerCode: 'SPRING20' }))).toContain('block:offer_mismatch');
    expect(rulesOf(intel({ overlay: { offerLine: '40% off your first 12 months' } }, { offerCode: 'FOUNDERS50' }))).toContain('block:offer_mismatch');
    expect(rulesOf(intel({ overlay: { offerLine: '50% off your first 6 months' } }, { offerCode: 'FOUNDERS50' }))).toContain('block:offer_mismatch');
    expect(rulesOf(intel({ primaryText: 'Use code FOUNDERS50 at checkout.' }))).toContain('block:offer_mismatch');
    expect(rulesOf(intel({ primaryText: 'Take SAVE30 for a discount.' }))).toContain('block:offer_mismatch');
    expect(rulesOf(intel({ headline: 'Founders Sale ends Friday' }))).toContain('block:offer_mismatch');
    expect(rulesOf(intel({ primaryText: 'Intel Starter is $649 per month.' }))).toContain('block:offer_mismatch');
    expect(rulesOf(intel({ primaryText: 'Intel Starter is $349 per month.' }))).not.toContain('block:offer_mismatch');
  });

  it('brand_name: CareMetric is one word and product names are exact', () => {
    expect(rulesOf(intel({ headline: 'Care Metric Intel for agencies' }))).toContain('block:brand_name');
    expect(rulesOf(intel({ headline: 'Caremetric Intel for agencies' }))).toContain('block:brand_name');
    expect(rulesOf(carebase({ headline: 'Carebase for personal care homes' }))).toContain('block:brand_name');
    expect(rulesOf(carebase({ headline: 'Care Base for personal care homes' }))).toContain('block:brand_name');
    expect(rulesOf(carebase({ headline: 'CareBase for personal care homes' }))).not.toContain('block:brand_name');
  });

  it('banned_phrase and required_disclaimer follow the brand kit', () => {
    const brandKit = { bannedPhrases: ['game changer'], requiredDisclaimers: ['Plans and prices may change.'] };
    expect(rulesOf(intel({ headline: 'A game changer for agencies' }, { brandKit }))).toEqual(expect.arrayContaining(['block:banned_phrase', 'block:required_disclaimer']));
    expect(intel({ description: 'Plans and prices may change.' }, { brandKit })).toEqual([]);
  });

  it('fact_sheet: blocks unlisted numbers, competitors, testimonials, demos and "prove" about CareBase', () => {
    expect(rulesOf(intel({ primaryText: 'Teams save 12 hours a week with CareMetric Intel.' }))).toContain('block:fact_sheet');
    expect(rulesOf(intel({ primaryText: 'Better than WellSky for referral tracking.' }))).toContain('block:fact_sheet');
    expect(rulesOf(intel({ primaryText: 'Our customers say it changed their week.' }))).toContain('block:fact_sheet');
    expect(rulesOf(intel({ cta: 'Book a demo' }))).toContain('block:fact_sheet');
    // No personal demos, calls or meetings with anyone (growth/playbook.mjs offersMeeting), but declining one passes.
    expect(rulesOf(intel({ primaryText: 'Happy to hop on a quick call to walk you through it.' }))).toContain('block:fact_sheet');
    expect(rulesOf(intel({ primaryText: 'You do not need a demo. Start a free trial.' }))).not.toContain('block:fact_sheet');
    expect(rulesOf(carebase({ primaryText: 'CareBase gives you proof for every survey.' }))).toContain('block:fact_sheet');
  });
});

describe('visual and video compliance', () => {
  const run = (over = {}) => ({ role: 'headline', color: '#111827', background: '#FFFFFF', fontSize: 40, bold: true, area: 10_000, ...over });
  // What a render reports about its colors: those it painted and those the product's brand allows.
  const brand = { colors: ['#FFFFFF', '#111827'], allowed: ['#FFFFFF', '#111827', '#2563EB'] };
  const visual = (over = {}) => checkVisual({ ...brand, ...over });

  it('brand_colors: blocks a color outside the brand, and blocks when the renderer reported none', () => {
    expect(visual()).toEqual([]);
    expect(visual({ colors: ['#ffffff', '#2563eb'] })).toEqual([]);
    const off = visual({ colors: ['#FFFFFF', '#FF00FF'] });
    expect(rulesOf(off)).toEqual(['block:brand_colors']);
    expect(off[0].message).toContain('#FF00FF');
    expect(rulesOf(checkVisual({}))).toEqual(['block:brand_colors']);
    expect(rulesOf(checkVisual({ colors: ['#FFFFFF'] }))).toEqual(['block:brand_colors']);
  });

  it('contrast: blocks text below WCAG AA and passes text above it', () => {
    expect(visual({ width: 1080, height: 1080, texts: [run()] })).toEqual([]);
    expect(rulesOf(visual({ width: 1080, height: 1080, texts: [run({ color: '#BBBBBB' })] }))).toEqual(['block:contrast']);
  });

  it('text_heavy: warns when text covers more than a fifth of the picture', () => {
    expect(rulesOf(visual({ width: 1080, height: 1080, texts: [run({ area: 300_000 })] }))).toEqual(['warn:text_heavy']);
    expect(visual({ width: 1080, height: 1080, texts: [run({ area: 100_000 })] })).toEqual([]);
  });

  it('text_heavy: a video is measured by its busiest picture, not the sum of every frame', () => {
    const frames = [run({ area: 150_000 }), run({ area: 150_000 }), run({ area: 150_000 })];
    expect(visual({ width: 1080, height: 1920, texts: frames, textArea: 150_000 })).toEqual([]);
    expect(rulesOf(visual({ width: 1080, height: 1920, texts: frames, textArea: 500_000 }))).toEqual(['warn:text_heavy']);
  });

  it('images: only the logo, the theme\'s brand imagery and attested screenshots', () => {
    expect(visual({ images: [{ kind: 'logo', attested: true }, { kind: 'brand', attested: true }, { kind: 'screenshot', attested: true }] })).toEqual([]);
    expect(rulesOf(visual({ images: [{ kind: 'screenshot', attested: false }] }))).toEqual(['block:images']);
    expect(rulesOf(visual({ images: [{ kind: 'photo' }] }))).toEqual(['block:images']);
  });

  it('brand_deviation: warns when a kit color or font had to be replaced', () => {
    expect(rulesOf(visual({ adjustments: ['textColor'], fonts: { substituted: true } }))).toEqual(['warn:brand_deviation']);
  });

  it('captions: required on every video', () => {
    expect(checkVideo({ burned: true, cues: 3 })).toEqual([]);
    expect(rulesOf(checkVideo({ burned: false, cues: 3 }))).toEqual(['block:captions']);
    expect(rulesOf(checkVideo({ burned: true, cues: 0 }))).toEqual(['block:captions']);
  });

  it('platform: the specs decide hard limits and warnings', () => {
    expect(checkPlatform({ placement: 'meta.feed_square', width: 1080, height: 1080, bytes: 1000, contentType: 'image/png', copy: {} })).toEqual([]);
    expect(rulesOf(checkPlatform({ placement: 'meta.feed_square', width: 1000, height: 1080, bytes: 1000, contentType: 'image/png', copy: {} }))).toEqual(['block:platform']);
    expect(rulesOf(checkText('google', { headline: 'x'.repeat(31) }))).toEqual(['block:platform']);
    expect(rulesOf(checkText('meta', { primaryText: 'x'.repeat(130) }))).toEqual(['warn:platform']);
  });

  it('the worst finding decides, and the badge says so', () => {
    expect(verdictOf([]).verdict).toBe('pass');
    const warned = verdictOf([{ rule: 'text_heavy', level: 'warn', message: 'w' }]);
    expect(warned.verdict).toBe('warn');
    expect(badgeText(warned)).toBe('Passed with 1 warning');
    const blocked = verdictOf([{ rule: 'text_heavy', level: 'warn', message: 'w' }, { rule: 'phi', level: 'block', message: 'b' }]);
    expect(blocked.verdict).toBe('block');
    expect(blocked.reasons[0].level).toBe('block');
    expect(badgeText(blocked)).toBe('Blocked: 1 problem');
  });
});
