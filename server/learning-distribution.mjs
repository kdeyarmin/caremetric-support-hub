import { HttpError } from './sms-auth.mjs';
import { distributionSession } from './distribution-session.mjs';
import { callNativeAdmin } from './admin-transport.mjs';
import { parsePortfolioEnvelope } from '../supabase/functions/_shared/portfolioProtocol.ts';
import { distributionDomain,distributionOperationSchema,distributionContextSchema,distributionPreviewSchema,projectDistributionContext } from '../src/learning/distributionProtocol.ts';

export function learningDistribution({pool,issue,observer,legacyOptInAllowed=false,fetchImpl=fetch}) {
  return async(sessionToken,input,requestSignal)=>{
    let op;try{op=distributionOperationSchema.parse(input);}catch{throw new HttpError(400,'Invalid course distribution request.','invalid_request');}
    const signal=AbortSignal.any([...(requestSignal?[requestSignal]:[]),AbortSignal.timeout(28000)]);
    const local=work=>distributionSession(pool,sessionToken,signal,async db=>{
      signal.throwIfAborted();await db.query('select hub.authorize_app_command()');await db.query('reset role');
      const result=await work(db);signal.throwIfAborted();return result;
    });
    const intent=requestId=>local(async db=>distributionPreviewSchema.parse((await db.query('select private.get_course_distribution_intent($1) as value',[requestId])).rows[0].value));
    const authority=async()=>{
      const operation={operation:'capabilities'},request={product:'carebase',operation};
      const capability=await issue(sessionToken,'carebase',operation,signal);
      await callNativeAdmin(fetchImpl,'https://cmcarebase.com/api/platform-admin/read','Authorization',capability,operation,
        value=>parsePortfolioEnvelope(value,request),false,signal,16384);
    };
    const observe=async courseId=>{
      const nonce=await local(async db=>(await db.query('select private.claim_course_distribution_observation($1) as value',[courseId])).rows[0].value);
      const operation={domain:distributionDomain,operation:'context',courseId};
      const capability=await issue(sessionToken,'carebase.learning',operation,signal);signal.throwIfAborted();
      const value=await callNativeAdmin(fetchImpl,'https://cmcarebase.com/api/learning-admin/distribution','Authorization',capability,operation,
          async raw=>({native:await projectDistributionContext(raw,operation),generatedAt:raw.generatedAt}),true,signal,4100000);
      // HTTP 404 alone cannot prove a tombstone: an unavailable route can also
      // return it. Only the closed authenticated machine response proves missing.
      const status={courseId,publicationState:value.native.publicationState,currentVersionId:value.native.currentVersionId,
        currentVersionState:value.native.currentVersionState,sourceRevision:value.native.source?.sourceRevision??null};
      await local(db=>db.query('select private.record_course_distribution_observation($1,$2,$3,$4::jsonb,false)',[courseId,nonce,value.generatedAt,JSON.stringify(status)]));
      return {...value,nonce,status};
    };
    const ensureSource=(observed,plan)=>{
      if(!observed.native?.source||observed.native.currentVersionId!==plan.versionId||observed.native.source.sourceRevision!==plan.sourceRevision)
        throw new HttpError(409,'The currently published CareBase source changed. Review it again.','conflict');
    };
    try{
      if(op.operation==='context'){
        let native;
        try {native=(await observe(op.courseId)).native;}
        catch(error){
          if(!(error instanceof HttpError)||![404,503].includes(error.status))throw error;
          // A missing/unreadable current course does not erase owned historical
          // receipts. Prove current native admin separately before disclosing them.
          await authority();native=null;
        }
        return await local(async db=>distributionContextSchema.parse({...((await db.query('select private.get_course_distribution_context($1) as value',[op.courseId])).rows[0].value),
          native,observerConfigured:observer?.configured===true,legacyOptInAllowed}));
      }
      if(op.operation==='resume'){
        await intent(op.requestId);await authority();return await intent(op.requestId);
      }
      if(op.operation==='preview'){
        const observed=await observe(op.plan.courseId);ensureSource(observed,op.plan);
        return await local(async db=>distributionPreviewSchema.parse((await db.query('select private.preview_course_distribution($1,$2::jsonb,$3,$4,$5) as value',
          [op.requestId,JSON.stringify(op.plan),observed.native.source.payload,observed.nonce,legacyOptInAllowed])).rows[0].value));
      }
      const saved=await intent(op.requestId);
      if(saved.previewDigest!==op.expectedDigest)throw new HttpError(409,'The reviewed distribution differs.','conflict');
      if(saved.result){
        await authority();
        return await local(async db=>distributionPreviewSchema.parse((await db.query('select private.commit_course_distribution($1,$2,null,$3) as value',
          [op.requestId,op.expectedDigest,legacyOptInAllowed])).rows[0].value));
      }
      const observed=await observe(saved.plan.courseId);
      if(!saved.result){
        ensureSource(observed,saved.plan);
        if(!observer?.configured)throw new HttpError(503,'The course availability observer is not configured.','unconfigured');
        const machine=await observer.read([saved.plan.courseId],signal);
        // Store even a changed pointer/tombstone before rejecting the commit, so
        // opted-in catalog availability never borrows an older successful read.
        await local(db=>db.query('select private.record_course_distribution_observation($1,$2,$3,$4::jsonb,true)',
          [saved.plan.courseId,observed.nonce,machine.generatedAt,JSON.stringify(machine.items[0])]));
        const row=machine.items[0];
        if(row.courseId!==observed.status.courseId||row.publicationState!==observed.status.publicationState||row.currentVersionId!==observed.status.currentVersionId
          ||row.currentVersionState!==observed.status.currentVersionState||row.sourceRevision!==observed.status.sourceRevision)
          throw new HttpError(409,'The machine observation and reviewed source differ.','conflict');
      }
      return await local(async db=>distributionPreviewSchema.parse((await db.query('select private.commit_course_distribution($1,$2,$3,$4) as value',
        [op.requestId,op.expectedDigest,observed.nonce,legacyOptInAllowed])).rows[0].value));
    }catch(error){
      if(error instanceof HttpError)throw error;
      const code=({42501:'forbidden',28000:'unauthenticated',40001:'conflict',22023:'invalid_request','22P02':'invalid_request'})[error.code]??'upstream';
      throw new HttpError(code==='forbidden'?403:code==='unauthenticated'?401:code==='conflict'?409:code==='invalid_request'?400:503,
        'Course distribution could not be confirmed. Recover the saved review before starting another request.',code);
    }
  };
}
