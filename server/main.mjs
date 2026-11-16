import { adsConfig } from './agents/ads/index.mjs';
import pg from 'pg';
import { smsProvider } from './sms-provider.mjs';
import { smsAuth, ownerAccess } from './sms-auth.mjs';
import { passwordAuth } from './password-auth.mjs';
import { gateway } from './gateway.mjs';
import { delegations } from './delegations.mjs';
import { appServer } from './http.mjs';
import { assertBackendContract } from '../src/lib/backendContract.ts';
import { databaseConfig, guardPool, untilReachable } from './database-config.mjs';
import { guardProcess } from './process-guards.mjs';
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
import { chosenMail, sesBulkMail, sesMail, snsReceiver, snsTopicPattern } from './ses.mjs';
import { platformBilling } from './billing.mjs';
import { selfService } from './self-service.mjs';
import { agentTeam } from './agents/index.mjs';
import { guideLibrary } from './agents/concierge/knowledge.mjs';
import { leadAdmin, leadFeature, leadIntake, leadSecrets } from './leads.mjs';
import { leadRetention } from './lead-retention.mjs';
import { helpCenter } from './help-center.mjs';
import { articleHomeUrl, helpCenterOrigin, servedElsewhere } from './agents/content/facts.mjs';
import { publicArticleFeed, publicArticlesFeature } from './public-articles.mjs';
import { growthStore } from './growth/store.mjs';
import { growthService } from './growth/service.mjs';
import { growthResearch } from './growth/research.mjs';
import { growthContactFinder } from './growth/contacts.mjs';
import { intelFeedReader } from './growth/intel-feed.mjs';
import { reportLinks } from './growth/report-link.mjs';
import { npiRegistry } from './growth/npi-registry.mjs';
import { mailboxChecker } from './growth/mailbox.mjs';
import { growthSender } from './growth/sender.mjs';
import { socialConfig } from './agents/social/index.mjs';
import { nativeVisitorReader } from './agents/scorecard/visitors.mjs';
import { googleAnalyticsReader, websiteVisitors } from './agents/scorecard/google-analytics.mjs';
import { creativeConfig } from './agents/creative/index.mjs';
import { creativeAdmin } from './agents/creative/admin.mjs';
import { learningMediaImport, mediaImportFeature, mediaImportHosts } from './learning-media-import.mjs';
import { hubSettings } from './hub-settings.mjs';
import { socialConnections } from './social-connections.mjs';

const storageUrl='https://xgauehtwksmnoqhgqegm.supabase.co';
// A dropped connection is logged and replaced, never an uncaught error (guardPool).
const pool=guardPool(new pg.Pool(databaseConfig()));
// Refuse an incomplete release before replacing the running application. A database that cannot be reached yet (a restart or failover)
// is waited for, 75 seconds at most for both reads together; a release that does not match it fails at once (untilReachable).
const reachableBy=Date.now()+75_000;
await untilReachable(()=>pool.query('select c.credential_version,s.auth_method from private.password_credentials c,private.sms_sessions s limit 0'),{deadline:reachableBy});
const provider=smsProvider({apiKey:process.env.HUB_TELNYX_API_KEY,profileId:process.env.HUB_TELNYX_VERIFY_PROFILE_ID});
const api=gateway(pool);
const contract=await untilReachable(()=>api.rpc('get_backend_contract',{}),{deadline:reachableBy});
assertBackendContract(contract);
// Optional features (declared ahead of the builds that use them) are read once at boot, like the AI team's.
const features=new Set(contract.features);
// The Hub's settings (Settings page, server/hub-settings.mjs): every switch and value that is not a secret. Railway keeps only the
// secrets and the service's wiring (docs/SETTINGS.md). Each service gets a reader, so a change applies within a minute without a restart.
// Until the settings migration is applied, the readers return what the old Railway variables say.
const settings=hubSettings({pool,features});
await settings.start();
const connections=socialConnections({pool,features,settings});
await connections.start();
const setting=settings.reader;
const observer=distributionObserver({pool,token:process.env.CAREBASE_DISTRIBUTION_OBSERVER_TOKEN});
const capabilities=delegations({pool,storageUrl,provider,observer,legacyDistributionOptIn:setting('learning.legacy_distribution_opt_in')});
const publicationService=publications({pool,delegations:capabilities,storageUrl});
const ai=aiAssistance({apiKey:process.env.ANTHROPIC_API_KEY,record:sqlAiUsageRecorder(pool).record});
const aiCases=aiCaseAssistance({ai,rpc:(name,args,sessionToken)=>api.rpc(name,args,sessionToken),rows:(name,sessionToken)=>api.rows(name,sessionToken)});
const automation=aiAutomation({ai,store:sqlAutomationStore(pool),enabled:setting('support.ai_automation'),draftTier:setting('support.ai_draft_tier'),
  followUpDelayMs:()=>settings.get('support.ai_follow_up_hours')*60*60*1000});
const publicOrigin=process.env.HUB_PUBLIC_ORIGIN||defaultPublicOrigin;
// One text sender and one mail sender, shared by the Communications inbox and the AI team's owner alerts.
const textSender=twilioMessaging({accountSid:process.env.HUB_TWILIO_ACCOUNT_SID,authToken:process.env.HUB_TWILIO_AUTH_TOKEN,messagingServiceSid:setting('sms.messaging_service_sid'),from:setting('sms.from_number')});
// One address for the Hub's email (docs/UNIFIED_COMMUNICATIONS.md, "One address"): staff replies, the AI team's alerts,
// customer emails and bulk email come from the support sender (Settings → Email, default support@caremetric.ai) and carry one Reply-To.
// Growth email (cold email and sales follow-ups) does too unless the growth email sender is set (below).
// caremetric.ai's mail is received by SendGrid Inbound Parse, so an answer to any of them lands in Communications.
const supportFrom=setting('email.support_from');
// Where customers' answers go: the address SendGrid Inbound Parse receives (Settings → Email → Reply-To), else the sender itself.
const supportReplyTo=()=>settings.get('email.reply_to')??settings.get('email.support_from');
// Which service sends it: SendGrid or Amazon SES (Settings → Email → Email service, docs/AMAZON_SES.md), read on each send. SES's access
// key is a secret in Railway; its region, configuration set and events topic are settings.
const emailService=setting('email.provider');
const sesAccess={accessKeyId:process.env.HUB_SES_ACCESS_KEY_ID,secretAccessKey:process.env.HUB_SES_SECRET_ACCESS_KEY,region:setting('email.ses_region'),configurationSet:setting('email.ses_configuration_set')};
const bulkSender=options=>chosenMail(emailService,{sendgrid:sendgridBulkMail({apiKey:process.env.HUB_SENDGRID_API_KEY,...options}),ses:sesBulkMail({...sesAccess,...options})});
const mailSender=chosenMail(emailService,{sendgrid:sendgridMail({apiKey:process.env.HUB_SENDGRID_API_KEY,from:supportFrom,replyTo:supportReplyTo}),
  ses:sesMail({...sesAccess,from:supportFrom,replyTo:supportReplyTo})});
// The mailing address in every marketing, growth and customer email footer (CAN-SPAM).
const postalAddress=()=>settings.get('email.postal_address')??'';
const messaging=communications({pool,delegations:capabilities,publicOrigin,
  twilioAuthToken:process.env.HUB_TWILIO_AUTH_TOKEN,sendgridInboundPublicKey:process.env.HUB_SENDGRID_INBOUND_PUBLIC_KEY,
  sms:textSender,email:mailSender,
  chatEnabled:setting('support.chat')});
// The Medicare roster from Intel's signed marketing feed (Settings → Customer growth; the shared secret HUB_INTEL_FEED_SECRET in Railway).
const roster={feed:intelFeedReader({features,enabled:setting('growth.roster'),key:process.env.HUB_INTEL_FEED_SECRET}),
  states:setting('growth.roster_states'),daily:setting('growth.roster_daily_resolutions'),
  // Web-found prospects matched to their Medicare record each day, so each gets its own market report (growth/agency-match.mjs).
  matchDaily:setting('growth.roster_match_daily')};
// Decision-makers and their work addresses, found by the Hub itself: the NPI registry, the business's own website and, when the owner
// chooses it, the business's own mail server (Settings → Customer growth → Finding people's addresses). No key: nothing to set in Railway.
const people={mode:setting('growth.enrichment_provider'),registry:npiRegistry(),
  mailbox:mailboxChecker({heloName:(()=>{try{return new URL(publicOrigin).hostname;}catch{return '';}})()})};
const growth=growthService({store:growthStore(pool),research:growthResearch({apiKey:process.env.HUB_GROWTH_SEARCH_API_KEY}),contacts:growthContactFinder(),roster,people,
  // Deeper research with web tools (Settings → Customer growth → Research prospects with web search).
  deepResearch:{enabled:setting('growth.deep_research'),perDay:setting('growth.deep_research_per_day'),cents:setting('growth.deep_research_cents')},
  // The weekly "what is working" memo, used in drafts once the owner approves it (Settings → Customer growth → Write from what is working).
  learning:{enabled:setting('growth.learning_memo')},
  // An account brief per agency, and first emails written from it on the quality tier with a reader's review (Settings → Customer growth).
  // Which agencies opened their market report, read from Intel with the feed's secret (Settings → Customer growth).
  views:{enabled:setting('growth.report_views'),feed:intelFeedReader({features,enabled:setting('growth.report_views'),key:process.env.HUB_INTEL_FEED_SECRET})},
  briefs:{enabled:setting('growth.account_brief'),perDay:setting('growth.brief_per_day'),cents:setting('growth.brief_cents'),
    qualityWriter:setting('growth.quality_writer'),critic:setting('growth.draft_critic')},
  // Each Medicare roster agency's free market report on Intel, linked in its outreach (growth/report-link.mjs; the feed's shared secret).
  reports:reportLinks({key:process.env.HUB_INTEL_FEED_SECRET}),importKey:process.env.HUB_GROWTH_IMPORT_SECRET,features:new Set(contract.features),enabled:setting('growth.send'),signingKey:process.env.HUB_GROWTH_SIGNING_KEY,eventKeys:{carebase:process.env.HUB_GROWTH_CAREBASE_EVENT_KEY,'caremetric-intel':process.env.HUB_GROWTH_INTEL_EVENT_KEY},webhookPublicKey:process.env.HUB_SENDGRID_EVENT_PUBLIC_KEY,
  sesEvents:snsReceiver({topicArn:setting('email.ses_events_topic')}),sesEventsReady:()=>snsTopicPattern.test(settings.get('email.ses_events_topic')??''),publicOrigin,postalAddress});
// Cold email and sales follow-ups may come from their own address (Settings → Email → Growth email sender, normally on a subdomain), so
// prospecting can never hurt the support address's reputation. Replies still go to the support inbox. Unset: the support sender.
const growthIdentity=()=>growthSender({HUB_GROWTH_FROM_EMAIL:settings.get('email.growth_from')??'',HUB_GROWTH_FROM_NAME:settings.get('email.growth_from_name')??''},
  {supportFrom:supportFrom(),supportReplyTo:supportReplyTo()});
for(const warning of growthIdentity().warnings)console.warn(warning);
// Growth email has its own switch (Settings → Email → Growth email service, SendGrid by default): Amazon SES does not allow unsolicited
// email, so prospecting stays off SES unless the owner chooses otherwise.
const growthOptions={from:()=>growthIdentity().from,fromName:()=>growthIdentity().fromName,replyTo:()=>growthIdentity().replyTo};
const growthMail=chosenMail(setting('email.growth_provider'),{sendgrid:sendgridBulkMail({apiKey:process.env.HUB_SENDGRID_API_KEY,...growthOptions}),ses:sesBulkMail({...sesAccess,...growthOptions})},{intoSes:false});
// The Account Manager's customer emails: from the support address, replies to it, one-click unsubscribe headers, and the postal address in every footer.
const customerMail=bulkSender({from:supportFrom,replyTo:supportReplyTo,category:'hub-lifecycle-email'});
// The AI team: inert until "Run the AI team" is switched on in Settings, and every agent starts paused until the owner resumes it.
const team=agentTeam({pool,growth,growthMail,postalAddress,sms:textSender,email:mailSender,ownerEmail:setting('agents.owner_email'),publicOrigin,enabled:setting('agents.enabled'),communications:messaging,features,anthropicApiKey:process.env.ANTHROPIC_API_KEY,record:sqlAiUsageRecorder(pool).record,guides:guideLibrary({load:()=>api.rpc('list_published_content',{}),loadProducts:()=>api.rows('products')}),customerTextToAi:setting('agents.customer_text_to_ai'),
  leadSecrets:leadSecrets(process.env),
  // Website leads followed up by email (Settings → Customer growth → Follow up website leads by email).
  inboundFollowup:setting('growth.inbound_followup'),
  // How many agent tasks may run side by side (Settings → AI team → Tasks at once).
  concurrentTasks:setting('agents.concurrent_tasks'),
  // Paid ads: Settings → Paid ads, with the Google Ads secrets from Railway.
  ads:()=>adsConfig(process.env,settings.get),
  // Days before the watchdog flags an agent that has not run (Settings → AI team).
  watchdogIdleDays:setting('agents.watchdog_idle_days'),
  // The social media tokens from Railway, with the page ids, ad accounts, images and ad limits from Settings → Social media.
  social:()=>socialConfig(connections.resolvedEnv(),connections.getSetting),
  // The Creative Director: Settings → Creative, with HeyGen's key from Railway.
  creative:()=>creativeConfig(process.env,settings.get),searchConsoleSites:setting('seo.search_console_sites'),
  searchConsoleCredentials:process.env.HUB_SEARCH_CONSOLE_CREDENTIALS,
  // Website visitors for the Monday scorecard: Intel's own session measurement, and Google Analytics (Settings → Website analytics) with
  // the Search Console service account key from Railway.
  visitorMetrics:websiteVisitors({native:nativeVisitorReader({features,enabled:setting('analytics.intel_visitors'),key:process.env.HUB_VISITOR_METRICS_KEY}),
    analytics:googleAnalyticsReader({credentials:process.env.HUB_SEARCH_CONSOLE_CREDENTIALS,properties:{carebase:setting('analytics.google_carebase_property'),'caremetric-intel':setting('analytics.google_intel_property')}})}),
  lifecycle:{mail:customerMail,get postalAddress(){return postalAddress().trim();},saveEmails:setting('growth.save_emails')},
  // Offers from the owner's menu: platform billing (created below) makes them, so the call is deferred until an offer is approved.
  offerBilling:{agentOffer:input=>billing.agentOffer(input)}});
const announcements=bulkEmail({pool,delegations:capabilities,publicOrigin:process.env.HUB_PUBLIC_ORIGIN||defaultPublicOrigin,postalAddress,
  mail:bulkSender({from:supportFrom,replyTo:supportReplyTo})});
// Platform billing: the Hub is the only Stripe client for every application's subscriptions.
const customerSelfService=selfService({pool,provider});
const billing=platformBilling({pool,secretKey:process.env.STRIPE_SECRET_KEY,authorizeCustomerBilling:customerSelfService.authorizeBilling,customerPurchasingEnabled:setting('billing.customer_purchasing'),
  webhookSecrets:(process.env.STRIPE_WEBHOOK_SECRET||'').split(',').map(value=>value.trim()).filter(Boolean),
  portalConfiguration:setting('billing.portal_configuration'),
  publicOrigin:process.env.HUB_PUBLIC_ORIGIN||defaultPublicOrigin});
// Intel sets its own plan prices (src/lib/planCatalog.ts in kdeyarmin/intel). After the start and every 15 minutes the Hub reads
// them and keeps Stripe in step, grandfathering current subscribers (server/app-catalog-sync.mjs). Switching off "Keep Stripe in step
// with Intel's prices" (Settings → Billing) stops it; INTEL_CATALOG_URL reads another Intel (staging) instead of www.caremetricintel.com.
let catalogSyncRunning=false;
// Each tick also refreshes which replaced Founders Sale prices keep the offer (Intel and CareBase), sync or not.
const syncCatalogs=async()=>{
  if(catalogSyncRunning)return;
  catalogSyncRunning=true;
  try{
    // The full refresh from Stripe, once: a no-op after it has run, and the retry when Stripe could not be reached at the start.
    await billing.reconcileOnce();
    const result=!settings.get('billing.intel_price_sync')?null
      :await billing.syncAppCatalog('caremetric-intel',process.env.INTEL_CATALOG_URL?{url:process.env.INTEL_CATALOG_URL}:{});
    if(result?.applied) console.info(`Intel prices: ${result.applied} Stripe product(s) and price(s) brought in step with catalog ${result.version}.`);
    // A sync that read the catalog has refreshed them already.
    if(!result?.version) await billing.refreshFounders();
  }catch{console.warn('The Intel price catalog or Founders Sale prices could not be synced; it will retry.');}
  finally{catalogSyncRunning=false;}
};
void billing.reconcileOnce().then(()=>syncCatalogs()).catch(() => {});
const catalogTimer=setInterval(()=>void syncCatalogs(),15*60*1000);catalogTimer.unref();
let billingSweepRunning=false;
const billingTimer=setInterval(()=>{
  if(billingSweepRunning)return;
  billingSweepRunning=true;
  void Promise.allSettled([billing.reconcileUsage(),billing.reconcileCustomerCheckouts()]).then(results=>{
    if(results.some(result=>result.status==='rejected')) console.warn('Customer billing reconciliation could not run.');
  }).finally(()=>{billingSweepRunning=false;});
},60*1000);billingTimer.unref();
const readiness=goLiveReadiness({pool,rpc:(name,args,sessionToken)=>api.rpc(name,args,sessionToken),automationEnabled:setting('support.ai_automation')});
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
const setup=integrationSetup({rpc:(name,args,sessionToken)=>api.rpc(name,args,sessionToken),env:connections.resolvedEnv});
// Public articles as HTML for crawlers, read exactly as an anonymous visitor's app reads them, at their canonical address.
// A product's public articles as JSON for its own website: answered only when the database declares content.public-articles.v1.
const publicArticles=features.has(publicArticlesFeature)?publicArticleFeed({load:async product=>(await pool.query({text:'select private.public_articles($1) as articles',values:[product],query_timeout:5000})).rows[0].articles}):null;
console.info(`Public article feed: ${publicArticles?'answering':'waiting for the content.public-articles.v1 migration'}.`);
// Once the feed answers, an article whose product's own website serves it (CareMetric Intel's) keeps its page here but names that
// address as canonical and leaves the sitemap. Before, the help center stays every article's home.
const help=helpCenter({load:()=>api.rpc('list_published_content',{}),...(publicArticles?{loadProducts:()=>api.rows('products'),elsewhere:(product,key)=>servedElsewhere(product)?articleHomeUrl(product,key):null}:{}),origin:helpCenterOrigin});
// The Creative screen and the approved-asset addresses Meta and LinkedIn fetch (platform.agents.creative.v1).
const creativeWeb=features.has('platform.agents.creative.v1')?{admin:creativeAdmin({pool,kick:()=>team.tick()}),publicFile:token=>team.store.creativePublicFile(token)}:null;
const server=appServer({auth:smsAuth({pool,provider}),password:passwordAuth({pool}),owner:ownerAccess(pool),gateway:api,delegations:capabilities,publications:publicationService,aiCases,readiness,integrationSetup:setup,settings,socialConnections:connections,communications:messaging,bulkEmail:announcements,billing,selfService:customerSelfService,agents:team.admin,growth,leads,leadAdmin:leadDesk,mediaImport,health:async()=>{await pool.query({text:'select 1',query_timeout:2000});},origins:['https://support-hub-web-production.up.railway.app','https://help.caremetric.ai'],helpCenter:help,publicArticles,creative:creativeWeb});
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
// Started: from here a stray rejection is logged and the Hub keeps running; an uncaught exception is logged and still stops it.
guardProcess();
server.requestTimeout=130000; server.headersTimeout=15000;
server.listen(Number(process.env.PORT || 8080),'0.0.0.0');
// A second signal while the first is still closing connections must not end the pool again: pg rejects that, and the
// unhandled rejection would crash the shutdown it interrupts.
let stopping=false;
for(const signal of ['SIGTERM','SIGINT']) process.on(signal,() => { if(stopping)return; stopping=true; settings.stop(); connections.stop(); clearInterval(billingTimer); clearInterval(catalogTimer); clearInterval(cleanupTimer); clearInterval(courseTimer); clearInterval(aiTimer); clearInterval(agentTimer); clearInterval(emailTimer); server.close(() => { void pool.end(); }); });
