import { withSession, HttpError } from './sms-auth.mjs';
import { callNativeAdmin } from './admin-transport.mjs';
import { authoringOperationSchema, authoringPreviewSchema, projectAuthoringResult, verifyAuthoringOutcome, governedStageResultSchema } from '../src/learning/authoringProtocol.ts';

export function learningAuthoring({pool,issue,fetchImpl=fetch}) {
  return async (sessionToken,input,requestSignal) => {
    let op;
    try {op=authoringOperationSchema.parse(input);} catch {throw new HttpError(400,'Invalid course request.','invalid_request');}
    const signal=AbortSignal.any([...(requestSignal?[requestSignal]:[]),AbortSignal.timeout(12000)]);
    const local=work=>withSession(pool,sessionToken,async db=>{
      signal.throwIfAborted();
      await db.query('select hub.authorize_app_command() as actor');
      signal.throwIfAborted();
      return work(db);
    });
    const native=async operation=>{
      signal.throwIfAborted();
      const capability=await issue(sessionToken,'carebase.learning',operation);
      signal.throwIfAborted();
      return callNativeAdmin(fetchImpl,'https://cmcarebase.com/api/learning-admin/authoring','Authorization',capability,operation,
        value=>projectAuthoringResult(value,operation),true,signal,operation.operation==='source'?4100000:1000000);
    };
    const heads=async db=>(await db.query('select hub.list_learning_source_heads() as value')).rows[0].value;
    const headFor=(rows,courseId)=>rows.find(row=>row.sourceCourseId.toLowerCase()===courseId.toLowerCase());
    const run=async()=>{
      if(op.operation==='inspect') return native(op);
      if(op.operation==='source' || op.operation==='preserve_source') {
        const source=await native({operation:'source',courseId:op.courseId,versionId:op.versionId});
        if(op.operation==='source') {
          const head=await local(async db=>headFor(await heads(db),op.courseId));
          return {...source,headRevision:head?.sourceRevision??null,snapshotId:head?.sourceRevision===source.sourceRevision?head.snapshotId:null};
        }
        if(source.sourceRevision!==op.sourceRevision) throw new HttpError(409,'Course material changed. Review it again.','conflict');
        return local(async db=>governedStageResultSchema.parse((await db.query('select hub.stage_learning_source($1,$2,$3) as value',
          [source.payload,source.sourceRevision,op.expectedHeadRevision])).rows[0].value));
      }
      if(op.operation==='preview') {
        // Confirm the selected source has a current preserved head before asking
        // the native owner for a preview. SQL rechecks this after the response.
        const head=await local(async db=>headFor(await heads(db),op.courseId));
        if(!head || head.sourceRevision!==op.parameters.sourceRevision) throw new HttpError(409,'Review and preserve this source before previewing changes.','conflict');
        const preview=await native(op);
        return local(async db=>authoringPreviewSchema.parse((await db.query('select hub.remember_learning_authoring_preview($1,$2::jsonb) as value',
          [head.snapshotId,JSON.stringify(preview)])).rows[0].value));
      }
      // The private record binds this exact native command to its reviewed,
      // immutable source. Native CAS controls the initial write; retries use the
      // same command identity and cannot manufacture a second version.
      const intent=await local(async db=>(await db.query('select hub.get_learning_authoring_intent($1,$2) as value',[op.commandId,op.expectedDigest])).rows[0].value);
      const preview=authoringPreviewSchema.parse(intent.preview);
      if(intent.result) verifyAuthoringOutcome(intent.result,preview);
      // Even a completed retry must recheck the mapped native administrator.
      // Native apply returns the original immutable outcome without another write.
      const result=verifyAuthoringOutcome(await native(op),preview);
      return local(async db=>verifyAuthoringOutcome((await db.query('select hub.record_learning_authoring_result($1,$2,$3::jsonb) as value',
        [op.commandId,op.expectedDigest,JSON.stringify(result)])).rows[0].value,preview));
    };
    let abort=()=>{};
    try {
      return await Promise.race([run(),new Promise((_,reject)=>{abort=()=>reject(new HttpError(503,'Course request did not finish. Retry the same request.','upstream'));
        if(signal.aborted) abort(); else signal.addEventListener('abort',abort,{once:true});})]);
    } catch(error) {
      if(error instanceof HttpError) throw error;
      const code=({42501:'forbidden',28000:'unauthenticated',40001:'conflict',22023:'invalid_request'})[error.code]??'upstream';
      throw new HttpError(code==='forbidden'?403:code==='unauthenticated'?401:code==='conflict'?409:code==='invalid_request'?400:503,'Course request could not be completed.',code);
    } finally {signal.removeEventListener('abort',abort);}
  };
}
