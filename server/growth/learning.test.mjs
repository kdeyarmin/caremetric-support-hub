import { describe, expect, it, vi } from 'vitest';
import { composeMemo, failedChecks, growthLearningFeature, learningHandlers, minimumSends, ownerNote } from './learning.mjs';

const arm = (arm, value, sent, replied) => ({ arm, value, sent, replied, positive: 0, negative: 0, notNow: 0, bounced: 0 });
const facts = (extra = {}) => ({ product: 'caremetric-intel', days: 90, sent: 0, replied: 0, positive: 0, bounced: 0, arms: [], memos: [], objections: {},
  ownerNotes: [], draftChecks: {}, rejectedDrafts: 0, ...extra });

describe('the learning memo', () => {
  it('says nothing until there is something worth saying', () => {
    expect(composeMemo('caremetric-intel', facts()).text).toBeNull();
    // Below the minimum sends per arm, a large difference is still not a finding.
    expect(composeMemo('caremetric-intel', facts({ arms: [arm('subject', 'question', minimumSends - 1, 9), arm('subject', 'plain', 40, 0)] })).text).toBeNull();
    // Enough sends, but no clear lead.
    expect(composeMemo('caremetric-intel', facts({ arms: [arm('subject', 'question', 40, 2), arm('subject', 'plain', 40, 2)] })).text).toBeNull();
  });

  it('compares arms with enough sends, names the playbook objections and the checks drafts fail, and keeps the owner\'s notes', () => {
    const memo = composeMemo('caremetric-intel', facts({
      arms: [arm('subject', 'question', 40, 6), arm('subject', 'plain', 38, 1), arm('trigger', 'web', 50, 5), arm('angle', 'territory', 5, 3)],
      objections: { current_system: 4, price: 2, none: 9 },
      draftChecks: { claim: 3, claim_then_link: 2, tagged_link: 1, citation: 1 },
      ownerNotes: ['Too long.', 'Call me at 215-555-0199', 'Too long.'],
    }));
    expect(memo.lines).toHaveLength(4);
    expect(memo.text).toContain('subjects phrased as a question drew replies to 6 of 40 emails (15%); plain subjects drew 1 of 38 (3%)');
    expect(memo.text).not.toContain('leading with territory');
    expect(memo.text).toContain('4 replies raised this: They already use a CRM');
    expect(memo.text).not.toContain('Cost or budget');
    expect(memo.text).toContain('5 recent drafts were thrown away by the same check. State only facts');
    expect(memo.text).toContain('"Too long."');
    expect(memo.text).not.toContain('215');
    expect(memo.text.startsWith('What the last 90 days')).toBe(true);
    expect(memo.text.length).toBeLessThanOrEqual(2000);
    expect(composeMemo('caremetric-intel', facts({ ownerNotes: ['Too long.'] })).text).toBe(composeMemo('caremetric-intel', facts({ ownerNotes: ['Too long.'] })).text);
  });

  it('folds repaired and rechecked failures into the check that failed first', () => {
    expect(failedChecks({ claim_then_link: 2, tagged_claim: 1, link: 4, odd: 'x' })).toEqual({ claim: 3, link: 4 });
    expect(ownerNote('  Too\nlong  ')).toBe('Too long');
    expect(ownerNote('')).toBeNull();
    expect(ownerNote('Write to jane@agency.example.org')).toBeNull();
    expect(ownerNote('Call (215) 555-0199 first')).toBeNull();
  });
});

describe('the weekly memo task', () => {
  const store = (extra = {}) => ({ learningFacts: vi.fn(async () => facts({ ownerNotes: ['Shorter, please.'] })), learningPropose: vi.fn(async () => ({ proposed: true, version: 2 })), ...extra });
  const handler = (growth, options = {}) => learningHandlers({ growth, features: new Set([growthLearningFeature]), enabled: true, marketed: () => ['caremetric-intel'], ...options })['growth.learn'];
  const monday = () => new Date('2026-11-16T14:00:00Z'), tuesday = () => new Date('2026-11-17T14:00:00Z');

  it('is absent without its migration, and does nothing while off, observing, or on a scheduled day other than Monday', async () => {
    expect(learningHandlers({ growth: { store: store() }, features: new Set() })).toEqual({});
    const s = store();
    expect((await handler({ store: s }, { enabled: false })({ sourceKind: 'schedule' }, { now: monday })).result).toEqual({ skipped: 'off' });
    expect((await handler({ store: s })({ sourceKind: 'schedule', agent: { autonomy: 'observe' } }, { now: monday })).result).toEqual({ skipped: 'observe_only' });
    expect((await handler({ store: s })({ sourceKind: 'schedule' }, { now: tuesday })).result).toEqual({ skipped: 'not_monday' });
    expect(s.learningFacts).not.toHaveBeenCalled();
  });

  it('proposes a memo for each marketed product on Monday, or when the owner runs it', async () => {
    const s = store();
    const { result } = await handler({ store: s })({ sourceKind: 'owner' }, { now: tuesday });
    expect(s.learningFacts).toHaveBeenCalledWith('caremetric-intel', 90);
    expect(s.learningFacts).toHaveBeenCalledTimes(1);
    expect(s.learningPropose.mock.calls[0][0]).toBe('caremetric-intel');
    expect(s.learningPropose.mock.calls[0][1]).toContain('Shorter, please.');
    expect(result).toEqual({ products: { 'caremetric-intel': { proposed: true, version: 2, lines: 1, sent: 0 } } });
    const quiet = store({ learningFacts: vi.fn(async () => facts({ sent: 12 })) });
    expect((await handler({ store: quiet })({ sourceKind: 'schedule' }, { now: monday })).result)
      .toEqual({ products: { 'caremetric-intel': { proposed: false, reason: 'too_little', sent: 12 } } });
    expect(quiet.learningPropose).not.toHaveBeenCalled();
  });
});
