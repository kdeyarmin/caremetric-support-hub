// Real disposable PostgreSQL, SMS cookies, fixed Hub delegation and HTTP routes.
// Native course writes use a deterministic contract fixture; CareBase's own CI
// separately exercises its clone/publish functions against native PostgreSQL.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { smsAuth,sessionCookie,digest,transaction,withSession } from './sms-auth.mjs';
import { gateway } from './gateway.mjs';
import { delegations } from './delegations.mjs';
import { appServer } from './http.mjs';
const databaseUrl=process.env.HUB_TEST_DATABASE_URL,local=new URL(databaseUrl);
assert.equal(local.hostname,'127.0.0.1');assert.equal(local.port,'54322');
const admin=new pg.Pool({connectionString:databaseUrl});
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl=new URL(databaseUrl);appUrl.username='hub_app_server';appUrl.password='ephemeral-test-only';
const pool=new pg.Pool({connectionString:appUrl.href});
const owner=randomUUID(),item=randomUUID(),phone='+12025550401';
const source=JSON.parse(readFileSync(new URL('../src/imports/fixtures/governedCourse.json',import.meta.url)));
source.sourceCourseId=randomUUID();source.sourceVersionId=randomUUID();
const course=source.sourceCourseId,version=source.sourceVersionId;
let payload=JSON.stringify(source),nativeRevoked=false,writes=0,calls=0,tamperOutcome=false,revokeAfterPolicy=false;
const revision=()=>digest(payload),commands=new Map();
await admin.query("insert into auth.users(id,email,is_anonymous) values($1,'authoring-sms-owner@test.invalid',false)",[owner]);
await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')",[owner]);
await admin.query('insert into private.sms_identities(user_id,phone_e164) values($1,$2)',[owner,phone]);
await admin.query("insert into hub.content_items(id,content_key,kind,status,access_level,source_system) values($1,$2,'course','published','public','penntrain')",[item,'authoring.integration.'+item]);
await admin.query('insert into hub.course_links(content_item_id,penntrain_course_id,source_version,launch_path) values($1,$2,$3,$4)',[item,course,version,'/app/courses/'+course]);
const provider={send:async()=>randomUUID(),verify:async(_id,_phone,code)=>code==='123456'};
const auth=smsAuth({pool,provider});
const caps=delegations({pool,storageUrl:'https://storage.test',fetchImpl:async(url,options)=>{
  calls++;assert.equal(url,'https://cmcarebase.com/api/learning-admin/authoring');assert.equal(options.redirect,'error');
  assert.deepEqual(Object.keys(options.headers).sort(),['Authorization','Content-Type']);
  const op=JSON.parse(options.body),ticket=options.headers.Authorization.slice(7);
  const authority=await caps.consume(ticket,'carebase.learning');
  assert.equal(authority.user_id,owner);assert.equal(authority.method,'sms');assert.equal(authority.aal,undefined);
  assert.deepEqual(authority.operation,op);assert.ok(Date.parse(authority.assurance_expires_at)>Date.now());
  await assert.rejects(caps.consume(ticket,'carebase.learning'),/Invalid authorization/);
  if(nativeRevoked)return Response.json({error:{code:'forbidden'}},{status:403});
  if(op.operation==='source')return Response.json({courseId:course,versionId:version,payload,sourceRevision:revision()});
  if(op.operation==='preview') {
    if(op.parameters.sourceRevision!==revision())return Response.json({error:{code:'conflict'}},{status:409});
    let row=commands.get(op.requestId);
    if(!row && ['learning.patchDraft','learning.reviewDraft','learning.editStructure','learning.editCreditPolicy'].includes(op.action)) {
      const before={courseId:course,versionId:version,currentVersionId:version,sourceRevision:revision(),status:'draft',versionNumber:2,title:source.version.title};
      const after={...before,title:op.parameters.patch?.version?.title??before.title,aiReviewRequired:op.action!=='learning.reviewDraft'};delete after.sourceRevision;
      row={commandId:randomUUID(),courseId:course,action:op.action,reason:op.reason,previewDigest:digest(JSON.stringify(op)),expiresAt:new Date(Date.now()+240000).toISOString(),before,after};
      Object.defineProperty(row,'parameters',{value:op.parameters,enumerable:false});commands.set(op.requestId,row);
    }
    if(!row){row={commandId:randomUUID(),courseId:course,action:op.action,reason:op.reason,previewDigest:digest(JSON.stringify(op)),expiresAt:new Date(Date.now()+240000).toISOString(),
      before:{courseId:course,versionId:version,currentVersionId:version,sourceRevision:revision(),status:'published',versionNumber:2,title:source.version.title},
      after:{status:'draft',versionNumber:3,title:op.parameters.title,aiReviewRequired:false,sourceVersionId:version}};commands.set(op.requestId,row);}
    return Response.json(row);
  }
  assert.equal(op.operation,'apply');const preview=[...commands.values()].find(row=>row.commandId===op.commandId);
  if(!preview||preview.previewDigest!==op.expectedDigest)return Response.json({error:{code:'conflict'}},{status:409});
  if(preview.result)return Response.json({...preview.result,replayed:true});
  if(preview.before.sourceRevision!==revision())return Response.json({error:{code:'conflict'}},{status:409});
  if(['learning.patchDraft','learning.reviewDraft','learning.editStructure','learning.editCreditPolicy'].includes(preview.action)) {
    if(preview.action==='learning.patchDraft') {
      const patch=preview.parameters.patch;
      Object.assign(source.version,patch.version??{});source.version.aiReviewedAt=null;
      for(const edit of patch.blocks??[]) {
        const block=source.blocks.find(b=>b.id===edit.blockId);assert.ok(block);
        if(Object.hasOwn(edit,'title'))block.title=edit.title;
        for(const key of ['content','transcript','estimatedMinutes'])if(Object.hasOwn(edit,key))block.body[key==='estimatedMinutes'?'estimated_minutes':key]=edit[key];
      }
    } else if(preview.action==='learning.editStructure') {
      // Deterministic native fixture for the compound creation/read path. Native
      // PostgreSQL separately proves actual CAS, rollback and history guards.
      for(const change of preview.parameters.changes) {
        if(change.operation==='addLesson') {
          assert.equal(change.blockType,'quiz');assert.deepEqual(change.body,{});
          source.blocks.push({id:change.blockId,type:'quiz',sortOrder:source.blocks.length,title:change.title,body:{},documentId:null,videoLocatorSha256:null,quiz:null});
        } else if(change.operation==='configureQuiz') {
          const block=source.blocks.find(value=>value.id===change.blockId);assert.ok(block);assert.equal(block.quiz,null);
          const {operation,blockId,quizId,...settings}=change;assert.equal(operation,'configureQuiz');assert.equal(blockId,block.id);
          block.quiz={id:quizId,...settings,questions:[]};
        } else if(change.operation==='saveQuestion') {
          const quiz=source.blocks.find(value=>value.quiz?.id===change.quizId)?.quiz;assert.ok(quiz);
          const {operation,quizId,questionId,answers,removedAnswerIds,...fields}=change;
          assert.equal(operation,'saveQuestion');assert.equal(quizId,quiz.id);assert.deepEqual(removedAnswerIds,[]);
          quiz.questions.push({id:questionId,sortOrder:quiz.questions.length,...fields,options:answers.map((answer,index)=>({id:answer.answerId,sortOrder:index,text:answer.text,correct:answer.correct}))});
        } else if(change.operation==='reorderLessons') {
          assert.deepEqual([...change.blockIds].sort(),source.blocks.map(block=>block.id).sort());
          source.blocks=change.blockIds.map((id,index)=>({...source.blocks.find(block=>block.id===id),sortOrder:index}));
        } else assert.fail('Unexpected synthetic structure operation');
      }
      source.version.aiReviewedAt=null;
    } else if(preview.action==='learning.editCreditPolicy') {
      const parameters=preview.parameters,old=new Map(source.credits.map(row=>[row.id,row]));
      const retained=new Set(parameters.credits.map(row=>row.creditId));
      assert.deepEqual(parameters.removedCreditIds.slice().sort(),source.credits.filter(row=>!retained.has(row.id)).map(row=>row.id).sort());
      source.credits=parameters.credits.map(row=>{
        if(row.preserve){assert.ok(old.has(row.creditId));return old.get(row.creditId);}
        const prior=old.get(row.creditId);if(prior)assert.equal(prior.trainingTypeId,row.trainingTypeId);
        return {id:row.creditId,trainingTypeId:row.trainingTypeId,topicCode:row.topicCode,creditHours:row.creditHours,mode:row.creditMode,citationNote:row.citationNote,active:row.isActive};
      });
      if(Object.hasOwn(parameters.policy,'versionLabel'))source.version.label=parameters.policy.versionLabel;
      if(Object.hasOwn(parameters.policy,'creditedDurationRationale'))source.version.creditedDurationRationale=parameters.policy.creditedDurationRationale;
      source.version.aiReviewedAt=null;
    } else source.version.aiReviewedAt=new Date().toISOString();
    payload=JSON.stringify(source);
    const result={commandId:preview.commandId,courseId:course,action:preview.action,versionId:version,versionNumber:2,status:'draft',appliedAt:new Date().toISOString(),replayed:false,sourceRevision:revision()};
    writes++;Object.defineProperty(preview,'result',{value:result,enumerable:false});
    if(preview.action==='learning.editCreditPolicy'&&revokeAfterPolicy)await admin.query('update private.staff_permissions set revoked_at=now() where user_id=$1',[owner]);
    return Response.json(result);
  }
  const result={commandId:preview.commandId,courseId:course,action:preview.action,versionId:randomUUID(),versionNumber:3,status:'draft',appliedAt:new Date().toISOString(),replayed:false};
  if(tamperOutcome)return Response.json({...result,versionNumber:99});
  writes++;Object.defineProperty(preview,'result',{value:result,enumerable:false});return Response.json(result);
}});
const server=appServer({auth,gateway:gateway(pool),delegations:caps,origins:['https://hub.test']});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`,jar={};
async function call(path,body,headers={}) {
  const response=await fetch(origin+'/api/'+path,{method:'POST',headers:{Origin:'https://hub.test','Content-Type':'application/json',Cookie:Object.entries(jar).map(([k,v])=>`${k}=${v}`).join('; '),...headers},body:JSON.stringify(body)});
  assert.equal(response.headers.get('cache-control'),'no-store');
  for(const value of response.headers.getSetCookie()){const [pair]=value.split(';'),i=pair.indexOf('=');jar[pair.slice(0,i)]=pair.slice(i+1);}
  return {status:response.status,body:await response.json()};
}
const author=body=>call('admin/authoring',body);
const sourceOp={operation:'source',courseId:course,versionId:version};
const previewOp=()=>({operation:'preview',requestId:randomUUID(),action:'learning.cloneVersion',courseId:course,parameters:{versionId:version,sourceRevision:revision(),title:'Synthetic next draft'},reason:'Reviewed source for a controlled revision'});
try {
  assert.equal((await author(sourceOp)).status,401);
  const challenge=await call('auth/sms/start',{phone});assert.equal(challenge.status,200);
  assert.equal((await call('auth/sms/verify',{challengeId:challenge.body.challengeId,code:'123456'})).status,200);
  assert.equal((await call('admin/authoring',sourceOp,{Origin:'https://evil.test'})).status,403);
  const noSource=previewOp(),beforeCalls=calls;
  assert.equal((await author(noSource)).status,409);assert.equal(calls,beforeCalls);
  const loaded=await author(sourceOp);assert.equal(loaded.status,200,JSON.stringify(loaded.body));assert.equal(loaded.body.payload,payload);assert.equal(loaded.body.headRevision,null);
  const preserve={operation:'preserve_source',courseId:course,versionId:version,sourceRevision:revision(),expectedHeadRevision:null,reviewed:true};
  assert.equal((await author({...preserve,reviewed:false})).status,400);
  const originalPayload=payload;payload+=' ';assert.equal((await author(preserve)).status,409);payload=originalPayload;
  const staged=await author(preserve);assert.equal(staged.status,200,JSON.stringify(staged.body));
  for(const key of ['playbackToken','signedUrl','token','api_key','clientSecret','secretKey','signing_secret']) {
    const bad=structuredClone(source);bad.blocks[0].body={[key]:'synthetic-only'};const raw=JSON.stringify(bad);
    await assert.rejects(withSession(pool,jar[sessionCookie],db=>db.query('select hub.stage_learning_source($1,$2,$3)',[raw,digest(raw),preserve.sourceRevision])),/credentials/);
  }
  assert.equal((await author(preserve)).body.replayed,true);
  const command=previewOp(),preview=await author(command);assert.equal(preview.status,200,JSON.stringify(preview.body));
  assert.equal((await author(command)).body.commandId,preview.body.commandId);
  assert.equal(Number((await admin.query('select count(*) from private.learning_authoring_intents where actor_id=$1',[owner])).rows[0].count),1);
  const apply={operation:'apply',commandId:preview.body.commandId,expectedDigest:preview.body.previewDigest};
  assert.equal((await author({...apply,expectedDigest:'0'.repeat(64)})).status,409);assert.equal(writes,0);
  tamperOutcome=true;assert.equal((await author(apply)).status,503);tamperOutcome=false;assert.equal(writes,0);
  const result=await author(apply);assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(writes,1);
  const replay=await author(apply);assert.equal(replay.status,200,JSON.stringify(replay.body));assert.equal(replay.body.replayed,true);assert.equal(writes,1);
  nativeRevoked=true;assert.equal((await author(apply)).status,403);nativeRevoked=false;
  const session=(await admin.query('select id from private.sms_sessions where token_hash=$1',[digest(jar[sessionCookie])])).rows[0].id;
  await assert.rejects(withSession(pool,jar[sessionCookie],db=>db.query('select * from private.learning_authoring_intents')),/permission denied/);
  await assert.rejects(transaction(admin,async db=>{await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:owner,sms_session_id:session})]);await db.query('select hub.get_learning_authoring_intent($1,$2)',[apply.commandId,apply.expectedDigest]);}),/administrator|Administrator|session|Session/);
  const driftPreview=await author(previewOp());assert.equal(driftPreview.status,200,JSON.stringify(driftPreview.body));
  payload+=' ';assert.equal((await author({operation:'apply',commandId:driftPreview.body.commandId,expectedDigest:driftPreview.body.previewDigest})).status,409);
  const next=await author({...preserve,sourceRevision:revision(),expectedHeadRevision:preserve.sourceRevision});assert.equal(next.status,200,JSON.stringify(next.body));
  assert.equal((await author(apply)).status,200);assert.equal(writes,1); // preserved head advances without invalidating a completed native receipt
  // Same real SMS/HTTP/delegation/SQL lane accepts bounded edits larger than
  // receipt requests, requires preservation after changes, and pins new receipts.
  source.sourceVersionState='draft';source.version.aiGenerated=true;source.version.aiReviewedAt=null;payload=JSON.stringify(source);
  const draftSource=await author(sourceOp);assert.equal(draftSource.status,200);
  assert.equal((await author({...preserve,sourceRevision:revision(),expectedHeadRevision:draftSource.body.headRevision})).status,200);
  const draftOp={operation:'preview',requestId:randomUUID(),courseId:course,action:'learning.patchDraft',parameters:{versionId:version,sourceRevision:revision(),patch:{version:{title:'Edited draft',description:'Synthetic detailed description '.repeat(220)}}},reason:'Review exact draft edits before saving'};
  assert.ok(Buffer.byteLength(JSON.stringify(draftOp))>4096);
  const editedPreview=await author(draftOp);assert.equal(editedPreview.status,200,JSON.stringify(editedPreview.body));
  const editApply={operation:'apply',commandId:editedPreview.body.commandId,expectedDigest:editedPreview.body.previewDigest};
  const edited=await author(editApply);assert.equal(edited.status,200,JSON.stringify(edited.body));assert.equal(edited.body.sourceRevision,revision());assert.equal(writes,2);
  assert.equal((await author(editApply)).body.replayed,true);assert.equal(writes,2);
  const reviewOp={operation:'preview',requestId:randomUUID(),courseId:course,action:'learning.reviewDraft',parameters:{versionId:version,sourceRevision:revision(),reviewed:true},reason:'Approve exact saved AI material and assessment'};
  assert.equal((await author(reviewOp)).status,409); // latest native material has not been preserved
  const editedSource=await author(sourceOp);assert.equal(editedSource.body.payload,payload);
  assert.equal((await author({...preserve,sourceRevision:revision(),expectedHeadRevision:editedSource.body.headRevision})).status,200);
  const approval=await author(reviewOp);assert.equal(approval.status,200,JSON.stringify(approval.body));assert.equal(approval.body.after.aiReviewRequired,false);
  const reviewApply={operation:'apply',commandId:approval.body.commandId,expectedDigest:approval.body.previewDigest};
  const reviewedResult=await author(reviewApply);assert.equal(reviewedResult.status,200,JSON.stringify(reviewedResult.body));assert.equal(reviewedResult.body.sourceRevision,revision());assert.equal(writes,3);
  assert.equal((await author(reviewApply)).body.replayed,true);assert.equal(writes,3);
  await assert.rejects(withSession(pool,jar[sessionCookie],db=>db.query('select hub.record_learning_authoring_result($1,$2,$3::jsonb)',[reviewApply.commandId,reviewApply.expectedDigest,JSON.stringify({...reviewedResult.body,sourceRevision:'f'.repeat(64)})])),/result changed/);
  nativeRevoked=true;assert.equal((await author(reviewApply)).status,403);nativeRevoked=false;
  // Read and preserve a newly added, unconfigured draft assessment. Published
  // snapshots must still fail at BOTH the JS and PostgreSQL source boundaries.
  const incompleteId=randomUUID(),newQuizId=randomUUID(),newQuestionId=randomUUID();
  async function preserveLatest() {
    const loaded=await author(sourceOp);assert.equal(loaded.status,200,JSON.stringify(loaded.body));
    assert.equal((await author({...preserve,sourceRevision:revision(),expectedHeadRevision:loaded.body.headRevision})).status,200);
  }
  await preserveLatest();
  const incompleteOp={operation:'preview',requestId:randomUUID(),courseId:course,action:'learning.editStructure',parameters:{versionId:version,sourceRevision:revision(),
    changes:[{operation:'addLesson',blockId:incompleteId,blockType:'quiz',title:'New draft assessment',body:{}}]},reason:'Add an assessment draft before configuring its questions'};
  const incompletePreview=await author(incompleteOp);assert.equal(incompletePreview.status,200,JSON.stringify(incompletePreview.body));
  const incompleteApply={operation:'apply',commandId:incompletePreview.body.commandId,expectedDigest:incompletePreview.body.previewDigest};
  assert.equal((await author(incompleteApply)).status,200);assert.equal(writes,4);
  await preserveLatest();
  const published=JSON.stringify({...source,sourceVersionState:'published'});
  await assert.rejects(admin.query('select private.validate_governed_learning_source($1,$2)',[published,digest(published)]),/Source quiz configuration/);
  const compoundOp={operation:'preview',requestId:randomUUID(),courseId:course,action:'learning.editStructure',parameters:{versionId:version,sourceRevision:revision(),changes:[
    {operation:'configureQuiz',blockId:incompleteId,quizId:newQuizId,title:'Reviewed knowledge check',kind:'knowledge_check',passingScore:80,maxAttempts:null,shuffleQuestions:false,shuffleAnswers:true,revealsAnswersAfterAttempt:true},
    {operation:'saveQuestion',quizId:newQuizId,questionId:newQuestionId,prompt:'Synthetic reviewed question '.repeat(190),type:'multiple_choice',points:101,topicCode:null,topicLabel:null,explanation:'Each correct choice matches the reviewed practice.',
      answers:[{answerId:randomUUID(),text:'The first correct answer',correct:true},{answerId:randomUUID(),text:'The second correct answer',correct:true}],removedAnswerIds:[]},
    {operation:'reorderLessons',blockIds:[incompleteId,...source.blocks.filter(block=>block.id!==incompleteId).map(block=>block.id)]},
  ]},reason:'Save the exact assessment, explanations and complete answer set together'};
  assert.ok(Buffer.byteLength(JSON.stringify(compoundOp))>4096);
  const compoundPreview=await author(compoundOp);assert.equal(compoundPreview.status,200,JSON.stringify(compoundPreview.body));
  assert.equal(compoundPreview.body.after.aiReviewRequired,true);
  const compoundApply={operation:'apply',commandId:compoundPreview.body.commandId,expectedDigest:compoundPreview.body.previewDigest};
  const compound=await author(compoundApply);assert.equal(compound.status,200,JSON.stringify(compound.body));assert.equal(compound.body.sourceRevision,revision());assert.equal(writes,5);
  assert.equal((await author(compoundApply)).body.replayed,true);assert.equal(writes,5);
  assert.equal(source.blocks[0].id,incompleteId);assert.equal(source.blocks[0].quiz.questions[0].points,101);assert.equal(source.version.aiReviewedAt,null);
  await preserveLatest();
  nativeRevoked=true;assert.equal((await author(compoundApply)).status,403);nativeRevoked=false;
  // A policy mutation uses the same actual source/session ledger. The unchanged
  // legacy citation remains in the native fixture; only its ID crosses the request.
  source.credits[1].citationNote='Legacy citation preserved exactly. '.repeat(500);
  payload=JSON.stringify(source);await preserveLatest();
  const oldCredit=structuredClone(source.credits[1]),removedCredit=source.credits[0].id,newCredit=randomUUID();
  const originalBlocks=JSON.stringify(source.blocks),originalProvider=JSON.stringify(source.provider);
  const policyOp={operation:'preview',requestId:randomUUID(),courseId:course,action:'learning.editCreditPolicy',parameters:{versionId:version,sourceRevision:revision(),
    policy:{versionLabel:'Reviewed credit edition',creditedDurationRationale:'The reviewed duration aligns with the instructional material and verification requirements.'},
    credits:[{creditId:oldCredit.id,preserve:true},{creditId:newCredit,trainingTypeId:source.credits[0].trainingTypeId,topicCode:'REVIEWED.CREDIT',creditHours:'0.10',creditMode:'verified_only',citationNote:'Reviewed synthetic citation. '.repeat(200),isActive:true}],
    removedCreditIds:[removedCredit]},reason:'Review original credit evidence and replace the explicitly removed rule'};
  assert.ok(Buffer.byteLength(JSON.stringify(policyOp))>4096);
  assert.equal((await author({...policyOp,parameters:{...policyOp.parameters,policy:{providerId:randomUUID()}}})).status,400);
  const policyPreview=await author(policyOp);assert.equal(policyPreview.status,200,JSON.stringify(policyPreview.body));
  assert.equal(policyPreview.body.after.aiReviewRequired,true);
  const policyApply={operation:'apply',commandId:policyPreview.body.commandId,expectedDigest:policyPreview.body.previewDigest};
  revokeAfterPolicy=true;assert.equal((await author(policyApply)).status,401);assert.equal(writes,6);
  assert.equal((await admin.query('select result from private.learning_authoring_intents where command_id=$1',[policyApply.commandId])).rows[0].result,null);
  revokeAfterPolicy=false;await admin.query('update private.staff_permissions set revoked_at=null where user_id=$1',[owner]);
  const policyResult=await author(policyApply);assert.equal(policyResult.status,200,JSON.stringify(policyResult.body));assert.equal(policyResult.body.replayed,true);assert.equal(writes,6);
  assert.equal(policyResult.body.sourceRevision,revision());assert.deepEqual(source.credits[0],oldCredit);assert.equal(source.credits[1].creditHours,'0.10');
  assert.equal(source.credits.some(row=>row.id===removedCredit),false);assert.equal(JSON.stringify(source.blocks),originalBlocks);assert.equal(JSON.stringify(source.provider),originalProvider);
  const {sourceRevision:policyDigest,...missingPolicyDigest}=policyResult.body;assert.equal(policyDigest,revision());
  await assert.rejects(withSession(pool,jar[sessionCookie],db=>db.query('select hub.record_learning_authoring_result($1,$2,$3::jsonb)',[policyApply.commandId,policyApply.expectedDigest,JSON.stringify(missingPolicyDigest)])),error=>error.code==='22023');
  assert.equal((await author({...policyOp,requestId:randomUUID()})).status,409);
  await preserveLatest();nativeRevoked=true;assert.equal((await author(policyApply)).status,403);nativeRevoked=false;
  await admin.query('update private.staff_permissions set revoked_at=now() where user_id=$1',[owner]);assert.equal((await author(apply)).status,401);
  await admin.query('update private.staff_permissions set revoked_at=null where user_id=$1',[owner]);
  await admin.query('update private.sms_identities set revoked_at=now() where user_id=$1',[owner]);assert.equal((await author(apply)).status,401);
  assert.equal(Number((await admin.query("select count(*) from private.audit_events where actor_id=$1 and action='learning.authoring.applied'",[owner])).rows[0].count),6);
  console.log('Authoring PostgreSQL/HTTP integration passed: source preservation, clone/edit/review/structure/credit policy, explicit credit removals and lossless preservation, post-write revocation recovery, incomplete draft assessments, complete weighted answers, exact digest receipts, large bounded edits, native/Hub revocation and immutable replay.');
} finally {await new Promise(resolve=>server.close(resolve));await pool.end();await admin.end();}
