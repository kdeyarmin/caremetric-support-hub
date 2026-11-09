import { resolve4, resolveCname } from 'node:dns/promises';
import { HttpError } from './sms-auth.mjs';

export const goLiveHostname = 'help.caremetric.ai';

// The store operations the auto-resolution loop runs through on the Hub server
// role, created by 20261020120000.
export const automationServerOperations = Object.freeze([
  'private.ai_automation_eligible_cases()', 'private.ai_automation_claim(uuid)',
  'private.ai_automation_active_cases()', 'private.ai_automation_work(uuid)',
  'private.ai_automation_knowledge(uuid)', 'private.ai_automation_post_message(uuid,text)',
  'private.ai_automation_post_note(uuid,text)', 'private.ai_automation_escalate(uuid)',
  'private.ai_automation_resolve(uuid)', 'private.ai_automation_save_state(uuid,jsonb)',
]);

// Evidence for the production migrations, read fresh from the database the Hub
// server is connected to. 20261015120000 is proven by the objects it alone
// creates — the automation state table, the customer response function, the
// loop stage on the case queue, and 'ai_assistant' as a permitted message
// author — the same evidence its own contract migration demands before it
// will proceed. 20261020120000 is proven by its store operations existing and
// being executable by this connection's role (the Hub server role). The two
// contract migrations are proven by the backend contract features they alone
// register. There is no migrations ledger in this schema to consult; the
// contract migration style of this repository is object evidence.
const migrationEvidenceQuery = `
  select
    to_regclass('hub.case_ai_automation') is not null as automation_table,
    to_regprocedure('hub.record_ai_resolution_response(uuid,boolean,uuid)') is not null as resolution_function,
    coalesce(position('ai_stage' in pg_get_viewdef(to_regclass('hub.support_case_queue'))) > 0, false) as queue_ai_stage,
    coalesce(position('ai_assistant' in (
      select pg_get_constraintdef(oid) from pg_constraint
      where conname = 'case_messages_author_role_check' limit 1
    )) > 0, false) as author_role_ai_assistant,
    (select count(*) from unnest($1::text[]) as operation(signature)
      where has_function_privilege(to_regprocedure(operation.signature), 'EXECUTE')) = cardinality($1::text[]) as automation_server_operations
`;

/** Live DNS evidence for the public help hostname: what it resolves to right
 * now (CNAME targets and A records), never a remembered answer. A name that
 * does not resolve, or does not answer within the window, reports no targets. */
export async function lookupGoLiveHostname(hostname, timeoutMs = 5000) {
  const found = new Set();
  const collect = async (resolve) => {
    try {
      for (const target of await resolve(hostname)) found.add(target);
    } catch { /* ENOTFOUND / ENODATA: the name does not resolve. */ }
  };
  const lookups = Promise.all([collect(resolveCname), collect(resolve4)]);
  let timer;
  const window = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  await Promise.race([lookups, window]);
  clearTimeout(timer);
  return [...found].sort();
}

/**
 * The AI go-live readiness evaluation, behind the same SMS session and actor
 * authorization as the neighboring admin endpoints: only the platform
 * administrator may read it. Every value is evaluated during the request —
 * the migration evidence is queried, the service environment is read (the
 * Anthropic key contributes only a boolean: its value is never returned,
 * logged, or measured), and the help hostname is resolved live.
 * The evaluation reports only; it changes nothing.
 */
// `automationEnabled` reads the Hub setting (server/hub-settings.mjs); without it, the Railway variable as before.
export function goLiveReadiness({ pool, rpc, env = process.env, automationEnabled = () => env.HUB_AI_AUTOMATION_ENABLED === 'true', lookup = lookupGoLiveHostname, now = () => new Date() }) {
  async function handle(sessionToken) {
    const context = await rpc('get_support_actor_context', {}, sessionToken);
    if (context?.role !== 'platform_admin') {
      throw new HttpError(403, 'The go-live readiness panel is available to the platform administrator only.');
    }
    const { rows } = await pool.query(migrationEvidenceQuery, [automationServerOperations]);
    const evidence = rows[0] ?? {};
    // Public release metadata is executable by anon/authenticated only, so it is
    // read through the gateway (as anon), exactly like the startup contract check.
    const contract = await rpc('get_backend_contract', {});
    const features = Array.isArray(contract?.features) ? contract.features : [];
    const aiAssistanceApplied = evidence.automation_table === true
      && evidence.resolution_function === true
      && evidence.queue_ai_stage === true
      && evidence.author_role_ai_assistant === true;
    const aiContractApplied = features.includes('support.ai-assistance.v1')
      && features.includes('support.ai-automation.v1');
    const automationServerApplied = evidence.automation_server_operations === true;
    const automationServerContractApplied = features.includes('support.ai-automation-server.v1');
    const targets = await lookup(goLiveHostname);
    const key = env.ANTHROPIC_API_KEY;
    return {
      checkedAt: now().toISOString(),
      migrations: {
        complete: aiAssistanceApplied && aiContractApplied && automationServerApplied && automationServerContractApplied,
        items: [
          { version: '20261015120000', name: 'AI case assistance', applied: aiAssistanceApplied },
          { version: '20261015120100', name: 'AI case assistance contract', applied: aiContractApplied },
          { version: '20261020120000', name: 'AI automation server boundary', applied: automationServerApplied },
          { version: '20261020120100', name: 'AI automation server contract', applied: automationServerContractApplied },
        ],
      },
      anthropicKey: { present: typeof key === 'string' && key.trim().length > 0 },
      aiAutomation: { enabled: automationEnabled() === true },
      helpDomain: { hostname: goLiveHostname, resolves: targets.length > 0, targets },
    };
  }
  return { handle };
}
