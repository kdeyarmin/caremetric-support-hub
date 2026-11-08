// @vitest-environment jsdom
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { Connect } from './Connect';

const client = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('./client', () => ({ selfServiceClient: client }));
vi.mock('../lib/appSession', () => ({ appSession: { current: vi.fn() }, appRequest: vi.fn() }));
const token = `cmc_${'a'.repeat(43)}`;
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); window.sessionStorage.clear(); window.history.replaceState(null, '', '/'); });
function renderConnect() {
  return render(<StrictMode><MemoryRouter initialEntries={['/connect']}><Routes>
    <Route path="/connect" element={<Connect authenticated />} />
    <Route path="/self-service" element={<h1>Customer center</h1>} />
  </Routes></MemoryRouter></StrictMode>);
}

it('can use a connection link when browser storage is unavailable', async () => {
  window.history.replaceState(null, '', `/connect#${token}`);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Storage blocked', 'SecurityError'); });
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Storage blocked', 'SecurityError'); });
  client.connect.mockResolvedValue({});
  renderConnect();
  fireEvent.click(screen.getByRole('button', { name: 'Connect to my signed-in Hub account' }));
  await screen.findByRole('heading', { name: 'Customer center' });
  expect(client.connect).toHaveBeenCalledWith(token);
  expect(window.location.hash).toBe('');
});

it('finishes a successful connection even if clearing saved browser state fails', async () => {
  window.history.replaceState(null, '', `/connect#${token}`);
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new DOMException('Storage blocked', 'SecurityError'); });
  client.connect.mockResolvedValue({});
  renderConnect();
  fireEvent.click(screen.getByRole('button', { name: 'Connect to my signed-in Hub account' }));
  await screen.findByRole('heading', { name: 'Customer center' });
  expect(client.connect).toHaveBeenCalledTimes(1);
});

it('does not offer a malformed saved connection token', () => {
  window.sessionStorage.setItem('caremetric.pendingConnection', 'invalid');
  renderConnect();
  expect(screen.getByRole('alert').textContent).toContain('new connection link');
  expect(screen.queryByRole('button', { name: 'Connect to my signed-in Hub account' })).toBeNull();
});
