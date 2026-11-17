// The Monday live writing evaluation through the real roles (20261117210000_growth_reach.sql, server/growth/live-evaluation.mjs): only the
// Hub server reads and records it; twelve made-up cases are written and read over several tries of one task, each grade kept once; the
// finished run is recorded as 'growth.live.1' (never the send gate's 'growth.1') and read back for the scorecard; a run that does not
// pass tells the owner once; a finished run does nothing more. The writer and reader are a stand-in model. Disposable loopback database
// only; nothing is drafted as a message and nothing is sent.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { growthStore } from './growth/store.mjs';
import { liveEvaluationHandlers, liveEvaluationNote } from './growth/live-evaluation.mjs';
import { criticPromptVersion } from './growth/draft.mjs';
import { growthReachFeature } from './growth/reach.mjs';

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const store = growthStore(pool);
const row = async (sql, values = []) => (await admin.query(sql, values)).rows[0];
const refused = code => error => error?.code === code;
const seedPolicy = await row("select approved_claim from private.growth_policies where product = 'caremetric-intel'");
const runs = [];

// A stand-in writer and reader: a first email in the form every agency gets (its market report and one question, citing the agency's own
// record), and the score it is told to give. Half of the cases carry the agency's own report; the rest have none, and are pointed to the
// market report page.
const stand = score => ({ configured: true, run: async (_task, request) => {
  if (request.promptVersion === criticPromptVersion) return { outcome: 'completed', output: { specific: 4, relevant: 4, clearAsk: 4, wouldReply: score, weakness: score < 4 ? 'generic_opening' : 'none', weakestSentence: '' } };
  const input = JSON.parse(request.user);
  const report = (input.links.find(link => link.url.includes('/report/')) ?? input.links.find(link => link.url.endsWith('/market-review'))).url;
  return { outcome: 'completed', output: { subject: 'A market report for your agency', citations: [input.sources.find(source => source.id !== 'county').id], needsHuman: false,
    body: `I put together a free market report for your agency from public Medicare data.\n${report}\n\nDoes it match what your team sees in the field?` } };
} });
// A clock a minute on at each reading: a try writes one batch and then finds its time for starting new batches spent, as a real run
// with a slow model would, so the twelve cases take several tries without the test waiting minutes.
const minuteClock = () => { let at = 0; return () => (at += 60_000); };
const evaluateWith = (score, notifier) => liveEvaluationHandlers({ growth: { store, liveEvaluation: { enabled: () => true }, briefs: { qualityWriter: () => false } },
  model: stand(score), notifier, features: new Set([growthReachFeature]), marketed: () => ['caremetric-intel'], clock: minuteClock() })['growth.evaluate_live'];
// Run now, tried again until it finishes, as the scheduler would after each queued result.
async function finish(handler) {
  const task = { id: randomUUID(), agentKey: 'marketing_manager', kind: 'growth.evaluate_live', sourceKind: 'owner', attempts: 1, agent: { autonomy: 'act' } };
  runs.push(`run:${task.id}`);
  let outcome = await handler(task, { now: () => new Date() }), tries = 1;
  while (outcome.status === 'queued' && tries < 10) { outcome = await handler(task, { now: () => new Date() }); tries += 1; }
  return { task, outcome, tries };
}

try {
  // ---- 1. Only the Hub server ---------------------------------------------------------------------------------------------------------
  for (const fn of ['private.growth_live_eval_state(text)', 'private.growth_live_eval_record(text,text,jsonb)', 'private.growth_live_evaluation_latest(timestamptz)']) {
    const access = await row(`select has_function_privilege('hub_app_server', $1, 'execute') as server, has_function_privilege('authenticated', $1, 'execute') as signed_in,
      has_function_privilege('anon', $1, 'execute') as anonymous`, [fn]);
    assert.deepEqual(access, { server: true, signed_in: false, anonymous: false }, `only the server may run ${fn}`);
  }
  assert.equal((await row("select has_table_privilege('hub_app_server', 'private.growth_live_eval_cases', 'select') as allowed")).allowed, false, 'the grades are closed');
  await assert.rejects(store.liveEvalRecord('week:soon', 'web.brief.report', {}), refused('22023'));
  assert.equal((await row("select count(*)::int as n from private.agent_schedules where agent_key = 'marketing_manager' and task_kind = 'growth.evaluate_live'")).n, 1);

  // ---- 2. Twelve cases over several tries, recorded as growth.live.1 ----------------------------------------------------------------------
  await admin.query("update private.growth_policies set approved_claim = $1 where product = 'caremetric-intel'",
    ['CareMetric Intel shows home health and hospice agencies where their referrals come from, from public Medicare data.']);
  const gateBefore = (await row("select count(*)::int as n from private.agent_evaluations where version = 'growth.1'")).n;
  const quiet = { send: async () => { throw new Error('a passing run tells nobody'); } };
  const passing = await finish(evaluateWith(4, quiet));
  assert.ok(passing.tries > 1, 'twelve cases take more than one try of the task');
  assert.equal(passing.outcome.result.version, 'growth.live.1');
  assert.equal(passing.outcome.result.passed, true);
  assert.equal(passing.outcome.result.cases, 12);
  assert.equal(passing.outcome.result.average, 4);
  const graded = await store.liveEvalState(runs[0]);
  assert.equal(graded.cases.length, 13, 'twelve grades and the finished mark');
  assert.ok(graded.cases.every(entry => !/free market report|what your team sees/.test(JSON.stringify(entry))), 'grades only, never an email\'s words');
  const recorded = await row("select passed, version, results from private.agent_evaluations where version = 'growth.live.1' and results ->> 'run' = $1", [runs[0]]);
  assert.equal(recorded.passed, true);
  assert.equal(recorded.results.results.length, 12);
  assert.equal((await row("select count(*)::int as n from private.agent_evaluations where version = 'growth.1'")).n, gateBefore, 'the send gate\'s evaluation is never written');
  const latest = await store.liveEvaluationLatest(new Date(Date.now() - 8 * 86_400_000));
  assert.equal(latest.results.run, runs[0]);
  assert.match(liveEvaluationNote(latest), /^Live writing evaluation passed: 12 of 12 drafts passed the checks; the reader's average "would reply" was 4\.0 of 5 \(lowest 4\)\.$/);
  const again = await evaluateWith(4, quiet)({ id: runs[0].slice(4), agentKey: 'marketing_manager', kind: 'growth.evaluate_live', sourceKind: 'owner', attempts: 2, agent: { autonomy: 'act' } }, { now: () => new Date() });
  assert.deepEqual(again.result, { skipped: 'already_done', run: runs[0] });
  // A grade already kept for the run is kept: the first one stands.
  assert.equal(await store.liveEvalRecord(runs[0], 'web.brief.report', { ok: false }), false);

  // ---- 3. A week that does not pass tells the owner once ---------------------------------------------------------------------------
  const notices = [];
  const failing = await finish(evaluateWith(2, { send: async notice => { notices.push(notice); return [{ channel: 'email', delivery: 'sent' }]; } }));
  assert.equal(failing.outcome.result.passed, false);
  assert.deepEqual(failing.outcome.result.failures, ['average']);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].dedupeKey, `growth:live-eval:${runs[1]}`);
  assert.equal((await store.liveEvaluationLatest(new Date(Date.now() - 8 * 86_400_000))).results.run, runs[1], 'the scorecard reads the latest run');

  console.log('Live writing evaluation integration passed: only the server reads and records it, twelve made-up cases are written and read over several tries of one task with each grade kept once, the run is recorded as growth.live.1 and never as the send gate\'s growth.1, the scorecard reads the latest, a failing week tells the owner once and a finished run does nothing more. Nothing was drafted as a message and nothing was sent.');
} finally {
  await admin.query('delete from private.growth_live_eval_cases where run_key = any($1::text[])', [runs]);
  await admin.query("delete from private.agent_evaluations where version = 'growth.live.1' and results ->> 'run' = any($1::text[])", [runs]);
  await admin.query("update private.growth_policies set approved_claim = $1 where product = 'caremetric-intel'", [seedPolicy?.approved_claim ?? null]);
  await pool.end(); await admin.end();
}
