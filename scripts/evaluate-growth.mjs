import { evaluateGrowth } from '../server/growth/evaluation.mjs';
import { growthStore } from '../server/growth/store.mjs';
import pg from 'pg';

const reports = await evaluateGrowth();
// Optional server-role connection records evidence for a rollout; never connects implicitly.
const url = process.env.HUB_GROWTH_EVAL_DATABASE_URL;
const pool = url ? new pg.Pool({ connectionString: url, max: 1 }) : null;
try {
  for (const report of reports) {
    if (pool) await growthStore(pool).evaluate(report.product, report.version, report.passed, { scope: report.scope, cases: report.results });
    console.log(JSON.stringify(report));
  }
} finally { await pool?.end(); }
if (reports.some(r => !r.passed)) process.exitCode = 1;
