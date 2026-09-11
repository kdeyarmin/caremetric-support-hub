import pg from 'pg';
import { smsProvider } from './sms-provider.mjs';
import { smsAuth } from './sms-auth.mjs';
import { gateway } from './gateway.mjs';
import { delegations } from './delegations.mjs';
import { appServer } from './http.mjs';
import { assertBackendContract } from '../src/lib/backendContract.ts';
import { databaseConfig } from './database-config.mjs';

const storageUrl='https://xgauehtwksmnoqhgqegm.supabase.co';
const pool=new pg.Pool(databaseConfig());
const provider=smsProvider({apiKey:process.env.HUB_TELNYX_API_KEY,profileId:process.env.HUB_TELNYX_VERIFY_PROFILE_ID});
const api=gateway(pool);
const contract=await api.rpc('get_backend_contract',{});
assertBackendContract(contract);
const server=appServer({auth:smsAuth({pool,provider}),gateway:api,delegations:delegations({pool,storageUrl}),origins:['https://support-hub-web-production.up.railway.app','https://help.caremetric.ai']});
server.requestTimeout=130000; server.headersTimeout=15000;
server.listen(Number(process.env.PORT || 8080),'0.0.0.0');
for(const signal of ['SIGTERM','SIGINT']) process.on(signal,() => server.close(() => { void pool.end(); }));
