import { describe, expect, it, vi } from 'vitest';
import { allowedNumbers, candidates, textProblem, weekFigures } from './rules.mjs';
import { rulesNote, strategistFeature, strategistHandlers, strategistSchema, strategyProblem } from './index.mjs';
import { schemaDefects } from '../runtime/schema.mjs';

// A week shaped like the first one with the address check on (2026-11-16), counts only.
const week = (over = {}) => ({
  prospects: { strong: 94, strongReachable: 28, strongNoContact: 66, briefed: 22, ...over.prospects },
  roster: { unresolved: 535, resolvedInWeek: 9, ...over.roster },
  addresses: { checked: 47, unanswered: 25, ...over.addresses },
  email: { firstSent: 10, followups: 12, delivered: 28, bounced: 0, complaints: 0, replies: 0, reportViews: 0, capDays: 2, waiting: 10, ...over.email },
  conversion: { trialStarts: 2, activated: 1, paid: 0, ...over.conversion },
  spend: { marketingCents: 1036, budgetCents: 1500, budgetDays: 0, ...over.spend },
  approvals: over.approvals ?? 3,
  settings: { coldEmailCap: 10, presendCheck: 'check', productDailyLimit: 50, reportViews: true, ...over.settings },
});

describe('the strategist\'s rules', () => {
  it('turns the week into whole numbers and percents', () => {
    expect(weekFigures(week())).toMatchObject({ strong: 94, strongNoContact: 66, sent: 28, bounceRate: 0, openRate: 0, cap: 10, spendDollars: 10, budgetDollars: 15 });
    expect(weekFigures(null)).toMatchObject({ strong: 0, sent: 0, bounceRate: 0 });
  });

  it('names only constraints the figures show, most binding first', () => {
    const list = candidates(week());
    expect(list.map(candidate => candidate.key)).toEqual(['reach']);
    expect(list[0]).toMatchObject({ evidence: { strong: 94, strongNoContact: 66, share: 70 }, watch: 'strongNoContact' });
    // Bounces over 2% of at least ten sends come before everything else; a complaint at once.
    expect(candidates(week({ email: { bounced: 3 } }))[0]).toMatchObject({ key: 'deliverability', evidence: { bounceRate: 10 } });
    expect(candidates(week({ email: { complaints: 1, bounced: 0 } }))[0]).toMatchObject({ key: 'deliverability', score: 100 });
    // Bounces from before the bounce guard's window, with ten clean sends since, weigh half.
    const since = candidates(week({ email: { bounced: 3 } }).guard ? null : { ...week({ email: { bounced: 3 } }), guard: { on: true, sent: 10, bounced: 0 } });
    expect(since.find(candidate => candidate.key === 'deliverability')).toMatchObject({ score: 45, evidence: { guardSent: 10, guardBounced: 0 } });
    expect(since[0].key).toBe('reach');
  });

  it('calls the cap binding only when it held most days, approved drafts waited and bounces were low, within the setting\'s 100', () => {
    const capped = candidates(week({ prospects: { strongNoContact: 10 }, email: { capDays: 6, waiting: 12, approvedWaiting: 12, delivered: 60, bounced: 0 } }));
    expect(capped[0]).toMatchObject({ key: 'volume', evidence: { capDays: 6, cap: 10, suggestedCap: 20 } });
    expect(capped[0].move).toBe('Raise "Most cold emails a day" (Settings → Customer growth) from 10 to 20.');
    expect(candidates(week({ prospects: { strongNoContact: 10 }, email: { capDays: 6, waiting: 12, approvedWaiting: 12, delivered: 60, bounced: 2 } })).map(c => c.key)).not.toContain('volume');
    // Drafts still waiting for your approval could not go out whatever the cap.
    expect(candidates(week({ prospects: { strongNoContact: 10 }, email: { capDays: 6, waiting: 12, approvedWaiting: 2, delivered: 60, bounced: 0 } })).map(c => c.key)).not.toContain('volume');
    const near = candidates(week({ prospects: { strongNoContact: 10 }, settings: { coldEmailCap: 98, productDailyLimit: 100 }, email: { capDays: 6, approvedWaiting: 12, delivered: 600, bounced: 0 } }));
    expect(near.find(c => c.key === 'volume').evidence.suggestedCap).toBe(100);
    expect(candidates(week({ prospects: { strongNoContact: 10 }, settings: { coldEmailCap: 100, productDailyLimit: 100 }, email: { capDays: 6, approvedWaiting: 12, delivered: 600, bounced: 0 } }))
      .map(c => c.key)).not.toContain('volume');
  });

  it('names the limit that was reached: Intel\'s own daily limit is checked before the shared cold-email cap', () => {
    // Both at 10 and both reached: raising only one would change nothing, so both are raised.
    const both = candidates(week({ prospects: { strongNoContact: 10 }, settings: { coldEmailCap: 10, productDailyLimit: 10 }, email: { capDays: 5, limitDays: 5, approvedWaiting: 12, delivered: 60, bounced: 0 } }));
    expect(both[0]).toMatchObject({ key: 'volume', evidence: { cap: 10, productLimit: 10, suggestedCap: 20 } });
    expect(both[0].move).toBe('Raise Intel\'s "Maximum messages per day" (Growth) from 10 to 20 and "Most cold emails a day" (Settings → Customer growth) from 10 to 20.');
    // Intel's limit lower and reached; the cap never was: only Intel's is raised.
    const product = candidates(week({ prospects: { strongNoContact: 10 }, settings: { coldEmailCap: 50, productDailyLimit: 8 }, email: { capDays: 0, limitDays: 6, approvedWaiting: 12, delivered: 60, bounced: 0 } }));
    expect(product[0]).toMatchObject({ key: 'volume', evidence: { limitDays: 6, suggestedCap: 16 } });
    expect(product[0].move).toBe('Raise Intel\'s "Maximum messages per day" (Growth) from 8 to 16.');
    expect(product[0].headline).toMatch(/^Intel's own limit of 8 emails a day was reached on 6 of 7 days/);
    // CareBase filled the shared cap while Intel stayed under its own lower limit: the cap is what was reached, and only it is raised.
    const shared = candidates(week({ prospects: { strongNoContact: 10 }, settings: { coldEmailCap: 50, productDailyLimit: 8 }, email: { capDays: 5, limitDays: 0, approvedWaiting: 12, delivered: 60, bounced: 0 } }));
    expect(shared[0].move).toBe('Raise "Most cold emails a day" (Settings → Customer growth) from 50 to 55.');
    expect(shared[0].headline).toMatch(/^The cold-email cap of 50 a day was reached on 5 of 7 days/);
  });

  it('tells addresses waiting for your permission from missing ones, and never counts unrecorded report opens as zero', () => {
    const waiting = candidates(week({ prospects: { strongNoContact: 6, strongAwaitingPermission: 60 } }));
    expect(waiting[0]).toMatchObject({ key: 'permission', evidence: { awaitingPermission: 60, share: 64 }, watch: 'awaitingPermission' });
    expect(waiting.map(c => c.key)).not.toContain('reach');
    expect(waiting[0].move).toMatch(/^Decide the addresses waiting on Growth/);
    const quiet = { prospects: { strongNoContact: 10 }, email: { delivered: 20, bounced: 0, replies: 0, reportViews: 0, firstSent: 20 } };
    const unrecorded = candidates(week({ ...quiet, settings: { reportViews: false } }), week(quiet)).find(c => c.key === 'engagement');
    expect(unrecorded).toMatchObject({ evidence: { sentTwoWeeks: 40, replies: 0 }, watch: 'replies' });
    expect(unrecorded.evidence).not.toHaveProperty('openRateTwoWeeks');
    expect(unrecorded.headline).toMatch(/report opens are not being recorded/);
  });

  it('takes the bounce rate over every cold email attempted, not only those whose delivery has been reported', () => {
    expect(weekFigures(week({ email: { sent: 100, delivered: 9, bounced: 1 } }))).toMatchObject({ sent: 100, bounceRate: 1 });
    expect(candidates(week({ email: { sent: 100, delivered: 9, bounced: 1 } })).map(c => c.key)).not.toContain('deliverability');
  });

  it('judges the message over two weeks, and interest without trials, and trials without first value', () => {
    const quiet = { prospects: { strongNoContact: 10 }, email: { delivered: 20, bounced: 0, replies: 0, reportViews: 1, firstSent: 20 } };
    expect(candidates(week(quiet)).map(c => c.key)).not.toContain('engagement');
    expect(candidates(week(quiet), week(quiet)).find(c => c.key === 'engagement')).toMatchObject({ evidence: { sentTwoWeeks: 40, reportViewsTwoWeeks: 2, openRateTwoWeeks: 5 } });
    // Opens the week before count too: a busy week then a quiet one is not a pattern.
    expect(candidates(week(quiet), week({ email: { delivered: 20, bounced: 0, replies: 0, reportViews: 20, firstSent: 20 } })).map(c => c.key)).not.toContain('engagement');
    expect(candidates(week({ prospects: { strongNoContact: 10 }, email: { replies: 2 }, conversion: { trialStarts: 0 } }))[0].key).toBe('conversion');
    expect(candidates(week({ prospects: { strongNoContact: 10 }, conversion: { trialStarts: 1, activated: 0 } }), week({ conversion: { trialStarts: 1, activated: 0 } }))
      .map(c => c.key)).toContain('activation');
  });

  it('allows only the week\'s own numbers in the text, and no links, addresses or titles', () => {
    const list = candidates(week());
    const numbers = allowedNumbers(week(), null, list);
    expect(textProblem('66 of 94 strong fits (70%) have no address; 7 days.', numbers)).toBeNull();
    expect(textProblem('Send 40 emails a day.', numbers)).toBe('unlisted_number');
    expect(textProblem('1,500 is not a figure here.', numbers)).toBe('unlisted_number');
    expect(textProblem('Write to info@example.org.', numbers)).toBe('contact_detail');
    expect(textProblem('Call Dr. Smith.', numbers)).toBe('personal_information');
  });
});

describe('the weekly strategist', () => {
  const features = new Set([strategistFeature]);
  const task = (over = {}) => ({ id: 'task', agentKey: 'chief_of_staff', kind: 'strategy.weekly', sourceKind: 'schedule', runAfter: '2026-11-16T12:35:00Z', ...over });
  const answer = { constraint: 'reach', headline: '66 of 94 strong-fit agencies have no address the team may write to.',
    why: 'Most strong fits cannot be reached, so more sending or better emails cannot help yet.', move: 'Raise "Most address checks a day".', watch: 'strongNoContact' };
  const harness = ({ output = answer, outcome = 'completed', note = null, configured = true, throws = null, on = true } = {}) => {
    const store = { strategyFacts: vi.fn(async ({ since }) => (since.toISOString() < '2026-11-08T00:00:00Z' ? week({ email: { firstSent: 3 } }) : week())),
      strategyNote: vi.fn(async when => (when === '2026-11-09' ? note : when === '2026-11-02' ? { constraint: 'volume', move: 'Raise the cap.', watch: 'firstSent', figures: { firstSent: 3 } } : null)),
      strategySave: vi.fn(async () => true) };
    const model = { configured, run: vi.fn(async (_task, request) => {
      if (throws) throw throws;
      const verdict = request.validate(output);
      return verdict === undefined ? { outcome, output, model: 'top-model' } : { outcome: 'no_result', errorCode: 'output_invalid' };
    }) };
    const run = strategistHandlers({ store, model, features, enabled: () => on })['strategy.weekly'];
    return { store, model, run };
  };
  const now = () => new Date('2026-11-16T12:35:00Z');

  it('asks for its answer in a format the model runtime accepts', () => {
    expect(schemaDefects(strategistSchema)).toEqual([]);
  });

  it('is registered only with the feature declared', () => {
    expect(strategistHandlers({ store: { strategyFacts: vi.fn() } })).toEqual({});
    expect(Object.keys(strategistHandlers({ store: { strategyFacts: vi.fn() }, features }))).toEqual(['strategy.weekly']);
  });

  it('names last week\'s constraint with the model, from the candidates and last week\'s note, and saves it for the reported week', async () => {
    const { store, model, run } = harness();
    const outcome = await run(task(), { now });
    // Two quiet weeks of 56 cold emails make the message a candidate too; the model chose among both.
    expect(outcome.result).toEqual({ week: '2026-11-09', constraint: 'reach', chosenBy: 'model', candidates: ['reach', 'engagement'] });
    const request = model.run.mock.calls[0][1];
    expect(request).toMatchObject({ tier: 'quality', effort: 'high', promptVersion: 'strategist.1' });
    const user = JSON.parse(request.user);
    expect(user.week).toEqual({ from: '2026-11-09', to: '2026-11-15' });
    expect(user.candidates.map(c => c.key)).toEqual(['reach', 'engagement']);
    expect(user.lastWeek).toMatchObject({ constraint: 'volume', watch: 'firstSent', watchedThen: 3, watchedNow: 10 });
    expect(user.weekBefore).not.toHaveProperty('strong');
    expect(user.figures).toMatchObject({ strong: 94, ready: 28 });
    expect(JSON.stringify(user)).not.toMatch(/@/);
    expect(store.strategySave).toHaveBeenCalledWith('2026-11-09', expect.objectContaining({ ...answer, chosenBy: 'model', model: 'top-model',
      candidates: [expect.objectContaining({ key: 'reach' }), expect.objectContaining({ key: 'engagement' })] }));
  });

  it('lets the model quote last week\'s watched figure as last week\'s note recorded it', async () => {
    const harnessed = harness({ output: { ...answer, why: 'Strong fits with no address went from 81 to 66; the move did not work.' } });
    harnessed.store.strategyNote.mockImplementation(async when => (when === '2026-11-02' ? { constraint: 'reach', move: 'Raise checks.', watch: 'strongNoContact', figures: { strongNoContact: 81 } } : null));
    expect((await harnessed.run(task(), { now })).result).toMatchObject({ chosenBy: 'model' });
    expect(JSON.parse(harnessed.model.run.mock.calls[0][1].user).lastWeek).toMatchObject({ watchedThen: 81, watchedNow: 66 });
  });

  it('falls back to the rules when the model is not configured, fails, or writes what the checks refuse', async () => {
    for (const setup of [{ configured: false }, { throws: Object.assign(new Error('x'), { code: 'ai_not_configured' }) },
      { output: { ...answer, move: 'Send 40 a day.' } }, { output: { ...answer, constraint: 'volume' } }]) {
      const { store, run } = harness(setup);
      const outcome = await run(task(), { now });
      expect(outcome.result).toMatchObject({ constraint: 'reach', chosenBy: 'rules' });
      expect(store.strategySave.mock.calls[0][1]).toMatchObject({ constraint: 'reach', chosenBy: 'rules', model: null, headline: expect.stringMatching(/^66 of 94/) });
    }
  });

  it('writes a scheduled week once, only while the owner has it on; Run now always writes', async () => {
    expect((await harness({ on: false }).run(task(), { now })).result).toEqual({ skipped: 'off' });
    const done = harness({ note: { constraint: 'reach' } });
    expect((await done.run(task(), { now })).result).toEqual({ skipped: 'already_written', week: '2026-11-09' });
    expect(done.store.strategySave).not.toHaveBeenCalled();
    const asked = harness({ note: { constraint: 'reach' }, on: false });
    expect((await asked.run(task({ sourceKind: 'owner' }), { now })).result).toMatchObject({ week: '2026-11-09', chosenBy: 'model' });
  });

  it('checks an answer against the week and writes a plain note when nothing stood out', () => {
    const list = candidates(week());
    const numbers = allowedNumbers(week(), null, list);
    expect(strategyProblem(answer, list, numbers)).toBeNull();
    expect(strategyProblem({ ...answer, watch: 'mood' }, list, numbers)).toBe('unknown_watch');
    expect(strategyProblem({ ...answer, why: '' }, list, numbers)).toBe('bad_why');
    expect(rulesNote([])).toMatchObject({ constraint: 'none', watch: null });
    expect(rulesNote(list)).toMatchObject({ constraint: 'reach', watch: 'strongNoContact', why: 'The rules ranked this first, and nothing else crossed a rule.' });
  });
});
