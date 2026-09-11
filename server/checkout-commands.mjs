import { withSession, HttpError } from './sms-auth.mjs';
import { callNativeAdmin } from './admin-transport.mjs';
import { isUuid } from '../supabase/functions/_shared/adminProtocol.ts';
import { checkoutCommandSchema, checkoutIntentSchema, checkoutResultMetadata, projectCheckoutCommand, verifyCheckoutOutcome } from '../supabase/functions/_shared/checkoutCommandProtocol.ts';

export function checkoutCommands({pool,issue,fetchImpl=fetch}) {
  return async(sessionToken,input,requestSignal)=>{
    let operation;
    try {operation=checkoutCommandSchema.parse(input);} catch {throw new HttpError(400,'Invalid checkout request.','invalid_request');}
    const signal=AbortSignal.any([...(requestSignal?[requestSignal]:[]),AbortSignal.timeout(12000)]);
    const local=work=>withSession(pool,sessionToken,async db=>{
      signal.throwIfAborted();
      await db.query('select hub.authorize_app_command()');
      await db.query('reset role');
      const result=await work(db);
      signal.throwIfAborted();
      return result;
    });
    const read=async(db,query,values)=>checkoutIntentSchema.parse((await db.query(query,values)).rows[0].value);
    const native=async command=>{
      signal.throwIfAborted();
      const capability=await issue(sessionToken,'carebase.command',command);
      signal.throwIfAborted();
      return callNativeAdmin(fetchImpl,'https://cmcarebase.com/api/platform-admin/billing/command','Authorization',capability,command,
        value=>projectCheckoutCommand(value,command),true,signal,16384);
    };
    try {
      if(operation.operation==='resume') return await local(async db=>{
        const value=(await db.query('select private.resume_billing_checkout($1) as value',[operation.targetId])).rows[0].value;
        return value===null?null:checkoutIntentSchema.parse(value);
      });
      if(operation.operation==='discard') return await local(async db=>(await db.query('select private.discard_billing_checkout($1) as value',[operation.requestId])).rows[0].value);
      if(operation.operation==='preview') {
        await local(db=>read(db,'select private.reserve_billing_checkout($1::jsonb) as value',[JSON.stringify(operation)]));
        await local(db=>read(db,'select private.dispatch_billing_checkout_preview($1) as value',[operation.requestId]));
        const preview=await native(operation);
        return await local(db=>read(db,'select private.remember_billing_checkout_preview($1,$2::jsonb) as value',[operation.requestId,JSON.stringify(preview)]));
      }
      const claim=await local(async db=>{
        const value=(await db.query('select private.claim_billing_checkout($1,$2,$3) as value',
          [operation.commandId,operation.expectedDigest,operation.operation==='check'])).rows[0].value;
        if(!value || Object.keys(value).length!==2 || !isUuid(value.observationId)) throw new Error('Invalid checkout claim');
        return {intent:checkoutIntentSchema.parse(value.intent),observationId:value.observationId};
      });
      const result=verifyCheckoutOutcome(await native(operation),claim.intent.preview);
      // An observation token prevents late responses from overwriting a later
      // check. Current Hub authority is rechecked before any URL is disclosed.
      await local(db=>read(db,'select private.record_billing_checkout_result($1,$2,$3::jsonb) as value',
        [operation.commandId,claim.observationId,JSON.stringify(checkoutResultMetadata(result))]));
      return result;
    } catch(error) {
      if(error instanceof HttpError) throw error;
      const code=({42501:'forbidden',28000:'unauthenticated',40001:'conflict',22023:'invalid_request','22P02':'invalid_request'})[error.code]??'upstream';
      throw new HttpError(code==='forbidden'?403:code==='unauthenticated'?401:code==='conflict'?409:code==='invalid_request'?400:503,
        'Checkout could not be confirmed. Recover the same review.',code);
    }
  };
}
