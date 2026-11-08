// Disposable PostgreSQL only. CI runs this against the complete Supabase
// migration chain, using the production HTTP handlers and real password hashes.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { passwordAuth, hashPassword } from './password-auth.mjs';
import { smsAuth, ownerAccess, sessionCookie, digest, withSession } from './sms-auth.mjs';
import { gateway } from './gateway.mjs';
import { appServer } from './http.mjs';
import { delegations } from './delegations.mjs';

const databaseUrl=process.env.HUB_TEST_DATABASE_URL;
const local=new URL(databaseUrl);
assert.equal(local.hostname,'127.0.0.1');assert.equal(local.port,'54322');
const admin=new pg.Pool({connectionString:databaseUrl});
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl=new URL(databaseUrl);appUrl.username='hub_app_server';appUrl.password='ephemeral-test-only';
const pool=new pg.Pool({connectionString:appUrl.href});
const owner=randomUUID(), stranger=randomUUID(), suffix=randomUUID().slice(0,8), username=`owner-${suffix}`;
const phone=`+1202${String(Math.floor(Math.random()*9000000)+1000000)}`;
const firstPassword='First test-only password phrase', nextPassword='Next test-only password phrase';
const origin='https://hub.test';
const provider={send:async()=>randomUUID(),verify:async(_id,_phone,code)=>code==='123456'};
const password=passwordAuth({pool});
const server=appServer({auth:smsAuth({pool,provider}),password,owner:ownerAccess(pool),gateway:gateway(pool),origins:[origin]});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
let clientCount=0;
function browser(initialCookie='') {
  const jar={};if(initialCookie)jar[sessionCookie]=initialCookie;
  const client=`password-test-${suffix}-${clientCount++}`;
  return {jar,async call(path,body,extra={}) {
    const response=await fetch(base+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Forwarded-For':client,
      Cookie:Object.entries(jar).map(([k,v])=>`${k}=${v}`).join('; '),...extra},body:body===undefined?undefined:JSON.stringify(body)});
    for(const cookie of response.headers.getSetCookie()){const [pair]=cookie.split(';'),i=pair.indexOf('=');jar[pair.slice(0,i)]=pair.slice(i+1);}
    return {status:response.status,body:await response.json(),cookies:response.headers.getSetCookie()};
  }};
}
const row=async(sql,args=[])=>(await admin.query(sql,args)).rows[0];
async function smsBrowser(number=phone) {
  await admin.query("delete from private.sms_challenges where phone_hash=$1",[digest(number)]);
  const b=browser(),start=await b.call('auth/sms/start',{phone:number});assert.equal(start.status,200);
  assert.equal((await b.call('auth/sms/verify',{challengeId:start.body.challengeId,code:'123456'})).status,200);
  return b;
}
async function clearLoginLimit(name=username) { await admin.query('delete from private.password_attempts where username_hash=$1',[digest(name)]); }

try {
  await admin.query(`insert into auth.users(id,email,raw_user_meta_data,is_anonymous) values($1,$3,'{"display_name":"Password test owner"}',false),($2,$4,'{}',false)`,[owner,stranger,`${username}@test.invalid`,`stranger-${suffix}@test.invalid`]);
  await admin.query("insert into private.staff_permissions(user_id,permission,granted_by) values($1,'platform.admin',$1)",[owner]);
  await admin.query('insert into private.sms_identities(user_id,phone_e164) values($1,$2)',[owner,phone]);
  const anonymous=browser();
  assert.equal((await anonymous.call('auth/password/settings')).status,401);
  assert.equal((await anonymous.call('auth/password/settings',{username,password:firstPassword})).status,401);
  const unknown=await anonymous.call('auth/password/login',{username:`unknown-${suffix}`,password:firstPassword});
  assert.equal(unknown.status,401);

  // The existing SMS-authenticated owner chooses their own credentials. No
  // password or username is seeded into production by a migration.
  const enrolled=await smsBrowser(), original=enrolled.jar[sessionCookie];
  assert.equal((await enrolled.call('auth/password/settings')).body.configured,false);
  const saved=await enrolled.call('auth/password/settings',{username:username.toUpperCase(),password:firstPassword});
  assert.equal(saved.status,200);assert.deepEqual(saved.body,{authenticated:true});
  assert.match(saved.cookies[0],/HttpOnly; Secure; SameSite=Strict; Max-Age=28800/);
  assert.equal((await browser(original).call('auth/session')).body.authenticated,false);
  assert.equal((await enrolled.call('auth/session')).body.method,'password');
  const stored=await row('select password_hash from private.password_credentials where user_id=$1',[owner]);
  assert.notEqual(stored.password_hash,firstPassword);assert.match(stored.password_hash,/^scrypt\$32768\$8\$3\$/);
  const authority=await withSession(pool,enrolled.jar[sessionCookie],async db=>(await db.query('select hub.authorize_app_admin() as value')).rows[0].value);
  assert.equal(authority.method,'password');assert.equal(authority.user_id,owner);
  await withSession(pool,enrolled.jar[sessionCookie],async(db,current)=>{
    const command=(await db.query('select hub.authorize_app_command() as value')).rows[0].value;
    assert.equal(command.method,'password');assert.equal(command.session_id,current.id);
  });
  const caps=delegations({pool,storageUrl:'https://storage.test',fetchImpl:async(_url,options)=>{
    const operation=JSON.parse(options.body),ticket=options.headers['X-CareMetric-Hub-Authorization'].slice(7);
    const approved=await caps.consume(ticket,'intel');
    assert.equal(approved.method,'password');assert.equal(approved.user_id,owner);assert.deepEqual(approved.operation,operation);
    await assert.rejects(caps.consume(ticket,'intel'));
    return Response.json({contractVersion:1,product:'intel',operation:operation.operation,generatedAt:new Date().toISOString(),
      data:{organizationCount:null,activeUserCount:null,registeredUserCount:2}});
  }});
  assert.equal((await caps.admin(enrolled.jar[sessionCookie],{product:'intel',operation:'overview'})).data.registeredUserCount,2);
  const bad=await anonymous.call('auth/password/login',{username,password:'incorrect test-only password'});
  assert.equal(bad.status,401);assert.deepEqual(bad.body,unknown.body);
  const other=browser();assert.equal((await other.call('auth/password/login',{username:username.toUpperCase(),password:firstPassword})).status,200);
  const otherToken=other.jar[sessionCookie], firstToken=enrolled.jar[sessionCookie];
  assert.equal((await enrolled.call('auth/password/settings',{username,password:nextPassword,currentPassword:'incorrect test-only password'})).status,401);
  assert.equal((await enrolled.call('auth/password/settings',{username,password:nextPassword,currentPassword:firstPassword})).status,200);
  for(const previous of [otherToken,firstToken]) assert.equal((await browser(previous).call('auth/session')).body.authenticated,false);
  // Even a version mismatch without a revoked_at flag fails closed in SQL and HTTP.
  await admin.query('update private.sms_sessions set revoked_at=null where token_hash=$1',[digest(otherToken)]);
  assert.equal((await browser(otherToken).call('auth/session')).body.authenticated,false);
  assert.equal((await anonymous.call('auth/password/login',{username,password:firstPassword})).status,401);
  assert.equal((await anonymous.call('auth/password/login',{username,password:nextPassword})).status,200);

  // Recent SMS is a recovery proof; an old SMS session cannot silently replace
  // an existing password. Failed recovery leaves the current credential intact.
  const recovery=await smsBrowser();
  await admin.query("update private.sms_sessions set created_at=now()-interval '11 minutes' where token_hash=$1",[digest(recovery.jar[sessionCookie])]);
  assert.equal((await recovery.call('auth/password/settings')).body.can_reset,false);
  assert.equal((await recovery.call('auth/password/settings',{username,password:firstPassword})).status,401);
  await admin.query('update private.sms_sessions set created_at=now() where token_hash=$1',[digest(recovery.jar[sessionCookie])]);
  assert.equal((await recovery.call('auth/password/settings',{username,password:firstPassword})).status,200);
  assert.equal((await anonymous.call('auth/session')).body.authenticated,false);

  // An owner permission or Auth-user revocation takes effect on the next
  // request and prevents a new password session, even with the right password.
  await admin.query("update private.staff_permissions set revoked_at=now() where user_id=$1 and permission='platform.admin'",[owner]);
  assert.equal((await recovery.call('auth/session')).body.authenticated,false);
  assert.equal((await browser().call('auth/password/login',{username,password:firstPassword})).status,401);
  await admin.query("update private.staff_permissions set revoked_at=null where user_id=$1 and permission='platform.admin'",[owner]);
  await admin.query("update auth.users set banned_until=now()+interval '1 hour' where id=$1",[owner]);
  assert.equal((await browser().call('auth/password/login',{username,password:firstPassword})).status,401);
  await admin.query('update auth.users set banned_until=null where id=$1',[owner]);
  await clearLoginLimit();

  // Pause between the first credential read and verification. A password
  // rotation must defeat a login that already read the previous hash.
  let release,seen;const read=new Promise(resolve=>{seen=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const raced=passwordAuth({pool:{connect:()=>pool.connect(),async query(sql,args){const result=await pool.query(sql,args);if(sql.includes('select c.*')){seen();await gate;}return result;}}});
  const signingIn=raced.login({username,password:firstPassword},'race-client').then(()=>null,error=>error);
  await read;
  await admin.query('update private.password_credentials set password_hash=$2 where user_id=$1',[owner,await hashPassword(nextPassword)]);
  release();assert.equal((await signingIn).status,401);

  // Persisted rate limits survive a new authentication service instance.
  const limited=`limited-${suffix}`;
  await admin.query("insert into private.password_attempts(username_hash,client_hash) select $1,'test-limit' from generate_series(1,10)",[digest(limited)]);
  await assert.rejects(passwordAuth({pool}).login({username:limited,password:firstPassword},'new-replica'),error=>error.status===429);

  // Identity rotation invalidates password login until the owner recovers
  // through their current approved mobile identity.
  const nextPhone=phone.slice(0,-1)+(phone.endsWith('9')?'0':String(Number(phone.at(-1))+1));
  await admin.query('update private.sms_identities set phone_e164=$2 where user_id=$1',[owner,nextPhone]);
  assert.equal((await browser().call('auth/password/login',{username,password:nextPassword})).status,401);
  const rebound=await smsBrowser(nextPhone);
  assert.equal((await rebound.call('auth/password/settings',{username,password:firstPassword})).status,200);
  const final=browser();assert.equal((await final.call('auth/password/login',{username,password:firstPassword})).status,200);
  const loggedOut=final.jar[sessionCookie];assert.equal((await final.call('auth/logout',{})).status,200);
  assert.equal((await browser(loggedOut).call('auth/session')).body.authenticated,false);
  assert.equal((await row("select count(*)::int as n from private.audit_events where actor_id=$1 and action='auth.password.created'",[owner])).n,1);
  assert.equal((await row("select count(*)::int as n from private.audit_events where actor_id=$1 and action='auth.password.changed'",[owner])).n,4);
  console.log('Password setup, login, recovery, rotation, revocation, rate limit and logout PostgreSQL/HTTP integration passed.');
} finally {
  await new Promise(resolve=>server.close(resolve));
  await pool.end();
  await admin.query('delete from private.audit_events where actor_id=any($1::uuid[])',[[owner,stranger]]);
  await admin.query('delete from private.password_credentials where user_id=$1',[owner]);
  await admin.query('delete from private.app_delegations where session_id in(select id from private.sms_sessions where user_id=$1)',[owner]);
  await admin.query('delete from private.sms_sessions where user_id=$1',[owner]);
  await admin.query('delete from private.sms_challenges where user_id=$1',[owner]);
  await admin.query('delete from private.sms_identities where user_id=$1',[owner]);
  await admin.query('delete from private.staff_permissions where user_id=$1',[owner]);
  await admin.query('delete from hub.profiles where id=any($1::uuid[])',[[owner,stranger]]);
  await admin.query('delete from auth.users where id=any($1::uuid[])',[[owner,stranger]]);
  await admin.query('delete from private.password_attempts where username_hash=any($1::text[])',[[username,`unknown-${suffix}`,`limited-${suffix}`,`change:${owner}`].map(digest)]);
  await admin.end();
}
