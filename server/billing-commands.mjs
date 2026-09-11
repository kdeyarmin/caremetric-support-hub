import { withSession, HttpError } from './sms-auth.mjs';
import { callNativeAdmin } from './admin-transport.mjs';
import { billingCommandSchema, billingIntentSchema, billingResultMetadata, projectBillingCommand, verifyBillingOutcome } from '../supabase/functions/_shared/billingCommandProtocol.ts';

export function billingCommands({pool,issue,fetchImpl=fetch}) {
  return async(sessionToken,input,requestSignal)=>{
    let operation;
    try {operation=billingCommandSchema.parse(input);} catch {throw new HttpError(400,'Invalid billing request.','invalid_request');}
    const signal=AbortSignal.any([...(requestSignal?[requestSignal]:[]),AbortSignal.timeout(12000)]);
    const local=work=>withSession(pool,sessionToken,async db=>{
      signal.throwIfAborted();
      await db.query('select hub.authorize_app_command()');
      await db.query('reset role');
      const result=await work(db);
      signal.throwIfAborted();
      return result;
    });
    const read=async(db,query,values)=>billingIntentSchema.parse((await db.query(query,values)).rows[0].value);
    const native=async command=>{
      signal.throwIfAborted();
      const capability=await issue(sessionToken,'carebase.command',command);
      signal.throwIfAborted();
      return callNativeAdmin(fetchImpl,'https://cmcarebase.com/api/platform-admin/billing/command','Authorization',capability,command,
        value=>projectBillingCommand(value,command),true,signal,16384);
    };
    try {
      if(operation.operation==='resume') return await local(async db=>{
        const value=(await db.query('select private.resume_billing_portal($1) as value',[operation.targetId])).rows[0].value;
        return value===null?null:billingIntentSchema.parse(value);
      });
      if(operation.operation==='discard') return await local(async db=>(await db.query('select private.discard_billing_portal($1) as value',[operation.requestId])).rows[0].value);
      if(operation.operation==='preview') {
        await local(db=>read(db,'select private.reserve_billing_portal($1::jsonb) as value',[JSON.stringify(operation)]));
        // Mark before issuing/sending any capability. An uncertain preview can
        // never be mistaken for an undispatched, safely replaceable request.
        await local(db=>read(db,'select private.dispatch_billing_portal_preview($1) as value',[operation.requestId]));
        const preview=await native(operation);
        return await local(db=>read(db,'select private.remember_billing_portal_preview($1,$2::jsonb) as value',[operation.requestId,JSON.stringify(preview)]));
      }
      const intent=await local(db=>read(db,'select private.claim_billing_portal($1,$2) as value',[operation.commandId,operation.expectedDigest]));
      const result=verifyBillingOutcome(await native(operation),intent.preview);
      // A completed replay always reaches the native owner again. Keep its URL
      // only in this response after current Hub authority accepts the metadata.
      await local(db=>read(db,'select private.record_billing_portal_result($1,$2::jsonb) as value',[operation.commandId,JSON.stringify(billingResultMetadata(result))]));
      return result;
    } catch(error) {
      if(error instanceof HttpError) throw error;
      const code=({42501:'forbidden',28000:'unauthenticated',40001:'conflict',22023:'invalid_request','22P02':'invalid_request'})[error.code]??'upstream';
      throw new HttpError(code==='forbidden'?403:code==='unauthenticated'?401:code==='conflict'?409:code==='invalid_request'?400:503,
        'Billing request could not be confirmed. Resume the same request.',code);
    }
  };
}
