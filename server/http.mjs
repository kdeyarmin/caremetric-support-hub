import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve,extname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { cookie,readCookie,sessionCookie,challengeCookie,HttpError } from './sms-auth.mjs';

export const securityHeaders = {
  'X-Content-Type-Options':'nosniff','X-Frame-Options':'SAMEORIGIN',
  'Strict-Transport-Security':'max-age=31536000; includeSubDomains','Referrer-Policy':'no-referrer',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=(), payment=()',
  'Content-Security-Policy':"default-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' https://xgauehtwksmnoqhgqegm.supabase.co; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
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
export function appServer({auth,gateway,delegations,origins,dist=resolve('dist')}) {
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
      if (path.startsWith('/api/')) {
        res.setHeader('Cache-Control','no-store');
        if (path.startsWith('/api/internal/')) {
          if(req.method!=='POST' || req.headers.origin) throw new HttpError(403,'Forbidden.');
          const audience={
            '/api/internal/media/authorize':'media', '/api/internal/admin/authorize':'carebase',
            '/api/internal/admin/breathe/authorize':'breathe', '/api/internal/admin/emr/authorize':'caremetric-emr',
            '/api/internal/admin/pennsync/authorize':'pennsync', '/api/internal/command/carebase/authorize':'carebase.command',
            '/api/internal/admin/go/authorize':'caremetric-go',
            '/api/internal/admin/intel/authorize':'intel',
            '/api/internal/learning/carebase/authorize':'carebase.learning',
          }[path];
          if(!audience) throw new HttpError(404,'Unavailable.');
          const authorization=req.headers.authorization;
          if(typeof authorization!=='string' || !authorization.startsWith('Bearer ')) throw new HttpError(401,'Authorization required.');
          await jsonBody(req,2048);
          return json(await delegations.consume(authorization.slice(7),audience));
        }
        if (!['GET','POST'].includes(req.method)) throw new HttpError(405,'Method not allowed.');
        if(req.method==='POST' && !sameOrigin(req,origins)) throw new HttpError(403,'Open this action in CareMetric.');
        if(path==='/api/auth/session' && req.method==='GET') return json(await gateway.session(session));
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
        if(path.startsWith('/api/rpc/') && req.method==='POST') return json(await gateway.rpc(path.slice(9),await jsonBody(req),session));
        if(path.startsWith('/api/rows/') && req.method==='GET') return json(await gateway.rows(path.slice(10),session));
        if(path==='/api/admin/read' && req.method==='POST') return json(await delegations.admin(session,await jsonBody(req,2048)));
        if(path==='/api/admin/command' && req.method==='POST') return json(await delegations.command(session,await jsonBody(req,4096)));
        if(path==='/api/admin/learning' && req.method==='POST') {
          const body=await jsonBody(req,4096);const controller=new AbortController();
          const abort=()=>{if(!res.writableEnded)controller.abort();};
          req.once('aborted',abort);res.once('close',abort);
          try {return json(await delegations.learning(session,body,controller.signal));}
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
