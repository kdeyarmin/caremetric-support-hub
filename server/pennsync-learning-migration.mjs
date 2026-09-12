import {withSession,HttpError} from './sms-auth.mjs';
import {callNativeAdmin} from './admin-transport.mjs';
import {adminRegistry} from '../supabase/functions/_shared/adminRegistry.ts';
import {pennsyncMigrationOperation,pennsyncMigrationResult,validatePennsyncSource,summarizePennsyncSource} from '../src/imports/pennsyncLearningSource.ts';

export function pennsyncLearningMigration({pool,issue,fetchImpl=fetch}) {
  return async(sessionToken,input,requestSignal)=>{
    let operation;
    try{operation=pennsyncMigrationOperation.parse(input);}catch{throw new HttpError(400,'Invalid source migration request.','invalid_request');}
    const deadline=Date.now()+15000;
    const signal=AbortSignal.any([...(requestSignal?[requestSignal]:[]),AbortSignal.timeout(15000)]);
    const local=work=>withSession(pool,sessionToken,async db=>{
      signal.throwIfAborted();
      const remaining=Math.max(1,Math.min(12000,deadline-Date.now()));
      await db.query("select set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)",[remaining+'ms']);
      signal.throwIfAborted();await db.query('select hub.authorize_app_command()');
      await db.query('reset role');
      signal.throwIfAborted();const result=await work(db);
      // Roll back the transaction if its I/O finished after cancellation.
      signal.throwIfAborted();if(Date.now()>=deadline)throw new HttpError(503,'Source request expired.','upstream');
      return result;
    });
    const run=async()=>{
      await local(async db=>(await db.query('select private.pennsync_learning_head() as value')).rows[0].value);
      const native={operation:'learning.source.snapshot'};
      signal.throwIfAborted();
      const capability=await issue(sessionToken,'pennsync',native);
      signal.throwIfAborted();
      const entry=adminRegistry.pennsync;
      const result=await callNativeAdmin(fetchImpl,entry.endpoint,entry.authorizationHeader,capability,native,async envelope=>{
        if(envelope?.contractVersion!==1||envelope.product!=='pennsync'||envelope.operation!==native.operation||typeof envelope.data?.payload!=='string'||typeof envelope.data?.sourceRevision!=='string')throw new Error('Invalid native source');
        const source=await validatePennsyncSource(envelope.data.payload,envelope.data.sourceRevision);
        return {payload:envelope.data.payload,sourceRevision:envelope.data.sourceRevision,summary:summarizePennsyncSource(source)};
      },true,signal,8000000);
      if(operation.operation==='inspect')return local(async db=>{
        const head=(await db.query('select private.pennsync_learning_head() as value')).rows[0].value;
        return pennsyncMigrationResult.parse({sourceRevision:result.sourceRevision,headRevision:head?.sourceRevision??null,
          snapshotId:head?.sourceRevision===result.sourceRevision?head.snapshotId:null,replayed:false,summary:result.summary});
      });
      if(operation.sourceRevision!==result.sourceRevision)throw new HttpError(409,'PennSync source changed. Inspect it again before preserving.','conflict');
      return local(async db=>pennsyncMigrationResult.parse((await db.query('select private.pennsync_learning_preserve($1,$2,$3,$4::jsonb,$5::timestamptz) as value',
        [result.payload,result.sourceRevision,operation.expectedHeadRevision,JSON.stringify(result.summary),new Date(deadline).toISOString()])).rows[0].value));
    };
    let cancel=()=>{};
    try{return await Promise.race([run(),new Promise((_,reject)=>{cancel=()=>reject(new HttpError(503,'Source read did not finish. Retry the same request.','upstream'));if(signal.aborted)cancel();else signal.addEventListener('abort',cancel,{once:true});})]);}
    catch(error){if(error instanceof HttpError)throw error;const code=({42501:'forbidden',28000:'unauthenticated',40001:'conflict',22023:'invalid_request'})[error.code]??'upstream';throw new HttpError(code==='forbidden'?403:code==='unauthenticated'?401:code==='conflict'?409:code==='invalid_request'?400:503,'Source migration did not complete.',code);}
    finally{signal.removeEventListener('abort',cancel);}
  };
}
