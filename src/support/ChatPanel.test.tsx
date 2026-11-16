// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from './ChatPanel';
import { chatClient, type ChatClient, type ChatThread } from './communicationsClient';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const thread: ChatThread = { reference: 1003, status: 'open', messages: [{ id: '33333333-3333-4333-8333-333333333333', from: 'visitor', body: 'Hello', createdAt: '2026-10-20T00:00:00Z' }] };
const client = (): ChatClient => ({ availability: vi.fn().mockResolvedValue({ chat: true }), thread: vi.fn().mockResolvedValue(thread), start: vi.fn(), send: vi.fn(), end: vi.fn() });
function polling() {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  let poll!: () => Promise<void>;
  const interval = window.setInterval.bind(window);
  vi.spyOn(window, 'setInterval').mockImplementation((callback, delay, ...args) => {
    if (delay !== 10000) return interval(callback, delay, ...args) as unknown as ReturnType<typeof window.setInterval>;
    poll = callback as () => Promise<void>;
    return 123 as unknown as ReturnType<typeof window.setInterval>;
  });
  return async () => { await act(async () => { await poll(); }); };
}

describe('chat connection recovery', () => {
  it('keeps the conversation visible when a poll fails and allows retry', async () => {
    const poll = polling(), chat = client();
    render(<ChatPanel client={chat} />);
    await screen.findByText('Hello');
    vi.mocked(chat.thread).mockRejectedValueOnce(new Error('offline'));
    await poll();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('Hello')).toBeTruthy();
    expect(screen.queryByLabelText('Name')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry chat' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('does not offer to replace an existing chat when the initial read fails', async () => {
    const chat = client();
    vi.mocked(chat.thread).mockRejectedValue(new Error('offline'));
    render(<ChatPanel client={chat} />);
    expect(await screen.findByRole('button', { name: 'Retry chat' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start chat' })).toBeNull();
  });

  it('does not offer to start a second chat when the new chat cannot be shown at once', async () => {
    const chat = client();
    vi.mocked(chat.thread).mockResolvedValueOnce(null);
    vi.mocked(chat.start).mockResolvedValue({ reference: 1003 });
    render(<ChatPanel client={chat} />);
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Pat' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'pat@agency.test' } });
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('checkbox'));
    // The chat starts, then reading it back fails: every start is a new conversation, so the form must not come back to be sent again.
    vi.mocked(chat.thread).mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));
    expect(await screen.findByRole('button', { name: 'Retry chat' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/started/);
    expect(screen.queryByRole('button', { name: 'Start chat' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry chat' }));
    expect(await screen.findByText('Hello')).toBeTruthy();
    expect(chat.start).toHaveBeenCalledOnce();
  });

  it('ignores an old poll that finishes after a reply is sent', async () => {
    const poll = polling(), chat = client();
    render(<ChatPanel client={chat} />);
    await screen.findByText('Hello');
    let resolve!: (value: ChatThread) => void;
    vi.mocked(chat.thread).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const pending = poll();
    vi.mocked(chat.send).mockResolvedValue({ ...thread, messages: [...thread.messages, { ...thread.messages[0], id: '44444444-4444-4444-8444-444444444444', body: 'New reply' }] });
    fireEvent.change(screen.getByLabelText('Your message'), { target: { value: 'New reply' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('New reply');
    await act(async () => { resolve(thread); await pending; });
    expect(screen.getByText('New reply')).toBeTruthy();
  });

  it('treats only a missing chat as an empty conversation', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: 'No chat' }, { status: 404 }));
    expect(await chatClient.thread()).toBeNull();
    fetch.mockResolvedValue(Response.json({ error: 'Unavailable' }, { status: 503 }));
    await expect(chatClient.thread()).rejects.toThrow('Unavailable');
  });
});
