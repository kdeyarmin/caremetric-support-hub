import { HttpError } from './sms-auth.mjs';
import { distributionStatusDomain,distributionStatusRequestSchema,projectDistributionStatuses } from '../src/learning/distributionProtocol.ts';
const endpoint='https://cmcarebase.com/api/internal/learning/distribution-status';
const fail=()=>new HttpError(503,'Current course availability could not be verified.','upstream');
export async function observerQuery(pool,sql,parameters,requestSignal){
  const signal=AbortSignal.any([...(requestSignal?[requestSignal]:[]),AbortSignal.timeout(12000)]);
  signal.throwIfAborted();let connection,released=false,rejectAbort;
  const aborted=new Promise((_,reject)=>{rejectAbort=reject;});
  const release=destroy=>{if(connection&&!released){released=true;connection.release(destroy);}};
  const abort=()=>{release(true);rejectAbort(fail());};signal.addEventListener('abort',abort,{once:true});
  const work=async()=>{
    connection=await pool.connect();if(signal.aborted){release(true);throw fail();}
    await connection.query('begin');
    await connection.query("set local statement_timeout='9s'; set local lock_timeout='3s'");
    const result=await connection.query(sql,parameters);signal.throwIfAborted();
    await connection.query('commit');return result;
  };
  try{return await Promise.race([work(),aborted]);}
  catch(error){release(true);throw error;}
  finally{signal.removeEventListener('abort',abort);release(false);}
}
async function boundedJson(response,signal){
  if(!response.body)throw fail();const reader=response.body.getReader(),chunks=[];let length=0;
  const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
  try{
    for(;;){signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;
      length+=value.byteLength;if(length>16384){await reader.cancel();throw fail();}chunks.push(Buffer.from(value));}
    signal.throwIfAborted();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,length)));
  }finally{signal.removeEventListener('abort',abort);reader.releaseLock();}
}
/** A dedicated native metadata reader. It has no human authoring delegation and
 * can never create a course, approve a revision or mutate learner evidence. */
export function distributionObserver({pool,token,fetchImpl=fetch,now=()=>Date.now()}){
  const configured=typeof token==='string'&&/^[A-Za-z0-9_-]{43}$/.test(token);
  let running=false;
  async function read(courseIds,requestSignal){
    if(!configured)throw new HttpError(503,'The course availability observer is not configured.','unconfigured');
    const operation=distributionStatusRequestSchema.parse({domain:distributionStatusDomain,operation:'status',courseIds});
    const signal=AbortSignal.any([...(requestSignal?[requestSignal]:[]),AbortSignal.timeout(12000)]);
    const response=await fetchImpl(endpoint,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      body:JSON.stringify(operation),signal,redirect:'error',cache:'no-store'});
    if(!response.ok){await response.body?.cancel();throw fail();}
    const raw=await boundedJson(response,signal),items=projectDistributionStatuses(raw,operation.courseIds,now());
    return {items,generatedAt:raw.generatedAt};
  }
  async function tick(){
    if(!configured||running)return {batches:0,courses:0};running=true;
    const stop=AbortSignal.timeout(120000);let batches=0,courses=0;
    try{
      // Drain due work in small leases, rather than checking only ten courses
      // every five minutes. Both run time and total work remain bounded.
      for(let index=0;index<100;index++){
        stop.throwIfAborted();const lease=(await observerQuery(pool,'select private.claim_distribution_status_batch() as value',[],stop)).rows[0].value;
        if(!lease.courseIds.length)break;
        let value;
        try { value=await read(lease.courseIds,stop); }
        catch {
          await observerQuery(pool,'select private.release_distribution_status_batch($1)',[lease.leaseId],stop);
          stop.throwIfAborted();continue;
        }
        const count=(await observerQuery(pool,'select private.record_distribution_status_batch($1,$2,$3::jsonb) as value',[lease.leaseId,value.generatedAt,JSON.stringify(value.items)],stop)).rows[0].value;
        batches++;courses+=count;
      }
      return {batches,courses};
    }finally{running=false;}
  }
  return {configured,read,tick};
}
