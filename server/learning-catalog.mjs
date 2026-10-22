import {withSession,HttpError} from './sms-auth.mjs';
import {callNativeAdmin} from './admin-transport.mjs';
import {catalogOperationSchema,projectCatalogResult} from '../src/learning/catalogProtocol.ts';

/** Training library curation. CareBase owns every record and replays a retried save by its requestId. */
export function learningCatalog({pool,issue,fetchImpl=fetch}) {
  return async (sessionToken,input,requestSignal) => {
    let operation;
    try {operation=catalogOperationSchema.parse(input);}catch{throw new HttpError(400,'Invalid training library request.','invalid_request');}
    const signal=AbortSignal.any([...(requestSignal?[requestSignal]:[]),AbortSignal.timeout(12000)]);
    const run=async()=>{
      signal.throwIfAborted();
      const capability=await issue(sessionToken,'carebase.learning',operation);
      signal.throwIfAborted();
      const result=await callNativeAdmin(fetchImpl,'https://cmcarebase.com/api/learning-admin/catalog','Authorization',capability,operation,
        value=>projectCatalogResult(value,operation),true,signal,2100000);
      // A logout or revocation while CareBase answered must keep the result from the browser.
      await withSession(pool,sessionToken,async db=>{
        signal.throwIfAborted(); await db.query('select hub.authorize_app_command() as actor'); signal.throwIfAborted();
      });
      return result;
    };
    let abort=()=>{};
    try {
      return await Promise.race([run(),new Promise((_,reject)=>{
        abort=()=>reject(new HttpError(503,'Training library request did not finish. Retry the same save.','upstream'));
        if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
      })]);
    }catch(error) {
      if(error instanceof HttpError)throw error;
      const status=error.code==='42501'?403:error.code==='28000'?401:503;
      throw new HttpError(status,'Training library request could not be completed.',status===503?'upstream':undefined);
    }finally{signal.removeEventListener('abort',abort);}
  };
}
