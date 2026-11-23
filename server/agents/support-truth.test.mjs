// Stage 5 of the team review of 2026-11-17 (20261117240000_support_truth.sql), unit by unit: the guides a conversation with no product
// reads, the acknowledgment's executor and the thread subject, the watchdog by cadence, the brief's Needs you, the scorecard's cost per
// trial and pilot line, and the strategist's new candidates.
import { describe, expect, it, vi } from 'vitest';
import { guideLibrary } from './concierge/knowledge.mjs';
import { acknowledgeExecutor, answerExecutor } from './concierge/answers.mjs';
import { replySubject, subjectFor } from './concierge/executor.mjs';
import { conciergeExecutors } from './concierge/index.mjs';
import { watchdogFindings } from './tasks/watchdog.mjs';
import { composeBrief } from './tasks/brief.mjs';
import { composeScorecard } from './scorecard/compose.mjs';
import { candidates, constraintLabels, watchLabels } from './strategist/rules.mjs';

const uuid = n => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

describe('the guides a conversation reads', () => {
  const library = () => guideLibrary({ load: async () => [
    { kind: 'article', id: 'a1', title: 'Build a lead list in Intel', summary: 'Lists of physicians', body_markdown: 'Open Setup and build a lead list.', product_slugs: ['caremetric-intel'] },
    { kind: 'article', id: 'a2', title: 'Assign training in CareBase', summary: 'Training', body_markdown: 'Assign training to each role.', product_slugs: ['carebase'] },
  ] });
  it('reads every product\'s guides for a conversation with no product, only with the feature', async () => {
    expect(await library().top('How do I build a lead list?')).toEqual([]);
    expect((await library().top('How do I build a lead list?', { anyProduct: true })).map(guide => guide.title)).toEqual(['Build a lead list in Intel']);
    // A conversation of one product still reads only its own.
    expect(await library().top('How do I build a lead list?', { productSlug: 'carebase', anyProduct: true })).toEqual([]);
  });
});

describe('the session-less acknowledgment', () => {
  const execution = (over = {}) => ({ id: uuid(1), agentKey: 'support_concierge', taskId: 't', execution: 1,
    input: { communicationId: uuid(2), basedOnMessageId: uuid(3), reference: 9, body: 'Hello,\n\nThank you.' }, ...over });

  it('sends through the inbox\'s acknowledgment path and reports a refusal by its code', async () => {
    const communications = { acknowledge: vi.fn(async () => ({ delivery: 'sent', deliveryChannel: 'email' })) };
    expect(await acknowledgeExecutor({ communications, notifier: { send: vi.fn() } })(execution()))
      .toEqual({ delivery: 'sent', channel: 'email', replay: false, author: 'ai_assistant' });
    expect(communications.acknowledge).toHaveBeenCalledWith({ actionId: uuid(1), execution: 1, subject: replySubject });
    for (const code of ['acknowledge_off', 'not_a_person', 'thread_changed']) {
      const refusing = { acknowledge: async () => ({ refused: code }) };
      await expect(acknowledgeExecutor({ communications: refusing, notifier: { send: vi.fn() } })(execution())).rejects.toMatchObject({ code });
    }
  });

  it('is registered only with the feature and the inbox\'s path', () => {
    const base = ['platform.agents.concierge.v1', 'platform.agents.concierge-autosend.v1'];
    const communications = { reply: vi.fn(), answer: vi.fn(), acknowledge: vi.fn() };
    expect(Object.keys(conciergeExecutors({ communications, store: {}, notifier: {}, features: new Set(base) }))).not.toContain('communication.acknowledge');
    expect(Object.keys(conciergeExecutors({ communications, store: {}, notifier: {}, features: new Set([...base, 'platform.agents.support-truth.v1']) })))
      .toContain('communication.acknowledge');
  });
});

describe('the subject an answer goes out under', () => {
  const store = subject => ({ communicationSnapshot: vi.fn(async () => ({ channel: 'email', subject })) });
  const sales = { agentKey: 'sales_executive', input: { communicationId: uuid(2) } };

  it('keeps a Sales Executive answer in its thread when the subject is clean, and the support subject otherwise', async () => {
    expect(await subjectFor(sales, { store: store('Re: Your county\'s referral sources'), threadSubjects: true })).toBeNull();
    expect(await subjectFor(sales, { store: store('Re: DOB 01/01/1900 for Pat Example'), threadSubjects: true })).toBe(replySubject);
    expect(await subjectFor(sales, { store: store(''), threadSubjects: true })).toBe(replySubject);
    expect(await subjectFor({ ...sales, agentKey: 'support_concierge' }, { store: store('Re: A question'), threadSubjects: true })).toBe(replySubject);
    expect(await subjectFor(sales, { store: store('Re: A question'), threadSubjects: false })).toBe(replySubject);
  });

  it('is what the answer executor asks the inbox for', async () => {
    const communications = { answer: vi.fn(async () => ({ delivery: 'sent' })) };
    await answerExecutor({ communications, notifier: { send: vi.fn() }, store: store('Re: Your county'), threadSubjects: true })({ ...sales, id: uuid(1), execution: 1,
      input: { communicationId: uuid(2), basedOnMessageId: uuid(3), reference: 9, body: 'Hello' } });
    expect(communications.answer).toHaveBeenCalledWith({ actionId: uuid(1), execution: 1, subject: null });
  });
});

describe('the watchdog by cadence', () => {
  const now = new Date('2026-11-17T12:00:00Z');
  const ago = days => new Date(now.getTime() - days * 86_400_000).toISOString();
  const agent = over => ({ key: 'seo_analyst', name: 'SEO Analyst', status: 'active', scheduled: true, lastRunAt: ago(10), failed7d: 0, ...over });

  it('counts a finished task as alive, waits 8 days for a weekly schedule, and keeps the old rule without the new facts', () => {
    expect(watchdogFindings({ agents: [agent({ lastTaskAt: ago(0.5), shortestSeconds: 86400 })] }, { now })).toEqual([]);
    expect(watchdogFindings({ agents: [agent({ lastTaskAt: ago(5), shortestSeconds: 7 * 86400 })] }, { now })).toEqual([]);
    expect(watchdogFindings({ agents: [agent({ lastTaskAt: ago(9), shortestSeconds: 7 * 86400 })] }, { now }).map(item => item.key)).toEqual(['idle:seo_analyst']);
    expect(watchdogFindings({ agents: [agent()] }, { now }).map(item => item.key)).toEqual(['idle:seo_analyst']);
  });

  it('names an agent whose every task in 14 days skipped, with the reason that is not the calendar', () => {
    const content = agent({ key: 'content_marketer', name: 'Content Marketer', lastTaskAt: ago(0.2), shortestSeconds: 86400, tasks14d: 14, worked14d: 0,
      skipped14d: { not_a_writing_day: 10, no_topic: 4 } });
    const [finding] = watchdogFindings({ agents: [content] }, { now });
    expect(finding).toEqual({ key: 'skipping:content_marketer',
      text: 'Content Marketer did nothing for 14 days: every task skipped, most often because it has no topic left to write about (add topics, or it stays idle).' });
    expect(watchdogFindings({ agents: [{ ...content, worked14d: 1 }] }, { now })).toEqual([]);
    expect(watchdogFindings({ agents: [{ ...content, skipped14d: { not_a_writing_day: 14 } }] }, { now })).toEqual([]);
  });

  it('marks what the owner can fix today', () => {
    const findings = watchdogFindings({ agents: [], losses: { launchFailed: { platform: 'linkedin', code: 'linkedin_permission', at: ago(1) }, bounce: { guard: { tripped: true } } } }, { now });
    expect(findings.filter(item => item.needsYou).map(item => item.key).sort()).toEqual(['lost:bounce', 'lost:launch:linkedin']);
  });
});

describe('the morning brief\'s Needs you', () => {
  const facts = { generatedAt: '2026-11-17T12:00:00Z', approvals: { count: 0 }, incidents: [], billing: {}, yesterday: {}, customerGrowth: { missingContact: 466 }, agents: [] };
  const watchdog = [{ key: 'lost:launch:linkedin', text: 'LinkedIn refused a new ad campaign.', needsYou: true }, { key: 'idle:x', text: 'X has not run for 4 days.' }];

  it('drops the opportunities with no contact, and lists what the team lost that the owner can fix', () => {
    const before = composeBrief(facts, { now: new Date('2026-11-17T12:00:00Z'), watchdog });
    expect(before.body).toContain('Opportunities missing a contact');
    const after = composeBrief(facts, { now: new Date('2026-11-17T12:00:00Z'), watchdog, truth: true });
    expect(after.body).not.toContain('Opportunities missing a contact');
    expect(after.needsYou).toBe(1);
    expect(after.body).toContain('- Lost work: LinkedIn refused a new ad campaign.');
    expect(after.body).toContain('Watchdog: X has not run for 4 days.');
    expect(after.body).not.toContain('Watchdog: LinkedIn');
    expect(composeBrief({ ...facts, customerGrowth: {} }, { watchdog: [], truth: true }).subject).toMatch(/nothing needs you$/);
  });
});

describe('the scorecard\'s cost per trial and pilot line', () => {
  const facts = {
    current: { since: '2026-11-09T05:00:00Z', lifecycleStartedAt: '2026-11-01T00:00:00Z', aiSpendCents: 10_000, marketingSpendCents: 4_000,
      products: [{ product: 'caremetric-intel', verifiedTrialStarts: 2 }, { product: 'carebase', verifiedTrialStarts: 0 }] },
    previous: { since: '2026-11-02T05:00:00Z', lifecycleStartedAt: '2026-11-01T00:00:00Z', aiSpendCents: 0, marketingSpendCents: 0, products: [] },
  };
  const card = options => composeScorecard({ week: '2026-11-09', facts, verifiedLifecycle: true, ads: { spendCents: 1_000, previousSpendCents: 0, failing: 0 }, ...options });
  const text = result => JSON.stringify(result.blocks);

  it('divides the Marketing Manager\'s spend and the ads by verified trials, and shows CareBase on one line', () => {
    expect(text(card({}))).toContain('$55.00 ($110.00 over 2 trials)');
    const truth = card({ marketingCost: true, pilots: ['carebase'] });
    expect(text(truth)).toContain('$25.00 ($50.00 over 2 trials)');
    expect(text(truth)).toContain('Marketing Manager AI $40.00 and ads $10.00');
    expect(text(truth)).toContain('CareBase (pilot, not marketed)');
    expect(truth.blocks.filter(block => block.type === 'paragraph' && block.text === 'CareBase')).toEqual([]);
  });
});

describe('the strategist\'s new candidates', () => {
  const week = conversion => ({ conversion, email: {}, prospects: {}, spend: {}, settings: {} });

  it('names trials lost unpaid, never an Intel trial without a card (none is needed to start it since 2026-11-23), and never suggests a call', () => {
    const list = candidates(week({ noCard: 2, trialsLost: 1 }), week({ noCard: 1 }));
    expect(list.find(item => item.key === 'conversion')).toBeUndefined();
    expect(list.find(item => item.key === 'paying')).toMatchObject({ evidence: { trialsLostTwoWeeks: 1 }, watch: 'paid' });
    expect(constraintLabels.paying).toBe('Trials are ending unpaid');
    expect(watchLabels.paid).toBe('new paying customers');
    const activation = candidates(week({ trialStarts: 2 }), week({ trialStarts: 1 })).find(item => item.key === 'activation');
    expect(activation.move).not.toMatch(/\bcall\b/i);
    expect(candidates(week({}), null).map(item => item.key)).not.toContain('paying');
  });
});
