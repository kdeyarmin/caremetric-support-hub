import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { digest, withSession } from './sms-auth.mjs';

/** Exercise the real server login; Supabase's postgres role cannot impersonate it. */
export async function exercisePennSyncNoPayments({ admin, pool }) {
  const user = randomUUID(), tenant = randomUUID(), connection = randomUUID();
  const token = `pennsync-support-${randomUUID()}`;
  const run = operation => withSession(pool, token, operation);
  const prepare = operation => run(db => db.query('select hub.prepare_self_service_operation($1,$2::jsonb) as id', [connection, JSON.stringify(operation)]));
  try {
    await admin.query("insert into auth.users(id,email,is_anonymous) values($1,'support-only@example.invalid',false)", [user]);
    await admin.query("insert into hub.tenants(id,slug,name) values($1,$2,'Disposable support-only agency')", [tenant, `support-only-${tenant}`]);
    await admin.query("insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,'+12025550191',now())", [user]);
    await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at) select $1,$2,user_id,identity_version,now()+interval '1 hour' from private.sms_identities where user_id=$3", [randomUUID(), digest(token), user]);
    await admin.query("insert into hub.tenant_products(tenant_id,product_id) select $1,id from hub.products where slug in ('pennsync','carebase')", [tenant]);
    await admin.query("insert into hub.tenant_product_memberships(tenant_id,product_id,user_id,role,case_scope) select $1,id,$2,'tenant_admin','own' from hub.products where slug='pennsync'", [tenant, user]);
    await admin.query("insert into private.self_service_connections(id,user_id,tenant_id,product_id,source_account,source_user,role,facilities,capabilities) select $1,$2,$3,id,$4,$5,'organization_admin','[]','[\"training.profile.v1\"]' from hub.products where slug='pennsync'", [connection, user, tenant, randomUUID().replaceAll('-', '').slice(0, 24), randomUUID().replaceAll('-', '').slice(0, 24)]);

    await assert.rejects(run(async db => {
      await db.query('reset role');
      return db.query('select private.customer_billing_context($1)', [connection]);
    }), { code: '42501', message: 'PennSync does not accept payments' });
    await assert.rejects(prepare({ action: 'billing.authorize', facility_id: null }), { code: '42501', message: 'PennSync does not accept payments' });
    assert.ok((await prepare({ action: 'scope.read' })).rows[0].id, 'support verification remains available');
    assert.ok((await prepare({ action: 'profile.read', cursor: 0 })).rows[0].id, 'training profiles remain available');
    assert.deepEqual((await run(db => db.query('select hub.my_billing() as value'))).rows[0].value.tenants, []);
    await assert.rejects(run(db => db.query('select hub.authorize_tenant_billing($1)', [tenant])), { code: '42501', message: 'You do not manage billing for this organization.' });

    await admin.query("insert into hub.tenant_product_memberships(tenant_id,product_id,user_id,role,case_scope) select $1,id,$2,'tenant_admin','own' from hub.products where slug='carebase'", [tenant, user]);
    assert.equal((await run(db => db.query('select hub.my_billing() as value'))).rows[0].value.tenants.length, 1, 'a separate paid-app membership retains billing authority');
  } finally {
    await admin.query('delete from private.self_service_operations where user_id=$1', [user]);
    await admin.query('delete from private.self_service_connections where user_id=$1', [user]);
    await admin.query('delete from private.audit_events where actor_id=$1', [user]);
    await admin.query('delete from private.sms_sessions where user_id=$1', [user]);
    await admin.query('delete from private.sms_identities where user_id=$1', [user]);
    await admin.query('delete from hub.tenants where id=$1', [tenant]);
    await admin.query('delete from auth.users where id=$1', [user]);
  }
}
