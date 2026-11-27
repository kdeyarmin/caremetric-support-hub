// Test phones for the integration scripts, and the teardown that frees them.
//
// private.sms_identities.phone_e164 is unique, and CI's database job runs every
// integration script against one shared database, many of them twice. A phone drawn
// at random, or one two scripts share, sooner or later meets an identity another
// script left behind, and the run fails on a duplicate key. So every script takes its
// numbers from this list, keyed by its own file name, and none appears twice
// (server/test-phones.test.mjs checks it). All are in the 202-555-0100 to 202-555-0999
// test range the scripts have always used.
//
// A new script adds its own entry here; it never borrows another script's numbers.

import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './sms-auth.mjs';

export const testPhoneRegistry = Object.freeze({
  integration: { editor: '+12025550101', learner: '+12025550102', unknown: '+12025550103', renumbered: '+12025550109', refused: '+12025550199' },
  'agents-accounts-integration': { owner: '+12025550601' },
  'agents-answers-integration': { owner: '+12025550973' },
  'agents-autonomy-integration': { owner: '+12025550972' },
  'agents-concierge-drafting-integration': { owner: '+12025550603', contact: '+12025550604' },
  'agents-concierge-integration': { owner: '+12025550602', contact: '+12025550142' },
  'agents-content-integration': { owner: '+12025550605' },
  'agents-external-email-integration': { owner: '+12025550606', secondOwner: '+12025550607', customer: '+12025550608' },
  'agents-growth-address-check-integration': { owner: '+12025550977' },
  'agents-growth-autonomy-integration': { owner: '+12025550622' },
  'agents-growth-brief-integration': { owner: '+12025550978' },
  'agents-growth-colleagues-integration': { owner: '+12025550976' },
  'agents-growth-integration': { owner: '+12025550610', contact: '+12025550188' },
  'agents-growth-learning-integration': { owner: '+12025550975' },
  'agents-growth-people-finder-integration': { owner: '+12025550625' },
  'agents-growth-priority-integration': { owner: '+12025550979' },
  'agents-growth-people-integration': { owner: '+12025550974' },
  'agents-growth-roster-integration': { owner: '+12025550623' },
  'agents-hardening-integration': { owner: '+12025550611' },
  'agents-integration': { owner: '+12025550701', other: '+12025550702', secondAdmin: '+12025550703' },
  'agents-lifecycle-integration': { owner: '+12025550612' },
  'agents-marketing-integration': { owner: '+12025550626' },
  'agents-offers-integration': { owner: '+12025550624' },
  'agents-owner-sequences-integration': { owner: '+12025550985' },
  'agents-runtime-integration': { owner: '+12025550613' },
  'agents-scorecard-integration': { owner: '+12025550628' },
  'ai-automation-integration': { owner: '+12025550631', customer: '+12025550632' },
  'authoring-integration': { owner: '+12025550630' },
  'billing-integration': { owner: '+12025550931', member: '+12025550932' },
  'bulk-email-integration': { owner: '+12025550895', customer: '+12025550896' },
  'catalog-integration': { owner: '+12025550861' },
  'communications-integration': { owner: '+12025550161', agent: '+12025550162', customer: '+12025550163', texter: '+12025550144', burst: '+12025550145', caller: '+12025550171' },
  'configuration-integration': { owner: '+12025550831' },
  'course-media-integration': { owner: '+12025550841' },
  'creation-integration': { owner: '+12025550801', other: '+12025550802' },
  'distribution-integration': { owner: '+12025550941' },
  'generated-course-integration': { owner: '+12025550619' },
  'generation-integration': { owner: '+12025550871' },
  'growth-integration': { owner: '+12025550971' },
  'invitations-integration': { owner: '+12025550983', member: '+12025550984' },
  'leads-integration': { owner: '+12025550614' },
  'learning-integration': { owner: '+12025550301' },
  'media-import-integration': { editor: '+12025550617', learner: '+12025550618' },
  'onboarding-integration': { owner: '+12025550501', customer: '+12025550502', other: '+12025550503' },
  'operations-integration': { owner: '+12025550911' },
  'owner-access-integration': { owner: '+12025550620', customer: '+12025550621' },
  'package-integration': { owner: '+12025550921' },
  'password-auth-integration': { owner: '+12025550615', rebound: '+12025550616' },
  'pennsync-migration-integration': { owner: '+12025550731' },
  'pennsync-no-payments-integration': { user: '+12025550191' },
  'phone-registry-integration': { line: '+12025550881', owner: '+12025550882', customer: '+12025550883', renamed: '+12025550884' },
  'provider-integration': { owner: '+12025550821' },
  'publication-integration': { owner: '+12025550181', scoped: '+12025550182', learner: '+12025550183' },
  'recovery-integration': { owner: '+12025550981', customer: '+12025550982' },
  'registration-integration': {
    owner: '+12025550901', outsider: '+12025550902', refused: '+12025550903', wrongNumber: '+12025550999',
    invited: Array.from({ length: 20 }, (_, index) => `+120255502${String(index + 1).padStart(2, '0')}`),
  },
  'self-service-integration': { customer: '+12025550851', supportOwner: '+12025550852' },
  'settings-integration': { owner: '+12025550629' },
  'social-connections-integration': { owner: '+12025550627' },
  'support-integration': { owner: '+12025550401', customer: '+12025550402' },
  'training-integration': { owner: '+12025550832' },
});

/** The calling script's own test phones: `testPhones(import.meta.url)`. */
export function testPhones(moduleUrl) {
  const script = basename(fileURLToPath(moduleUrl), '.mjs');
  const phones = testPhoneRegistry[script];
  if (!phones) throw new Error(`${script} has no test phones. Add its own entry to server/test-phones.mjs.`);
  return phones;
}

const sessionsOf = 'select id from private.sms_sessions where user_id = any($1::uuid[])';

/**
 * Deletes test users with their SMS identities, so their phones are free for the next run,
 * in one transaction: what points at their SMS sessions, then `also` (the script's own rows
 * that point at the users, each statement given the users as $1), then their challenges,
 * sessions and identities, and last their auth.users rows (profiles, memberships and staff
 * permissions go with them).
 *
 * `unlock` names [table, trigger] pairs that keep the script's own rows immutable, such as
 * provenance. They are disabled for this transaction only and enabled again before it commits.
 *
 * `phones` lists numbers the script asked codes for that no identity holds. Their challenges
 * carry no user, so they are found by the number's hash; left behind, they would keep the
 * SMS rate limits closed to the next run.
 *
 * Call it in the script's `finally` with the script's pg.Pool. A failure fails the run, but
 * is reported without hiding the error that ended the test.
 */
export async function removeTestIdentities(pool, users, { also = [], unlock = [], phones = [] } = {}) {
  const steps = [
    `delete from private.app_delegations where session_id in (${sessionsOf})`,
    `delete from private.learning_authoring_intents where session_id in (${sessionsOf})`,
    `delete from private.course_creation_intents where session_id in (${sessionsOf})`,
    ...also,
    'delete from private.sms_challenges where user_id = any($1::uuid[])',
    'delete from private.sms_sessions where user_id = any($1::uuid[])',
    'delete from private.sms_identities where user_id = any($1::uuid[])',
    'delete from auth.users where id = any($1::uuid[])',
  ];
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const [table, trigger] of unlock) await client.query(`alter table ${table} disable trigger ${trigger}`);
    for (const sql of steps) await client.query(sql, [users]);
    if (phones.length) await client.query('delete from private.sms_challenges where phone_hash = any($1::text[])', [phones.map(digest)]);
    for (const [table, trigger] of unlock) await client.query(`alter table ${table} enable trigger ${trigger}`);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    console.error(`Teardown could not remove the test users: ${error.message}`);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}
