// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Growth } from './Growth';
vi.hoisted(() => { vi.stubEnv('VITE_DEMO_MODE','true'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const empty = { total:0,items:[],work:[],metrics:[],deliveries:[],policies:[],services:{sending:false,signing:false,postalAddress:false,research:false} };
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
