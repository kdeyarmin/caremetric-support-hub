// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PasswordSignIn } from './PasswordSignIn';
const api=vi.hoisted(()=>({signInWithPassword:vi.fn(),start:vi.fn(),verify:vi.fn()}));
vi.mock('../lib/appSession',()=>({appSession:api}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
it('uses email/password by default and lets the password manager recognize the fields',async()=>{
  api.signInWithPassword.mockResolvedValue(undefined);const remember=vi.fn();
  render(<PasswordSignIn rememberPath={remember}/>);
  expect(screen.queryByLabelText('Mobile number')).toBeNull();
  const username=screen.getByLabelText('Email or username'),password=screen.getByLabelText('Password');
  expect(username.getAttribute('autocomplete')).toBe('username');expect(password.getAttribute('autocomplete')).toBe('current-password');
  fireEvent.change(username,{target:{value:'owner@example.com'}});fireEvent.change(password,{target:{value:'H7!mQ2vR8z'}});
  fireEvent.click(screen.getByRole('button',{name:'Sign in'}));
  await waitFor(()=>expect(api.signInWithPassword).toHaveBeenCalledWith('owner@example.com','H7!mQ2vR8z'));
  expect(remember).toHaveBeenCalledWith();expect(api.start).not.toHaveBeenCalled();
});
it('shows a failed login without retaining its password or claiming success',async()=>{
  api.signInWithPassword.mockRejectedValue(new Error('The sign-in details are incorrect.'));
  render(<PasswordSignIn rememberPath={vi.fn()}/>);
  fireEvent.change(screen.getByLabelText('Email or username'),{target:{value:'owner@example.com'}});fireEvent.change(screen.getByLabelText('Password'),{target:{value:'wrong password'}});
  fireEvent.click(screen.getByRole('button',{name:'Sign in'}));
  expect((await screen.findByRole('alert')).textContent).toBe('The sign-in details are incorrect.');
  expect(screen.getByLabelText('Password')).toHaveProperty('value','');
});
it('uses SMS only when requested for setup/recovery and returns to the Security page',async()=>{
  const remember=vi.fn();api.start.mockResolvedValue({challengeId:'challenge',retryAfter:60});
  render(<PasswordSignIn rememberPath={remember}/>);
  fireEvent.click(screen.getByRole('button',{name:'Set up or reset your password'}));
  expect(api.start).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Mobile number'),{target:{value:'+12025550101'}});fireEvent.click(screen.getByRole('button',{name:'Text me a code'}));
  await screen.findByLabelText('SMS code');expect(remember).toHaveBeenCalledWith('/security');
  fireEvent.click(screen.getByRole('button',{name:'Back to password sign-in'}));expect(screen.getByLabelText('Password')).toBeTruthy();
});
