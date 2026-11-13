// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Growth } from './Growth';
const settings=vi.hoisted(()=>({demoMode:false}));
vi.mock('../lib/config',()=>({config:settings}));
import { growthMutation } from './growthClient';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); settings.demoMode=false; });
const empty = { total:0,items:[],work:[],metrics:[],deliveries:[],policies:[],services:{sending:false,signing:false,postalAddress:false,research:false} };
const opportunity = (id: string, name: string) => ({id,organization_id:`org-${id}`,product:'carebase',name,domain:'example.org',internal:false,tenant_id:null,contact_id:null,email:null,contact_name:null,eligibility:null,verified_at:null,contact_version:null,stage:'identified',goal:'',memory:{},next_action:'Research',next_at:'2026-11-03T12:00:00Z',trial_end:null,renewal_at:null,owner_agent:'marketing_manager',fit:null,intent:null,version:1});
const evidence = (claim: string) => ({evidence:[{id:claim,source_url:'https://example.org/about',claim,confidence:'high',observed_at:'2026-11-03T12:00:00Z'}],messages:[],events:[]});
function deferredResponse() {
 let resolve!: (response: Response) => void;
 const promise = new Promise<Response>(done => { resolve = done; });
 return { promise, resolve: (data: unknown) => resolve(new Response(JSON.stringify(data))) };
}
it('blocks reads and mutations in preview without sending a credentialed request',async()=>{
 settings.demoMode=true;
 const request=vi.fn();vi.stubGlobal('fetch',request);
 render(<MemoryRouter><Growth/></MemoryRouter>);
 expect((await screen.findByRole('alert')).textContent).toContain('not available in the preview');
 await expect(growthMutation('policy',{enabled:true})).rejects.toThrow('not available in the preview');
 expect(request).not.toHaveBeenCalled();
});
it('keeps evidence and message history when the selected organization is clicked again',async()=>{
 const item={id:'opportunity-1',organization_id:'org-1',product:'carebase',name:'Example Care',domain:'example.org',internal:false,tenant_id:null,contact_id:null,email:null,contact_name:null,eligibility:null,verified_at:null,contact_version:null,stage:'identified',goal:'',memory:{},next_action:'Research',next_at:'2026-11-03T12:00:00Z',trial_end:null,renewal_at:null,owner_agent:'marketing_manager',fit:null,intent:null,version:1};
 const detail={evidence:[{id:'source-1',source_url:'https://example.org/about',claim:'Verified organization source',confidence:'high',observed_at:'2026-11-03T12:00:00Z'}],messages:[{id:'message-1',subject:'Existing message history',body:'A reviewed message.',status:'unknown',model_generated:false,variant:'control'}],events:[]};
 const request=vi.fn(async(_url:unknown,init:RequestInit)=>new Response(JSON.stringify(JSON.parse(String(init.body)).operation==='detail'?detail:{...empty,total:1,items:[item]})));
 vi.stubGlobal('fetch',request);render(<MemoryRouter><Growth/></MemoryRouter>);
 fireEvent.click(await screen.findByRole('button',{name:'Example Care'}));
 await screen.findByText(/Verified organization source/);
 fireEvent.click(screen.getByRole('button',{name:'Example Care'}));
 expect(screen.getByText(/Verified organization source/)).toBeTruthy();
 expect(screen.getByText(/Existing message history/)).toBeTruthy();
});
it('shows both priority products and paused readiness without inventing a pipeline', async () => {
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(empty))));
  render(<MemoryRouter><Growth/></MemoryRouter>);
  expect(await screen.findByText(/Sending: disabled/)).toBeTruthy();
  expect(screen.getByText(/Breathe is deferred/)).toBeTruthy();
  expect(screen.getByRole('option',{name:'CareBase'})).toBeTruthy();
  expect(screen.getByRole('option',{name:'CareMetric Intel'})).toBeTruthy();
  expect(screen.queryByRole('option',{name:'Breathe'})).toBeNull();
  expect(screen.getByText(/No open follow-ups/)).toBeTruthy();
});
it('creates a prospect with an explicit product and reports uncertain results', async () => {
  const request=vi.fn(async(_url:unknown,init:RequestInit)=>JSON.parse(String(init.body)).operation==='workspace'?new Response(JSON.stringify(empty)):new Response(JSON.stringify({error:'Refresh before retrying.'}),{status:503}));
  vi.stubGlobal('fetch',request);
  render(<MemoryRouter><Growth/></MemoryRouter>);
  await screen.findByText(/Sending: disabled/);
  fireEvent.change(screen.getByLabelText('Organization'),{target:{value:'Example Care'}});
  fireEvent.change(screen.getByLabelText('Business domain'),{target:{value:'example.org'}});
  fireEvent.change(screen.getByLabelText('Product'),{target:{value:'caremetric-intel'}});
  fireEvent.click(screen.getByRole('button',{name:'Add to pipeline'}));
  await waitFor(()=>expect(screen.getByRole('alert').textContent).toBe('Refresh before retrying.'));
  const posted=JSON.parse(String(request.mock.calls[1][1].body));
  expect(posted).toMatchObject({operation:'create',data:{name:'Example Care',domain:'example.org',product:'caremetric-intel'}});
});

it('ignores a delayed detail response for a previously selected organization',async()=>{
 const first = deferredResponse();
 vi.stubGlobal('fetch',vi.fn(async(_url:unknown,init:RequestInit)=>{
  const {operation,data} = JSON.parse(String(init.body));
  if(operation==='workspace')return new Response(JSON.stringify({...empty,total:2,items:[opportunity('a','First organization'),opportunity('b','Second organization')]}));
  return data.id==='a'?first.promise:new Response(JSON.stringify(evidence('Second organization evidence')));
 }));
 render(<MemoryRouter><Growth/></MemoryRouter>);
 fireEvent.click(await screen.findByRole('button',{name:'First organization'}));
 fireEvent.click(screen.getByRole('button',{name:'Second organization'}));
 await screen.findByText(/Second organization evidence/);
 await act(async()=>first.resolve(evidence('First organization evidence')));
 expect(screen.queryByText(/First organization evidence/)).toBeNull();
 expect(screen.getByText(/Second organization evidence/)).toBeTruthy();
});

it('hides the old pipeline while another page loads and ignores a late refresh',async()=>{
 const refresh = deferredResponse(), page = deferredResponse();
 const request=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({...empty,total:51,items:[opportunity('a','First page')]}))).mockReturnValueOnce(refresh.promise).mockReturnValueOnce(page.promise);
 vi.stubGlobal('fetch',request);
 render(<MemoryRouter><Growth/></MemoryRouter>);
 await screen.findByRole('button',{name:'First page'});
 fireEvent.click(screen.getByRole('button',{name:'Refresh'}));
 fireEvent.click(screen.getByRole('button',{name:'Next'}));
 expect(screen.queryByRole('button',{name:'First page'})).toBeNull();
 await act(async()=>page.resolve({...empty,total:51,items:[opportunity('b','Second page')]}));
 await screen.findByRole('button',{name:'Second page'});
 await act(async()=>refresh.resolve({...empty,total:51,items:[opportunity('a','First page')]}));
 expect(screen.queryByRole('button',{name:'First page'})).toBeNull();
 expect(screen.getByRole('button',{name:'Second page'})).toBeTruthy();
});

it('clears a load error after a successful refresh',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockRejectedValueOnce(new Error('Connection interrupted')).mockResolvedValueOnce(new Response(JSON.stringify(empty))));
 render(<MemoryRouter><Growth/></MemoryRouter>);
 await screen.findByText('Connection interrupted');
 fireEvent.click(screen.getByRole('button',{name:'Refresh'}));
 await screen.findByText(/Sending: disabled/);
 expect(screen.queryByRole('alert')).toBeNull();
});

it('shows the Medicare roster once its migration is live: what is missing, the read and the best-ranked agencies',async()=>{
 const roster={sync:{period:'2026Q3',states:['PA'],complete:true,syncedAt:'2026-11-12T12:00:00Z',rows:2},counts:{new:1,graduated:1},total:2,
  items:[{ccn:'391501',name:'Valley Hospice, Inc.',setting:'hospice',city:'Philadelphia',state:'PA',rank:75,reasons:['Change of ownership (2026-03-01)'],status:'graduated',reason:null,attempts:1,resolveAfter:null,confirmation:'phone',domain:'valleyhospice.org',organizationId:'org-1'},
   {ccn:'397001',name:'County Home Health',setting:'home_health',city:'Pittsburgh',state:'PA',rank:40,reasons:[],status:'unresolved',reason:'no_site',attempts:1,resolveAfter:'2026-11-20T12:00:00Z',confirmation:null,domain:null,organizationId:null}],
  services:{feed:{declared:true,enabled:true,signing:false},states:['PA'],daily:25,research:true}};
 const request=vi.fn(async(_url:unknown,init:RequestInit)=>new Response(JSON.stringify(JSON.parse(String(init.body)).operation==='roster'?roster:{...empty,services:{...empty.services,roster:true}})));
 vi.stubGlobal('fetch',request);render(<MemoryRouter><Growth/></MemoryRouter>);
 expect(await screen.findByText(/Medicare roster · 2 agencies/)).toBeTruthy();
 expect(screen.getByText(/set HUB_INTEL_FEED_SECRET/)).toBeTruthy();
 expect(screen.getByText(/In the pipeline: 1/)).toBeTruthy();
 expect(screen.getByText(/confirmed by its CMS telephone number/)).toBeTruthy();
 expect(screen.getByText(/no website matched/)).toBeTruthy();
 expect(screen.queryByRole('button',{name:'Next agencies'})).toBeNull();
});
it('leaves the roster out until its migration is live',async()=>{
 const request=vi.fn<(url:unknown,init:RequestInit)=>Promise<Response>>(async()=>new Response(JSON.stringify(empty)));
 vi.stubGlobal('fetch',request);render(<MemoryRouter><Growth/></MemoryRouter>);
 await screen.findByText(/Sending: disabled/);
 expect(screen.queryByText(/Medicare roster/)).toBeNull();
 expect(request.mock.calls.every(([,init])=>JSON.parse(String(init.body)).operation!=='roster')).toBe(true);
});
