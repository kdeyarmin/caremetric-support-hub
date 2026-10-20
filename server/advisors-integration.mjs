// Real PostgreSQL deployment-gate tests for the Advisors bridge. Never run against a hosted database.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
const databaseUrl=process.env.HUB_TEST_DATABASE_URL;
const local=new URL(databaseUrl);assert.equal(local.hostname,'127.0.0.1');assert.equal(local.port,'54322');
const client=new pg.Client({connectionString:databaseUrl});await client.connect();
const contractMigration=await readFile(new URL('../supabase/migrations/20261020150100_advisors_application_contract.sql',import.meta.url),'utf8');
const registration=await readFile(new URL('../supabase/migrations/20261020150000_advisors_application.sql',import.meta.url),'utf8');
const readContract=async()=>(await client.query('select hub.get_backend_contract() as data')).rows[0].data;
try{
  const current=await readContract();
  assert.ok(current.features.includes('platform.admin.advisors.v1'));
  await client.query('begin');
  try{
    const faqRevisions=(await client.query("select count(*)::int as n from hub.content_revisions r join hub.content_items i on i.id=r.item_id where i.content_key like 'advisors.faq.%'")).rows[0].n;
    await client.query(registration);await client.query(contractMigration);
    assert.deepEqual(await readContract(),current,'replaying the registration and declaration is idempotent');
    assert.equal((await client.query("select count(*)::int as n from hub.content_revisions r join hub.content_items i on i.id=r.item_id where i.content_key like 'advisors.faq.%'")).rows[0].n,faqRevisions,'a replay never duplicates an FAQ revision');
  }finally{await client.query('rollback');}
  for(const change of [
    "update hub.products set status='retired' where slug='advisors'",
    "update hub.products set support_enabled=false where slug='advisors'",
    // NOT VALID keeps existing Advisors rows; the gate must still refuse the narrower constraint.
    `alter table private.app_delegations drop constraint app_delegations_audience_check;
     alter table private.app_delegations add constraint app_delegations_audience_check check(audience in ('carebase','breathe','caremetric-emr','pennsync','caremetric-go','intel','carebase.command','carebase.learning','publication','media')) not valid`,
    "alter function hub.authorize_app_admin() rename to fixture_missing_admin_authority",
  ]){
    await client.query('begin');
    try{await client.query(change);await assert.rejects(client.query(contractMigration),error=>error.code==='55000');}
    finally{await client.query('rollback');}
  }
  console.log('Advisors bridge: idempotent registration, pinned FAQ revisions and four incomplete deployment boundaries rejected.');
}finally{await client.end();}
