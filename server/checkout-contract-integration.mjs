// Every incomplete deployment fixture is rolled back in the disposable database.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { assertBackendContract } from '../src/lib/backendContract.ts';
const databaseUrl=process.env.HUB_TEST_DATABASE_URL,local=new URL(databaseUrl);
assert.equal(local.hostname,'127.0.0.1');assert.equal(local.port,'54322');
const client=new pg.Client({connectionString:databaseUrl});
const migration=await readFile(new URL('../supabase/migrations/20260911204842_billing_checkout_backend_contract.sql',import.meta.url),'utf8');
const readContract=async()=> (await client.query('select hub.get_backend_contract() as contract')).rows[0].contract;
const fixtures=[
  ['alter function private.reserve_billing_checkout(jsonb) rename to test_missing_checkout_reserve',/Missing reviewed checkout function/],
  ['alter function private.record_billing_checkout_result(uuid,uuid,jsonb) rename to test_missing_checkout_record',/Missing reviewed checkout function/],
  ['alter table private.billing_checkout_intents rename to test_missing_checkout_intents',/checkout intent table/],
  ["alter type private.billing_checkout_action rename value 'billing.checkout.create' to 'test.unsupported'",/closed checkout action/],
  ['alter table private.billing_checkout_intents alter column action drop not null',/closed checkout action/],
  ["create or replace function private.reserve_billing_checkout(p_request jsonb) returns jsonb language sql set search_path='' as $$ select null::jsonb $$",/closed checkout action/],
  ['alter table private.billing_checkout_intents rename column observation_id to test_missing_observation',/checkout observation/],
  ['alter table private.billing_checkout_intents rename column provider_session_id to test_missing_session',/checkout observation/],
  ["create or replace function private.record_billing_checkout_result(p_command_id uuid,p_observation_id uuid,p_result jsonb) returns jsonb language sql set search_path='' as $$ select p_result $$",/checkout observation/],
  ["create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='' as $$ select null::jsonb $$",/complete structure and portal foundation/],
];
await client.connect();
try {
  assertBackendContract(await readContract());
  for(const [sql,expected] of fixtures) {
    await client.query('begin');
    try {
      await client.query(sql);const before=await readContract();await client.query('savepoint before_declaration');
      await assert.rejects(()=>client.query(migration),error=>error.code==='55000'&&expected.test(error.message));
      await client.query('rollback to savepoint before_declaration');assert.deepEqual(await readContract(),before);
    } finally {await client.query('rollback');}
  }
  await client.query('begin');
  try {const before=await readContract();await client.query(migration);assert.deepEqual(await readContract(),before);assertBackendContract(await readContract());}
  finally {await client.query('rollback');}
  await client.query('begin');
  try {
    const before=await readContract(),withIndependent={...before,features:[...before.features,'test.independent.v1']};
    // Only a synthetic public literal is installed; it grants no actor rights.
    await client.query("create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='' as $$ select '"+JSON.stringify(withIndependent)+"'::jsonb $$");
    await client.query(migration);assert.deepEqual(await readContract(),withIndependent);
  } finally {await client.query('rollback');}
  console.log('Checkout declaration rejected ten incomplete boundaries and preserved all fourteen features.');
} finally {await client.end();}
