import {withSession,HttpError} from './sms-auth.mjs';
import {generationOperationSchema,projectGenerationResult,generationMessage} from '../src/learning/generationProtocol.ts';

const target='https://cmcarebase.com/api/learning-generation/run';
// CareBase answers within about 2 minutes 20 seconds; leave room for its own timeout reply.
const TIMEOUT_MS=160000;
const fail=(status,code,message)=>Object.assign(new HttpError(status,'Generation request could not be completed.',code),message?{publicMessage:message}:{});
// Why a request ended in 503, for the log line the route writes then (see learningGeneration). Never sent to the browser.
const because=(error,why)=>Object.assign(error,{why});
async function boundedJson(response,limit,signal) {
  if(!response.body)return null;
  const reader=response.body.getReader(),chunks=[];let size=0;
  const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
  try {
    for(;;){signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;if(size>limit){await reader.cancel();throw because(fail(503,'upstream'),{reason:'response_too_large',limit});}chunks.push(Buffer.from(value));}
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size)));}catch{return null;}
  } finally{signal.removeEventListener('abort',cancel);reader.releaseLock();}
}
const word=value=>typeof value==='string'&&/^[A-Za-z0-9_.-]{1,40}$/.test(value)?value:null;
/** A failed check of CareBase's answer, as where and what: a schema path and an issue code, never a value. */
function issueOf(error) {
  const first=error?.issues?.[0];
  if(!first)return word(error?.name)??'rejected';
  const path=first.path.map(part=>typeof part==='number'?part:word(part)??'?').join('.')||'(root)';
  return `${path}: ${word(first.code)??'invalid'}${Array.isArray(first.keys)?` ${first.keys.slice(0,5).map(key=>word(key)??'?').join(',')}`:''}`;
}
// Where a request that failed without a reason of its own had got to.
const stageReasons={delegation:'delegation_failed',request:'carebase_unreachable',response:'response_unreadable',recheck:'session_recheck_failed'};
/**
 * AI drafting, block regeneration and avatar video. CareBase re-verifies the administrator again when it saves.
 *
 * Every 503 writes one line, `hub_learning_generation_unavailable`, with the operation, CareBase's status when it answered, and a
 * reason: `carebase_status` (CareBase answered with an error, and its error code), `response_too_large`, `invalid_result` (an answer
 * that did not match the operation, and the first schema issue), `carebase_unreachable`, `response_unreadable`, `delegation_failed` or
 * `session_recheck_failed` (and the error or database code). Nothing CareBase, HeyGen or the administrator wrote is logged.
 */
export function learningGeneration({pool,issue,fetchImpl=fetch,log=line=>console.warn(line)}) {
  return async (sessionToken,input,requestSignal) => {
    let operation;
    try{operation=generationOperationSchema.parse(input);}catch{throw fail(400,'invalid_request');}
    const signal=AbortSignal.any([...(requestSignal?[requestSignal]:[]),AbortSignal.timeout(TIMEOUT_MS)]);
    let stage='delegation',status=null;
    try {
      signal.throwIfAborted();
      const capability=await issue(sessionToken,'carebase.learning',operation);
      signal.throwIfAborted();
      stage='request';
      const response=await fetchImpl(target,{method:'POST',headers:{Authorization:`Bearer ${capability}`,'Content-Type':'application/json'},
        body:JSON.stringify(operation),signal,redirect:'error',cache:'no-store'});
      stage='response';status=response.status;
      if(!response.ok){
        // Only the code and an administrator message cross; nothing else of the body is kept.
        const error=(await boundedJson(response,8192,signal))?.error,code=typeof error?.code==='string'?error.code:'',message=generationMessage(error?.message);
        if(status===401)throw fail(401,'unauthenticated');
        if(status===403)throw fail(403,'forbidden',message);
        if(status===409)throw fail(409,'conflict',message);
        if(status===400||status===404||status===413)throw fail(400,'invalid_request',message);
        if(status===504)throw fail(504,'timeout',message);
        const why={reason:'carebase_status',carebaseCode:word(code)};
        if(status===503&&['unconfigured','provider_runtime_busy'].includes(code))throw because(fail(503,code,message),why);
        throw because(fail(status===502?502:503,'upstream',message),why);
      }
      const body=await boundedJson(response,1100000,signal);
      let result;
      try{result=projectGenerationResult(body,operation);}
      catch(error){throw because(fail(503,'upstream'),{reason:'invalid_result',issue:body===null?'not_json':issueOf(error)});}
      // A logout or revocation while the provider ran must keep the result from the browser.
      stage='recheck';
      await withSession(pool,sessionToken,async db=>{signal.throwIfAborted();await db.query('select hub.authorize_app_command() as actor');});
      return result;
    } catch(error) {
      let thrown=error;
      if(!(error instanceof HttpError)) {
        if(signal.aborted)throw fail(504,'timeout');
        const failed=error?.code==='42501'?403:error?.code==='28000'?401:503;
        thrown=because(fail(failed,failed===403?'forbidden':failed===401?'unauthenticated':'upstream'),
          {reason:stageReasons[stage],error:word(error?.code)??word(error?.cause?.code)??word(error?.name)??'unknown'});
      }
      if(thrown.status===503)log(JSON.stringify({event:'hub_learning_generation_unavailable',operation:operation.operation,status,
        ...(thrown.why??{reason:stageReasons[stage]??'unknown',error:word(thrown.code)})}));
      throw thrown;
    }
  };
}
