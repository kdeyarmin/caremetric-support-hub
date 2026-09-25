import {HttpError} from './sms-auth.mjs';
import {callNativeAdmin} from './admin-transport.mjs';
import {boundedSession} from './bounded-session.mjs';
import {parseTrainingOperation,projectTrainingResponse} from '../supabase/functions/_shared/trainingProtocol.ts';

/** Training stays in its native database. The Hub delegates only the exact reviewed operation. */
export function trainingAdministration({pool,issue,fetchImpl=fetch}) {
  return async(sessionToken,input,requestSignal)=>{
    let operation;
    try {operation=parseTrainingOperation(input);} catch {throw new HttpError(400,'Invalid training request.','invalid_request');}
    const signal=AbortSignal.any([...(requestSignal?[requestSignal]:[]),AbortSignal.timeout(12000)]);
    const run=async()=>{
      signal.throwIfAborted();
      const capability=await issue(sessionToken,'carebase.command',operation,signal);
      signal.throwIfAborted();
      const result=await callNativeAdmin(fetchImpl,'https://cmcarebase.com/api/platform-admin/training','Authorization',capability,operation,
        value=>projectTrainingResponse(value,operation),true,signal,operation.operation==='enrollments.report'&&operation.limit===10000?12_000_000:1_048_576);
      await boundedSession(pool,sessionToken,signal,async db=>{
        signal.throwIfAborted();await db.query('select hub.authorize_app_command() as actor');signal.throwIfAborted();
      });
      return result;
    };
    let abort=()=>{};
    try {return await Promise.race([run(),new Promise((_,reject)=>{
      abort=()=>reject(new HttpError(503,'Training request did not finish. Retry the same saved request.','upstream'));
      if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
    })]);} catch(error) {
      if(error instanceof HttpError)throw error;
      const status=error.code==='42501'?403:error.code==='28000'?401:503;
      throw new HttpError(status,'Training request could not be completed.',status===503?'upstream':undefined);
    } finally {signal.removeEventListener('abort',abort);}
  };
}
