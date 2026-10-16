import pg from 'pg';
import { smsProvider } from './sms-provider.mjs';
import { smsAuth } from './sms-auth.mjs';
import { gateway } from './gateway.mjs';
import { delegations } from './delegations.mjs';
import { appServer } from './http.mjs';
import { assertBackendContract } from '../src/lib/backendContract.ts';
import { databaseConfig } from './database-config.mjs';
import { publications } from './publications.mjs';
import { docstudio } from './docstudio.mjs';
import { distributionObserver } from './distribution-observer.mjs';
import { aiAssistance } from './ai-assistance.mjs';
import { aiCaseAssistance } from './ai-case-assistance.mjs';
import { aiAutomation, sqlAutomationStore } from './ai-automation.mjs';

const storageUrl='https://xgauehtwksmnoqhgqegm.supabase.co';
const pool=new pg.Pool(databaseConfig());
const provider=smsProvider({apiKey:process.env.HUB_TELNYX_API_KEY,profileId:process.env.HUB_TELNYX_VERIFY_PROFILE_ID});
const api=gateway(pool);
const contract=await api.rpc('get_backend_contract',{});
assertBackendContract(contract);
const observer=distributionObserver({pool,token:process.env.CAREBASE_DISTRIBUTION_OBSERVER_TOKEN});
const capabilities=delegations({pool,storageUrl,provider,observer,legacyDistributionOptIn:process.env.HUB_LEGACY_DISTRIBUTION_OPT_IN==='true'});
const publicationService=publications({pool,delegations:capabilities,storageUrl});
const studio=docstudio({pool,publications:publicationService,workerToken:process.env.DOCSTUDIO_WORKER_TOKEN});
const ai=aiAssistance({apiKey:process.env.ANTHROPIC_API_KEY});
const aiCases=aiCaseAssistance({ai,rpc:(name,args,sessionToken)=>api.rpc(name,args,sessionToken),rows:(name,sessionToken)=>api.rows(name,sessionToken)});
const followUpHours=Number(process.env.HUB_AI_FOLLOW_UP_DELAY_HOURS);
const automation=aiAutomation({ai,store:sqlAutomationStore(pool),enabled:process.env.HUB_AI_AUTOMATION_ENABLED==='true',draftTier:process.env.HUB_AI_DRAFT_TIER==='quality'?'quality':'draft',followUpDelayMs:(Number.isFinite(followUpHours)&&followUpHours>0?followUpHours:24)*60*60*1000});
const server=appServer({auth:smsAuth({pool,provider}),gateway:api,delegations:capabilities,publications:publicationService,docstudio:studio,aiCases,origins:['https://support-hub-web-production.up.railway.app','https://help.caremetric.ai']});
let cleanupRunning=false;
const cleanup=async()=>{
  if(cleanupRunning) return;
  cleanupRunning=true;
  try { await publicationService.cleanupExpired(); await studio.cleanupExpired(); } catch { console.warn('Private media cleanup could not complete; it will retry.'); }
  finally { cleanupRunning=false; }
};
const cleanupTimer=setInterval(()=>void cleanup(),15*60*1000); cleanupTimer.unref();
void cleanup();
const checkCourses=async()=>{try{await observer.tick();}catch{console.warn('Course availability observation could not complete; it will retry.');}};
const courseTimer=setInterval(()=>void checkCourses(),5*60*1000);courseTimer.unref();void checkCourses();
const sweepAi=async()=>{try{await automation.tick();}catch{console.warn('AI case automation could not complete; it will retry.');}};
const aiTimer=setInterval(()=>void sweepAi(),60*1000);aiTimer.unref();void sweepAi();
server.requestTimeout=130000; server.headersTimeout=15000;
server.listen(Number(process.env.PORT || 8080),'0.0.0.0');
for(const signal of ['SIGTERM','SIGINT']) process.on(signal,() => { clearInterval(cleanupTimer); clearInterval(courseTimer); clearInterval(aiTimer); server.close(() => { void pool.end(); }); });
