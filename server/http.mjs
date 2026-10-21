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
export function sameOrigin(req,origins) {
  return origins.includes(req.headers.origin) && (!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site']==='same-origin');
}
const mime={'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.woff2':'font/woff2','.html':'text/html'};
const aiCaseActions=new Set(['summary','draft-reply','triage-suggestion']);
const staffCommunicationActions=new Set(['list','get','update','note','reply','sync']);
// Railway's edge appends the visitor address last; rate limits use it only as a hashed bucket.
const visitorAddress=req=>String(req.headers['x-forwarded-for']||'').split(',').at(-1).trim()||req.socket.remoteAddress||'unknown';
export function appServer({auth,gateway,delegations,publications,docstudio,aiCases,readiness,integrationSetup,communications,bulkEmail,origins,dist=resolve('dist')}) {
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
      const session=readCookie(req.headers.cookie,sessionCookie);
      async function studioMedia(result) {
        const {descriptor,response}=result;
        res.setHeader('Content-Type',descriptor.contentType);res.setHeader('Content-Length',String(descriptor.byteLength));
        let bytes=0;
        async function* bounded() {for await(const chunk of Readable.fromWeb(response.body)){bytes+=chunk.length;if(bytes>descriptor.byteLength)throw new Error('Oversized private media');yield chunk;}if(bytes!==descriptor.byteLength)throw new Error('Incomplete private media');}
        await pipeline(Readable.from(bounded()),res);
      }
      if (path.startsWith('/api/')) {
        res.setHeader('Cache-Control','no-store');
        if (path.startsWith('/api/internal/')) {
          if(path.startsWith('/api/internal/docstudio/') && docstudio) {
            if(req.headers.origin || req.headers.cookie || url.search) throw new HttpError(403,'Forbidden.');
            const authorization=req.headers.authorization;
            if(path==='/api/internal/docstudio/media/authorize' && req.method==='POST') {
              const input=await jsonBody(req,2048);if(Object.keys(input).length)throw new HttpError(400,'Invalid media authorization.');
              return json(await docstudio.consumeMedia(typeof authorization==='string' && authorization.startsWith('Bearer ')?authorization.slice(7):null));
            }
            if(path==='/api/internal/docstudio/worker' && req.method==='POST') return json(await docstudio.worker(authorization,await jsonBody(req,4096)));
            const workerMedia=/^\/api\/internal\/docstudio\/worker\/jobs\/([0-9a-f-]{36})\/(sources|outputs)\/([0-9a-f-]{36}|primary|captions|transcript)$/.exec(path);
            if(workerMedia) {
              const lease=req.headers['x-caremetric-job-lease'];
              if(workerMedia[2]==='sources' && req.method==='GET') return await studioMedia(await docstudio.workerSource(authorization,workerMedia[1],workerMedia[3],lease));
              if(workerMedia[2]==='outputs' && req.method==='POST') return json(await docstudio.workerOutput(authorization,workerMedia[1],workerMedia[3],lease,req,req.headers));
            }
            throw new HttpError(404,'DocStudio resource unavailable.');
          }
          if(req.method!=='POST' || req.headers.origin || req.headers.cookie) throw new HttpError(403,'Forbidden.');
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
        if (!['GET','POST','HEAD'].includes(req.method)) throw new HttpError(405,'Method not allowed.');
        if(req.method==='POST' && !sameOrigin(req,origins)) throw new HttpError(403,'Open this action in CareMetric.');
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
        if(path.startsWith('/api/docstudio') && docstudio) {
          if(url.search)throw new HttpError(400,'DocStudio query parameters are not supported.');
          if(path==='/api/docstudio' && req.method==='GET') return json(await docstudio.read(session));
          if(path==='/api/docstudio/page' && req.method==='POST') return json(await docstudio.read(session,await jsonBody(req,2048)));
          if(path==='/api/docstudio/preview' && req.method==='POST') return json(await docstudio.preview(session,await jsonBody(req,1048576)));
          if(path==='/api/docstudio/apply' && req.method==='POST') return json(await docstudio.apply(session,await jsonBody(req,2048)));
          if(path==='/api/docstudio/export' && req.method==='POST') return json(await docstudio.export(session,await jsonBody(req,2048)));
          const project=/^\/api\/docstudio\/projects\/([0-9a-f-]{36})(?:\/assets(?:\/([0-9a-f-]{36}))?)?$/.exec(path);
          if(project) {
            if(!path.includes('/assets') && req.method==='GET')return json(await docstudio.get(session,project[1]));
            if(path.endsWith('/assets') && req.method==='POST')return json(await docstudio.stageAsset(session,project[1],await jsonBody(req,2048)));
            if(project[2] && req.method==='POST')return json(await docstudio.uploadAsset(session,project[1],project[2],req,req.headers['content-type']));
            if(project[2] && req.method==='GET')return await studioMedia(await docstudio.media(session,{projectId:project[1],assetId:project[2]}));
          }
          const output=/^\/api\/docstudio\/jobs\/([0-9a-f-]{36})\/(primary|captions|transcript)$/.exec(path);
          if(output && req.method==='GET')return await studioMedia(await docstudio.media(session,{jobId:output[1],part:output[2]}));
          throw new HttpError(404,'DocStudio resource unavailable.');
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
        if(path==='/api/auth/invitation/start' && req.method==='POST') {
          if(url.search)throw new HttpError(400,'Invitation query parameters are not supported.');
          const result=await delegations.registration.start(await jsonBody(req,2048),req.socket.remoteAddress);
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
          const result=await auth.start(phone,req.socket.remoteAddress);
          if(result.unavailable) throw new HttpError(503,'SMS is temporarily unavailable. Please try again later.');
          return json({challengeId:result.id,retryAfter:60},200,[cookie(challengeCookie,result.browserToken,300)]);
        }
        if(path==='/api/auth/sms/verify' && req.method==='POST') {
          const {challengeId,code}=await jsonBody(req,2048);
          const value=await auth.verify(challengeId,readCookie(req.headers.cookie,challengeCookie),code,session);
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
        if(path.startsWith('/api/rpc/') && req.method==='POST') return json(await gateway.rpc(path.slice(9),await jsonBody(req),session));
        if(path.startsWith('/api/rows/') && req.method==='GET') return json(await gateway.rows(path.slice(10),session));
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
        if(path==='/api/admin/command' && req.method==='POST') return json(await delegations.command(session,await jsonBody(req,4096)));
        if(path==='/api/admin/registration' && req.method==='POST') {
          if(url.search)throw new HttpError(400,'Invitation query parameters are not supported.');
          return json(await delegations.registration.admin(session,await jsonBody(req,4096)));
        }
        if(['/api/admin/training','/api/admin/configuration','/api/admin/pennsync-migration','/api/admin/learning','/api/admin/authoring','/api/admin/provider','/api/admin/course-creation','/api/admin/course-distribution','/api/admin/billing-command','/api/admin/checkout-command','/api/admin/onboarding'].includes(path) && req.method==='POST') {
          if(path==='/api/admin/training'&&url.search)throw new HttpError(400,'Training query parameters are not supported.','invalid_request');
          if(path==='/api/admin/course-distribution'&&url.search)throw new HttpError(400,'Distribution query parameters are not supported.');
          const body=await jsonBody(req,path.endsWith('/authoring')||path.endsWith('/provider')||path.endsWith('/course-creation')||path.endsWith('/course-distribution')?32768:4096);const controller=new AbortController();
          const abort=()=>{if(!res.writableEnded)controller.abort();};
          req.once('aborted',abort);res.once('close',abort);
          try {return json(await delegations[path.endsWith('/training')?'training':path.endsWith('/configuration')?'configuration':path.endsWith('/pennsync-migration')?'pennsyncMigration':path.endsWith('/provider')?'provider':path.endsWith('/course-distribution')?'distribution':path.endsWith('/course-creation')?'creation':path.endsWith('/onboarding')?'onboarding':path.endsWith('/checkout-command')?'checkoutCommand':path.endsWith('/billing-command')?'billingCommand':path.endsWith('/authoring')?'authoring':'learning'](session,body,controller.signal));}
          finally {req.removeListener('aborted',abort);res.removeListener('close',abort);}
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
      const status=error instanceof HttpError?error.status:error?.code==='28000'?401:error?.code==='42501'?403:500;
      const message=error instanceof HttpError?error.message:error?.code==='P0001'?'The action could not be completed. Check the form and try again.':status===401?'Sign in with an SMS code to continue.':status===403?'You do not have access to this action.':'The service is temporarily unavailable.';
      json({error:error instanceof HttpError && error.code ? {code:error.code} : message},status);
    }
  });
}
