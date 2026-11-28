import { transaction, withSession } from '../sms-auth.mjs';

/** The state launch functions (20261128100000_state_launches.sql): the Hub server's own, and the owner's commands under the owner's session. */
export function stateLaunchStore(pool) {
  const run = (client, fn, args) => client.query(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) as result`, args).then(r => r.rows[0].result);
  const server = (fn, args = []) => transaction(pool, db => run(db, fn, args));
  const owner = (token, fn, args = []) => withSession(pool, token, db => run(db, fn, args));
  // node-pg sends a JavaScript array as a Postgres array, not JSON: jsonb arguments that are arrays or objects go as JSON text.
  const json = value => JSON.stringify(value);
  return {
    next: () => server('private.state_launch_next'),
    save: (id, patch) => server('private.state_launch_save', [id, json(patch)]),
    addTargets: (id, rows) => server('private.state_launch_add_targets', [id, json(rows)]),
    pending: (id, limit) => server('private.state_launch_pending', [id, limit]),
    targetSave: (target, patch) => server('private.state_launch_target_save', [target, json(patch)]),
    leads: id => server('private.state_launch_leads', [id]),
    mark: (ids, status, note, campaign) => server('private.state_launch_mark', [json(ids), status, note, campaign]),
    event: (campaign, email, kind) => server('private.state_launch_event', [campaign, email, kind]),
    reportClaim: target => server('private.state_launch_report_claim', [target]),
    list: token => owner(token, 'hub.state_launches'),
    detail: (token, id) => owner(token, 'hub.state_launch_detail', [id]),
    request: (token, state) => owner(token, 'hub.state_launch_request', [state]),
    approve: (token, id) => owner(token, 'hub.state_launch_approve', [id]),
    more: (token, id) => owner(token, 'hub.state_launch_more', [id]),
    cancel: (token, id) => owner(token, 'hub.state_launch_cancel', [id]),
  };
}
