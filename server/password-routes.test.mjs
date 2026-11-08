import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { appServer } from './http.mjs';
import { sessionCookie } from './sms-auth.mjs';

const origin = 'https://hub.test';
const value = 'p'.repeat(43), old = 's'.repeat(43);
const password = { login:vi.fn(),settings:vi.fn(),save:vi.fn() };
const owner = { allows:vi.fn() }, auth = { logout:vi.fn() };
let server,base;
beforeAll(async () => {
  server=appServer({password,owner,auth,gateway:{},origins:[origin]});
  server.listen(0,'127.0.0.1'); await once(server,'listening'); base=`http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise(resolve => server.close(resolve)));
beforeEach(() => { vi.resetAllMocks(); password.login.mockResolvedValue(value);password.save.mockResolvedValue(value);owner.allows.mockResolvedValue(true); });
const post = (path,headers={},body={username:'owner',password:'test-only password'}) => fetch(base+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
it('keeps passwords in the JSON body, rotates a secure cookie and passes the edge visitor bucket',async()=>{
  const response=await post('/api/auth/password/login',{'X-Forwarded-For':'198.51.100.1, 203.0.113.4',Cookie:`${sessionCookie}=${old}`});
  expect(response.status).toBe(200);
  expect(password.login).toHaveBeenCalledWith({username:'owner',password:'test-only password'},'203.0.113.4',old);
  expect(await response.json()).toEqual({authenticated:true});
  expect(response.headers.getSetCookie()[0]).toBe(`${sessionCookie}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
});
it('rejects cross-site login/setup and credentials in query strings without calling authentication',async()=>{
  for(const path of ['/api/auth/password/login','/api/auth/password/settings']) {
    expect((await post(path,{Origin:'https://other.test'})).status).toBe(403);
    expect((await post(path,{'Sec-Fetch-Site':'cross-site'})).status).toBe(403);
    expect((await post(path+'?password=never-put-here')).status).toBe(400);
    expect((await fetch(base+path+'?username=owner')).status).toBe(400);
  }
  expect(password.login).not.toHaveBeenCalled();expect(password.save).not.toHaveBeenCalled();expect(password.settings).not.toHaveBeenCalled();
});
it('revokes a login that lost owner permission before returning its cookie',async()=>{
  owner.allows.mockResolvedValue(false);
  const response=await post('/api/auth/password/login');
  expect(response.status).toBe(403);expect(response.headers.getSetCookie()).toEqual([]);expect(auth.logout).toHaveBeenCalledWith(value);
});
it('does not forward a revoked session into password setup',async()=>{
  owner.allows.mockResolvedValue(false);password.settings.mockResolvedValue({configured:false});
  await fetch(base+'/api/auth/password/settings',{headers:{Cookie:`${sessionCookie}=${old}`}});
  expect(password.settings).toHaveBeenCalledWith(undefined);
});
