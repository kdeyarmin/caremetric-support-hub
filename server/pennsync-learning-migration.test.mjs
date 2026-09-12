import {expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {digest} from './sms-auth.mjs';
import {pennsyncLearningMigration} from './pennsync-learning-migration.mjs';
import {summarizePennsyncSource,validatePennsyncSource} from '../src/imports/pennsyncLearningSource.ts';
const payload=readFileSync('src/imports/fixtures/pennsyncLearningSource.json','utf8'),revision=digest(payload),id='11111111-1111-4111-8111-111111111111';
const summary=summarizePennsyncSource(await validatePennsyncSource(payload,revision));
function setup({head=null,revoked=false,changed=false}={}){
 const query=vi.fn(async(sql,args)=>{
  if(sql.includes('select s.id,s.user_id'))return {rows:[{id,user_id:id}]};
  if(sql.includes('authorize_app_command')&&revoked)throw Object.assign(new Error('private'),{code:'42501'});
  if(sql.includes('pennsync_learning_head'))return {rows:[{value:head?{sourceRevision:head,snapshotId:id}:null}]};
  if(sql.includes('pennsync_learning_preserve'))return {rows:[{value:{sourceRevision:revision,headRevision:revision,snapshotId:id,replayed:false,summary}}]};
  void args;return {rows:[]};
 });
 const pool={connect:async()=>({query,release:vi.fn()})},issue=vi.fn(async()=>'cmh_'+'x'.repeat(43));
 const fetchImpl=vi.fn(async()=>Response.json({contractVersion:1,product:'pennsync',operation:'learning.source.snapshot',data:{payload,sourceRevision:changed?'b'.repeat(64):revision}}));
 return {run:pennsyncLearningMigration({pool,issue,fetchImpl}),query,issue,fetchImpl};
}
it('browser inspection receives only counts and catalog metadata, with no source payload or learner identity',async()=>{
 const f=setup();const result=await f.run('x'.repeat(43),{operation:'inspect'});
 expect(result).toMatchObject({sourceRevision:revision,headRevision:null,summary});expect(JSON.stringify(result)).not.toContain('unmatched@example.test');expect(result.payload).toBeUndefined();
 expect(f.issue).toHaveBeenCalledWith('x'.repeat(43),'pennsync',{operation:'learning.source.snapshot'});
 expect(f.fetchImpl.mock.calls[0][1].headers['X-CareMetric-Hub-Authorization']).toMatch(/^Bearer cmh_/);
});
it('preservation fetches native source again and only passes verified bytes to private SQL',async()=>{
 const f=setup();await f.run('x'.repeat(43),{operation:'preserve',sourceRevision:revision,expectedHeadRevision:null,reviewed:true});
 expect(f.fetchImpl).toHaveBeenCalledTimes(1);const args=f.query.mock.calls.find(([sql])=>sql.includes('pennsync_learning_preserve'))[1];expect(args.slice(0,4)).toEqual([payload,revision,null,JSON.stringify(summary)]);expect(Date.parse(args[4])-Date.now()).toBeGreaterThan(10000);
});
it('changed source, checksum tampering and revoked authority prevent staging',async()=>{
 for(const options of [{changed:true},{revoked:true},{}]){
  const f=setup(options);await expect(f.run('x'.repeat(43),{operation:'preserve',sourceRevision:'c'.repeat(64),expectedHeadRevision:null,reviewed:true})).rejects.toBeDefined();
  expect(f.query.mock.calls.some(([sql])=>sql.includes('pennsync_learning_preserve'))).toBe(false);
 }
});
it('unsupported source URLs and extra caller fields never reach the native transport',async()=>{
 const f=setup();await expect(f.run('x'.repeat(43),{operation:'inspect',url:'https://other.test'})).rejects.toMatchObject({status:400});expect(f.issue).not.toHaveBeenCalled();
});
it('cancelled pool waits terminate without staging',async()=>{
 const controller=new AbortController();const run=pennsyncLearningMigration({pool:{connect:()=>new Promise(()=>{})},issue:vi.fn()});
 const pending=run('x'.repeat(43),{operation:'inspect'},controller.signal);controller.abort();await expect(pending).rejects.toMatchObject({status:503});
});
