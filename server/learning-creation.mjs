import { withSession, HttpError } from './sms-auth.mjs';
import { callNativeAdmin } from './admin-transport.mjs';
import { creationOperationSchema, creationIntentSchema, creationResumeSchema, projectCreationResult, verifyCreationResult } from '../src/learning/creationProtocol.ts';
import { projectAuthoringResult } from '../src/learning/authoringProtocol.ts';

export function learningCreation({pool,issue,fetchImpl=fetch}) {
  return async(sessionToken,input,requestSignal)=>{
    let op;
    try {op=creationOperationSchema.parse(input);} catch {throw new HttpError(400,'Invalid course creation request.','invalid_request');}
    const signal=AbortSignal.any([...(requestSignal?[requestSignal]:[]),AbortSignal.timeout(12000)]);
    const local=work=>withSession(pool,sessionToken,async db=>{
      signal.throwIfAborted();await db.query('select hub.authorize_app_command()');await db.query('reset role');
      const result=await work(db);signal.throwIfAborted();return result;
    });
    const native=async operation=>{
      signal.throwIfAborted();const capability=await issue(sessionToken,'carebase.learning',operation);signal.throwIfAborted();
      return callNativeAdmin(fetchImpl,'https://cmcarebase.com/api/learning-admin/authoring','Authorization',capability,operation,
        value=>operation.operation==='source'?projectAuthoringResult(value,operation):projectCreationResult(value,operation),true,signal,operation.operation==='source'?4100000:32768);
    };
    const read=async(db,query,args)=>creationIntentSchema.parse((await db.query(query,args)).rows[0].value);
    const finish=async(intent,result)=>{
      const verified=verifyCreationResult(result,intent.preview);
      // The current source may have changed after the initial creation. Register
      // its identity, but preserve the initial snapshot only if its SHA matches.
      const source=intent.registration?null:await native({operation:'source',courseId:verified.courseId,versionId:verified.versionId});
      return local(db=>read(db,'select private.register_course_creation($1,$2::jsonb,$3,$4) as value',
        [intent.request.requestId,JSON.stringify(verified),source?.payload??null,source?.sourceRevision??null]));
    };
    try {
      if(op.operation==='creationOptions') return await native(op);
      if(op.operation==='resume') return await local(async db=>creationResumeSchema.parse((await db.query('select private.list_course_creations($1) as value',[op.offset??0])).rows[0].value));
      if(op.operation==='discard') return await local(async db=>(await db.query('select private.discard_course_creation($1) as value',[op.requestId])).rows[0].value);
      if(op.operation==='preview') {
        await local(db=>read(db,'select private.reserve_course_creation($1::jsonb) as value',[JSON.stringify(op)]));
        const preview=await native(op);
        return await local(db=>read(db,'select private.remember_course_creation($1,$2::jsonb) as value',[op.requestId,JSON.stringify(preview)]));
      }
      if(op.operation==='recover') {
        const intent=await local(db=>read(db,'select private.get_course_creation($1) as value',[op.requestId]));
        const status=await native({operation:'creationStatus',requestId:intent.request.requestId,courseId:intent.request.courseId,versionId:intent.request.parameters.versionId});
        if(status.status==='absent') {
          if(intent.result)throw new HttpError(409,'The recorded native course is unavailable.','conflict');
          await local(db=>read(db,'select private.get_course_creation($1) as value',[op.requestId]));
          return {status:'absent',intent};
        }
        if(!intent.preview)throw new HttpError(409,'Recover the original preview before registering this course.','conflict');
        return {status:'applied',intent:await finish(intent,status.result)};
      }
      const intent=await local(db=>read(db,'select private.dispatch_course_creation($1,$2) as value',[op.commandId,op.expectedDigest]));
      return await finish(intent,await native(op));
    } catch(error) {
      if(error instanceof HttpError)throw error;
      const code=({42501:'forbidden',28000:'unauthenticated',40001:'conflict',22023:'invalid_request','22P02':'invalid_request'})[error.code]??'upstream';
      throw new HttpError(code==='forbidden'?403:code==='unauthenticated'?401:code==='conflict'?409:code==='invalid_request'?400:503,
        'Course creation could not be confirmed. Recover the saved request before starting another course.',code);
    }
  };
}
