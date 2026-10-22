import {withSession,HttpError} from './sms-auth.mjs';
import {generationOperationSchema,projectGenerationResult,generationMessage} from '../src/learning/generationProtocol.ts';

const target='https://cmcarebase.com/api/learning-generation/run';
// CareBase answers within about 2 minutes 20 seconds; leave room for its own timeout reply.
const TIMEOUT_MS=160000;
const fail=(status,code,message)=>Object.assign(new HttpError(status,'Generation request could not be completed.',code),message?{publicMessage:message}:{});
async function boundedJson(response,limit,signal) {
  if(!response.body)return null;
  const reader=response.body.getReader(),chunks=[];let size=0;
  const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
  try {
    for(;;){signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;if(size>limit){await reader.cancel();throw fail(503,'upstream');}chunks.push(Buffer.from(value));}
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size)));}catch{return null;}
  } finally{signal.removeEventListener('abort',cancel);reader.releaseLock();}
}
/** AI drafting, block regeneration and avatar video. CareBase re-verifies the administrator again when it saves. */
export function learningGeneration({pool,issue,fetchImpl=fetch}) {
  return async (sessionToken,input,requestSignal) => {
    let operation;
    try{operation=generationOperationSchema.parse(input);}catch{throw fail(400,'invalid_request');}
    const signal=AbortSignal.any([...(requestSignal?[requestSignal]:[]),AbortSignal.timeout(TIMEOUT_MS)]);
    try {
      signal.throwIfAborted();
      const capability=await issue(sessionToken,'carebase.learning',operation);
      signal.throwIfAborted();
      const response=await fetchImpl(target,{method:'POST',headers:{Authorization:`Bearer ${capability}`,'Content-Type':'application/json'},
        body:JSON.stringify(operation),signal,redirect:'error',cache:'no-store'});
      if(!response.ok){
        // Only the code and an administrator message cross; nothing else of the body is kept.
        const error=(await boundedJson(response,8192,signal))?.error,code=typeof error?.code==='string'?error.code:'',message=generationMessage(error?.message);
        const status=response.status;
        if(status===401)throw fail(401,'unauthenticated');
        if(status===403)throw fail(403,'forbidden',message);
        if(status===409)throw fail(409,'conflict',message);
        if(status===400||status===404||status===413)throw fail(400,'invalid_request',message);
        if(status===504)throw fail(504,'timeout',message);
        if(status===503&&['unconfigured','provider_runtime_busy'].includes(code))throw fail(503,code,message);
        throw fail(status===502?502:503,'upstream',message);
      }
      const result=projectGenerationResult(await boundedJson(response,1100000,signal),operation);
      // A logout or revocation while the provider ran must keep the result from the browser.
      await withSession(pool,sessionToken,async db=>{signal.throwIfAborted();await db.query('select hub.authorize_app_command() as actor');});
      return result;
    } catch(error) {
      if(error instanceof HttpError)throw error;
      if(signal.aborted)throw fail(504,'timeout');
      const status=error.code==='42501'?403:error.code==='28000'?401:503;
      throw fail(status,status===403?'forbidden':status===401?'unauthenticated':'upstream');
    }
  };
}
