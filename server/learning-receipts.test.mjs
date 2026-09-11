import { expect, it, vi } from 'vitest';
import { learningReceipts } from './learning-receipts.mjs';
const id='abf00000-0000-4000-8000-000000000001';
const state={mappings:[],receipts:[],tenants:[],users:[],snapshots:[],mappingTotal:0,receiptTotal:0};
function fixture(overrides={}) {
  const query=vi.fn(async(sql)=>{
    if(sql.includes('select s.id,s.user_id')) return {rows:[{id,user_id:id}]};
    if(sql==='select hub.authorize_app_command() as actor') {
      if(overrides.revoked) throw Object.assign(new Error('private native detail'),{code:'42501'});
      return {rows:[{actor:{user_id:id,session_id:id,method:'sms'}}]};
    }
    if(sql.startsWith('select hub.get_learning_receipt_status')) return {rows:[{result:{...state,private:'must not leave server'}}]};
    return {rows:[]};
  });
  const release=vi.fn();const pool={connect:async()=>({query,release})};const issue=vi.fn();
  return {query,release,issue,run:learningReceipts({pool,issue,fetchImpl:vi.fn()})};
}
it('uses fresh session authority and fixed SQL while projecting status',async()=>{
  const f=fixture();expect(await f.run('x'.repeat(43),{operation:'status'})).toEqual(state);
  expect(f.query.mock.calls.map(c=>c[0])).toContain('select hub.authorize_app_command() as actor');
  expect(f.query.mock.calls.some(c=>c[0].includes('p_actor_id=>$1::uuid,p_session_id=>$2::uuid'))).toBe(true);
  expect(f.issue).not.toHaveBeenCalled();expect(f.release).toHaveBeenCalledTimes(1);
});
it('cannot turn a learning request into an arbitrary SQL RPC',async()=>{
  const f=fixture();await expect(f.run('x'.repeat(43),{operation:'status',rpc:'execute_sql'})).rejects.toMatchObject({status:400,code:'invalid_request'});
  expect(f.query).not.toHaveBeenCalled();
});
it('sanitizes current actor revocation before returning database status',async()=>{
  const f=fixture({revoked:true});await expect(f.run('x'.repeat(43),{operation:'status'})).rejects.toMatchObject({status:403,code:'forbidden',message:'Learning request could not be completed.'});
  expect(f.query.mock.calls.some(c=>c[0].startsWith('select hub.get_learning_receipt_status'))).toBe(false);
});
it('caller cancellation bounds even a pool connection that never resolves',async()=>{
  const controller=new AbortController();const run=learningReceipts({pool:{connect:()=>new Promise(()=>{})},issue:vi.fn(),fetchImpl:vi.fn()});
  const result=run('x'.repeat(43),{operation:'status'},controller.signal);controller.abort();
  await expect(result).rejects.toMatchObject({status:503,code:'upstream'});
});
