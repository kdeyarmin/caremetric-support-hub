import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
const url=new URL(process.env.HUB_TEST_DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'54322');
const db=new pg.Client({connectionString:url.href});await db.connect();
const declaration=await readFile(new URL('../supabase/migrations/20260912002345_governed_course_media_contract.sql',import.meta.url),'utf8');
const read=async()=> (await db.query('select hub.get_backend_contract() as value')).rows[0].value;
try{
  for(const sql of [
    "create or replace function private.governed_learning_schema() returns json language sql immutable set search_path='' as $$ select '{}'::json $$",
    'grant execute on function private.validate_governed_learning_source(text,text) to authenticated',
    "create or replace function private.validate_governed_learning_source(text,text) returns jsonb language sql set search_path='' as $$ select '{}'::jsonb $$",
  ]){
    await db.query('begin');try{const before=await read();await db.query(sql);await db.query('savepoint reviewed');
      await assert.rejects(db.query(declaration),error=>error.code==='55000');await db.query('rollback to savepoint reviewed');assert.deepEqual(await read(),before);
    }finally{await db.query('rollback');}
  }
  await db.query('begin');try{
    const value=await read();value.features.push('fixture.independent.v1');
    await db.query("create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='' as $$ select '"+JSON.stringify(value)+"'::jsonb $$");
    await db.query(declaration);assert.deepEqual(await read(),value);await db.query(declaration);assert.deepEqual(await read(),value);
  }finally{await db.query('rollback');}
  console.log('Media declaration rejects missing schema, weakened validation and public execution; additive declarations are idempotent.');
}finally{await db.end();}
