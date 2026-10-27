// Closed gate omissions are tested only in disposable PostgreSQL transactions.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { assertBackendContract } from '../src/lib/backendContract.ts';
const databaseUrl=process.env.HUB_TEST_DATABASE_URL,local=new URL(databaseUrl);
assert.equal(local.hostname,'127.0.0.1');assert.equal(local.port,'54322');
const client=new pg.Client({connectionString:databaseUrl});
const migration=await readFile(new URL('../supabase/migrations/20260911215751_learning_credit_policy_contract.sql',import.meta.url),'utf8');
// The declaration requires its exact historical six-action shape; later migrations add catalog actions.
const historicalIntents=await readFile(new URL('../supabase/migrations/20260911215749_learning_credit_policy_intents.sql',import.meta.url),'utf8');
const readContract=async()=> (await client.query('select hub.get_backend_contract() as contract')).rows[0].contract;
// Historical declarations gate on billing features that platform billing retired; replay them from a contract that still lists them.
const declareHistorical=async()=>{
  const contract=await readContract();
  const historical={...contract,features:contract.features.flatMap(feature=>feature==='learning.draft-editing.v1'?[feature,'billing.portal.v1']
    :feature==='support.customer-registration.v1'?[feature,'billing.checkout.v1']:[feature])};
  const sql=(await client.query("select format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal($1::text)||'::jsonb') as sql",[JSON.stringify(historical)])).rows[0].sql;
  await client.query(sql);
};
const fixtures=[
  'alter function private.learning_authoring_actions() rename to test_missing_policy_actions',
  'alter function hub.record_learning_authoring_result(uuid,text,jsonb) rename to test_missing_policy_result',
  'alter function hub.remember_learning_authoring_preview(uuid,jsonb) rename to test_missing_policy_preview',
  'alter function private.require_learning_editor() rename to test_missing_policy_authority',
  'alter table private.learning_authoring_intents rename to test_missing_policy_intents',
  "create or replace function private.learning_authoring_actions() returns text[] language sql immutable security invoker set search_path='' as $$ select array['learning.cloneVersion','learning.publishVersion','learning.patchDraft','learning.reviewDraft','learning.editStructure']::text[] $$",
  "create or replace function hub.record_learning_authoring_result(p_command_id uuid,p_expected_digest text,p_result jsonb) returns jsonb language sql security definer set search_path='' as $$ select p_result $$",
  "create or replace function hub.remember_learning_authoring_preview(p_snapshot_id uuid,p_preview jsonb) returns jsonb language sql security definer set search_path='' as $$ select p_preview $$",
  "create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='' as $$ select null::jsonb $$",
];
await client.connect();
try {
  assertBackendContract(await readContract());
  for(const fixture of fixtures) {
    await client.query('begin');
    try {
      await client.query(historicalIntents);await declareHistorical();await client.query(fixture);const before=await readContract();await client.query('savepoint before_credit_declaration');
      await assert.rejects(()=>client.query(migration),error=>error.code==='55000');
      await client.query('rollback to savepoint before_credit_declaration');assert.deepEqual(await readContract(),before);
    } finally {await client.query('rollback');}
  }
  await client.query('begin');
  try {
    await client.query(historicalIntents);await declareHistorical();const before=await readContract();await client.query(migration);assert.deepEqual(await readContract(),before);
    const withLater={...before,features:[...before.features,'fixture.independent-credit.v1']};
    const sql=(await client.query("select format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal($1::text)||'::jsonb') as sql",[JSON.stringify(withLater)])).rows[0].sql;
    await client.query(sql);await client.query(migration);assert.deepEqual(await readContract(),withLater);assertBackendContract(await readContract());
  } finally {await client.query('rollback');}
  console.log('Credit policy declaration rejected nine incomplete boundaries and preserved independently reviewed features.');
} finally {await client.end();}
