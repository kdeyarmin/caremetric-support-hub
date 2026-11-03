// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Growth } from './Growth';
const settings=vi.hoisted(()=>({demoMode:false}));
vi.mock('../lib/config',()=>({config:settings}));
import { growthMutation } from './growthClient';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); settings.demoMode=false; });
const empty = { total:0,items:[],work:[],metrics:[],deliveries:[],policies:[],services:{sending:false,signing:false,postalAddress:false,research:false} };
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
