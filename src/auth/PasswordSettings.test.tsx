// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PasswordSettings } from './PasswordSettings';
const api=vi.hoisted(()=>({passwordSettings:vi.fn(),savePassword:vi.fn(),signOut:vi.fn()}));
vi.mock('../lib/appSession',()=>({appSession:api}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
const fill=(confirm='test-only long passphrase')=>{
  fireEvent.change(screen.getByLabelText('Username'),{target:{value:'Owner'}});
  fireEvent.change(screen.getByLabelText('New password'),{target:{value:'test-only long passphrase'}});
  fireEvent.change(screen.getByLabelText('Confirm new password'),{target:{value:confirm}});
};
it('sets credentials after owner authentication and clears secrets after saving',async()=>{
  api.passwordSettings.mockResolvedValue({username:'',configured:false,can_reset:true});api.savePassword.mockResolvedValue({authenticated:true});
  render(<PasswordSettings/>);await screen.findByLabelText('Username');fill();fireEvent.click(screen.getByRole('button',{name:'Set username and password'}));
  expect((await screen.findByRole('status')).textContent).toContain('Other sessions have been signed out');
  expect(api.savePassword).toHaveBeenCalledWith({username:'Owner',password:'test-only long passphrase'});
  expect(screen.getByLabelText('New password')).toHaveProperty('value','');expect(screen.getByLabelText('Confirm new password')).toHaveProperty('value','');
  expect(screen.getByLabelText('Current password')).toBeTruthy();
});
it('requires matching confirmation and the current password when not using fresh SMS recovery',async()=>{
  api.passwordSettings.mockResolvedValue({username:'owner',configured:true,can_reset:false});api.savePassword.mockRejectedValue(new Error('Current password rejected.'));
  render(<PasswordSettings/>);await screen.findByLabelText('Current password');fill('different password');
  fireEvent.change(screen.getByLabelText('Current password'),{target:{value:'current test password'}});
  fireEvent.click(screen.getByRole('button',{name:'Save username and password'}));
  expect((await screen.findByRole('alert')).textContent).toContain('do not match');expect(api.savePassword).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Confirm new password'),{target:{value:'test-only long passphrase'}});fireEvent.click(screen.getByRole('button',{name:'Save username and password'}));
  await waitFor(()=>expect(screen.getByRole('alert').textContent).toBe('Current password rejected.'));
  expect(api.savePassword).toHaveBeenCalledWith({username:'Owner',password:'test-only long passphrase',currentPassword:'current test password'});
  expect(screen.queryByRole('status')).toBeNull();expect(screen.getByLabelText('Current password')).toHaveProperty('value','');
});
it('reports failed sign-out instead of pretending the session ended',async()=>{
  api.passwordSettings.mockResolvedValue({username:'owner',configured:true,can_reset:false});api.signOut.mockRejectedValue(new Error('offline'));
  render(<PasswordSettings/>);await screen.findByLabelText('Username');fireEvent.click(screen.getByRole('button',{name:'Sign out'}));
  expect((await screen.findByRole('alert')).textContent).toContain('Sign-out could not be completed');
});
it('refreshes expired SMS recovery so the current-password field becomes usable',async()=>{
  api.passwordSettings.mockResolvedValueOnce({username:'owner',configured:true,can_reset:true})
    .mockResolvedValue({username:'owner',configured:true,can_reset:false});
  api.savePassword.mockRejectedValueOnce(new Error('Enter your current password, or sign in with a new SMS code to reset it.'))
    .mockResolvedValue({authenticated:true});
  render(<PasswordSettings/>);await screen.findByLabelText('Username');fill();
  expect(screen.queryByLabelText('Current password')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Save username and password'}));
  await screen.findByLabelText('Current password');
  expect(screen.getByRole('alert').textContent).toContain('Enter your current password');
  expect(screen.getByLabelText('Username')).toHaveProperty('value','Owner');
  expect(screen.getByLabelText('New password')).toHaveProperty('value','');
  fill();fireEvent.change(screen.getByLabelText('Current password'),{target:{value:'current test password'}});
  fireEvent.click(screen.getByRole('button',{name:'Save username and password'}));
  expect((await screen.findByRole('status')).textContent).toContain('are saved');
  expect(api.savePassword).toHaveBeenLastCalledWith({username:'Owner',password:'test-only long passphrase',currentPassword:'current test password'});
});
