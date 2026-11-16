import { describe, expect, it, vi } from 'vitest';
import { reviewImage, visionFindings, visionPromptVersion, visionRequest, visionSchema } from './vision.mjs';
import { schemaDefects } from '../runtime/schema.mjs';

const asset = { product: 'caremetric-intel', platform: 'meta', placement: 'meta.feed_square', width: 1080, height: 1080, layout: 'stat', headline: 'Three agencies, most of the patients',
  primaryText: 'See where your agency stands.', cta: 'Get your free report', audience: 'Owners at home health agencies serving Erie County, PA',
  overlay: { stat: '61%', statLabel: 'of the Medicare patients of Erie County, PA home health agencies went to the 3 largest', statSource: 'CMS, 2024', checklist: [] } };
const answer = (over = {}) => ({ textSeen: '61% ...', defects: [], score: 4, reader: 'Most patients go to three agencies; I want to know where we stand.', fix: 'Name the report sooner.', ...over });

describe('the vision review', () => {
  it('asks in a schema the runtime accepts, and tells the model only the ad\'s own words', () => {
    expect(schemaDefects(visionSchema)).toEqual([]);
    const sent = JSON.parse(visionRequest(asset));
    expect(sent.meantToShow).toMatchObject({ headline: asset.headline, stat: '61%', statLabel: asset.overlay.statLabel, statSource: 'CMS, 2024', checklist: null });
    expect(sent).toMatchObject({ product: 'CareMetric Intel', size: '1080 x 1080', audience: asset.audience, postText: asset.primaryText });
  });

  it('blocks a defect a reader would see, warns on a softer one or a weak score, and keeps the answer', () => {
    const clean = visionFindings(answer());
    expect(clean.findings).toEqual([]);
    expect(clean.review).toMatchObject({ version: visionPromptVersion, score: 4, defects: [] });
    const cut = visionFindings(answer({ defects: [{ kind: 'text_cut_off', where: 'the stat label, last line' }, { kind: 'crowded', where: 'lower half' }] }));
    expect(cut.findings.map(item => [item.rule, item.level])).toEqual([['vision_defect', 'block'], ['vision_note', 'warn']]);
    expect(cut.findings[0].message).toMatch(/text is cut off \(the stat label, last line\)/);
    const weak = visionFindings(answer({ score: 2, fix: 'Lead with the number.' }), { minScore: 3 });
    expect(weak.findings).toEqual([{ rule: 'vision_weak', level: 'warn', message: 'The image review scored it 2 of 5 as its audience would. Lead with the number.' }]);
    expect(visionFindings(answer({ score: 3 }), { minScore: 3 }).findings).toEqual([]);
  });

  it('shows the model the rendered PNG before the words, on the draft tier, and says when it could not look', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const run = vi.fn(async () => ({ outcome: 'completed', output: answer() }));
    const reviewed = await reviewImage({ run, asset, png });
    const request = run.mock.calls[0][0];
    expect(request).toMatchObject({ promptVersion: visionPromptVersion, tier: 'draft', images: [{ mediaType: 'image/png', data: png.toString('base64') }] });
    expect(request.validate({ ...answer(), defects: [{ kind: 'invented', where: 'x' }] })).toBe('review_shape');
    expect(request.validate(answer())).toBeUndefined();
    expect(reviewed.review.score).toBe(4);
    for (const result of [{ outcome: 'budget_exhausted' }, { outcome: 'unavailable', code: 'ai_unavailable' }, { outcome: 'refused' }]) {
      const missed = await reviewImage({ run: async () => result, asset, png });
      expect(missed.findings.map(item => [item.rule, item.level])).toEqual([['vision_unreviewed', 'warn']]);
      expect(missed.review.skipped).toBe(result.code ?? result.outcome);
    }
    const huge = await reviewImage({ run, asset, png: Buffer.alloc(6 * 1024 * 1024) });
    expect(huge.review.skipped).toBe('image_too_large');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
