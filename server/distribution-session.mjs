import {withSession,HttpError} from './sms-auth.mjs';
/** Keep existing relational SMS authorization while giving this coordinator's
 * deadline authority over pool acquisition, queries and connection lifetime. */
export async function distributionSession(pool,sessionToken,signal,operation){
  signal.throwIfAborted();const active=new Set();let rejectAbort;
  const aborted=new Promise((_,reject)=>{rejectAbort=reject;});
  const abort=()=>{for(const release of active)release(true);rejectAbort(new HttpError(503,'Course distribution timed out. Recover the saved request.','upstream'));};
  signal.addEventListener('abort',abort,{once:true});
  const boundedPool={connect:async()=>{
    const client=await pool.connect();let released=false;
    const release=destroy=>{if(!released){released=true;active.delete(release);client.release(destroy);}};
    if(signal.aborted){release(true);signal.throwIfAborted();}active.add(release);
    return {query:(...args)=>{signal.throwIfAborted();return client.query(...args);},release:()=>release(false)};
  }};
  try{return await Promise.race([withSession(boundedPool,sessionToken,operation),aborted]);}
  finally{signal.removeEventListener('abort',abort);}
}
