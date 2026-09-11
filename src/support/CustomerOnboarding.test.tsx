// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CustomerOnboarding } from './CustomerOnboarding';
const id='11111111-1111-4111-8111-111111111111';
const preview={intentId:id,proofDigest:'a'.repeat(64),expiresAt:new Date(Date.now()+60000).toISOString(),
  identity:{product:'breathe',sourceUserId:'CasePreserved_User',sourceAccountId:id,accountKind:'organization',relationship:'organization_member',revision:'b'.repeat(64)},
  hubUserId:id,hubDisplayName:'Existing verified member',hubTenantId:id,tenantName:'Example customer',access:'customer',caseScope:'own',intakeEnabled:false};
afterEach(cleanup);
function fill(){
  fireEvent.change(screen.getByLabelText('Native app user ID'),{target:{value:'CasePreserved_User'}});
  fireEvent.change(screen.getByLabelText('Native organization ID'),{target:{value:id}});
  fireEvent.change(screen.getByLabelText('Existing Hub user ID'),{target:{value:id}});
  fireEvent.change(screen.getByLabelText('Customer account name'),{target:{value:'Example customer'}});
}
it('reviews concrete native and Hub IDs, repeats one request ID after an uncertain response, and grants nothing before confirmation',async()=>{
  let applies=0;const request=vi.fn(async(body:unknown)=>{
    const op=body as {operation:string};if(op.operation==='preview')return preview;
    if(++applies===1)throw new Error('Response lost');return {intentId:id,hubTenantId:id,hubUserId:id,product:'breathe',replayed:true,access:'customer',caseScope:'own',intakeEnabled:false};
  });const onLinked=vi.fn();render(<CustomerOnboarding request={request} onLinked={onLinked} />);fill();
  fireEvent.click(screen.getByRole('button',{name:'Verify and preview account link'}));
  const apply=await screen.findByRole('button',{name:'Confirm customer link'});expect(apply).toHaveProperty('disabled',true);
  expect(screen.getByText('CasePreserved_User')).toBeTruthy();expect(screen.getByText(/Existing verified member/)).toBeTruthy();expect(request).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(apply);await screen.findByRole('alert');fireEvent.click(apply);
  await waitFor(()=>expect(onLinked).toHaveBeenCalledOnce());expect(request.mock.calls[1][0]).toEqual(request.mock.calls[2][0]);
});
it('clears a reviewed pairing when an identity field or app changes',async()=>{
  const request=vi.fn(async()=>preview);render(<CustomerOnboarding request={request} onLinked={()=>{}} />);fill();
  fireEvent.click(screen.getByRole('button',{name:'Verify and preview account link'}));await screen.findByRole('button',{name:'Confirm customer link'});fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.change(screen.getByLabelText('Existing Hub user ID'),{target:{value:'22222222-2222-4222-8222-222222222222'}});
  expect(screen.queryByRole('button',{name:'Confirm customer link'})).toBeNull();expect(request).toHaveBeenCalledOnce();
  fireEvent.change(screen.getByLabelText('Application'),{target:{value:'intel'}});expect(screen.queryByLabelText('Native organization ID')).toBeNull();
});
