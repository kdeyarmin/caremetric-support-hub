// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CustomerCenter } from './CustomerCenter';
const methods = vi.hoisted(() => ({ workspace: vi.fn(), diagnosticSupport: vi.fn() }));
vi.mock('../lib/config', () => ({ config: { demoMode: false } }));
vi.mock('./client', () => ({ selfServiceClient: methods }));
afterEach(() => { cleanup(); methods.workspace.mockReset(); methods.diagnosticSupport.mockReset(); });
const connection = '97000000-0000-4000-8000-000000000001', caseId = '97000000-0000-4000-8000-000000000002';
function show() {
  methods.workspace.mockResolvedValue({ connections: [{ id: connection, tenant_id: '97000000-0000-4000-8000-000000000003', app: 'carebase', name: 'CareBase', role: 'member', facilities: [], capabilities: [], connected_at: '2026-10-27' }] });
  render(<MemoryRouter><CustomerCenter /></MemoryRouter>);
}
describe('customer diagnostic support', () => {
  it('keeps a PennSync administrator in support and training without payment links', async () => {
    methods.workspace.mockResolvedValue({ connections: [{ id: connection, app: 'pennsync', name: 'PennSync', role: 'organization_admin', facilities: [], capabilities: ['training.profile.v1'] }] });
    render(<MemoryRouter><CustomerCenter /></MemoryRouter>);
    await screen.findByText('PennSync');
    expect(screen.queryByRole('link', { name: /Plans & add-ons/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /Invoices & payments/ })).toBeNull();
    expect(screen.getByRole('link', { name: /My profile & training/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Support requests/ })).toBeTruthy();
  });
  it('creates a private support request and shows unavailable tools without claiming a successful check', async () => {
    methods.diagnosticSupport.mockResolvedValue({ case_id: caseId, case_number: 177, tool_state: 'unavailable' });
    show(); fireEvent.click(await screen.findByRole('button', { name: 'Get AI-assisted connection support' }));
    await screen.findByText(/The application check was unavailable/);
    expect(screen.getByRole('link', { name: 'Open support request' }).getAttribute('href')).toBe(`/cases?case=${caseId}`);
    expect(methods.diagnosticSupport).toHaveBeenCalledWith(connection, expect.any(String));
  });
  it('keeps a stable ticket request identity across an uncertain response', async () => {
    methods.diagnosticSupport.mockRejectedValueOnce(new Error('The response was unavailable')).mockResolvedValueOnce({ case_id: caseId, case_number: 178, tool_state: 'available' });
    show(); fireEvent.click(await screen.findByRole('button', { name: 'Get AI-assisted connection support' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Get AI-assisted connection support' }));
    await waitFor(() => expect(methods.diagnosticSupport).toHaveBeenCalledTimes(2));
    expect(methods.diagnosticSupport.mock.calls[1]).toEqual(methods.diagnosticSupport.mock.calls[0]);
    await screen.findByRole('link', { name: 'Open support request' });
  });
});
