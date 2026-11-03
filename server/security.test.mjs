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
  it('serves the AI team reads through the gateway and keeps every change out of it',()=>{
    const page=rpcQuery('list_agent_activity',{p_kind:'runs',p_agent_key:null,p_offset:0,p_limit:5});
    expect(page.text).toBe('select to_jsonb(hub.list_agent_activity(p_kind => $1,p_agent_key => $2,p_offset => $3,p_limit => $4)) as data');
    expect(page.values).toEqual(['runs',null,0,5]);
    expect(rpcQuery('get_agent_team').text).toBe('select to_jsonb(hub.get_agent_team()) as data');
    expect(rpcQuery('list_audit_events',{p_action_prefix:'agent.',p_offset:0,p_limit:5}).values).toEqual(['agent.',0,5]);
    expect(()=>rpcQuery('list_agent_activity',{p_kind:'runs',sql:'select 1'})).toThrow();
    // Approving an action also carries it out, so changes run only through the owner routes, never the browser RPC allowlist.
    for(const name of ['set_agent_status','set_agent_autonomy','set_agent_budget','decide_agent_action','request_agent_task','cancel_agent_task','agent_task_claim','owner_contact','agent_task_heartbeat','agent_task_finish','agent_actions_ready','agent_action_executed','agent_action_release']) expect(()=>rpcQuery(name,{})).toThrow();
  });
  it('serves the lead list through the gateway and keeps intake and status changes out of it',()=>{
    const page=rpcQuery('list_leads',{p_kind:'demo_request',p_source:null,p_include_test:false,p_offset:0,p_limit:25});
    expect(page.text).toBe('select to_jsonb(hub.list_leads(p_kind => $1,p_source => $2,p_include_test => $3,p_offset => $4,p_limit => $5)) as data');
    expect(page.values).toEqual(['demo_request',null,false,0,25]);
    expect(()=>rpcQuery('list_leads',{p_kind:'contact',p_status:'won'})).toThrow();
    // Intake is the signed server-to-server route; a status change is the owner route with reviewed conflict handling.
    for(const name of ['lead_intake','lead_record','lead_json','update_lead_status']) expect(()=>rpcQuery(name,{})).toThrow();
  });
  it('limits media capabilities to known objects and rejects traversal',()=>{
    for(const path of ['../secret','learning/../../secret','https://evil.test/file',`learning/${id}/answer.json`,`learning/${id}/videoxmp4`]) expect(()=>validateMedia(path,'sign')).toThrow();
    expect(()=>validateMedia(`learning/${id}/video.mp4`,'sign')).not.toThrow();
    expect(validDelegation('cmh_'+token())).toBe(true);
    expect(validDelegation('jwt.value')).toBe(false);
  });
});
