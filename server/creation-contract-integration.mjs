import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { assertBackendContract } from '../src/lib/backendContract.ts';
const local=new URL(process.env.HUB_TEST_DATABASE_URL);assert.equal(local.hostname,'127.0.0.1');assert.equal(local.port,'54322');
const db=new pg.Client({connectionString:local.href});await db.connect();
const gate=await readFile(new URL('../supabase/migrations/20260911212027_governed_course_creation_contract.sql',import.meta.url),'utf8');
const read=async()=>(await db.query('select hub.get_backend_contract() as value')).rows[0].value;
try {
  assertBackendContract(await read());
  const omissions=[
    'alter function private.course_creation_actor() rename to fixture_missing_creation_actor',
    'alter function private.register_course_creation(uuid,jsonb,text,text) rename to fixture_missing_creation_registration',
    'alter table private.course_creation_intents rename to fixture_missing_creation_intents',
    'grant select on private.course_creation_intents to authenticated',
    'grant insert on private.course_creation_intents to hub_app_server',
    'grant execute on function private.register_course_creation(uuid,jsonb,text,text) to authenticated',
    'revoke execute on function private.register_course_creation(uuid,jsonb,text,text) from hub_app_server',
    "create or replace function private.course_creation_actor() returns jsonb language plpgsql stable security definer set search_path='' as $$ begin return hub.authorize_app_command(); end; $$",
  ];
  for(const omission of omissions){await db.query('begin');try {await db.query(omission);await assert.rejects(db.query(gate),error=>error.code==='55000');}finally{await db.query('rollback');}}
  await db.query('begin');try {
    const contract=await read(),future={...contract,features:[...contract.features,'synthetic.independent.v1']};
    const declaration=(await db.query("select format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal($1::text)||'::jsonb') as value",[JSON.stringify(future)])).rows[0].value;
    await db.query(declaration);await db.query(gate);assert.deepEqual(await read(),future);assertBackendContract(await read());
  }finally{await db.query('rollback');}
  console.log('Course creation gate rejected eight absent or weakened boundaries and preserved independently reviewed features.');
}finally{await db.end();}
