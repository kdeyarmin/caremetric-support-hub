import pg from 'pg';
import { smsProvider } from './sms-provider.mjs';
import { smsAuth } from './sms-auth.mjs';
import { gateway } from './gateway.mjs';
import { delegations } from './delegations.mjs';
import { appServer } from './http.mjs';
import { assertBackendContract } from '../src/lib/backendContract.ts';
import { databaseConfig } from './database-config.mjs';
import { publications } from './publications.mjs';

const storageUrl='https://xgauehtwksmnoqhgqegm.supabase.co';
const pool=new pg.Pool(databaseConfig());
const provider=smsProvider({apiKey:process.env.HUB_TELNYX_API_KEY,profileId:process.env.HUB_TELNYX_VERIFY_PROFILE_ID});
const api=gateway(pool);
const contract=await api.rpc('get_backend_contract',{});
assertBackendContract(contract);
const capabilities=delegations({pool,storageUrl});
const publicationService=publications({pool,delegations:capabilities,storageUrl});
const server=appServer({auth:smsAuth({pool,provider}),gateway:api,delegations:capabilities,publications:publicationService,origins:['https://support-hub-web-production.up.railway.app','https://help.caremetric.ai']});
let cleanupRunning=false;
const cleanup=async()=>{
  if(cleanupRunning) return;
  cleanupRunning=true;
  try { await publicationService.cleanupExpired(); } catch { console.warn('Publication cleanup could not complete; it will retry.'); }
  finally { cleanupRunning=false; }
};
const cleanupTimer=setInterval(()=>void cleanup(),15*60*1000); cleanupTimer.unref();
void cleanup();
server.requestTimeout=130000; server.headersTimeout=15000;
server.listen(Number(process.env.PORT || 8080),'0.0.0.0');
for(const signal of ['SIGTERM','SIGINT']) process.on(signal,() => { clearInterval(cleanupTimer); server.close(() => { void pool.end(); }); });
