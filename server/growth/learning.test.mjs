import { describe, expect, it, vi } from 'vitest';
import { composeMemo, failedChecks, growthLearningFeature, learningHandlers, minimumReported, minimumSends, ownerNote, weaknessNotes } from './learning.mjs';

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
    // Handed over (the owner's "Learning memo" step): the database uses the memo at once and says so.
    const used = store({ learningPropose: vi.fn(async () => ({ proposed: true, version: 3, activated: true })) });
    expect((await handler({ store: used })({ sourceKind: 'schedule' }, { now: monday })).result)
      .toEqual({ products: { 'caremetric-intel': { proposed: true, version: 3, activated: true, lines: 1, sent: 0 } } });
    const quiet = store({ learningFacts: vi.fn(async () => facts({ sent: 12 })) });
    expect((await handler({ store: quiet })({ sourceKind: 'schedule' }, { now: monday })).result)
      .toEqual({ products: { 'caremetric-intel': { proposed: false, reason: 'too_little', sent: 12 } } });
    expect(quiet.learningPropose).not.toHaveBeenCalled();
  });
});

it('never compares report length with concise/control while preserving other experiments', () => {
 const result=composeMemo('caremetric-intel',facts({arms:[arm('length','report',100,80),arm('length','control',40,5),
  arm('length','concise',40,1),arm('subject','question',40,6),arm('subject','plain',40,0)]}));
 expect(result.text).not.toContain('80 of 100');
 expect(result.text).toContain('under 120 words');
 expect(result.text).toContain('subjects phrased as a question');
});

describe('report opens and the reader\'s weaknesses (2026-11-17)', () => {
  const linked = (name, value, sent, replied, reported, opened) => ({ ...arm(name, value, sent, replied), reported, opened });

  it('compares an arm on report opens only when replies cannot tell, and only above the thresholds', () => {
    const memo = composeMemo('caremetric-intel', facts({ arms: [linked('subject', 'question', 30, 1, 20, 8), linked('subject', 'plain', 30, 0, 18, 2)] }));
    expect(memo.lines).toHaveLength(1);
    expect(memo.text).toContain('Replies are still too few to compare, so this compares report opens.');
    expect(memo.text).toContain('the agency opened it after 8 of 20 subjects phrased as a question (40%) and after 2 of 18 plain subjects (11%)');
    // Too few emails linked the report on one side.
    expect(composeMemo('caremetric-intel', facts({ arms: [linked('subject', 'question', 30, 0, 20, 8), linked('subject', 'plain', 30, 0, minimumReported - 1, 0)] })).text).toBeNull();
    // The best has fewer than three opens.
    expect(composeMemo('caremetric-intel', facts({ arms: [linked('subject', 'question', 30, 0, 20, 2), linked('subject', 'plain', 30, 0, 20, 0)] })).text).toBeNull();
    // A lead under ten points.
    expect(composeMemo('caremetric-intel', facts({ arms: [linked('subject', 'question', 30, 0, 20, 5), linked('subject', 'plain', 30, 0, 20, 4)] })).text).toBeNull();
    // An opens comparison needs no minimum of sends, only of linked reports.
    expect(composeMemo('caremetric-intel', facts({ arms: [linked('subject', 'question', 16, 0, 16, 6), linked('subject', 'plain', 15, 0, 15, 1)] })).text)
      .toContain('after 6 of 16 subjects phrased as a question (38%) and after 1 of 15 plain subjects (7%)');
    // The first email's form is not compared, on opens or on replies: every first email built around a market report is the report and
    // nothing else since 2026-11-17, so "short" against "standard" would set emails written under different instructions side by side.
    expect(composeMemo('caremetric-intel', facts({ arms: [linked('form', 'short', 16, 0, 16, 6), linked('form', 'standard', 15, 0, 15, 1)] })).text).toBeNull();
    const reasons = composeMemo('caremetric-intel', facts({ arms: [linked('reason', 'trigger', 20, 0, 16, 6), linked('reason', 'none', 20, 0, 15, 1)] }));
    expect(reasons.text).toContain('first emails that named something that just happened at the agency');
    expect(reasons.text).toContain('first emails with no dated reason');
    expect(reasons.text).toContain('report opens');
  });

  it('never lets opens override a reply comparison, nor compares the send order or an earlier open on opens', () => {
    const replies = composeMemo('caremetric-intel', facts({ arms: [linked('subject', 'question', 40, 6, 30, 1), linked('subject', 'plain', 38, 1, 30, 20)] }));
    expect(replies.lines).toHaveLength(1);
    expect(replies.text).toContain('subjects phrased as a question drew replies to 6 of 40 emails');
    expect(replies.text).not.toContain('report opens');
    expect(composeMemo('caremetric-intel', facts({ arms: [linked('band', '1', 20, 0, 20, 15), linked('band', '4', 20, 0, 20, 1),
      linked('viewed', 'yes', 20, 0, 20, 15), linked('viewed', 'no', 20, 0, 20, 1)] })).text).toBeNull();
    // An arm value the memo has no name for is never compared, and counts that cannot be true are ignored.
    expect(composeMemo('caremetric-intel', facts({ arms: [linked('subject', 'question', 30, 0, 20, 25), linked('subject', 'plain', 30, 0, 20, 0),
      linked('subject', 'odd', 30, 0, 20, 0)] })).text).toBeNull();
  });

  it('names the send bands when replies compare them, and no longer compares the first email\'s form', () => {
    const memo = composeMemo('caremetric-intel', facts({ arms: [arm('band', '2', 25, 4), arm('band', '4', 40, 1), arm('form', 'short', 30, 5), arm('form', 'standard', 30, 1)] }));
    expect(memo.lines).toHaveLength(1);
    expect(memo.text).toContain('first emails with a brief and a checked named person drew replies to 4 of 25 emails (16%); other emails drew 1 of 40 (3%)');
    expect(memo.text).not.toMatch(/short first emails|standard first emails/);
    expect(composeMemo('caremetric-intel', facts({ arms: [arm('form', 'short', 30, 5), arm('form', 'standard', 30, 1)] })).text).toBeNull();
  });

  it('names the reader\'s commonest weakness after three drafts, with what to do about it', () => {
    expect(composeMemo('caremetric-intel', facts({ weaknesses: { too_long: 2, about_sender: 2 } })).text).toBeNull();
    const memo = composeMemo('caremetric-intel', facts({ weaknesses: { too_long: 3, generic_opening: 3, about_sender: 1, invented_code: 9, none: 12 } }));
    expect(memo.lines).toEqual(['The reader\'s commonest finding in 3 recent first emails: the opening could go to any agency. Open with something true of this agency alone: its setting, its county or a dated event from the sources.']);
    expect(memo.stats.weaknesses).toEqual({ too_long: 3, generic_opening: 3, about_sender: 1 });
    expect(composeMemo('caremetric-intel', facts({ weaknesses: { unclear_ask: 4, too_long: 3 } })).text).toContain('what it asks for is unclear. End with one plain question');
    for (const [code, note] of Object.entries(weaknessNotes)) {
      expect(code).toMatch(/^[a-z_]{1,30}$/);
      expect(`${note.finding} ${note.remedy}`).not.toMatch(/\b(demo|call|meeting|share|rank|rating)s?\b/i);
    }
  });

  it('writes the same text from the same counts, and keeps the opens in its stats', () => {
    const counts = facts({ reported: 40, opened: 9, weaknesses: { no_reason_now: 5 },
      arms: [linked('angle_by', 'brief', 22, 1, 20, 7), linked('angle_by', 'hash', 21, 0, 20, 1)] });
    const first = composeMemo('caremetric-intel', counts);
    expect(first.text).toBe(composeMemo('caremetric-intel', structuredClone(counts)).text);
    expect(first.lines).toHaveLength(2);
    expect(first.stats).toMatchObject({ reported: 40, opened: 9, weaknesses: { no_reason_now: 5 } });
    expect(first.text.length).toBeLessThanOrEqual(2000);
  });
});
