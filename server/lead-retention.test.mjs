import { describe, expect, it } from 'vitest';
import { leadRetention, leadRetentionBatchSize, leadRetentionIntervalMs, leadRetentionMaxBatches, sqlLeadRetentionStore } from './lead-retention.mjs';

const minute = 60 * 1000;
const hour = 60 * minute;
const fixedWarning = 'Lead retention could not complete; it will retry.';

/** A store that answers each batch from `answers` in turn (an Error is thrown) and repeats the last one. */
function fakeStore(answers) {
  const limits = [];
  return {
    limits,
    batch: async limit => {
      limits.push(limit);
      const answer = answers[Math.min(limits.length - 1, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

function harness(answers, { enabled = true } = {}) {
  let time = Date.parse('2027-11-03T12:00:00.000Z');
  const store = fakeStore(answers);
  const lines = [];
  const warnings = [];
  const job = leadRetention({ pool: null, store, enabled, now: () => time, log: line => lines.push(line), warn: line => warnings.push(line) });
  return { job, store, lines, warnings, advance: ms => { time += ms; } };
}

describe('lead retention', () => {
  it('keeps the documented schedule and batch bounds', () => {
    expect([leadRetentionIntervalMs, leadRetentionBatchSize, leadRetentionMaxBatches]).toEqual([6 * hour, 500, 10]);
  });

  it('runs only when the database declares the lead desk', async () => {
    const { job, store, lines, warnings } = harness([{ leads: 1, conversations: 1, more: false }], { enabled: false });
    expect(job.enabled()).toBe(false);
    expect(await job.tick()).toBeNull();
    expect(store.limits).toEqual([]);
    expect([lines, warnings]).toEqual([[], []]);
  });

  it('runs at the first cleanup, then at most once every six hours', async () => {
    const { job, store, advance } = harness([{ leads: 0, conversations: 0, more: false }]);
    expect(await job.tick()).toEqual({ leads: 0, conversations: 0, more: false, batches: 1 });
    for (const step of [15 * minute, 5 * hour, 45 * minute - 1]) {
      advance(step);
      expect(await job.tick()).toBeNull();
    }
    expect(store.limits).toEqual([500]);
    advance(1);
    expect(await job.tick()).toEqual({ leads: 0, conversations: 0, more: false, batches: 1 });
    expect(store.limits).toEqual([500, 500]);
  });

  it('asks for batches of 500 while more are due and adds up the counts', async () => {
    const { job, store, lines } = harness([{ leads: 500, conversations: 20, more: true }, { leads: 120, conversations: 1, more: false }]);
    expect(await job.tick()).toEqual({ leads: 620, conversations: 21, more: false, batches: 2 });
    expect(store.limits).toEqual([500, 500]);
    expect(lines).toEqual(['Lead retention: deleted 620 leads and 21 website conversations.']);
  });

  it('stops after ten batches and leaves the rest for the next run', async () => {
    const { job, store, lines, advance } = harness([{ leads: 500, conversations: 500, more: true }]);
    expect(await job.tick()).toEqual({ leads: 5000, conversations: 5000, more: true, batches: 10 });
    expect(store.limits).toHaveLength(10);
    expect(lines).toEqual(['Lead retention: deleted 5000 leads and 5000 website conversations; more are due at the next run.']);
    advance(15 * minute);
    expect(await job.tick()).toBeNull();
    expect(store.limits).toHaveLength(10);
  });

  it('logs the counts only, and nothing when nothing was deleted', async () => {
    const quiet = harness([{ leads: 0, conversations: 0, more: false }]);
    await quiet.job.tick();
    expect([quiet.lines, quiet.warnings]).toEqual([[], []]);
    const single = harness([{ leads: 1, conversations: 1, more: false }]);
    await single.job.tick();
    expect(single.lines).toEqual(['Lead retention: deleted 1 lead and 1 website conversation.']);
  });

  it('logs a failure as one fixed line, never the error, and tries again at the next cleanup', async () => {
    const canary = 'jordan.rivera@sunrise.example';
    const { job, store, lines, warnings, advance } = harness([
      { leads: 500, conversations: 0, more: true },
      new Error(`connection lost near ${canary}`),
      { leads: 3, conversations: 2, more: false },
    ]);
    expect(await job.tick()).toBeNull();
    expect(warnings).toEqual([fixedWarning]);
    expect(lines).toEqual([]);
    advance(15 * minute);
    expect(await job.tick()).toEqual({ leads: 3, conversations: 2, more: false, batches: 1 });
    expect(store.limits).toHaveLength(3);
    expect(lines).toEqual(['Lead retention: deleted 3 leads and 2 website conversations.']);
    for (const line of [...lines, ...warnings]) expect(line).not.toContain(canary);
    advance(15 * minute);
    expect(await job.tick()).toBeNull();
    expect(store.limits).toHaveLength(3);
  });

  it('treats an answer of the wrong shape as a failure', async () => {
    for (const answer of [null, {}, { leads: '2', conversations: 0, more: false }, { leads: 1, conversations: -1, more: false },
      { leads: 1.5, conversations: 0, more: false }, { leads: 1, conversations: 0, more: 'no' }]) {
      const { job, lines, warnings } = harness([answer]);
      expect(await job.tick()).toBeNull();
      expect([lines, warnings]).toEqual([[], [fixedWarning]]);
    }
  });

  it('never runs twice at once', async () => {
    let release;
    const store = { calls: 0, batch: () => { store.calls += 1; return new Promise(resolve => { release = resolve; }); } };
    const job = leadRetention({ pool: null, store, enabled: true, log: () => {}, warn: () => {} });
    const first = job.tick();
    expect(await job.tick()).toBeNull();
    release({ leads: 0, conversations: 0, more: false });
    expect(await first).toEqual({ leads: 0, conversations: 0, more: false, batches: 1 });
    expect(store.calls).toBe(1);
  });

  it('runs each batch through private.lead_retention in its own transaction', async () => {
    const queries = [];
    const client = {
      query: async (text, params) => {
        queries.push(params ? [text, params] : text);
        return { rows: [{ result: { leads: 1, conversations: 0, more: false } }] };
      },
      release: () => queries.push('release'),
    };
    const store = sqlLeadRetentionStore({ connect: async () => client });
    expect(await store.batch(500)).toEqual({ leads: 1, conversations: 0, more: false });
    expect(queries).toEqual(['begin', "set local statement_timeout='12s'", ['select private.lead_retention($1) as result', [500]], 'commit', 'release']);
  });
});
