import { describe, expect, it, vi } from 'vitest';
import { gradeCase, gradeLiveEvaluation, liveEvaluationCases, liveEvaluationHandlers, liveEvaluationNote, liveTriggers, passAverage, passLowest } from './live-evaluation.mjs';
import { growthReachFeature, liveEvaluationVersion } from './reach.mjs';
import { criticPromptVersion, messageArms } from './draft.mjs';
import { reportTouchAngle, reviewTouchAngle } from './playbook.mjs';
import { growthEvaluationVersion } from './evaluation.mjs';
import { scorecardFeature, scorecardHandlers } from '../agents/scorecard/index.mjs';

// Monday 16 November 2026, 06:50 Eastern (EST): the scheduled run is due.
const monday = new Date('2026-11-16T11:50:00Z');
const policy = { enabled: true, approvedClaim: 'CareMetric Intel shows home health and hospice agencies where their referrals come from, from Medicare data.', maxTouches: 3, experiment: false, version: 4 };
const scheduled = (over = {}) => ({ id: '00000000-0000-4000-8000-0000000000aa', agentKey: 'marketing_manager', kind: 'growth.evaluate_live', sourceKind: 'schedule', attempts: 1,
  requestKey: 'schedule:00000000-0000-4000-8000-000000000001:20261116T115000Z', agent: { autonomy: 'act' }, ...over });

// A reader-and-writer model stand-in: writes a first email in the form every agency gets (its market report and one question, linking
// the case's own report, or the market report page for a case without one), and scores it as told.
const reviewPage = 'https://www.caremetricintel.com/market-review';
const email = (link, source) => ({ subject: 'A market report for your agency', body: `I put together a free market report for your agency from Medicare data.\n${link}\n\nDoes it match what your team sees in the field?`,
  citations: [source], needsHuman: false });
function stubModel({ score = 4, weakness = 'none', outcome = 'completed', failOn = null } = {}) {
  const calls = [];
  return { calls, configured: true, run: vi.fn(async (_task, request) => {
    calls.push(request.promptVersion);
    if (outcome !== 'completed') return { outcome };
    if (request.promptVersion === criticPromptVersion) return { outcome: 'completed', output: { specific: 4, relevant: 4, clearAsk: 4, wouldReply: typeof score === 'function' ? score() : score, weakness, weakestSentence: '' } };
    const input = JSON.parse(request.user);
    const report = input.links.find(link => link.url.includes('/report/'))?.url ?? input.links.find(link => link.url === reviewPage).url;
    const source = input.sources.find(item => item.id !== 'county').id;
    if (failOn && failOn(input)) return { outcome: 'completed', output: { ...email(report, source), body: `${email(report, source).body}\n\nWe guarantee more referrals.` } };
    return { outcome: 'completed', output: email(report, source) };
  }) };
}
function setup({ state = { cases: [], policy }, enabled = true, features = new Set([growthReachFeature]), model = stubModel(), clock } = {}) {
  const recorded = new Map((state.cases ?? []).map(entry => [entry.key, entry.result]));
  const store = {
    liveEvalState: vi.fn(async () => ({ ...state, cases: [...recorded].map(([key, result]) => ({ key, result })) })),
    liveEvalRecord: vi.fn(async (_run, key, result) => { if (recorded.has(key)) return false; recorded.set(key, result); return true; }),
    evaluate: vi.fn(async () => undefined),
  };
  const notifier = { send: vi.fn(async () => [{ channel: 'email', delivery: 'sent' }]) };
  const growth = { store, liveEvaluation: { enabled: () => enabled }, briefs: { qualityWriter: () => true } };
  const handlers = liveEvaluationHandlers({ growth, model, notifier, features, marketed: () => ['caremetric-intel'], ...(clock ? { clock } : {}) });
  return { store, notifier, model, handlers, recorded, run: (task = scheduled(), now = monday) => handlers['growth.evaluate_live'](task, { now: () => now }) };
}

describe('the twelve live evaluation cases', () => {
  const cases = liveEvaluationCases(monday, policy);
  it('cover each trigger three times and every pairing of a brief and the link the first email carries three times', () => {
    expect(cases).toHaveLength(12);
    expect(new Set(cases.map(item => item.key)).size).toBe(12);
    expect(new Set(cases.map(item => item.opportunity.id)).size).toBe(12);
    for (const trigger of liveTriggers) expect(cases.filter(item => item.trigger === trigger)).toHaveLength(3);
    // The agency's own report, or the market report page for an agency with no roster record. (It was the short or the standard first
    // email until every first email became the report and nothing else, 2026-11-17.)
    for (const brief of [true, false]) for (const link of ['report', 'review']) expect(cases.filter(item => item.brief === brief && item.link === link)).toHaveLength(3);
    // The database keeps a case under its key (private.growth_live_eval_record).
    for (const item of cases) expect(item.key).toMatch(/^[a-z_.]{1,60}$/);
    expect(cases.map(item => item.key)).toContain('web.brief.review');
  });
  it('give each case the trigger it asks for, the first email\'s one form, and its own report only where the case has one', () => {
    for (const item of cases) {
      const arms = messageArms(item.opportunity, item.opportunity.evidence, { reportLed: true });
      expect(arms.trigger, item.key).toBe(item.trigger);
      expect(arms.form, item.key).toBe('short');
      if (item.link === 'report') expect(item.report.url, item.key).toMatch(/^https:\/\/www\.caremetricintel\.com\/report\/[A-Za-z0-9_.-]+$/);
      else expect(item.report, item.key).toBeNull();
      expect(Boolean(item.briefPart)).toBe(item.brief);
      expect(item.opportunity.policy.approved_claim).toBe(policy.approvedClaim);
    }
  });
  it('carry no person, address or phone: invented agencies only', () => {
    const text = JSON.stringify(cases);
    expect(text).not.toMatch(/@|\(\d{3}\)|\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/);
    expect(text).not.toMatch(/\b(Dr|Mr|Mrs|Ms)\.? [A-Z]/);
    for (const item of cases) {
      expect(item.opportunity.domain).toMatch(/\.example$/);
      expect(item.opportunity.evidence.every(source => Date.parse(source.observed_at) > monday.getTime() - 30 * 86_400_000)).toBe(true);
    }
  });
});

describe('grading', () => {
  const graded = (wouldReply, over = {}) => ({ kind: 'web', brief: true, link: 'report', ok: true, wouldReply, ...over });
  it('passes at an average of at least 3.5 with none below 2, and every draft through the checks', () => {
    expect(passAverage).toBe(3.5); expect(passLowest).toBe(2);
    expect(gradeLiveEvaluation([...Array(6).fill(graded(4)), ...Array(6).fill(graded(3))])).toMatchObject({ passed: true, average: 3.5, lowest: 3, failures: [] });
    expect(gradeLiveEvaluation([...Array(7).fill(graded(3)), ...Array(5).fill(graded(4))])).toMatchObject({ passed: false, failures: ['average'] });
    expect(gradeLiveEvaluation([graded(1), ...Array(11).fill(graded(5))])).toMatchObject({ passed: false, failures: ['lowest'] });
    expect(gradeLiveEvaluation([graded(null, { ok: false, problem: 'own_standing' }), ...Array(11).fill(graded(5))])).toMatchObject({ passed: false, failures: ['checks'] });
    expect(gradeLiveEvaluation([graded(null), ...Array(11).fill(graded(5))])).toMatchObject({ passed: false, failures: ['unread'] });
    expect(gradeLiveEvaluation(Array(12).fill(graded(5)), { incomplete: true }).failures).toContain('incomplete');
    expect(gradeLiveEvaluation(Array(5).fill(graded(5))).failures).toContain('incomplete');
  });
  it('keeps codes and scores, never words', () => {
    const item = { trigger: 'new_owner', brief: false, link: 'review' };
    expect(gradeCase(item, { modelGenerated: true, body: 'secret words', arms: { critic: '4', weakness: 'too_long', form: 'short' } }))
      .toEqual({ kind: 'new_owner', brief: false, link: 'review', ok: true, wouldReply: 4, weakness: 'too_long', formWritten: 'short' });
    expect(gradeCase(item, null, ['guarantee'])).toEqual({ kind: 'new_owner', brief: false, link: 'review', ok: false, wouldReply: null, problem: 'guarantee' });
    expect(gradeCase(item, { modelGenerated: false, arms: {} })).toMatchObject({ ok: false });
  });
});

describe('growth.evaluate_live', () => {
  it('writes and reads all twelve on Monday over a few tries, records growth.live.1 (never growth.1) and stays quiet when it passes', async () => {
    const { run, store, notifier, model } = setup();
    let outcome = await run();
    for (let tries = 0; outcome.status === 'queued' && tries < 6; tries += 1) {
      expect(outcome.retryAt.getTime()).toBeGreaterThan(monday.getTime());
      outcome = await run();
    }
    expect(outcome.result).toMatchObject({ run: 'week:2026-11-16', version: 'growth.live.1', passed: true, cases: 12, passedChecks: 12, average: 4, lowest: 4 });
    expect(store.evaluate).toHaveBeenCalledTimes(1);
    const [product, version, passed, results] = store.evaluate.mock.calls[0];
    expect([product, version, passed]).toEqual(['caremetric-intel', liveEvaluationVersion, true]);
    expect(version).not.toBe(growthEvaluationVersion);
    expect(results.results).toHaveLength(12);
    expect(JSON.stringify(results)).not.toMatch(/free market report|what your team sees|report\/live-eval|market-review/);
    expect(JSON.stringify(results).length).toBeLessThan(12_000);
    expect(model.calls.filter(version => version === criticPromptVersion).length).toBeGreaterThanOrEqual(12);
    expect(criticPromptVersion).toBe('critic.4');
    // Six were written around the agency's own report and six around the market report page, each in the one first-email form.
    const written = model.run.mock.calls.filter(([, request]) => request.promptVersion !== criticPromptVersion).map(([, request]) => JSON.parse(request.user));
    expect(written.filter(input => input.touchPlan === reportTouchAngle && input.report === true)).toHaveLength(6);
    expect(written.filter(input => input.touchPlan === reviewTouchAngle && input.report === undefined)).toHaveLength(6);
    expect(results.results.map(item => item.link).sort()).toEqual([...Array(6).fill('report'), ...Array(6).fill('review')]);
    expect(results.results.every(item => item.formWritten === 'short')).toBe(true);
    expect(notifier.send).not.toHaveBeenCalled();
    // Done for the week: a later try that day does nothing.
    expect((await run()).result).toEqual({ skipped: 'already_done', run: 'week:2026-11-16' });
  });

  it('tells the owner when the week does not pass, and never holds up sending', async () => {
    const { run, notifier, store } = setup({ model: stubModel({ score: 2, weakness: 'generic_opening' }) });
    let outcome = await run();
    while (outcome.status === 'queued') outcome = await run();
    expect(outcome.result).toMatchObject({ passed: false, failures: ['average'] });
    expect(store.evaluate.mock.calls[0][1]).toBe('growth.live.1');
    expect(notifier.send).toHaveBeenCalledTimes(1);
    expect(notifier.send.mock.calls[0][0]).toMatchObject({ severity: 'warning', subject: 'The live writing evaluation did not pass', dedupeKey: 'growth:live-eval:week:2026-11-16' });
    expect(notifier.send.mock.calls[0][0].body).toMatch(/Nothing was held up/);
  });

  it('a draft that fails a check fails the week', async () => {
    const { run } = setup({ model: stubModel({ failOn: input => input.organization?.name === 'Cedar Ridge Home Care' }) });
    let outcome = await run();
    while (outcome.status === 'queued') outcome = await run();
    expect(outcome.result).toMatchObject({ passed: false, passedChecks: 9 });
    expect(outcome.result.failures).toContain('checks');
  });

  it('ends as incomplete when the day\'s budget runs out, without grading the unwritten cases as failures', async () => {
    const { run, store, recorded } = setup({ model: stubModel({ outcome: 'budget_exhausted' }) });
    const outcome = await run();
    expect(outcome.status).toBeUndefined();
    expect(outcome.result).toMatchObject({ passed: false, cases: 0 });
    expect(outcome.result.failures).toContain('incomplete');
    expect([...recorded.keys()]).toEqual(['final']);
    expect(store.evaluate.mock.calls[0][2]).toBe(false);
  });

  it('does its work on Mondays only when scheduled, on any day when the owner presses Run now', async () => {
    const tuesday = new Date('2026-11-17T11:50:00Z');
    const off = setup();
    expect((await off.run(scheduled({ requestKey: 'schedule:00000000-0000-4000-8000-000000000001:20261117T115000Z' }), tuesday)).result).toEqual({ skipped: 'not_monday' });
    expect(off.store.liveEvalState).not.toHaveBeenCalled();
    const asked = setup();
    const outcome = await asked.run(scheduled({ sourceKind: 'owner', requestKey: null }), tuesday);
    expect(outcome.result.run).toBe('run:00000000-0000-4000-8000-0000000000aa');
  });

  it('does nothing while the switch is off, in Observe, without a model or before the database declares stage 3', async () => {
    expect((await setup({ enabled: false }).run()).result).toEqual({ skipped: 'off' });
    expect((await setup().run(scheduled({ agent: { autonomy: 'observe' } }))).result).toEqual({ skipped: 'observe_only' });
    expect((await setup({ model: { configured: false } }).run()).result).toEqual({ skipped: 'model_not_configured' });
    expect(setup({ features: new Set() }).handlers).toEqual({});
    expect((await setup({ state: { cases: [], policy: { approvedClaim: '' } } }).run()).result).toMatchObject({ skipped: 'no_approved_claim' });
  });

  it('stops starting cases once its time is spent and comes back for the rest', async () => {
    let now = 0;
    const { run, recorded } = setup({ clock: () => now, model: { configured: true, run: vi.fn(async (_task, request) => {
      now += 60_000;
      return stubModel().run(_task, request);
    }) } });
    const outcome = await run();
    expect(outcome.status).toBe('queued');
    expect(recorded.size).toBeGreaterThan(0);
    expect(recorded.size).toBeLessThan(12);
  });
});

describe('the Monday scorecard line', () => {
  const summary = { cases: 12, passedChecks: 12, average: 3.75, lowest: 3, weaknesses: { generic_opening: 3, too_long: 1 }, failures: [] };
  it('says whether the week passed, the checks, the average and lowest scores and the commonest weakness', () => {
    expect(liveEvaluationNote({ passed: true, results: { summary } })).toBe('Live writing evaluation passed: 12 of 12 drafts passed the checks; the reader\'s average "would reply" was 3.8 of 5 (lowest 3). Commonest weakness: the opening could be sent to any agency.');
    expect(liveEvaluationNote({ passed: false, results: { summary: { ...summary, passedChecks: 11, average: 3.2, lowest: 2, weaknesses: {}, failures: ['checks', 'average'] } } }))
      .toBe('Live writing evaluation did not pass: 11 of 12 drafts passed the checks; the reader\'s average "would reply" was 3.2 of 5 (lowest 2).');
    expect(liveEvaluationNote({ passed: false, results: { summary: { cases: 3, passedChecks: 3, average: null, lowest: null, weaknesses: {}, failures: ['incomplete'] } } }))
      .toBe('Live writing evaluation did not finish: 3 of 3 drafts passed the checks; the reader scored none of them.');
    expect(liveEvaluationNote(null)).toBeNull();
  });

  it('is read for the last eight days and added to the scorecard\'s notes once stage 3 is declared', async () => {
    const latest = { passed: true, at: '2026-11-16T11:55:00Z', results: { summary } };
    const growth = { store: { liveEvaluationLatest: vi.fn(async () => latest) } };
    const store = { scorecardFacts: vi.fn(async () => ({ aiSpendCents: 0, products: [] })), briefFacts: vi.fn(async () => ({ approvals: null, incidents: [] })),
      accountsPage: vi.fn(async () => ({ generatedAt: monday.toISOString(), mode: 'live', total: 0, truncated: false, coupons: [], accounts: [] })),
      notificationStatus: vi.fn(async () => null), startRun: vi.fn(async () => 'run-1'), finishRun: vi.fn(async () => undefined) };
    const notifier = { send: vi.fn(async () => [{ channel: 'email', delivery: 'sent' }]) };
    const at = new Date('2026-11-16T12:50:00Z');
    for (const [features, expected] of [[new Set([scorecardFeature, growthReachFeature]), true], [new Set([scorecardFeature]), false]]) {
      notifier.send.mockClear(); growth.store.liveEvaluationLatest.mockClear();
      const handlers = scorecardHandlers({ store, notifier, features, growth, searchConsole: null, env: {}, sites: [], audit: async () => ({ findings: [] }), log: () => {} });
      await handlers['scorecard.weekly']({ id: 't1', agentKey: 'chief_of_staff', kind: 'scorecard.weekly', sourceKind: 'owner', attempts: 1 }, { now: () => at });
      const sent = notifier.send.mock.calls[0][0];
      expect(sent.blocks.some(block => String(block.text ?? '').startsWith('Live writing evaluation passed')), String([...features])).toBe(expected);
      if (expected) expect(growth.store.liveEvaluationLatest.mock.calls[0][0].toISOString()).toBe(new Date(at.getTime() - 8 * 86_400_000).toISOString());
    }
  });
});
