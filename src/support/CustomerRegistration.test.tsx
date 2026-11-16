// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CustomerRegistration } from './CustomerRegistration';
const id='11111111-1111-4111-8111-111111111111';
const identity={product:'breathe',sourceUserId:'Native_User',sourceAccountId:id,accountKind:'organization',relationship:'organization_member',revision:'a'.repeat(64)};
const preview={reviewId:id,proofDigest:'b'.repeat(64),expiresAt:new Date(Date.now()+60000).toISOString(),identity,phone:'+12025550100',displayName:'Synthetic customer',tenantName:'Example organization'};
const invitation={invitationId:id,identity,displayName:preview.displayName,tenantName:preview.tenantName,phoneEnding:'0100',expiresAt:new Date(Date.now()+900000).toISOString(),state:'pending',hubUserId:null};
afterEach(cleanup);
function fill(){for(const [label,value] of [['Invited app user ID','Native_User'],['Invited app organization ID',id],['Customer mobile number','2025550100'],['Customer display name',preview.displayName],['Invited customer account name',preview.tenantName]])fireEvent.change(screen.getByLabelText(label),{target:{value}});}
it('offers the three connected apps and preserves one invitation code and request ID after an uncertain response',async()=>{
  let issued=0;const request=vi.fn(async(body:unknown)=>{const op=body as {operation:string};if(op.operation==='list')return {rows:[],offset:0,total:0};if(op.operation==='preview')return preview;
    if(++issued===1)throw new Error('Response interrupted');return invitation;});
  render(<MemoryRouter><CustomerRegistration request={request} onLinked={()=>{}}/></MemoryRouter>);expect(Array.from((screen.getByLabelText('Invitation application') as HTMLSelectElement).options).map(option=>option.value)).toEqual(['carebase','breathe','intel']);fill();
  fireEvent.click(screen.getByRole('button',{name:'Review new customer invitation'}));const create=await screen.findByRole('button',{name:'Create invitation code'});expect(create).toHaveProperty('disabled',true);
  fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(create);await screen.findByRole('alert');fireEvent.click(create);await screen.findByLabelText('New invitation code');
  const attempts=request.mock.calls.map(([body])=>body as {operation:string;claimCode:string}).filter(op=>op.operation==='issue');expect(attempts).toHaveLength(2);expect(attempts[0]).toEqual(attempts[1]);
  expect(attempts[0].claimCode).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(screen.getByLabelText('New invitation code')).toHaveProperty('value',attempts[0].claimCode);
});
it('requires a fresh review when the customer number changes',async()=>{
  const request=vi.fn(async(body:unknown)=>(body as {operation:string}).operation==='list'?{rows:[],offset:0,total:0}:preview);
  render(<MemoryRouter><CustomerRegistration request={request} onLinked={()=>{}}/></MemoryRouter>);fill();fireEvent.click(screen.getByRole('button',{name:'Review new customer invitation'}));
  await screen.findByRole('button',{name:'Create invitation code'});fireEvent.change(screen.getByLabelText('Customer mobile number'),{target:{value:'2025550101'}});
  expect(screen.queryByRole('button',{name:'Create invitation code'})).toBeNull();
});
it('requires explicit revocation and prefills a distinct CareBase customer-access review after SMS claim',async()=>{
  const claimed={...invitation,invitationId:'22222222-2222-4222-8222-222222222222',identity:{...identity,product:'carebase',sourceUserId:id},state:'claimed',hubUserId:id};
  const request=vi.fn(async(body:unknown)=>(body as {operation:string}).operation==='list'?{rows:[invitation,claimed],offset:0,total:2}:{...invitation,state:'revoked'});
  render(<MemoryRouter><CustomerRegistration request={request} onLinked={()=>{}}/></MemoryRouter>);fireEvent.click(await screen.findByRole('button',{name:'Revoke invitation'}));
  const revoke=screen.getByRole('button',{name:'Confirm invitation revocation'});expect(revoke).toHaveProperty('disabled',true);fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(revoke);
  await waitFor(()=>expect(request.mock.calls.some(([b])=>(b as {operation:string}).operation==='revoke')).toBe(true));
  fireEvent.click(screen.getByRole('button',{name:'Review app access'}));expect(screen.getByLabelText('Existing Hub user ID')).toHaveProperty('value',id);
  expect(screen.getByLabelText('Application')).toHaveProperty('value','carebase');expect(screen.getByLabelText('Native organization ID')).toHaveProperty('value',id);
});
