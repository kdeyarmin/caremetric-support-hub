import {withSession,HttpError} from './sms-auth.mjs';
import {callNativeAdmin} from './admin-transport.mjs';
import {providerOperationSchema,projectProviderResult} from '../src/learning/providerPolicyProtocol.ts';

export function learningProvider({pool,issue,fetchImpl=fetch}) {
  return async (sessionToken,input,requestSignal) => {
    let operation;
    try {operation=providerOperationSchema.parse(input);}catch{throw new HttpError(400,'Invalid provider request.','invalid_request');}
    const signal=AbortSignal.any([...(requestSignal?[requestSignal]:[]),AbortSignal.timeout(12000)]);
    const run=async()=>{
      signal.throwIfAborted();
      const capability=await issue(sessionToken,'carebase.learning',operation);
      signal.throwIfAborted();
      const result=await callNativeAdmin(fetchImpl,'https://cmcarebase.com/api/learning-admin/provider','Authorization',capability,operation,
        value=>projectProviderResult(value,operation),true,signal,1048576);
      // Revalidate the opaque session and current relational authority after I/O,
      // even for a durable receipt. The native ledger alone owns the command.
      await withSession(pool,sessionToken,async db=>{
        signal.throwIfAborted(); await db.query('select hub.authorize_app_command() as actor'); signal.throwIfAborted();
      });
      return result;
    };
    let abort=()=>{};
    try {
      return await Promise.race([run(),new Promise((_,reject)=>{
        abort=()=>reject(new HttpError(503,'Provider request did not finish. Check its saved result.','upstream'));
        if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
      })]);
    }catch(error) {
      if(error instanceof HttpError)throw error;
      const status=error.code==='42501'?403:error.code==='28000'?401:503;
      throw new HttpError(status,'Provider request could not be completed.',status===503?'upstream':undefined);
    }finally{signal.removeEventListener('abort',abort);}
  };
}
