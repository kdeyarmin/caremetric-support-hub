import pg from 'pg';
import { smsProvider } from './sms-provider.mjs';
import { smsAuth, ownerAccess } from './sms-auth.mjs';
import { passwordAuth } from './password-auth.mjs';
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
import { leadAdmin, leadFeature, leadIntake, leadSecrets } from './leads.mjs';
import { leadRetention } from './lead-retention.mjs';
import { helpCenter } from './help-center.mjs';
import { helpCenterOrigin } from './agents/content/facts.mjs';
import { growthStore } from './growth/store.mjs';
import { growthService } from './growth/service.mjs';
import { growthResearch } from './growth/research.mjs';
import { growthContactFinder } from './growth/contacts.mjs';
import { socialConfig } from './agents/social/index.mjs';
import { learningMediaImport, mediaImportFeature, mediaImportHosts } from './learning-media-import.mjs';

const storageUrl='https://xgauehtwksmnoqhgqegm.supabase.co';
const pool=new pg.Pool(databaseConfig());
// Refuse an incomplete release before replacing the running application.
await pool.query('select c.credential_version,s.auth_method from private.password_credentials c,private.sms_sessions s limit 0');
const provider=smsProvider({apiKey:process.env.HUB_TELNYX_API_KEY,profileId:process.env.HUB_TELNYX_VERIFY_PROFILE_ID});
const api=gateway(pool);
const contract=await api.rpc('get_backend_contract',{});
assertBackendContract(contract);
// Optional features (declared ahead of the builds that use them) are read once at boot, like the AI team's.
const features=new Set(contract.features);
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
// One address for every email the Hub sends (docs/UNIFIED_COMMUNICATIONS.md, "One address"): staff replies, the AI team's alerts,
// cold email, customer emails and bulk email all come from HUB_SUPPORT_FROM_EMAIL (support@caremetric.ai) and carry one Reply-To.
// caremetric.ai's mail is received by SendGrid Inbound Parse, so an answer to any of them lands in Communications.
const supportFrom=process.env.HUB_SUPPORT_FROM_EMAIL?.trim()||'support@caremetric.ai';
if(process.env.HUB_BULK_EMAIL_FROM?.trim())console.warn('HUB_BULK_EMAIL_FROM is no longer read: every email comes from HUB_SUPPORT_FROM_EMAIL.');
// Where customers' answers go: the address SendGrid Inbound Parse receives (HUB_SUPPORT_REPLY_TO), else the sender itself.
// An address that is not one is ignored (with a warning) rather than making SendGrid refuse every email.
const configuredReplyTo=process.env.HUB_SUPPORT_REPLY_TO?.trim()||'';
const validReplyTo=/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(configuredReplyTo)&&configuredReplyTo.length<=320?configuredReplyTo:null;
if(configuredReplyTo&&!validReplyTo)console.warn('HUB_SUPPORT_REPLY_TO is not an email address; replies go to the support sender.');
const supportReplyTo=validReplyTo||supportFrom;
const mailSender=sendgridMail({apiKey:process.env.HUB_SENDGRID_API_KEY,from:supportFrom,replyTo:supportReplyTo});
const messaging=communications({pool,delegations:capabilities,publicOrigin,
  twilioAuthToken:process.env.HUB_TWILIO_AUTH_TOKEN,sendgridInboundPublicKey:process.env.HUB_SENDGRID_INBOUND_PUBLIC_KEY,
  sms:textSender,email:mailSender,
  chatEnabled:process.env.HUB_CHAT_ENABLED==='true'});
const growth=growthService({store:growthStore(pool),research:growthResearch({apiKey:process.env.HUB_GROWTH_SEARCH_API_KEY}),contacts:growthContactFinder(),features:new Set(contract.features),enabled:process.env.HUB_GROWTH_SEND_ENABLED==='true',signingKey:process.env.HUB_GROWTH_SIGNING_KEY,eventKeys:{carebase:process.env.HUB_GROWTH_CAREBASE_EVENT_KEY,'caremetric-intel':process.env.HUB_GROWTH_INTEL_EVENT_KEY},webhookPublicKey:process.env.HUB_SENDGRID_EVENT_PUBLIC_KEY,publicOrigin,postalAddress:process.env.HUB_BULK_EMAIL_POSTAL_ADDRESS});
const growthMail=sendgridBulkMail({apiKey:process.env.HUB_SENDGRID_API_KEY,from:supportFrom,replyTo:supportReplyTo});
// CareMetric does no demos, calls or meetings with anyone (owner decision 2026-11-09), so no message offers a booking page any more.
if(process.env.HUB_BOOKING_URL) console.warn('HUB_BOOKING_URL is set but no longer used: no message offers a booking page. Remove it from the service.');
// The Account Manager's customer emails: from the support address, replies to it, one-click unsubscribe headers, and the postal address in every footer.
const customerMail=sendgridBulkMail({apiKey:process.env.HUB_SENDGRID_API_KEY,from:supportFrom,replyTo:supportReplyTo,category:'hub-lifecycle-email'});
// The AI team: inert unless HUB_AGENTS_ENABLED is exactly "true", and every agent starts paused until the owner resumes it.
const team=agentTeam({pool,growth,growthMail,postalAddress:process.env.HUB_BULK_EMAIL_POSTAL_ADDRESS,sms:textSender,email:mailSender,ownerEmail:process.env.HUB_OWNER_EMAIL,publicOrigin,enabled:process.env.HUB_AGENTS_ENABLED==='true',communications:messaging,features,anthropicApiKey:process.env.ANTHROPIC_API_KEY,record:sqlAiUsageRecorder(pool).record,guides:guideLibrary({load:()=>api.rpc('list_published_content',{}),loadProducts:()=>api.rows('products')}),customerTextToAi:process.env.HUB_AGENTS_CUSTOMER_TEXT_TO_AI==='true',
  leadSecrets:leadSecrets(process.env),social:socialConfig(process.env),
  lifecycle:{mail:customerMail,postalAddress:(process.env.HUB_BULK_EMAIL_POSTAL_ADDRESS||'').trim()},
  // Offers from the owner's menu: platform billing (created below) makes them, so the call is deferred until an offer is approved.
  offerBilling:{agentOffer:input=>billing.agentOffer(input)}});
const announcements=bulkEmail({pool,delegations:capabilities,publicOrigin:process.env.HUB_PUBLIC_ORIGIN||defaultPublicOrigin,postalAddress:(process.env.HUB_BULK_EMAIL_POSTAL_ADDRESS||'').trim(),
  mail:sendgridBulkMail({apiKey:process.env.HUB_SENDGRID_API_KEY,from:supportFrom,replyTo:supportReplyTo})});
// Platform billing: the Hub is the only Stripe client for every application's subscriptions.
const customerSelfService=selfService({pool,provider});
const billing=platformBilling({pool,secretKey:process.env.STRIPE_SECRET_KEY,authorizeCustomerBilling:customerSelfService.authorizeBilling,customerPurchasingEnabled:process.env.HUB_CUSTOMER_PURCHASING_ENABLED==='true',
  webhookSecrets:(process.env.STRIPE_WEBHOOK_SECRET||'').split(',').map(value=>value.trim()).filter(Boolean),
  portalConfiguration:/^bpc_[A-Za-z0-9]+$/.test(process.env.STRIPE_PORTAL_CONFIGURATION_ID||'')?process.env.STRIPE_PORTAL_CONFIGURATION_ID:undefined,
  publicOrigin:process.env.HUB_PUBLIC_ORIGIN||defaultPublicOrigin});
// Intel sets its own plan prices (src/lib/planCatalog.ts in kdeyarmin/intel). After the start and every 15 minutes the Hub reads
// them and keeps Stripe in step, grandfathering current subscribers (server/app-catalog-sync.mjs). HUB_APP_CATALOG_SYNC=off
// stops it; INTEL_CATALOG_URL reads another Intel (staging) instead of www.caremetricintel.com.
let catalogSyncRunning=false;
// Each tick also refreshes which replaced Founders Sale prices keep the offer (Intel and CareBase), sync or not.
const syncCatalogs=async()=>{
  if(catalogSyncRunning)return;
  catalogSyncRunning=true;
  try{
    const result=process.env.HUB_APP_CATALOG_SYNC==='off'?null
      :await billing.syncAppCatalog('caremetric-intel',process.env.INTEL_CATALOG_URL?{url:process.env.INTEL_CATALOG_URL}:{});
    if(result?.applied) console.info(`Intel prices: ${result.applied} Stripe product(s) and price(s) brought in step with catalog ${result.version}.`);
    // A sync that read the catalog has refreshed them already.
    if(!result?.version) await billing.refreshFounders();
  }catch{console.warn('The Intel price catalog or Founders Sale prices could not be synced; it will retry.');}
  finally{catalogSyncRunning=false;}
};
void billing.start().then(ready => ready && billing.reconcile()).then(()=>syncCatalogs()).catch(() => {});
const catalogTimer=setInterval(()=>void syncCatalogs(),15*60*1000);catalogTimer.unref();
let billingSweepRunning=false;
const billingTimer=setInterval(()=>{
  if(billingSweepRunning)return;
  billingSweepRunning=true;
  void Promise.allSettled([billing.reconcileUsage(),billing.reconcileCustomerCheckouts()]).then(results=>{
    if(results.some(result=>result.status==='rejected')) console.warn('Customer billing reconciliation could not run.');
  }).finally(()=>{billingSweepRunning=false;});
},60*1000);billingTimer.unref();
const readiness=goLiveReadiness({pool,rpc:(name,args,sessionToken)=>api.rpc(name,args,sessionToken)});
// Website leads: answered only when the database declares support.leads.v1 and the product's secret is set.
const leads=leadIntake({pool,secrets:leadSecrets(process.env),enabled:features.has(leadFeature)});
const leadDesk=leadAdmin({pool,enabled:features.has(leadFeature)});
// Leads and website conversations are deleted twelve months on (docs/LEAD_INTAKE.md, "Retention"), from the cleanup below.
const leadRetentionJob=leadRetention({pool,enabled:features.has(leadFeature)});
console.info(`Website leads: ${leads.enabled()?'database ready':'waiting for the support.leads.v1 migration'}; secrets set for ${leads.configured().join(', ')||'no product'}.`);
// Bulk lesson-media import: answered only when the database declares learning.media-import.v1. MP4s are fetched only
// from the exact hosts in HUB_MEDIA_IMPORT_HOSTS (default: HeyGen's asset hosts); an unusable value disables fetching.
const importHosts=mediaImportHosts(process.env.HUB_MEDIA_IMPORT_HOSTS);
if(!importHosts) console.warn('HUB_MEDIA_IMPORT_HOSTS must list exact host names separated by commas; bulk media import will refuse every source.');
const mediaImport=learningMediaImport({pool,hosts:importHosts,enabled:features.has(mediaImportFeature),
  storage:{upload:(sessionToken,path,body,contentType)=>capabilities.media(sessionToken,path,'upload',body,contentType),
    download:(sessionToken,path)=>capabilities.media(sessionToken,path,'download')}});
const setup=integrationSetup({rpc:(name,args,sessionToken)=>api.rpc(name,args,sessionToken)});
// Public articles as HTML for crawlers, read exactly as an anonymous visitor's app reads them, at their canonical address.
const help=helpCenter({load:()=>api.rpc('list_published_content',{}),origin:helpCenterOrigin});
const server=appServer({auth:smsAuth({pool,provider}),password:passwordAuth({pool}),owner:ownerAccess(pool),gateway:api,delegations:capabilities,publications:publicationService,aiCases,readiness,integrationSetup:setup,communications:messaging,bulkEmail:announcements,billing,selfService:customerSelfService,agents:team.admin,growth,leads,leadAdmin:leadDesk,mediaImport,health:async()=>{await pool.query({text:'select 1',query_timeout:2000});},origins:['https://support-hub-web-production.up.railway.app','https://help.caremetric.ai'],helpCenter:help});
let cleanupRunning=false;
const cleanup=async()=>{
  if(cleanupRunning) return;
  cleanupRunning=true;
  try {
    try { await publicationService.cleanupExpired(); } catch { console.warn('Private media cleanup could not complete; it will retry.'); }
    // At most once every six hours, and only while support.leads.v1 is declared; it never throws.
    await leadRetentionJob.tick();
  } finally { cleanupRunning=false; }
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
for(const signal of ['SIGTERM','SIGINT']) process.on(signal,() => { clearInterval(billingTimer); clearInterval(catalogTimer); clearInterval(cleanupTimer); clearInterval(courseTimer); clearInterval(aiTimer); clearInterval(agentTimer); clearInterval(emailTimer); server.close(() => { void pool.end(); }); });
