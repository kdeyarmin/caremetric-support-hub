// Destructive DATA recovery drill. Runs only against disposable GitHub CI Postgres.
// Provider Auth, Storage bytes and cluster roles are outside this logical archive.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { digest } from './sms-auth.mjs';
import { gateway } from './gateway.mjs';

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Recovery drill requires a disposable GitHub runner');
assert.equal(process.env.HUB_RUN_RECOVERY_DRILL, 'disposable-data-loss', 'Explicit drill opt-in required');
const url = new URL(process.env.HUB_TEST_DATABASE_URL);
assert.ok(url.href === 'postgresql://postgres:postgres@127.0.0.1:54322/postgres', 'Only the exact disposable local database is allowed');
const run = promisify(execFile);
const docker = async args => (await run('docker', args, { timeout: 120_000, maxBuffer: 2_000_000 })).stdout;
const names = (await docker(['ps', '--format', '{{.Names}}'])).trim().split('\n').filter(name => /^supabase_db_[a-zA-Z0-9_-]+$/.test(name));
assert.equal(names.length, 1, 'Exactly one disposable Supabase database must be running');
const container = names[0];
const [inspected] = JSON.parse(await docker(['inspect', container]));
assert.match(inspected.Config.Image, /supabase\/postgres:/);
assert.ok(inspected.NetworkSettings.Ports['5432/tcp'].some(binding => binding.HostPort === '54322' && ['127.0.0.1','0.0.0.0'].includes(binding.HostIp)));
const execDb = args => docker(['exec', container, ...args]);
const archive = `/tmp/hub-recovery-${randomUUID()}.dump`;
const admin = new pg.Pool({ connectionString: url.href });
const appUrl = new URL(url); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const api = gateway(pool);
const owner = randomUUID(), customer = randomUUID(), tenant = randomUUID();
const ownerToken = randomUUID(), customerToken = randomUUID();
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const qualified = row => `${quote(row.schema)}.${quote(row.name)}`;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inventory = async () => (await admin.query(`select n.nspname as schema,c.relname as name,c.relkind
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in ('hub','private') and c.relkind in ('r','S') order by n.nspname,c.relname`)).rows;
async function dataState(objects) {
  const state = [];
  for (const object of objects) {
    const result = object.relkind === 'S'
      ? await admin.query(`select last_value::text,is_called from ${qualified(object)}`)
      : await admin.query(`select count(*)::text as count,
          encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(entry) order by to_jsonb(entry)::text)::text,'[]'),'sha256'),'hex') as digest
          from ${qualified(object)} entry`);
    state.push({ ...object, ...result.rows[0] });
  }
  return state;
}
async function authorityState() {
  const tables = (await admin.query(`select n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('hub','private') order by n.nspname,c.relname`)).rows;
  const functions = (await admin.query(`select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) as args,
    p.prosecdef,p.proacl::text,pg_get_functiondef(p.oid) as definition
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('hub','private') and p.prokind='f' order by 1,2,3`)).rows;
  const triggers = (await admin.query(`select n.nspname,c.relname,t.tgname,t.tgenabled
    from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('hub','private') order by 1,2,3`)).rows;
  return hash({ tables, functions, triggers });
}
try {
  await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
  const product = (await admin.query("select id from hub.products where slug='caremetric-go'")).rows[0].id;
  await admin.query("insert into auth.users(id,email,is_anonymous) values($1,'recovery-owner@test.invalid',false),($2,'recovery-customer@test.invalid',false)", [owner,customer]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')", [owner]);
  await admin.query("insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,'+12025550981',now()),($2,'+12025550982',now())", [owner,customer]);
  for (const [user,token] of [[owner,ownerToken],[customer,customerToken]]) {
    await admin.query(`insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at)
      select gen_random_uuid(),$1,user_id,identity_version,now()+interval '1 hour' from private.sms_identities where user_id=$2`, [digest(token),user]);
  }
  await admin.query("insert into hub.tenants(id,slug,name) values($1,$2,'Synthetic recovery customer')", [tenant,`recovery-${tenant}`]);
  await admin.query('insert into hub.tenant_products(tenant_id,product_id) values($1,$2)', [tenant,product]);
  await admin.query('insert into hub.tenant_product_memberships(tenant_id,product_id,user_id) values($1,$2,$3)', [tenant,product,customer]);
  await api.rpc('set_support_intake',{p_tenant_id:tenant,p_product_id:product,p_enabled:true,p_reviewed:true,p_expected_updated_at:null},ownerToken);
  const requestKey = randomUUID();
  const create = { p_tenant_id:tenant,p_product_id:product,p_subject:'Synthetic recovery drill',p_category:'general',p_priority:'normal',
    p_body:'Synthetic original customer message',p_app_version:null,p_route:null,p_contains_phi:false,p_request_key:requestKey };
  const supportCase = await api.rpc('create_support_case',create,customerToken);
  const reply = { p_case_id:supportCase.id,p_body:'Synthetic public staff reply',p_visibility:'customer',p_request_key:randomUUID() };
  const note = { p_case_id:supportCase.id,p_body:'Synthetic private staff note',p_visibility:'internal',p_request_key:randomUUID() };
  await api.rpc('reply_to_support_case',reply,ownerToken);
  await api.rpc('reply_to_support_case',note,ownerToken);
  const thread = token => api.rpc('get_support_case_thread',{p_case_id:supportCase.id},token);
  const customerThread = await thread(customerToken), ownerThread = await thread(ownerToken);
  assert.equal(customerThread.length,2); assert.equal(ownerThread.length,3);
  assert.ok(customerThread.every(row=>row.visibility==='customer'));
  const objects = await inventory();
  assert.ok(objects.length>20, 'Archive must include the entire Hub data domain');
  const before = await dataState(objects), authority = await authorityState();
  // Supabase's ordinary postgres role is deliberately not a superuser. Only
  // the disposable container administrator can suspend foreign-key triggers.
  const restoreAuthority = await execDb(['psql','-U','supabase_admin','-d','postgres','-At','-c',
    "select rolsuper from pg_roles where rolname=current_user"]);
  assert.equal(restoreAuthority.trim(),'t','Disposable restore administrator required before data loss');
  const started = Date.now();
  await execDb(['pg_dump','-U','postgres','-d','postgres','--format=custom','--data-only','--schema=hub','--schema=private',`--file=${archive}`]);
  // No CASCADE: any foreign dependency outside the exact domain must stop the drill.
  await admin.query(`truncate table ${objects.filter(o=>o.relkind==='r').map(qualified).join(',')} restart identity`);
  assert.equal((await admin.query('select count(*)::int as count from hub.support_cases')).rows[0].count,0);
  await assert.rejects(thread(customerToken), /Sign in/, 'Lost session state must deny requests');
  await execDb(['pg_restore','-U','supabase_admin','-d','postgres','--exit-on-error','--single-transaction','--data-only','--disable-triggers',archive]);
  assert.deepEqual(await dataState(objects),before, 'Every archived row and sequence must restore exactly');
  assert.equal(await authorityState(),authority, 'Grants, RLS, functions and all trigger modes must remain intact');
  assert.deepEqual(await thread(customerToken),customerThread);
  assert.deepEqual(await thread(ownerToken),ownerThread);
  assert.equal((await api.rpc('create_support_case',create,customerToken)).id,supportCase.id,'Restored request key prevents duplicate cases');
  await api.rpc('reply_to_support_case',reply,ownerToken);
  await api.rpc('reply_to_support_case',note,ownerToken);
  assert.deepEqual(await thread(ownerToken),ownerThread,'Restored reply keys prevent duplicated public or private messages');
  const permissions = (await admin.query(`select has_table_privilege('anon','hub.support_cases','SELECT') as anon_cases,
    has_table_privilege('authenticated','private.case_notes','SELECT') as raw_notes,
    has_table_privilege('hub_app_server','auth.users','SELECT') as raw_auth`)).rows[0];
  assert.deepEqual(permissions,{anon_cases:false,raw_notes:false,raw_auth:false});
  // A restore may resurrect old sessions. Quarantine them before reopening traffic.
  await admin.query('update private.sms_sessions set revoked_at=now() where revoked_at is null');
  await admin.query('update private.sms_challenges set consumed_at=now() where consumed_at is null');
  await admin.query('update private.app_delegations set consumed_at=now() where consumed_at is null');
  await admin.query('update private.publication_cleanup_tokens set consumed_at=now() where consumed_at is null');
  await admin.query('delete from private.publication_public_downloads');
  await assert.rejects(thread(customerToken),/Sign in/);
  await assert.rejects(thread(ownerToken),/Sign in/);
  console.log(JSON.stringify({drill:'hub-logical-data-recovery',tables:objects.filter(o=>o.relkind==='r').length,
    sequences:objects.filter(o=>o.relkind==='S').length,dataDigest:hash(before),elapsedMs:Date.now()-started,
    checks:['all rows','sequence positions','case history','internal note privacy','request replay','grants and RLS','trigger restoration','restored session quarantine'],
    excluded:['provider Auth restore','Storage object bytes','custom-role passwords','production PITR and retention']}));
} finally {
  // The whole runner database is disposable and stopped by the workflow even on failure.
  await execDb(['rm','-f',archive]).catch(()=>{});
  await pool.end(); await admin.end();
}
