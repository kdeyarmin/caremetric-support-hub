// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { JoinHub } from './JoinHub';
const api=vi.hoisted(()=>({startInvitation:vi.fn(),verifyInvitation:vi.fn()}));
vi.mock('../lib/appSession',()=>({appSession:api}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
it('requires explicit SMS consent, normalizes the reviewed number, and verifies before showing account readiness',async()=>{
  api.startInvitation.mockResolvedValue({challengeId:'11111111-1111-4111-8111-111111111111',retryAfter:60});api.verifyInvitation.mockResolvedValue(undefined);
  render(<MemoryRouter><JoinHub/></MemoryRouter>);
  fireEvent.change(screen.getByLabelText('Invitation code'),{target:{value:'a'.repeat(43)}});
  fireEvent.change(screen.getByLabelText('Mobile number'),{target:{value:'202-555-0100'}});
  const send=screen.getByRole('button',{name:'Text me a verification code'});expect(send).toHaveProperty('disabled',true);
  fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(send);
  const code=await screen.findByLabelText('SMS code');expect(api.startInvitation).toHaveBeenCalledWith({claimCode:'a'.repeat(43),phone:'+12025550100',consent:true});
  expect(screen.getByRole('button',{name:/Resend in/})).toHaveProperty('disabled',true);
  fireEvent.change(code,{target:{value:'123456'}});fireEvent.click(screen.getByRole('button',{name:'Verify and create account'}));
  await screen.findByRole('heading',{name:'Your phone is verified.'});expect(api.verifyInvitation).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111','123456');
  expect(screen.getByText(/administrator can now review and connect/)).toBeTruthy();expect(screen.queryByLabelText('Invitation code')).toBeNull();
});
it('leaves a rejected SMS code open for correction without claiming registration succeeded',async()=>{
  api.startInvitation.mockResolvedValue({challengeId:'11111111-1111-4111-8111-111111111111',retryAfter:60});api.verifyInvitation.mockRejectedValue(new Error('Code could not be verified.'));
  render(<MemoryRouter><JoinHub/></MemoryRouter>);fireEvent.change(screen.getByLabelText('Invitation code'),{target:{value:'a'.repeat(43)}});
  fireEvent.change(screen.getByLabelText('Mobile number'),{target:{value:'+12025550100'}});fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button',{name:'Text me a verification code'}));fireEvent.change(await screen.findByLabelText('SMS code'),{target:{value:'000000'}});
  fireEvent.click(screen.getByRole('button',{name:'Verify and create account'}));await waitFor(()=>expect(screen.getByRole('status').textContent).toBe('Code could not be verified.'));
  expect(screen.queryByRole('heading',{name:'Your phone is verified.'})).toBeNull();
});
