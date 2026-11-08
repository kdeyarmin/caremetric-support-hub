// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const signOut = vi.hoisted(() => vi.fn());
vi.mock('../lib/appSession', () => ({ appSession: { signOut } }));
import { SignOutButton } from './SignOutButton';
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('explains a failed sign-out and allows retry', async () => {
  signOut.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
  render(<SignOutButton />);
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Sign-out could not complete. Please try again.');
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  await waitFor(() => expect(signOut).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('alert')).toBeNull();
});
