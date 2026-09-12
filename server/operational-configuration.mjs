import {withSession,HttpError} from './sms-auth.mjs';
import {callNativeAdmin} from './admin-transport.mjs';
import { boundedSession } from './bounded-session.mjs';
import {parseConfigurationOperation} from '../supabase/functions/_shared/operationalConfiguration.ts';
import {projectConfigurationResult} from '../src/admin/configurationProtocol.ts';
export function operationalConfiguration({pool,issue,fetchImpl=fetch}){
  return async(sessionToken,input,requestSignal)=>{
    let operation;try{operation=parseConfigurationOperation(input);}catch{throw new HttpError(400,'Invalid operational configuration request.','invalid_request');}
    const signal=AbortSignal.any([...(requestSignal?[requestSignal]:[]),AbortSignal.timeout(12000)]);
    const run=async()=>{
      signal.throwIfAborted();const capability=await issue(sessionToken,'carebase.command',operation);signal.throwIfAborted();
      const result=await callNativeAdmin(fetchImpl,'https://cmcarebase.com/api/platform-admin/configuration','Authorization',capability,operation,
        value=>projectConfigurationResult(value,operation),true,signal,1048576);
      await boundedSession(pool,sessionToken,signal,async db=>{signal.throwIfAborted();await db.query('select hub.authorize_app_command() as actor');signal.throwIfAborted();});
      return result;
    };
    let abort=()=>{};
    try{return await Promise.race([run(),new Promise((_,reject)=>{abort=()=>reject(new HttpError(503,'Configuration request did not finish. Check its saved result.','upstream'));
      if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});})]);}
    catch(error){if(error instanceof HttpError)throw error;const status=error.code==='42501'?403:error.code==='28000'?401:503;
      throw new HttpError(status,'Configuration request could not be completed.',status===503?'upstream':undefined);}
    finally{signal.removeEventListener('abort',abort);}
  };
}
