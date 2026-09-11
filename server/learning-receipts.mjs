import { withSession, HttpError } from './sms-auth.mjs';
import { callNativeAdmin } from './admin-transport.mjs';
import { coordinateLearningReceipt } from '../src/learning/receiptCoordinator.ts';
import { learningReceiptOperationSchema, nativeLearningOperationSchema, projectReceiptResult } from '../src/learning/receiptProtocol.ts';
import { GatewayError } from '../supabase/functions/_shared/adminGateway.ts';

const rpcArguments = {
  get_learning_receipt_status: {},
  provision_learning_receipt_access: {p_native_organization_id:'uuid',p_native_employee_id:'uuid',p_native_profile_id:'uuid',p_hub_tenant_id:'uuid',p_tenant_name:'text',p_hub_user_id:'uuid'},
  prepare_learning_receipt_mapping: {p_mapping_id:'uuid',p_source_snapshot_id:'uuid',p_native_organization_id:'uuid',p_native_employee_id:'uuid',p_hub_tenant_id:'uuid',p_hub_user_id:'uuid'},
  set_learning_receipt_mapping_state: {p_mapping_id:'uuid',p_state:'text'},
  ingest_learning_receipt: {p_payload:'text',p_source_digest:'text'},
};
async function withinDeadline(work,signal) {
  let abort=()=>{};
  try {
    return await Promise.race([work,new Promise((_,reject)=>{
      abort=()=>reject(new GatewayError('upstream'));
      if(signal.aborted) abort(); else signal.addEventListener('abort',abort,{once:true});
    })]);
  } finally {signal.removeEventListener('abort',abort);}
}
export function learningReceipts({pool,issue,fetchImpl=fetch}) {
  return async (sessionToken,input,requestSignal) => {
    let op;
    try { op=learningReceiptOperationSchema.parse(input); } catch { throw new HttpError(400,'Invalid learning request.','invalid_request'); }
    const signal=AbortSignal.any([...(requestSignal?[requestSignal]:[]),AbortSignal.timeout(12000)]);
    const hub=async(name,args={})=>{
      signal.throwIfAborted();
      const fields=rpcArguments[name];
      if (!fields || Object.keys(args).length!==Object.keys(fields).length || Object.keys(fields).some(key=>!Object.hasOwn(args,key))) throw new GatewayError('invalid_request');
      return withSession(pool,sessionToken,async(db)=>{
        const actor=(await db.query('select hub.authorize_app_command() as actor')).rows[0].actor;
        // Authorization is relational and is repeated before every mutation.
        // The SQL guard checks this same SMS session again after resetting role.
        await db.query('reset role'); signal.throwIfAborted();
        const values=[actor.user_id,actor.session_id];
        const parameters=['p_actor_id=>$1::uuid','p_session_id=>$2::uuid'];
        for(const [key,type] of Object.entries(fields)) {values.push(args[key]);parameters.push(`${key}=>$${values.length}::${type}`);}
        const {rows}=await db.query(`select hub.${name}(${parameters.join(',')}) as result`,values);
        return rows[0].result;
      }).catch(error=>{
        if(error instanceof HttpError) throw new GatewayError(error.status===401?'unauthenticated':error.status===403?'forbidden':'upstream');
        throw new GatewayError(({42501:'forbidden',28000:'unauthenticated',40001:'conflict',22023:'invalid_request'})[error.code]??'upstream');
      });
    };
    const native=async(input)=>{
      signal.throwIfAborted();
      const operation=nativeLearningOperationSchema.parse(input);
      const capability=await issue(sessionToken,'carebase.learning',operation);
      signal.throwIfAborted();
      try { return await callNativeAdmin(fetchImpl,'https://cmcarebase.com/api/learning-admin/receipt','Authorization',capability,operation,value=>value,true,signal); }
      catch(error) { throw new GatewayError(error.status===401?'unauthenticated':error.status===403?'forbidden':error.status===409?'conflict':'upstream'); }
    };
    try {
      const result=projectReceiptResult(await withinDeadline(coordinateLearningReceipt(op,{signal,hub,native}),signal),op);
      signal.throwIfAborted();
      if(Buffer.byteLength(JSON.stringify(result))>1000000) throw new GatewayError('upstream');
      return result;
    } catch(error) {
      const code=error instanceof GatewayError?error.code:'upstream';
      throw new HttpError(code==='unauthenticated'?401:code==='forbidden'?403:code==='conflict'?409:code==='invalid_request'?400:503,'Learning request could not be completed.',code);
    }
  };
}
