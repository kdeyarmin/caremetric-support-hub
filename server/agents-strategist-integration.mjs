// The weekly strategist through the real roles (20261117170000_weekly_strategist.sql): the week's Intel funnel counts strong fits not
// yet written to (and which of them the team may write to), first emails and later touches, deliveries, hard and soft bounces, agencies
// that opened their report or replied, trials, roster agencies resolved, briefs, drafts waiting, days at the cap, the Marketing
// Manager's spend and the days its budget ran out, never an internal organization; the read is the Hub server's and at most 31 days;
// a week's note is saved and read back by the server only, replaced on a second save and refused when malformed; the strategist writes
// a note end to end from these figures with a stand-in model; and the gate refuses drift. Disposable loopback database only; no model is
// called and no email is sent.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { digest } from './sms-auth.mjs';
import { growthStore } from './growth/store.mjs';
import { sqlAgentStore } from './agents/store.mjs';
import { strategistFeature, strategistHandlers } from './agents/strategist/index.mjs';
import { weekStart } from './agents/accounts/week.mjs';
import { schemaDefects } from './agents/runtime/schema.mjs';

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const store = growthStore(pool), agents = sqlAgentStore(pool, { fenced: true, growth: true, strategist: true });
const run = randomUUID().slice(0, 8);
const row = async (sql, values = []) => (await admin.query(sql, values)).rows[0];
const refused = code => error => error?.code === code;
const gate = await readFile(new URL('../supabase/migrations/20261117170100_weekly_strategist_contract.sql', import.meta.url), 'utf8');
const seedAgents = (await admin.query("select key,status,autonomy,config from private.agents where key='marketing_manager'")).rows;
const seedPolicies = (await admin.query('select * from private.growth_policies')).rows;
const seedSettings = (await admin.query("select key,value,changed_at from private.hub_settings where key in ('growth.cold_email_daily_cap','growth.presend_check','growth.bounce_guard_percent')")).rows;
const runStart = (await row('select now() as t')).t;
const domains = [], tasks = [], ccns = [];
const domainOf = label => { const value = `${label}-${run}.example.org`; domains.push(value); return value; };
const signing = { hash: digest, unsubscribeToken: key => digest(`strategist-test:${key}`) };
const setting = (key, value) => admin.query('update private.hub_settings set value=$2,changed_at=now() where key=$1', [key, value === null ? null : JSON.stringify(value)]);
const task = async (kind = 'growth.pipeline', agent = 'marketing_manager') => {
  const id = (await row("insert into private.agent_tasks(agent_key,kind,request_key,status,attempts,lease_until) values($1,$2,$3,'running',1,now()+interval '10 minutes') returning id", [agent, kind, `strategist:${run}:${randomUUID()}`])).id;
  tasks.push(id); return id;
};
const opportunityOf = domain => row('select o.* from private.growth_opportunities o join private.growth_organizations g on g.id=o.organization_id where g.domain=$1', [domain]);
// A strong-fit Intel prospect found online, with or without its public role address.
async function prospect(label, { contact = true, internal = false } = {}) {
  const domain = domainOf(label);
  await store.discover('caremetric-intel', [{ name: `Synthetic ${label}`, domain, url: `https://${domain}/about`, claim: 'A Medicare-certified home health agency.' }]);
  const org = (await row('select id from private.growth_organizations where domain=$1', [domain])).id;
  if (contact) await store.recordContact(org, `info@${domain}`, `https://${domain}/contact`);
  let o = await opportunityOf(domain);
  const evidence = (await admin.query('select id from private.growth_evidence where opportunity_id=$1', [o.id])).rows.map(e => e.id);
  assert.equal(await store.assess(o.id, { fit: 85, intent: null, rationale: 'Synthetic assessment.', citations: evidence, nextAction: 'Qualify', version: o.version }), true);
  await store.autoQualify(100);
  o = await opportunityOf(domain);
  // CareMetric's own organizations are marked afterwards: the Hub never discovers, contacts or emails one.
  if (internal) await admin.query('update private.growth_organizations set internal=true where id=$1', [org]);
  return { domain, org, opportunity: o.id, evidence, email: `info@${domain}` };
}
// A first email: drafted and proposed, and sent when asked.
async function touch(p, { send = true } = {}) {
  const versions = await row('select o.version,c.version as "contactVersion",p.version as "policyVersion" from private.growth_opportunities o join private.growth_contacts c on c.id=o.contact_id join private.growth_policies p on p.product=o.product where o.id=$1', [p.opportunity]);
  const work = await store.plan(p.opportunity, { key: 'outreach:0', kind: 'outreach', action: 'Offer the market report.', success: 'A reply.', owner: 'marketing_manager', dueAt: new Date().toISOString() });
  const draft = await store.draft(p.opportunity, work, { ...versions, purpose: 'marketing', subject: 'Your county\'s referrals', body: 'The approved words.',
    citations: p.evidence, unsubscribeHash: signing.hash(signing.unsubscribeToken(work)), modelGenerated: true });
  const action = await store.propose(await task(), draft.id);
  if (!send) return { id: draft.id, action: action.id };
  await admin.query("update private.agent_actions set status='auto_approved',executing_at=null where id=$1", [action.id]);
  await agents.beginExecution(action.id);
  const claimed = await store.claim(draft.id, action.id);
  assert.equal(claimed.send, true, `${p.domain} is sent: ${JSON.stringify(claimed)}`);
  assert.equal(await store.finish(draft.id, 'accepted', `synthetic-${randomUUID()}`), true);
  return { id: draft.id, action: action.id };
}
const window = () => ({ since: new Date(runStart.getTime() - 60_000), until: new Date(Date.now() + 3_600_000) });
const facts = () => agents.strategyFacts(window());
const delta = (after, before, path) => path.split('.').reduce((value, key) => value?.[key], after) - path.split('.').reduce((value, key) => value?.[key], before);

let savedWeeks = [];
try {
  await admin.query("update private.agents set status='active',autonomy='act',config=jsonb_set(config,'{auto_approve_kinds}','[\"growth.cold_email\"]') where key='marketing_manager'");
  await admin.query("insert into private.agent_evaluations(product,version,passed,results) values('caremetric-intel','growth.1',true,'[]')");
  await admin.query("update private.growth_policies set enabled=true,auto_send=false,daily_limit=100,min_gap_hours=72,max_touches=3,approved_claim='Know every referral source in your county.' where product='caremetric-intel'");
  await setting('growth.presend_check', null);
  await setting('growth.bounce_guard_percent', null);
  await setting('growth.cold_email_daily_cap', 100);

  // ---- 1. The week's funnel, as differences from before this run's rows ------------------------------------------------------------
  const before = await facts();
  assert.equal(before.product, 'caremetric-intel');
  const opened = await prospect('strategist-opened');
  const bounced = await prospect('strategist-bounced');
  const soft = await prospect('strategist-soft');
  const waiting = await prospect('strategist-waiting');
  const unreachable = await prospect('strategist-no-address', { contact: false });
  const internal = await prospect('strategist-internal', { internal: true });
  // A strong fit whose found address waits for the owner's permission: not missing, and not one more address checks can reach.
  const review = await prospect('strategist-review');
  await admin.query("update private.growth_contacts set eligibility='review' where organization_id=$1", [review.org]);
  const sent = await touch(opened);
  await store.delivery(`strategist-delivered:${run}`, sent.id, 'delivered', new Date().toISOString());
  const hard = await touch(bounced);
  await store.delivery(`strategist-hard:${run}`, hard.id, 'bounced', new Date().toISOString());
  const softly = await touch(soft);
  await store.delivery(`strategist-soft:${run}`, softly.id, 'bounced', new Date().toISOString(), false);
  const held = await touch(waiting, { send: false });
  for (const [org, kind, key] of [[opened.org, 'report_viewed', 'view-1'], [opened.org, 'report_viewed', 'view-2'], [opened.org, 'reply', 'reply'],
    [opened.org, 'trial_started', 'trial'], [internal.org, 'report_viewed', 'internal-view'], [internal.org, 'reply', 'internal-reply']]) {
    await admin.query('insert into private.customer_activity_events(product,organization_id,event_key,kind,occurred_at) values($1,$2,$3,$4,now())', ['caremetric-intel', org, `strategist-${key}:${run}`, kind]);
  }
  const graduated = `9${run.replace(/[^0-9]/g, '').padEnd(5, '1').slice(0, 5)}`, open = `8${run.replace(/[^0-9]/g, '').padEnd(5, '2').slice(0, 5)}`;
  ccns.push(graduated, open);
  await admin.query("insert into private.growth_roster_targets(ccn,name,setting,state,county_fips,period,claim,status,organization_id,resolved_at) values($1,'Synthetic graduated','home_health','PA','42003','2026Q3','A Medicare-certified agency.','graduated',$2,now())", [graduated, unreachable.org]);
  await admin.query("insert into private.growth_roster_targets(ccn,name,setting,state,county_fips,period,claim,status) values($1,'Synthetic open','home_health','PA','42003','2026Q3','A Medicare-certified agency.','unresolved')", [open]);
  await admin.query("insert into private.growth_briefs(opportunity_id,version,writer,research,model,prompt_version,cost_cents) values($1,1,'{}','{}','synthetic-model','brief.2',1)", [opened.opportunity]);
  const spendTask = await task('growth.brief');
  await admin.query("insert into private.agent_runs(task_id,agent_key,model,prompt_version,outcome,cost_cents) values($1,'marketing_manager','synthetic-model','strategist-test','completed',12.4),($1,'marketing_manager','synthetic-model','strategist-test','budget_exhausted',0)", [spendTask]);
  const after = await facts();
  assert.deepEqual({
    strong: delta(after, before, 'prospects.strong'), strongNoContact: delta(after, before, 'prospects.strongNoContact'),
    awaitingPermission: delta(after, before, 'prospects.strongAwaitingPermission'),
    strongReachable: delta(after, before, 'prospects.strongReachable'), briefed: delta(after, before, 'prospects.briefed'),
    firstSent: delta(after, before, 'email.firstSent'), followups: delta(after, before, 'email.followups'), delivered: delta(after, before, 'email.delivered'),
    bounced: delta(after, before, 'email.bounced'), softBounced: delta(after, before, 'email.softBounced'), replies: delta(after, before, 'email.replies'),
    reportViews: delta(after, before, 'email.reportViews'), waiting: delta(after, before, 'email.waiting'), trialStarts: delta(after, before, 'conversion.trialStarts'),
    resolved: delta(after, before, 'roster.resolvedInWeek'), unresolved: delta(after, before, 'roster.unresolved'), marketingCents: delta(after, before, 'spend.marketingCents'),
    sent: delta(after, before, 'email.sent'), approvedWaiting: delta(after, before, 'email.approvedWaiting'),
  }, {
    // Strong fits never written to: the waiting one (reachable), the one with no address and the one whose address waits for
    // permission; the sent ones and the internal one are not.
    strong: 3, strongNoContact: 1, awaitingPermission: 1, strongReachable: 1, briefed: 1,
    firstSent: 3, followups: 0, delivered: 1, bounced: 1, softBounced: 1, replies: 1, reportViews: 1, waiting: 1, trialStarts: 1,
    resolved: 1, unresolved: 1, marketingCents: 12,
    // Every cold email attempted counts as sent, whatever its delivery events say; a waiting draft is approved only once its action is.
    sent: 3, approvedWaiting: ['approved', 'auto_approved'].includes((await row('select status from private.agent_actions where id=$1', [held.action])).status) ? 1 : 0,
  }, 'the week\'s funnel counts Intel\'s outside agencies only, and a bounce as hard only once the address is suppressed');
  assert.ok(after.spend.budgetDays >= 1, 'a day the Marketing Manager ran out of budget is counted');
  // A draft whose action still waits for the owner is waiting, but not approved.
  await admin.query("update private.agent_actions set status='proposed' where id=$1", [held.action]);
  const proposedOnly = await facts();
  assert.deepEqual([delta(proposedOnly, before, 'email.waiting'), delta(proposedOnly, before, 'email.approvedWaiting')], [1, 0], 'an unapproved draft is not ready to send');
  await setting('growth.cold_email_daily_cap', 3);
  assert.ok((await facts()).email.capDays >= 1, 'a day with as many cold emails as the cap is counted');
  assert.equal((await facts()).settings.coldEmailCap, 3, 'the move can name the cap as it is');
  const seedViews = await row("select value from private.hub_settings where key='growth.report_views'");
  await setting('growth.report_views', false);
  assert.equal((await facts()).settings.reportViews, false, 'opens not recorded are not zero opens');
  await setting('growth.report_views', true);
  assert.equal((await facts()).settings.reportViews, true);
  await admin.query("update private.hub_settings set value=$1 where key='growth.report_views'", [seedViews?.value ?? null]);
  // Intel's own daily limit (Growth), checked by the send claim before the cap: its days are counted too, and the move can name it.
  await admin.query("update private.growth_policies set daily_limit=3 where product='caremetric-intel'");
  const limited = await facts();
  assert.equal(limited.settings.productDailyLimit, 3);
  assert.ok(limited.email.limitDays >= 1, 'a day Intel sent as many emails as its own limit is counted');
  await assert.rejects(agents.strategyFacts({ since: new Date(Date.now() - 40 * 86_400_000), until: new Date() }), refused('22023'), 'at most 31 days');
  await assert.rejects(pool.query('select private.growth_strategy_facts_json(now()-interval \'1 day\', now())'), refused('42501'), 'the funnel helper is closed');

  // ---- 2. A week's note -----------------------------------------------------------------------------------------------------------
  const week = '2026-11-09';
  savedWeeks = (await admin.query('select * from private.agent_strategy_notes where week = any($1::date[])', [[week, weekStartOfLast()]])).rows;
  const note = { constraint: 'reach', headline: '1 of 2 strong fits has no address.', why: 'Most strong fits cannot be reached yet.', move: 'Raise "Most address checks a day".',
    watch: 'strongNoContact', chosenBy: 'rules', model: null, promptVersion: 'strategist.1', candidates: [{ key: 'reach', score: 65, evidence: { strong: 2 } }], figures: { strong: 2 } };
  assert.equal(await agents.strategySave(week, note), true);
  assert.deepEqual(await agents.strategyNote(week), { week, constraint: 'reach', headline: note.headline, why: note.why, move: note.move, watch: 'strongNoContact',
    chosenBy: 'rules', figures: { strong: 2 }, updatedAt: (await agents.strategyNote(week)).updatedAt });
  assert.equal(await agents.strategySave(week, { ...note, constraint: 'volume', watch: 'firstSent', chosenBy: 'model', model: 'synthetic-model' }), true);
  assert.equal((await agents.strategyNote(week)).constraint, 'volume', 'a second save replaces the week\'s note');
  for (const bad of [{ ...note, constraint: 'mood' }, { ...note, watch: null }, { ...note, constraint: 'none' }, { ...note, headline: '' },
    { ...note, chosenBy: 'owner' }, { ...note, model: 'Not A Model' }, { ...note, figures: [] }, { ...note, headline: 'x'.repeat(201) }]) {
    await assert.rejects(agents.strategySave(week, bad), refused('22023'), JSON.stringify(bad).slice(0, 80));
  }
  await assert.rejects(agents.strategySave('2026-11-10', note), refused('22023'), 'a note is for a week, from its Monday');
  assert.equal(await agents.strategyNote('2026-11-02'), null);
  await assert.rejects(pool.query('select * from private.agent_strategy_notes'), refused('42501'), 'the server reads notes only through the function');

  // ---- 2b. Whether the strategist's task is due or running (the catch-up scorecard waits for it) -----------------------------------
  const pendingBefore = await agents.strategyPending();
  const due = (await row("insert into private.agent_tasks(agent_key,kind,request_key,status,due_at) values('chief_of_staff','strategy.weekly',$1,'queued',now()) returning id", [`strategist-pending:${run}`])).id;
  tasks.push(due);
  assert.equal(await agents.strategyPending(), true, 'a strategist task due now is pending');
  await admin.query("update private.agent_tasks set due_at=now()+interval '2 hours' where id=$1", [due]);
  assert.equal(await agents.strategyPending(), pendingBefore, 'one due hours from now is not');
  await admin.query("update private.agent_tasks set status='done',due_at=now(),finished_at=now() where id=$1", [due]);
  assert.equal(await agents.strategyPending(), pendingBefore, 'nor one that is done');

  // ---- 3. The strategist, end to end, with a stand-in model ---------------------------------------------------------------------------
  const model = { configured: true, run: async (_task, request) => {
    // The real runtime refuses a request whose answer format it cannot enforce (runtime/schema.mjs), before any model call.
    assert.deepEqual(schemaDefects(request.schema), [], 'the answer format is one the runtime accepts');
    const user = JSON.parse(request.user);
    assert.ok(user.candidates.length >= 1, 'the model is offered the week\'s candidates');
    assert.doesNotMatch(request.user, /@|example\.org/, 'no address reaches the model');
    const pick = user.candidates[0];
    const output = { constraint: pick.key, headline: pick.headline, why: 'The figures show it.', move: pick.move, watch: pick.watch };
    const problem = request.validate(output);
    return problem === undefined ? { outcome: 'completed', output, model: 'synthetic-model' } : { outcome: 'no_result' };
  } };
  const handler = strategistHandlers({ store: agents, model, features: new Set([strategistFeature]), enabled: false })['strategy.weekly'];
  const strategyTask = await task('strategy.weekly', 'chief_of_staff');
  const outcome = await handler({ id: strategyTask, agentKey: 'chief_of_staff', kind: 'strategy.weekly', sourceKind: 'owner' });
  assert.equal(outcome.result.week, weekStartOfLast());
  const written = await agents.strategyNote(outcome.result.week);
  assert.equal(written.constraint, outcome.result.constraint);
  assert.ok(['model', 'rules'].includes(written.chosenBy));
  assert.deepEqual((await handler({ id: strategyTask, agentKey: 'chief_of_staff', kind: 'strategy.weekly', sourceKind: 'schedule' })).result, { skipped: 'off' },
    'a scheduled run waits for the owner\'s setting');

  // ---- 4. The gate refuses drift ----------------------------------------------------------------------------------------------------
  const client = await admin.connect();
  const rewrite = (signature, from, to) => `do $$ declare d text := pg_get_functiondef('${signature}'::regprocedure); begin
    if position($q$${from}$q$ in d) = 0 then raise exception 'fixture text missing'; end if; execute replace(d, $q$${from}$q$, $q$${to}$q$); end $$`;
  try {
    await client.query('begin'); await client.query(gate); await client.query(gate); await client.query('rollback');
    for (const drift of [
      "delete from private.hub_settings where key='agents.strategist'",
      'alter table private.agent_strategy_notes disable row level security',
      'grant select on private.agent_strategy_notes to hub_app_server',
      'grant execute on function private.growth_strategy_facts_json(timestamptz,timestamptz) to hub_app_server',
      'grant execute on function private.agent_strategy_save(date,jsonb) to authenticated',
      'revoke execute on function private.agent_strategy_note(date) from hub_app_server',
      'grant execute on function private.agent_strategy_pending() to authenticated',
      rewrite('private.growth_strategy_facts(timestamptz,timestamptz)', 'perform private.require_hub_app_server();', ' '),
      rewrite('private.growth_strategy_facts_json(timestamptz,timestamptz)', 'not g.internal', 'true'),
      rewrite('private.growth_strategy_facts_json(timestamptz,timestamptz)', 'private.email_suppressions s where s.email_hash', 'private.growth_contacts s where s.email'),
      "update private.agent_schedules set at_local='08:00' where agent_key='chief_of_staff' and task_kind='strategy.weekly'",
    ]) {
      await client.query('begin');
      try { await client.query(drift); await assert.rejects(client.query(gate), refused('55000'), drift); }
      finally { await client.query('rollback'); }
    }
  } finally { client.release(); }

  console.log('Strategist integration passed: the week\'s Intel funnel (strong fits and which may be written to, first emails, deliveries, hard and soft bounces, opens, replies, trials, roster, briefs, waiting drafts, the cap, spend and budget days) without internal organizations, through the server only and within 31 days; a week\'s note saved, replaced, refused when malformed and closed to every role; the strategist end to end with a stand-in model; and gate drift. No model was called and nothing was sent.');
} finally {
  await admin.query("delete from private.agent_strategy_notes where week in ('2026-11-09', $1::date)", [weekStartOfLast()]);
  for (const saved of savedWeeks) {
    await admin.query('insert into private.agent_strategy_notes select (jsonb_populate_record(null::private.agent_strategy_notes, $1::jsonb)).* on conflict (week) do nothing', [JSON.stringify(saved)]);
  }
  await admin.query('delete from private.growth_roster_targets where ccn = any($1::text[])', [ccns]);
  for (const domain of domains) {
    const org = (await row('select id from private.growth_organizations where domain=$1', [domain]))?.id;
    if (!org) continue;
    const ids = (await admin.query('select m.id from private.growth_messages m join private.growth_opportunities o on o.id=m.opportunity_id where o.organization_id=$1', [org])).rows.map(r => r.id);
    await admin.query('delete from private.growth_delivery_events where message_id=any($1::uuid[])', [ids]);
    await admin.query('delete from private.growth_messages where id=any($1::uuid[])', [ids]);
    await admin.query('delete from private.customer_success_plans where opportunity_id in(select id from private.growth_opportunities where organization_id=$1)', [org]);
    await admin.query('delete from private.growth_evidence where opportunity_id in(select id from private.growth_opportunities where organization_id=$1)', [org]);
    await admin.query('delete from private.customer_activity_events where organization_id=$1', [org]);
    await admin.query('delete from private.growth_opportunities where organization_id=$1', [org]);
    const emails = (await admin.query('select email from private.growth_contacts where organization_id=$1', [org])).rows.map(r => digest(r.email));
    await admin.query('delete from private.email_suppressions where email_hash=any($1::text[])', [emails]);
    await admin.query('delete from private.growth_contacts where organization_id=$1', [org]);
    await admin.query("delete from private.audit_events where action like 'growth.%' and entity_id=$1", [org]);
    await admin.query('delete from private.growth_organizations where id=$1', [org]);
  }
  await admin.query("delete from private.audit_events where entity_type='agent_action' and entity_id in (select id from private.agent_actions where task_id=any($1::uuid[]))", [tasks]);
  await admin.query('delete from private.agent_actions where task_id=any($1::uuid[])', [tasks]);
  await admin.query('delete from private.agent_runs where task_id=any($1::uuid[])', [tasks]);
  await admin.query('delete from private.agent_tasks where id=any($1::uuid[])', [tasks]);
  await admin.query('delete from private.agent_evaluations where created_at>=$1', [runStart]);
  await admin.query("delete from private.audit_events where action='growth.auto_qualified' and created_at>=$1", [runStart]);
  for (const s of seedSettings) await admin.query('update private.hub_settings set value=$2,changed_at=$3 where key=$1', [s.key, s.value, s.changed_at]);
  for (const a of seedAgents) await admin.query('update private.agents set status=$2,autonomy=$3,config=$4 where key=$1', [a.key, a.status, a.autonomy, a.config]);
  for (const p of seedPolicies) await admin.query('update private.growth_policies set enabled=$2,auto_send=$3,daily_limit=$4,min_gap_hours=$5,max_touches=$6,booking_url=$7,approved_claim=$8,version=$9 where product=$1', [p.product, p.enabled, p.auto_send, p.daily_limit, p.min_gap_hours, p.max_touches, p.booking_url, p.approved_claim, p.version]);
  await pool.end(); await admin.end();
}

// The Monday of the week before this one, by the Eastern calendar: the week a run now reports.
function weekStartOfLast() {
  const monday = weekStart(new Date());
  const [year, month, day] = monday.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day - 7)).toISOString().slice(0, 10);
}
