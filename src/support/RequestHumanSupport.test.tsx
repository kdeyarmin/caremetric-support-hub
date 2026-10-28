// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestHumanSupport } from './RequestHumanSupport';
const request = vi.hoisted(() => vi.fn());
vi.mock('../lib/appSession', () => ({ appRequest: request }));
afterEach(() => { cleanup(); request.mockReset(); });
describe('immediate human support', () => {
  it('is available before an AI response and confirms the result', async () => {
    request.mockResolvedValue({ stage: 'halted' }); const onChanged = vi.fn();
    render(<RequestHumanSupport caseId="synthetic-case" onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Request human support' }));
    await screen.findByRole('status');
    expect(request).toHaveBeenCalledWith('rpc/request_human_support', { p_case_id: 'synthetic-case', p_request_key: expect.any(String) });
    expect(onChanged).toHaveBeenCalledOnce();
  });
  it('retains the request identity across an unavailable-tool retry', async () => {
    request.mockRejectedValueOnce(new Error('Support temporarily unavailable')).mockResolvedValueOnce({ stage: 'halted', replayed: true });
    render(<RequestHumanSupport caseId="synthetic-case" onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Request human support' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Request human support' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]).toEqual(request.mock.calls[0]);
    await screen.findByRole('status');
  });
});
