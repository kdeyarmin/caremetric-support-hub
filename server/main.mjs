import pg from 'pg';
import { smsProvider } from './sms-provider.mjs';
import { smsAuth, ownerAccess } from './sms-auth.mjs';
import { gateway } from './gateway.mjs';
import { delegations } from './delegations.mjs';
import { appServer } from './http.mjs';
import { assertBackendContract } from '../src/lib/backendContract.ts';
import { databaseConfig } from './database-config.mjs';
import { publications } from './publications.mjs';
import { distributionObserver } from './distribution-observer.mjs';
import { aiAssistance } from './ai-assistance.mjs';
import { aiCaseAssistance } from './ai-case-assistance.mjs';
import { aiAutomation, sqlAutomationStore } from './ai-automation.mjs';
import { goLiveReadiness } from './go-live-readiness.mjs';
import { integrationSetup } from './integration-setup.mjs';
import { sqlAiUsageRecorder } from './ai-usage.mjs';
import { communications, defaultPublicOrigin, sendgridMail, twilioMessaging } from './communications.mjs';
import { bulkEmail, sendgridBulkMail } from './bulk-email.mjs';
import { platformBilling } from './billing.mjs';
import { selfService } from './self-service.mjs';
import { agentTeam } from './agents/index.mjs';
import { guideLibrary } from './agents/concierge/knowledge.mjs';

const storageUrl='https://xgauehtwksmnoqhgqegm.supabase.co';
const pool=new pg.Pool(databaseConfig());
const provider=smsProvider({apiKey:process.env.HUB_TELNYX_API_KEY,profileId:process.env.HUB_TELNYX_VERIFY_PROFILE_ID});
const api=gateway(pool);
const contract=await api.rpc('get_backend_contract',{});
assertBackendContract(contract);
const observer=distributionObserver({pool,token:process.env.CAREBASE_DISTRIBUTION_OBSERVER_TOKEN});
const capabilities=delegations({pool,storageUrl,provider,observer,legacyDistributionOptIn:process.env.HUB_LEGACY_DISTRIBUTION_OPT_IN==='true'});
const publicationService=publications({pool,delegations:capabilities,storageUrl});
const ai=aiAssistance({apiKey:process.env.ANTHROPIC_API_KEY,record:sqlAiUsageRecorder(pool).record});
const aiCases=aiCaseAssistance({ai,rpc:(name,args,sessionToken)=>api.rpc(name,args,sessionToken),rows:(name,sessionToken)=>api.rows(name,sessionToken)});
const followUpHours=Number(process.env.HUB_AI_FOLLOW_UP_DELAY_HOURS);
const automation=aiAutomation({ai,store:sqlAutomationStore(pool),enabled:process.env.HUB_AI_AUTOMATION_ENABLED==='true',draftTier:process.env.HUB_AI_DRAFT_TIER==='quality'?'quality':'draft',followUpDelayMs:(Number.isFinite(followUpHours)&&followUpHours>0?followUpHours:24)*60*60*1000});
const publicOrigin=process.env.HUB_PUBLIC_ORIGIN||defaultPublicOrigin;
// One text sender and one mail sender, shared by the Communications inbox and the AI team's owner alerts.
const textSender=twilioMessaging({accountSid:process.env.HUB_TWILIO_ACCOUNT_SID,authToken:process.env.HUB_TWILIO_AUTH_TOKEN,messagingServiceSid:process.env.HUB_TWILIO_MESSAGING_SERVICE_SID,from:process.env.HUB_TWILIO_FROM_NUMBER});
const mailSender=sendgridMail({apiKey:process.env.HUB_SENDGRID_API_KEY,from:process.env.HUB_SUPPORT_FROM_EMAIL||'support@caremetric.ai'});
const messaging=communications({pool,delegations:capabilities,publicOrigin,
  twilioAuthToken:process.env.HUB_TWILIO_AUTH_TOKEN,sendgridInboundPublicKey:process.env.HUB_SENDGRID_INBOUND_PUBLIC_KEY,
  sms:textSender,email:mailSender,
  chatEnabled:process.env.HUB_CHAT_ENABLED==='true'});
// The AI team: inert unless HUB_AGENTS_ENABLED is exactly "true", and every agent starts paused until the owner resumes it.
const team=agentTeam({pool,sms:textSender,email:mailSender,ownerEmail:process.env.HUB_OWNER_EMAIL,publicOrigin,enabled:process.env.HUB_AGENTS_ENABLED==='true',communications:messaging,features:new Set(contract.features),anthropicApiKey:process.env.ANTHROPIC_API_KEY,record:sqlAiUsageRecorder(pool).record,guides:guideLibrary({load:()=>api.rpc('list_published_content',{})}),customerTextToAi:process.env.HUB_AGENTS_CUSTOMER_TEXT_TO_AI==='true'});
const announcements=bulkEmail({pool,delegations:capabilities,publicOrigin:process.env.HUB_PUBLIC_ORIGIN||defaultPublicOrigin,postalAddress:(process.env.HUB_BULK_EMAIL_POSTAL_ADDRESS||'').trim(),
  mail:sendgridBulkMail({apiKey:process.env.HUB_SENDGRID_API_KEY,from:process.env.HUB_BULK_EMAIL_FROM||process.env.HUB_SUPPORT_FROM_EMAIL||'support@caremetric.ai',replyTo:process.env.HUB_SUPPORT_FROM_EMAIL||'support@caremetric.ai'})});
// Platform billing: the Hub is the only Stripe client for every application's subscriptions.
const customerSelfService=selfService({pool,provider});
const billing=platformBilling({pool,secretKey:process.env.STRIPE_SECRET_KEY,authorizeCustomerBilling:customerSelfService.authorizeBilling,customerPurchasingEnabled:process.env.HUB_CUSTOMER_PURCHASING_ENABLED==='true',
  webhookSecrets:(process.env.STRIPE_WEBHOOK_SECRET||'').split(',').map(value=>value.trim()).filter(Boolean),
  portalConfiguration:/^bpc_[A-Za-z0-9]+$/.test(process.env.STRIPE_PORTAL_CONFIGURATION_ID||'')?process.env.STRIPE_PORTAL_CONFIGURATION_ID:undefined,
  publicOrigin:process.env.HUB_PUBLIC_ORIGIN||defaultPublicOrigin});
void billing.start().then(ready => ready && billing.reconcile()).catch(() => {});
let billingSweepRunning=false;
const billingTimer=setInterval(()=>{
  if(billingSweepRunning)return;
  billingSweepRunning=true;
  void Promise.allSettled([billing.reconcileUsage(),billing.reconcileCustomerCheckouts()]).then(results=>{
    if(results.some(result=>result.status==='rejected')) console.warn('Customer billing reconciliation could not run.');
  }).finally(()=>{billingSweepRunning=false;});
},60*1000);billingTimer.unref();
const readiness=goLiveReadiness({pool,rpc:(name,args,sessionToken)=>api.rpc(name,args,sessionToken)});
const setup=integrationSetup({rpc:(name,args,sessionToken)=>api.rpc(name,args,sessionToken)});
const server=appServer({auth:smsAuth({pool,provider}),owner:ownerAccess(pool),gateway:api,delegations:capabilities,publications:publicationService,aiCases,readiness,integrationSetup:setup,communications:messaging,bulkEmail:announcements,billing,selfService:customerSelfService,agents:team.admin,health:async()=>{await pool.query({text:'select 1',query_timeout:2000});},origins:['https://support-hub-web-production.up.railway.app','https://help.caremetric.ai']});
let cleanupRunning=false;
const cleanup=async()=>{
  if(cleanupRunning) return;
  cleanupRunning=true;
  try { await publicationService.cleanupExpired(); } catch { console.warn('Private media cleanup could not complete; it will retry.'); }
  finally { cleanupRunning=false; }
};
const cleanupTimer=setInterval(()=>void cleanup(),15*60*1000); cleanupTimer.unref();
void cleanup();
const checkCourses=async()=>{try{await observer.tick();}catch{console.warn('Course availability observation could not complete; it will retry.');}};
const courseTimer=setInterval(()=>void checkCourses(),5*60*1000);courseTimer.unref();void checkCourses();
const sweepAi=async()=>{try{await automation.tick();}catch{console.warn('AI case automation could not complete; it will retry.');}};
const aiTimer=setInterval(()=>void sweepAi(),60*1000);aiTimer.unref();void sweepAi();
const runAgents=async()=>{try{await team.tick();}catch{console.warn('The AI team could not complete a tick; it will retry.');}};
const agentTimer=setInterval(()=>void runAgents(),60*1000);agentTimer.unref();void runAgents();
const deliverEmail=async()=>{try{await announcements.tick();}catch{console.warn('Bulk email delivery could not complete; it will retry.');}};
const emailTimer=setInterval(()=>void deliverEmail(),60*1000);emailTimer.unref();void deliverEmail();
server.requestTimeout=130000; server.headersTimeout=15000;
server.listen(Number(process.env.PORT || 8080),'0.0.0.0');
for(const signal of ['SIGTERM','SIGINT']) process.on(signal,() => { clearInterval(billingTimer); clearInterval(cleanupTimer); clearInterval(courseTimer); clearInterval(aiTimer); clearInterval(agentTimer); clearInterval(emailTimer); server.close(() => { void pool.end(); }); });
