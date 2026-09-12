import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {assertBackendContract} from '../src/lib/backendContract.ts';
const local=new URL(process.env.HUB_TEST_DATABASE_URL);assert.equal(local.hostname,'127.0.0.1');assert.equal(local.port,'54322');
const db=new pg.Client({connectionString:local.href});await db.connect();
const gate=await readFile(new URL('../supabase/migrations/20260911234549_governed_course_distribution_contract.sql',import.meta.url),'utf8');
const read=async()=>(await db.query('select hub.get_backend_contract() as value')).rows[0].value;
try{
  assertBackendContract(await read());
  const omissions=[
    'alter function private.current_distribution_actor() rename to fixture_missing_distribution_wallclock',
    "create or replace function private.current_distribution_actor() returns jsonb language sql security definer set search_path='' as $$select private.course_creation_actor()$$",
    'alter table private.learning_distribution_intents rename to fixture_missing_distribution_intents',
    'alter function private.commit_course_distribution(uuid,text,uuid,boolean) rename to fixture_missing_distribution_commit',
    'alter function private.release_distribution_status_batch(uuid) rename to fixture_missing_distribution_retry',
    'grant select on private.learning_distribution_intents to authenticated',
    'grant insert on private.learning_distribution_observations to hub_app_server',
    'grant execute on function private.record_distribution_status_batch(uuid,timestamptz,jsonb) to service_role',
    'revoke execute on function private.commit_course_distribution(uuid,text,uuid,boolean) from hub_app_server',
    'alter table private.learning_distribution_revisions disable trigger learning_distribution_provenance_immutable',
    "create or replace function private.commit_course_distribution(p_request_id uuid,p_expected_digest text,p_observation_id uuid,p_allow_legacy boolean) returns jsonb language sql security definer set search_path='' as $$select null::jsonb$$",
    "create or replace function private.course_distribution_available(p_item_id uuid,p_revision_id uuid) returns boolean language sql security definer set search_path='' as $$select true$$",
    "create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='' as $$select null::jsonb$$",
  ];
  for(const sql of omissions){await db.query('begin');try{await db.query(sql);await assert.rejects(db.query(gate),error=>error.code==='55000');}finally{await db.query('rollback');}}
  await db.query('begin');try{
    const before=await read();await db.query(gate);assert.deepEqual(await read(),before);
    const future={...before,features:[...before.features,'fixture.independent-distribution.v1']};
    const sql=(await db.query("select format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal($1::text)||'::jsonb') as sql",[JSON.stringify(future)])).rows[0].sql;
    await db.query(sql);await db.query(gate);assert.deepEqual(await read(),future);assertBackendContract(await read());
  }finally{await db.query('rollback');}
  console.log('Distribution declaration rejected thirteen incomplete permission, observer, immutable revision and freshness boundaries, preserving independent features.');
}finally{await db.end();}
