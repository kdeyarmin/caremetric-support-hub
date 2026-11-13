import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve,extname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { cookie,readCookie,sessionCookie,challengeCookie,HttpError } from './sms-auth.mjs';
import { parseMediaUploadHeader } from './learning-media.mjs';
import { parsePackageUploadHeader } from './learning-packages.mjs';
import { chatCookie } from './communications.mjs';
import { bulkEmailActions } from './bulk-email.mjs';
import { agentAdminActions } from './agents/admin.mjs';
import { creativeAdminActions } from './agents/creative/admin.mjs';

export const securityHeaders = {
  'X-Content-Type-Options':'nosniff','X-Frame-Options':'SAMEORIGIN',
  'Strict-Transport-Security':'max-age=31536000; includeSubDomains','Referrer-Policy':'no-referrer',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=(), payment=()',
  'Content-Security-Policy':"default-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob: https://xgauehtwksmnoqhgqegm.supabase.co; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
};
async function jsonBody(req,limit=2000000) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new HttpError(415,'Use a JSON request.');
  const chunks=[]; let size=0;
  for await (const chunk of req) { size+=chunk.length; if(size>limit) throw new HttpError(413,'Request is too large.'); chunks.push(chunk); }
  let body;
  try { body=JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400,'Invalid request.'); }
  if (!body || Array.isArray(body) || typeof body!=='object') throw new HttpError(400,'Invalid request.');
  return body;
}
async function rawBody(req,limit) {
  const chunks=[]; let size=0;
  for await (const chunk of req) { size+=chunk.length; if(size>limit) throw new HttpError(413,'Request is too large.'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
export function sameOrigin(req,origins) {
  return origins.includes(req.headers.origin) && (!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site']==='same-origin');
}
/**
 * A file from memory, with one byte range when asked (a video player seeks with ranges). `disposition` is inline or attachment.
 */
function sendBytes(req,res,{contentType,bytes,fileName=null,disposition='inline',cache='private, no-store'}) {
  const data=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes);
  res.setHeader('Content-Type',contentType); res.setHeader('Accept-Ranges','bytes'); res.setHeader('Cache-Control',cache);
  if(fileName) res.setHeader('Content-Disposition',`${disposition}; filename="${String(fileName).replace(/[^A-Za-z0-9._-]/g,'')}"`);
  const range=/^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range??''));
  let start=0, end=data.length-1;
  if(range && (range[1]||range[2])) {
    start=range[1]?Number(range[1]):Math.max(0,data.length-Number(range[2]));
    end=range[1]&&range[2]?Math.min(Number(range[2]),data.length-1):data.length-1;
    if(!(start<=end && start<data.length)) { res.statusCode=416; res.setHeader('Content-Range',`bytes */${data.length}`); return res.end(); }
    res.statusCode=206; res.setHeader('Content-Range',`bytes ${start}-${end}/${data.length}`);
  } else res.statusCode=200;
  res.setHeader('Content-Length',String(end-start+1));
  if(req.method==='HEAD') return res.end();
  return res.end(data.subarray(start,end+1));
}
const mime={'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.woff2':'font/woff2','.html':'text/html'};
const aiCaseActions=new Set(['summary','draft-reply','triage-suggestion']);
const staffCommunicationActions=new Set(['list','get','update','note','reply','sync']);
// Railway's edge appends the visitor address last; rate limits use it only as a hashed bucket.
const visitorAddress=req=>String(req.headers['x-forwarded-for']||'').split(',').at(-1).trim()||req.socket.remoteAddress||'unknown';
// The database functions raise these codes with a message written for the person using the Hub (a stale save, a closed case, a
// course that cannot publish yet and why): it is shown with a matching status instead of "temporarily unavailable". Sign-in and
// permission errors keep their fixed wording, and anything else (a constraint naming a table, an outage) stays generic.
const databaseStatus={'22023':400,P0001:422,P0002:404,'40001':409,'55000':409,P4040:404,P4090:409,P4130:413,P4290:429};
export function reviewedDatabaseError(error) {
  if(typeof error?.code!=='string'||!Object.hasOwn(databaseStatus,error.code)||typeof error.severity!=='string'||typeof error.message!=='string') return null;
  const message=error.message.split('\n')[0].trim().slice(0,500);
  return message?{status:databaseStatus[error.code],message}:null;
}
export const privateHubMessage='This Hub is private. Only its owner can sign in.';
/**
 * `owner.allows(sessionToken)` makes the Hub private to its owner: a session that fails it is
 * treated as signed out, a sign-in that fails it is revoked at once, and the routes that create
 * sign-ins for anyone else (invitation claims and application self-service) are closed.
 */
export function appServer({auth,password,gateway,delegations,publications,aiCases,readiness,integrationSetup,settings=null,socialConnections=null,communications,bulkEmail,billing,selfService,agents,growth,leads,leadAdmin,mediaImport=null,health,owner,origins,helpCenter=null,publicArticles=null,creative=null,dist=resolve('dist')}) {
  return createServer(async(req,res) => {
    for (const [name,value] of Object.entries(securityHeaders)) res.setHeader(name,value);
    const json=(body,status=200,cookies=[]) => {
      res.statusCode=status; res.setHeader('Content-Type','application/json'); res.setHeader('Cache-Control','no-store');
      if(cookies.length) res.setHeader('Set-Cookie',cookies);
      res.end(JSON.stringify(body));
    };
    try {
      const url=new URL(req.url,'http://internal');
      const path=url.pathname;
      const cookieSession=readCookie(req.headers.cookie,sessionCookie);
      const session=owner && cookieSession && path.startsWith('/api/') && !(await owner.allows(cookieSession)) ? undefined : cookieSession;
      if (path.startsWith('/api/')) {
        res.setHeader('Cache-Control','no-store');
        // Public liveness for uptime probes: whether this process can reach its database. It reveals nothing else.
        if(path==='/api/health') {
          if(!['GET','HEAD'].includes(req.method)) throw new HttpError(405,'Method not allowed.');
          if(health) { try { await health(); } catch { throw new HttpError(503,'Unavailable.'); } }
          return json({ok:true});
        }
        // A product's public help articles as JSON for its own website (server/public-articles.mjs): read-only, no session, cacheable.
        // Answered only when the database declares content.public-articles.v1; otherwise the address does not exist.
        if(path==='/api/public/articles' || path.startsWith('/api/public/articles/')) {
          if(publicArticles && await publicArticles.serve(req,res,url)) return;
          throw new HttpError(404,'This resource is unavailable.');
        }
        if (path.startsWith('/api/internal/')) {
          if(req.method!=='POST' || req.headers.origin || req.headers.cookie) throw new HttpError(403,'Forbidden.');
          const customerCapability=/^\/api\/internal\/self-service\/([a-z-]+)\/authorize$/.exec(path);
          if(customerCapability && selfService) {
            const input=await jsonBody(req,2048);
            if(Object.keys(input).length) throw new HttpError(400,'Invalid capability request.');
            return json(await selfService.consume(req.headers.authorization,customerCapability[1]));
          }
          if(path==='/api/internal/publications/public/authorize' && publications) {
            const authorization=req.headers.authorization;
            if(typeof authorization!=='string' || !authorization.startsWith('Bearer ')) throw new HttpError(401,'Authorization required.');
            const input=await jsonBody(req,2048);
            if(Object.keys(input).length) throw new HttpError(400,'Invalid public download request.');
            return json(await publications.consumePublicDownload(authorization.slice(7)));
          }
          if(path==='/api/internal/publications/cleanup/authorize' && publications) {
            const authorization=req.headers.authorization;
            if(typeof authorization!=='string' || !authorization.startsWith('Bearer ')) throw new HttpError(401,'Authorization required.');
            const input=await jsonBody(req,2048);
            if(Object.keys(input).length) throw new HttpError(400,'Invalid cleanup request.');
            return json(await publications.consumeCleanup(authorization.slice(7)));
          }
          const audience={
            '/api/internal/publications/authorize':'publication',
            '/api/internal/media/authorize':'media', '/api/internal/admin/authorize':'carebase',
            '/api/internal/admin/breathe/authorize':'breathe', '/api/internal/admin/emr/authorize':'caremetric-emr',
            '/api/internal/admin/pennsync/authorize':'pennsync', '/api/internal/command/carebase/authorize':'carebase.command',
            '/api/internal/admin/go/authorize':'caremetric-go',
            '/api/internal/admin/intel/authorize':'intel',
            '/api/internal/admin/advisors/authorize':'advisors',
            '/api/internal/learning/carebase/authorize':'carebase.learning',
          }[path];
          if(!audience) throw new HttpError(404,'Unavailable.');
          const authorization=req.headers.authorization;
          if(typeof authorization!=='string' || !authorization.startsWith('Bearer ')) throw new HttpError(401,'Authorization required.');
          await jsonBody(req,2048);
          return json(await delegations.consume(authorization.slice(7),audience));
        }
        // Provider webhooks: authenticated by their own signatures, never by browser state.
        if(path.startsWith('/api/channels/')) {
          if(req.method!=='POST' || req.headers.origin || req.headers.cookie || url.search) throw new HttpError(403,'Forbidden.');
          if(!communications) throw new HttpError(503,'Communications are not configured.');
          if(path==='/api/channels/sms/twilio') {
            const twiml=await communications.smsWebhook(req);
            res.statusCode=200; res.setHeader('Content-Type','text/xml'); return res.end(twiml);
          }
          if(path==='/api/channels/email/inbound') return json(await communications.emailWebhook(req));
          throw new HttpError(404,'Unavailable.');
        }
        const growthEvent=/^\/api\/growth\/events\/(carebase|caremetric-intel)$/.exec(path);
        // A list built elsewhere, signed with HUB_GROWTH_IMPORT_SECRET like the lead forms (docs/CUSTOMER_GROWTH.md, "Importing a list").
        if(path==='/api/growth/import') {
          if(req.method!=='POST'||req.headers.origin||req.headers.cookie||url.search) throw new HttpError(403,'Forbidden.');
          if(!growth) throw new HttpError(503,'Growth is unavailable.');
          return json(await growth.importSigned(await rawBody(req,262144),req.headers));
        }
        if(growthEvent || path==='/api/growth/delivery' || path==='/api/growth/delivery/ses') {
          if(req.method!=='POST'||req.headers.origin||req.headers.cookie||url.search) throw new HttpError(403,'Forbidden.');
          if(!growth) throw new HttpError(503,'Growth is unavailable.');
          const raw=await rawBody(req,growthEvent?8192:262144);
          // Amazon SES events arrive as SNS notifications (docs/AMAZON_SES.md); SendGrid's signed Event Webhook keeps its own address.
          if(path==='/api/growth/delivery/ses') return json(await growth.sesDelivery(raw));
          return json(growthEvent?await growth.activity(growthEvent[1],raw,req.headers):await growth.delivery(raw,req.headers));
        }
        // `preferences` is the address new growth emails carry; `unsubscribe` stays for emails already sent (see growthOptOutPath in growth/worker.mjs).
        const growthUnsubscribe=/^\/api\/growth\/(?:unsubscribe|preferences)\/([a-f0-9]{64})$/.exec(path);
        if(growthUnsubscribe) {
          if(!growth)throw new HttpError(503,'Growth is unavailable.');
          if(!['GET','POST'].includes(req.method))throw new HttpError(405,'Method not allowed.');
          if(req.method==='POST')await rawBody(req,4096);
          const html=await growth.unsubscribe(growthUnsubscribe[1],req.method==='POST');
          res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(html);
        }
        // Stripe calls the billing webhook; its signature over the exact raw body is the only authority.
        if(path==='/api/webhooks/stripe') {
          if(req.method!=='POST' || req.headers.origin || req.headers.cookie || url.search) throw new HttpError(403,'Forbidden.');
          if(!billing) throw new HttpError(503,'Billing is not configured.');
          return json(await billing.webhook(await rawBody(req,1000000),req.headers['stripe-signature']));
        }
        // Website leads from CareBase, Intel and Advisors: server to server, signed per product, answered exactly as
        // docs/LEAD_INTAKE.md says (the handler checks the method, browser state and query string itself).
        if(path==='/api/leads') {
          if(!leads) return json({error:'not_configured'},503);
          const result=await leads.handle(req);
          for(const [name,value] of Object.entries(result.headers??{})) res.setHeader(name,value);
          return json(result.body,result.status);
        }
        // Application servers ask what a tenant has and report billable quantities with their application key.
        if(path==='/api/apps/connect' && selfService) {
          if(req.method!=='POST' || req.headers.origin || req.headers.cookie || url.search) throw new HttpError(403,'Forbidden.');
          if(owner) throw new HttpError(403,privateHubMessage);
          return json(await selfService.issue(req.headers.authorization,await jsonBody(req,262144)));
        }
        if(path==='/api/apps/growth') {
          if(req.method!=='POST' || req.headers.origin || req.headers.cookie || url.search) throw new HttpError(403,'Forbidden.');
          if(!growth?.appActivity) throw new HttpError(503,'Growth is unavailable.');
          return json(await growth.appActivity(req.headers.authorization,await jsonBody(req,8192)));
        }
        const appBilling=/^\/api\/apps\/(entitlements|facility-entitlements|usage|trials|portal|billing)$/.exec(path);
        if(appBilling) {
          if(req.method!=='POST' || req.headers.origin || req.headers.cookie || url.search) throw new HttpError(403,'Forbidden.');
          if(!billing) throw new HttpError(503,'Billing is not configured.');
          const action={entitlements:'entitlements','facility-entitlements':'facilityEntitlements',usage:'usage',trials:'trial',portal:'appPortal',billing:'appPlanChanges'}[appBilling[1]];
          return json(await billing[action](req.headers.authorization,await jsonBody(req,['facility-entitlements','billing'].includes(appBilling[1])?262144:8192)));
        }
        // Unsubscribe links in bulk email: the secret token in the path is the only authority,
        // so a mail client's one-click POST (RFC 8058) works without a session or origin.
        const unsubscribe=/^\/api\/email\/unsubscribe\/([0-9a-f]{64})$/.exec(path);
        if(unsubscribe) {
          if(!bulkEmail) throw new HttpError(503,'Email is not configured.');
          if(!['GET','POST'].includes(req.method)) throw new HttpError(405,'Method not allowed.');
          if(req.method==='POST') { let size=0; for await (const chunk of req) { size+=chunk.length; if(size>4096) throw new HttpError(413,'Request is too large.'); } }
          const html=await bulkEmail.unsubscribePage(unsubscribe[1],req.method==='POST');
          res.statusCode=200; res.setHeader('Content-Type','text/html; charset=utf-8'); return res.end(html);
        }
        // An approved Creative Director asset, for Meta and LinkedIn to fetch: the unguessable token in the path is the only authority,
        // and it answers only while the asset is approved or live (a retired or rejected asset is gone).
        const creativePublic=/^\/api\/creative\/a\/([0-9a-f]{64})\.(png|mp4)$/.exec(path);
        if(creativePublic) {
          if(!['GET','HEAD'].includes(req.method)) throw new HttpError(405,'Method not allowed.');
          if(url.search || !creative?.publicFile) throw new HttpError(404,'Unavailable.');
          const file=await creative.publicFile(creativePublic[1]);
          if(!file || file.contentType!==(creativePublic[2]==='png'?'image/png':'video/mp4')) throw new HttpError(404,'Unavailable.');
          return sendBytes(req,res,{contentType:file.contentType,bytes:file.bytes,cache:'public, max-age=300'});
        }
        if (!['GET','POST','HEAD'].includes(req.method)) throw new HttpError(405,'Method not allowed.');
        if(req.method==='POST' && !sameOrigin(req,origins)) throw new HttpError(403,'Open this action in CareMetric.');
        if(owner && (path.startsWith('/api/self-service/connect/') || path.startsWith('/api/auth/invitation/'))) throw new HttpError(403,privateHubMessage);
        if(path==='/api/self-service/connect/start' && req.method==='POST' && selfService) {
          if(url.search) throw new HttpError(400,'Query parameters are not supported.');
          const started=await selfService.start(await jsonBody(req,4096),visitorAddress(req));
          return json({challenge_id:started.id},200,[cookie(challengeCookie,started.browserToken,300)]);
        }
        if(path==='/api/self-service/connect/verify' && req.method==='POST' && selfService) {
          if(url.search) throw new HttpError(400,'Query parameters are not supported.');
          const connectedSession=await selfService.verify(await jsonBody(req,4096),readCookie(req.headers.cookie,challengeCookie),session);
          return json({authenticated:true},200,[cookie(sessionCookie,connectedSession,28800),cookie(challengeCookie,'',0)]);
        }
        if(path==='/api/self-service' && req.method==='POST' && selfService) {
          if(url.search) throw new HttpError(400,'Query parameters are not supported.');
          return json(await selfService.handle(session,await jsonBody(req,8192)));
        }
        if(path==='/api/billing/customer' && req.method==='POST' && billing) {
          if(url.search) throw new HttpError(400,'Query parameters are not supported.');
          return json(await billing.customer(session,await jsonBody(req,8192)));
        }
        if(path.startsWith('/api/chat/') && communications) {
          if(url.search) throw new HttpError(400,'Chat query parameters are not supported.');
          const chat=readCookie(req.headers.cookie,chatCookie);
          if(path==='/api/chat/start' && req.method==='POST') {
            const started=await communications.startChat(await jsonBody(req,8192),visitorAddress(req));
            return json({reference:started.reference},200,[cookie(chatCookie,started.token,2592000)]);
          }
          if(path==='/api/chat/availability' && req.method==='GET') return json(communications.availability());
          if(path==='/api/chat/thread' && req.method==='GET') return json(await communications.readChat(chat));
          if(path==='/api/chat/message' && req.method==='POST') return json(await communications.postChat(chat,await jsonBody(req,8192),visitorAddress(req)));
          if(path==='/api/chat/end' && req.method==='POST') { await jsonBody(req,2048); return json({ended:true},200,[cookie(chatCookie,'',0)]); }
          throw new HttpError(404,'Chat resource unavailable.');
        }
        if(path.startsWith('/api/communications/') && communications) {
          if(url.search) throw new HttpError(400,'Communication query parameters are not supported.');
          const action=path.slice('/api/communications/'.length);
          if(action==='channels' && req.method==='GET') return json(await communications.channels(session));
          if(staffCommunicationActions.has(action) && req.method==='POST') return json(await communications[action](session,await jsonBody(req,16384)));
          throw new HttpError(404,'Communication resource unavailable.');
        }
        if(path.startsWith('/api/course-media')) {
          if(url.search)throw new HttpError(400,'Media query parameters are not supported.');
          const controller=new AbortController();
          const abort=()=>{if(!res.writableEnded)controller.abort();};req.once('aborted',abort);res.once('close',abort);
          const deadline=setTimeout(()=>{controller.abort();req.destroy();},path==='/api/course-media'?12000:120000);deadline.unref();
          try {
            if(path==='/api/course-media' && req.method==='POST'){
              const input=await jsonBody(req,8192);if(!['media.context','media.status','media.finish'].includes(input.operation))throw new HttpError(400,'Invalid media metadata operation.');
              return json(await delegations.courseMedia(session,input,{signal:controller.signal}));
            }
            if(path==='/api/course-media/upload' && req.method==='POST')return json(await delegations.courseMedia(session,parseMediaUploadHeader(req.headers['x-caremetric-media-request']),
              {body:req,contentType:req.headers['content-type'],contentLength:req.headers['content-length'],signal:controller.signal}));
            const ids=/^\/api\/course-media\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/.exec(path);
            if(ids&&['GET','HEAD'].includes(req.method)) {
              if(req.headers['sec-fetch-site']&&!['same-origin','none'].includes(req.headers['sec-fetch-site']))throw new HttpError(403,'Open this media in CareMetric.');
              const result=await delegations.courseMedia(session,{operation:'media.read',courseId:ids[1],versionId:ids[2],blockId:ids[3],assetId:ids[4],range:null},
                {rangeHeader:req.headers.range,headOnly:req.method==='HEAD',signal:controller.signal});
              res.statusCode=result.range?206:200;res.setHeader('Content-Type',result.asset.mimeType);res.setHeader('Content-Length',String(result.length));
              res.setHeader('Cache-Control','private, no-store');res.setHeader('Accept-Ranges','bytes');
              if(result.range)res.setHeader('Content-Range',`bytes ${result.range.start}-${result.range.end}/${result.asset.byteSize}`);
              if(req.method==='HEAD')return res.end();
              await pipeline(result.body,res);return;
            }
            throw new HttpError(404,'Media resource unavailable.');
          }finally{clearTimeout(deadline);req.removeListener('aborted',abort);res.removeListener('close',abort);}
        }
        if(path.startsWith('/api/publications/') && publications) {
          if(url.search) throw new HttpError(400,'Publication query parameters are not supported.');
          if(path==='/api/publications/access' && req.method==='GET') return json(await publications.access(session));
          if(path==='/api/publications/imports/stage' && req.method==='POST') return json(await publications.stage(session,await jsonBody(req,70000)));
          const asset=/^\/api\/publications\/imports\/([0-9a-f-]{36})\/assets\/(primary|captions|transcript)$/.exec(path);
          if(asset && req.method==='POST') return json(await publications.upload(session,asset[1],asset[2],req,req.headers['content-type']));
          const intent=/^\/api\/publications\/imports\/([0-9a-f-]{36})(?:\/(preview|commit))?$/.exec(path);
          if(intent) {
            if(!intent[2] && req.method==='GET') return json(await publications.get(session,intent[1]));
            if(intent[2]==='preview' && req.method==='POST') {
              const input=await jsonBody(req,2048); if(Object.keys(input).length) throw new HttpError(400,'Invalid preview request.');
              return json(await publications.preview(session,intent[1]));
            }
            if(intent[2]==='commit' && req.method==='POST') return json(await publications.commit(session,intent[1],await jsonBody(req,4096)));
          }
          const mediaInfo=/^\/api\/publications\/media\/([0-9a-f-]{36})$/.exec(path);
          if(mediaInfo && req.method==='GET') return json(await publications.mediaInfo(session,mediaInfo[1]));
          const media=/^\/api\/publications\/media\/([0-9a-f-]{36})\/(primary|captions|transcript)$/.exec(path);
          if(media && ['GET','HEAD'].includes(req.method)) {
            const {asset,range,response}=await publications.media(session,media[1],media[2],req.headers.range,req.method==='HEAD');
            const length=range?.length ?? asset.byteLength;
            res.statusCode=range?206:200;
            res.setHeader('Content-Type',asset.contentType); res.setHeader('Content-Length',String(length)); res.setHeader('Accept-Ranges','bytes');
            if(range) res.setHeader('Content-Range',`bytes ${range.start}-${range.end}/${asset.byteLength}`);
            if(req.method==='HEAD') return res.end();
            let received=0;
            async function* boundedMedia() {
              for await(const chunk of Readable.fromWeb(response.body)) {
                received+=chunk.length; if(received>length) throw new Error('Invalid publication media length.'); yield chunk;
              }
              if(received!==length) throw new Error('Incomplete publication media.');
            }
            await pipeline(Readable.from(boundedMedia()),res); return;
          }
          throw new HttpError(404,'Publication resource unavailable.');
        }
        if(path==='/api/auth/session' && req.method==='GET') return json(await gateway.session(session));
        if(path==='/api/auth/password/login' || path==='/api/auth/password/settings') {
          if(url.search) throw new HttpError(400,'Authentication query parameters are not supported.');
          if(!password) throw new HttpError(503,'Password sign-in is unavailable.');
          if(path.endsWith('/settings') && req.method==='GET') return json(await password.settings(session));
          if(req.method!=='POST') throw new HttpError(405,'Method not allowed.');
          const input=await jsonBody(req,4096);
          const value=path.endsWith('/login')
            ? await password.login(input,visitorAddress(req),session)
            : await password.save(session,input,visitorAddress(req));
          if(owner && !(await owner.allows(value))) { await auth.logout(value); throw new HttpError(403,privateHubMessage); }
          return json({authenticated:true},200,[cookie(sessionCookie,value,28800),cookie(challengeCookie,'',0)]);
        }
        if(path==='/api/auth/invitation/start' && req.method==='POST') {
          if(url.search)throw new HttpError(400,'Invitation query parameters are not supported.');
          const result=await delegations.registration.start(await jsonBody(req,2048),visitorAddress(req));
          if(result.unavailable)throw new HttpError(503,'SMS is temporarily unavailable. Please try again later.');
          return json({challengeId:result.id,retryAfter:60},200,[cookie(challengeCookie,result.browserToken,300)]);
        }
        if(path==='/api/auth/invitation/verify' && req.method==='POST') {
          if(url.search)throw new HttpError(400,'Invitation query parameters are not supported.');
          const value=await delegations.registration.verify(await jsonBody(req,2048),readCookie(req.headers.cookie,challengeCookie),session);
          return json({authenticated:true},200,[cookie(sessionCookie,value,28800),cookie(challengeCookie,'',0)]);
        }
        if(path==='/api/auth/sms/start' && req.method==='POST') {
          const {phone}=await jsonBody(req,2048);
          // The same answer for every number: whether one is registered, or its text could be sent, is never revealed.
          const result=await auth.start(phone,visitorAddress(req));
          return json({challengeId:result.id,retryAfter:60},200,[cookie(challengeCookie,result.browserToken,300)]);
        }
        if(path==='/api/auth/sms/verify' && req.method==='POST') {
          const {challengeId,code}=await jsonBody(req,2048);
          const value=await auth.verify(challengeId,readCookie(req.headers.cookie,challengeCookie),code,session);
          if(owner && !(await owner.allows(value))) { await auth.logout(value); throw new HttpError(403,privateHubMessage); }
          return json({authenticated:true},200,[cookie(sessionCookie,value,28800),cookie(challengeCookie,'',0)]);
        }
        if(path==='/api/auth/logout' && req.method==='POST') {
          await jsonBody(req,2048); await auth.logout(session);
          return json({authenticated:false},200,[cookie(sessionCookie,'',0),cookie(challengeCookie,'',0)]);
        }
        if(path==='/api/admin/go-live-readiness' && req.method==='POST') {
          if(url.search) throw new HttpError(400,'Readiness query parameters are not supported.');
          const input=await jsonBody(req,2048); if(Object.keys(input).length) throw new HttpError(400,'Invalid readiness request.');
          if(!readiness) throw new HttpError(503,'Go-live readiness is not configured.');
          return json(await readiness.handle(session));
        }
        if(path==='/api/admin/integration-setup' && req.method==='POST') {
          if(url.search) throw new HttpError(400,'Integration setup query parameters are not supported.');
          const input=await jsonBody(req,2048); if(Object.keys(input).length) throw new HttpError(400,'Invalid integration setup request.');
          if(!integrationSetup) throw new HttpError(503,'Integration setup is not configured.');
          return json(await integrationSetup.handle(session));
        }
        // The Hub's settings (server/hub-settings.mjs): switches and values the owner changes here instead of in Railway variables.
        if(path==='/api/admin/settings') {
          if(req.method!=='POST'||url.search) throw new HttpError(400,'Use the Settings page.');
          if(!settings) throw new HttpError(503,'Settings are not configured.');
          return json(await settings.admin(session,await jsonBody(req,32768)));
        }
        if(path==='/api/admin/social-connections') {
          if(req.method!=='POST'||url.search) throw new HttpError(400,'Use Social media in Settings.');
          if(!socialConnections) throw new HttpError(503,'Social connection setup is unavailable.');
          return json(await socialConnections.admin(session,await jsonBody(req,65536)));
        }
        if(path==='/api/admin/growth') {
          if(req.method!=='POST'||url.search)throw new HttpError(400,'Use the growth workspace.');
          if(!growth)throw new HttpError(503,'Growth is unavailable.');
          return json(await growth.admin(session,await jsonBody(req,32768)));
        }
        // The AI team's controls. Approving an action also carries it out, so changes are routes here, not browser RPCs.
        if(path.startsWith('/api/admin/team/')) {
          if(url.search) throw new HttpError(400,'AI team query parameters are not supported.');
          if(!agents) throw new HttpError(503,'The AI team is not configured.');
          const action=path.slice('/api/admin/team/'.length);
          if(!agentAdminActions.has(action) || req.method!=='POST') throw new HttpError(404,'AI team resource unavailable.');
          return json(await agents[action](session,await jsonBody(req,action==='email'?32768:8192)));
        }
        // The Creative screen. Reads and changes are POSTs that the hub.* operations authorize; a file is a GET the same session reads.
        if(path.startsWith('/api/admin/creative/')) {
          if(!creative?.admin) throw new HttpError(503,'The Creative Director is not configured.');
          const fileRoute=/^\/api\/admin\/creative\/file\/([0-9a-f-]{36})$/.exec(path);
          if(fileRoute) {
            if(!['GET','HEAD'].includes(req.method)) throw new HttpError(405,'Method not allowed.');
            const download=url.searchParams.get('download');
            if([...url.searchParams.keys()].some(key=>key!=='download') || (download!==null && download!=='1')) throw new HttpError(400,'Creative query parameters are not supported.');
            const file=await creative.admin.file(session,fileRoute[1]);
            return sendBytes(req,res,{...file,disposition:download==='1'?'attachment':'inline'});
          }
          if(url.search) throw new HttpError(400,'Creative query parameters are not supported.');
          const action=path.slice('/api/admin/creative/'.length);
          if(!creativeAdminActions.has(action) || req.method!=='POST') throw new HttpError(404,'Creative resource unavailable.');
          return json(await creative.admin[action](session,await jsonBody(req,action==='brandFile'?7_500_000:32768)));
        }
        // The owner's lead status change; the Leads screen reads through the RPC allowlist (list_leads).
        if(path.startsWith('/api/admin/leads/')) {
          if(url.search) throw new HttpError(400,'Lead query parameters are not supported.');
          if(!leadAdmin) throw new HttpError(503,'Leads are not configured.');
          if(path!=='/api/admin/leads/status' || req.method!=='POST') throw new HttpError(404,'Lead resource unavailable.');
          return json(await leadAdmin.status(session,await jsonBody(req,2048)));
        }
        if(path.startsWith('/api/admin/bulk-email/')) {
          if(url.search) throw new HttpError(400,'Bulk email query parameters are not supported.');
          if(!bulkEmail) throw new HttpError(503,'Bulk email is not configured.');
          const action=path.slice('/api/admin/bulk-email/'.length);
          if(!bulkEmailActions.has(action) || req.method!=='POST') throw new HttpError(404,'Bulk email resource unavailable.');
          return json(await bulkEmail[action](session,await jsonBody(req,131072)));
        }
        const aiCaseRoute=/^\/api\/ai\/cases\/([0-9a-f-]{36})\/([a-z-]+)$/.exec(path);
        if(aiCaseRoute && req.method==='POST') {
          if(!aiCaseActions.has(aiCaseRoute[2])) throw new HttpError(404,'This resource is unavailable.');
          if(!aiCases) throw new HttpError(503,'AI assistance is not configured.','AI_NOT_CONFIGURED');
          return json(await aiCases.handle(session,aiCaseRoute[2],aiCaseRoute[1],await jsonBody(req,4096)));
        }
        if(path==='/api/admin/billing' && req.method==='POST') {
          if(url.search) throw new HttpError(400,'Billing query parameters are not supported.');
          if(!billing) throw new HttpError(503,'Billing is not configured.');
          return json(await billing.command(session,await jsonBody(req,65536)));
        }
        if(path==='/api/billing/portal' && req.method==='POST') {
          if(selfService) await selfService.refreshAuthority(session);
          if(url.search) throw new HttpError(400,'Billing query parameters are not supported.');
          if(!billing) throw new HttpError(503,'Billing is not configured.');
          return json(await billing.customerPortal(session,await jsonBody(req,2048)));
        }
        if(path.startsWith('/api/rpc/') && req.method==='POST') {
          const name=path.slice(9);
          if(selfService && session && (name.includes('support_case') || name==='my_billing')) await selfService.refreshAuthority(session);
          return json(await gateway.rpc(name,await jsonBody(req),session));
        }
        if(path.startsWith('/api/rows/') && req.method==='GET') {
          const name=path.slice(10);
          if(selfService && session && name==='support_case_queue') await selfService.refreshAuthority(session);
          return json(await gateway.rows(name,session));
        }
        if(path==='/api/admin/packages' && req.method==='POST') {
          if(url.search)throw new HttpError(400,'Package query parameters are not supported.');
          if(req.headers['content-encoding']&&req.headers['content-encoding']!=='identity')throw new HttpError(415,'Package content encoding is unsupported.');
          const upload=req.headers['content-type']==='application/zip';
          if(!upload&&req.headers['x-caremetric-package-request'])throw new HttpError(400,'Unexpected package metadata.');
          const input=upload?parsePackageUploadHeader(req.headers['x-caremetric-package-request']):await jsonBody(req,8192);
          const controller=new AbortController();const abort=()=>{if(!res.writableEnded)controller.abort();};
          req.once('aborted',abort);res.once('close',abort);
          try{return json(await delegations.package(session,input,{...(upload?{body:req,contentLength:req.headers['content-length']}:{}),signal:controller.signal}));}
          finally{req.removeListener('aborted',abort);res.removeListener('close',abort);}
        }
        if(path==='/api/admin/read' && req.method==='POST') return json(await delegations.admin(session,await jsonBody(req,2048)));
        // Advisors' own body limit: two 3,000-character notes (the change and what the owner saw) can need about 18 KB.
        if(path==='/api/admin/advisors-command' && req.method==='POST') return json(await delegations.advisorsCommand(session,await jsonBody(req,20000)));
        if(path==='/api/admin/command' && req.method==='POST') return json(await delegations.command(session,await jsonBody(req,4096)));
        if(path==='/api/admin/registration' && req.method==='POST') {
          if(url.search)throw new HttpError(400,'Invitation query parameters are not supported.');
          return json(await delegations.registration.admin(session,await jsonBody(req,4096)));
        }
        if(['/api/admin/training','/api/admin/configuration','/api/admin/pennsync-migration','/api/admin/learning','/api/admin/authoring','/api/admin/provider','/api/admin/learning-catalog','/api/admin/learning-generation','/api/admin/course-creation','/api/admin/course-distribution','/api/admin/onboarding'].includes(path) && req.method==='POST') {
          if(path==='/api/admin/training'&&url.search)throw new HttpError(400,'Training query parameters are not supported.','invalid_request');
          if(path==='/api/admin/course-distribution'&&url.search)throw new HttpError(400,'Distribution query parameters are not supported.');
          const body=await jsonBody(req,path.endsWith('/learning-generation')?262144:path.endsWith('/learning-catalog')?65536:path.endsWith('/authoring')||path.endsWith('/provider')||path.endsWith('/course-creation')||path.endsWith('/course-distribution')?32768:4096);const controller=new AbortController();
          const abort=()=>{if(!res.writableEnded)controller.abort();};
          req.once('aborted',abort);res.once('close',abort);
          try {return json(await delegations[path.endsWith('/training')?'training':path.endsWith('/configuration')?'configuration':path.endsWith('/pennsync-migration')?'pennsyncMigration':path.endsWith('/provider')?'provider':path.endsWith('/learning-catalog')?'catalog':path.endsWith('/learning-generation')?'generation':path.endsWith('/course-distribution')?'distribution':path.endsWith('/course-creation')?'creation':path.endsWith('/onboarding')?'onboarding':path.endsWith('/authoring')?'authoring':'learning'](session,body,controller.signal));}
          finally {req.removeListener('aborted',abort);res.removeListener('close',abort);}
        }
        // Bulk lesson-media import (docs/MEDIA_IMPORT.md): the server fetches each MP4, so a row can take minutes.
        if(path==='/api/admin/learning-media-import') {
          if(req.method!=='POST'||url.search) throw new HttpError(400,'Use the media import panel.');
          if(!mediaImport) throw new HttpError(503,'Media import is not configured.');
          const input=await jsonBody(req,6200000);const controller=new AbortController();
          const abort=()=>{if(!res.writableEnded)controller.abort();};req.once('aborted',abort);res.once('close',abort);
          try{return json(await mediaImport(session,input,controller.signal));}
          finally{req.removeListener('aborted',abort);res.removeListener('close',abort);}
        }
        if(path==='/api/media/sign' && req.method==='POST') {
          const {path:objectPath}=await jsonBody(req,2048);
          const response=await delegations.media(session,objectPath,'sign');
          if(!response.ok) throw new HttpError(503,'Media link could not be issued.');
          return json(await response.json());
        }
        if(path.startsWith('/api/media/learning/')) {
          const objectPath=path.slice('/api/media/'.length);
          const upload=req.method==='POST';
          const expected=objectPath.endsWith('/video.mp4') ? ['video/mp4',268435456] : objectPath.endsWith('/captions.vtt') ? ['text/vtt',2000000] : ['text/plain',1000000];
          if(upload && req.headers['content-type']?.split(';')[0]!==expected[0]) throw new HttpError(415,'Invalid media type.');
          async function* boundedUpload() {
            let size=0;
            for await(const chunk of req) { size+=chunk.length; if(size>expected[1]) throw new HttpError(413,'Media is too large.'); yield chunk; }
            if(!size) throw new HttpError(400,'Empty media file.');
          }
          const response=await delegations.media(session,objectPath,upload?'upload':'download',upload?Readable.toWeb(Readable.from(boundedUpload())):undefined,expected[0]);
          if(!response.ok) throw new HttpError(response.status===409?409:503,'Media transfer could not complete.');
          if(upload) return json({uploaded:true});
          res.setHeader('Content-Type',expected[0]);
          await pipeline(Readable.fromWeb(response.body),res); return;
        }
        throw new HttpError(404,'This resource is unavailable.');
      }
      if(!['GET','HEAD'].includes(req.method)) throw new HttpError(405,'Method not allowed.');
      // Public help articles, the sitemap and robots.txt as real HTML and text for crawlers (server/help-center.mjs); everything else is the app.
      if(helpCenter && await helpCenter.serve(req,res,path)) return;
      let decoded; try { decoded=decodeURIComponent(path); } catch { throw new HttpError(400,'Invalid path.'); }
      let file=resolve(dist,`.${decoded}`);
      if(!file.startsWith(`${resolve(dist)}/`) && !file.startsWith(`${resolve(dist)}\\`) && file!==resolve(dist)) throw new HttpError(404,'Not found.');
      let info; try { info=await stat(file); } catch { /* SPA fallback below. */ }
      if(!info?.isFile()) {
        if(extname(path)) throw new HttpError(404,'Not found.');
        file=resolve(dist,'index.html');
      }
      res.setHeader('Content-Type',mime[extname(file)] || 'application/octet-stream');
      res.setHeader('Cache-Control',path.startsWith('/assets/')?'public,max-age=604800,immutable':'no-store');
      if(req.method==='HEAD') return res.end();
      await pipeline(createReadStream(file),res);
    } catch(error) {
      if(res.headersSent) { res.destroy(); return; }
      const reviewed=reviewedDatabaseError(error);
      const status=error instanceof HttpError?error.status:reviewed?reviewed.status:error?.code==='28000'?401:error?.code==='42501'?403:500;
      const message=error instanceof HttpError?error.message:reviewed?reviewed.message:error?.code==='P0001'?'The action could not be completed. Check the form and try again.':status===401?'Sign in to continue.':status===403?'You do not have access to this action.':'The service is temporarily unavailable.';
      json({error:error instanceof HttpError && error.code ? {code:error.code,...(typeof error.publicMessage==='string'?{message:error.publicMessage}:{})} : message},status);
    }
  });
}
