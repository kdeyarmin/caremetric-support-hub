import { describe,it,expect,vi } from 'vitest';
import { smsProvider,normalizePhone } from './sms-provider.mjs';
import { cookie,readCookie,sessionCookie,token } from './sms-auth.mjs';
import { rpcQuery } from './gateway.mjs';
import { sameOrigin } from './http.mjs';
import { validateMedia,validDelegation } from './delegations.mjs';
const phone='+12025550101', profile='11111111-1111-4111-8111-111111111111', id='22222222-2222-4222-8222-222222222222';
describe('SMS provider verification boundary',()=>{
  it('normalizes US input and rejects malformed numbers',()=>{
    expect(normalizePhone('(202) 555-0101')).toBe(phone);
    for(const input of [null,{},'2025550101;DROP','+0123456789','javascript:2025550101']) expect(normalizePhone(input)).toBeNull();
  });
  it('only accepts the vendor code-check verdict for the intended number',async()=>{
    for(const data of [{status:'accepted',phone_number:phone},{response_code:'rejected',phone_number:phone},{response_code:'accepted',phone_number:'+12025550102'},null]) {
      const fetchImpl=vi.fn(async()=>Response.json({data}));
      const provider=smsProvider({apiKey:'test-only',profileId:profile,fetchImpl});
      expect(await provider.verify(id,phone,'123456')).toBe(false);
      expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({code:'123456'});
    }
    const provider=smsProvider({apiKey:'test-only',profileId:profile,fetchImpl:async()=>Response.json({data:{response_code:'accepted',phone_number:phone}})});
    expect(await provider.verify(id,phone,'123456')).toBe(true);
  });
  it('rejects a send response for another account, number, or channel',async()=>{
    for(const extra of [{verify_profile_id:id},{phone_number:'+12025550102'},{type:'call'},{id:'invalid'}]) {
      const provider=smsProvider({apiKey:'test-only',profileId:profile,fetchImpl:async()=>Response.json({data:{id,phone_number:phone,verify_profile_id:profile,type:'sms',...extra}})});
      await expect(provider.send(phone)).rejects.toThrow('invalid response');
    }
  });
  it('does not reveal upstream errors or follow redirects',async()=>{
    const fetchImpl=vi.fn(async()=>new Response('secret-provider-detail',{status:401}));
    await expect(smsProvider({apiKey:'test-only',profileId:profile,fetchImpl}).send(phone)).rejects.toThrow('temporarily unavailable');
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('manual');
  });
});
describe('application request boundary',()=>{
  it('uses host-only secure cookies and rejects ambiguous values',()=>{
    const value=token();
    expect(cookie(sessionCookie,value,60)).toContain('Path=/; HttpOnly; Secure; SameSite=Strict;');
    expect(readCookie(`${sessionCookie}=${value}`,sessionCookie)).toBe(value);
    expect(readCookie(`${sessionCookie}=${value}; ${sessionCookie}=${value}`,sessionCookie)).toBeNull();
    expect(readCookie(`${sessionCookie}=short`,sessionCookie)).toBeNull();
  });
  it('rejects missing or cross-site origin on mutations',()=>{
    for(const headers of [{},{origin:'https://evil.test'},{origin:'https://hub.test','sec-fetch-site':'cross-site'}]) expect(sameOrigin({headers},['https://hub.test'])).toBe(false);
    expect(sameOrigin({headers:{origin:'https://hub.test','sec-fetch-site':'same-origin'}},['https://hub.test'])).toBe(true);
  });
  it('allows only fixed RPC names and parameters, with all user values bound',()=>{
    for(const name of ['__proto__','constructor','get_learning_draft); select pg_sleep(1)--','execute_sql']) expect(()=>rpcQuery(name,{})).toThrow();
    expect(()=>rpcQuery('get_learning_draft',{p_item_id:'id',sql:'ignored?'})).toThrow();
    const query=rpcQuery('save_learning_draft',{p_item_id:null,p_document:{title:"');drop table--"},p_expected_version:0});
    expect(query.text).not.toContain('drop table');
    expect(query.values[1]).toBe(JSON.stringify({title:"');drop table--"}));
    expect(rpcQuery('list_published_content').text).toContain('jsonb_agg');
    expect(rpcQuery('get_support_case_thread',{p_case_id:id}).text).toContain('jsonb_agg');
    expect(rpcQuery('create_support_case').text).toContain('to_jsonb');
  });
  it('limits media capabilities to known objects and rejects traversal',()=>{
    for(const path of ['../secret','learning/../../secret','https://evil.test/file',`learning/${id}/answer.json`,`learning/${id}/videoxmp4`]) expect(()=>validateMedia(path,'sign')).toThrow();
    expect(()=>validateMedia(`learning/${id}/video.mp4`,'sign')).not.toThrow();
    expect(validDelegation('cmh_'+token())).toBe(true);
    expect(validDelegation('jwt.value')).toBe(false);
  });
});
