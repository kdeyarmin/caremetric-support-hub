import { describe, expect, it, vi } from 'vitest';
import { guideLibrary } from './knowledge.mjs';

const rows = [
  { kind: 'article', title: 'Export the staff roster', summary: 'Download the roster for a month.', body_markdown: 'Open Reports and select Export.' },
  { kind: 'article', title: 'Reset a password', summary: 'Reset your sign-in password.', body_markdown: 'Choose Forgot password on the sign-in page.' },
  { kind: 'article', title: 'Export the staff roster', summary: 'Download the roster for a month.', body_markdown: 'A duplicate placement of the same article.' },
  { kind: 'video', title: 'Roster export video', summary: 'Watch the roster export.', body_markdown: '' },
  { kind: 'course', title: 'Roster export course', summary: 'Learn about roster export.', body_markdown: '' },
  { kind: 'article', title: '   ', summary: 'Nameless', body_markdown: 'x' },
  { kind: 'article', title: 'Long article about rosters', summary: 'roster '.repeat(200), body_markdown: `Roster steps. ${'word '.repeat(1000)}` },
  null,
];

const library = (over = {}) => {
  let clock = 1_000_000;
  const load = vi.fn(async () => rows);
  const logs = [];
  const instance = guideLibrary({ load, now: () => clock, log: line => logs.push(line), ...over });
  return { instance, load, logs, advance: ms => { clock += ms; } };
};

describe('the published guides', () => {
  it('offers the best matching articles for a question, never a video or a course, and only once each', async () => {
    const { instance } = library();
    const top = await instance.top('How do I export the staff roster for last month?');
    expect(top.map(guide => guide.title)).toEqual(['Export the staff roster', 'Long article about rosters']);
    expect(top[0]).toEqual({ title: 'Export the staff roster', summary: 'Download the roster for a month.', body: 'Open Reports and select Export.' });
    expect((await instance.top('How can I reset my password?')).map(guide => guide.title)).toEqual(['Reset a password']);
  });

  it('clips each article so a request has a known size', async () => {
    const { instance } = library();
    const [, long] = await instance.top('How do I export the staff roster for last month?');
    expect(long.summary.length).toBeLessThanOrEqual(401);
    expect(long.body.length).toBeLessThanOrEqual(2001);
    expect(long.summary.endsWith('…')).toBe(true);
    expect(long.body.endsWith('…')).toBe(true);
  });

  it('offers nothing when no article shares words with the question', async () => {
    const { instance } = library();
    expect(await instance.top('Zebra xylophone quantum')).toEqual([]);
    expect(await instance.top('')).toEqual([]);
    expect(await instance.top(undefined)).toEqual([]);
  });

  it('reads the list once for ten minutes, at once for simultaneous questions, and again afterwards', async () => {
    const { instance, load, advance } = library();
    await Promise.all([instance.top('export roster'), instance.top('reset password'), instance.top('export roster')]);
    expect(load).toHaveBeenCalledTimes(1);
    advance(599_000);
    await instance.top('export roster');
    expect(load).toHaveBeenCalledTimes(1);
    advance(2_000);
    await instance.top('export roster');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps the last good list when a read fails, tries again in a minute and logs only that it failed', async () => {
    const { instance, load, logs, advance } = library();
    await instance.top('export roster');
    load.mockRejectedValue(new Error('database says Pat Example'));
    advance(601_000);
    expect((await instance.top('export roster')).map(guide => guide.title)).toContain('Export the staff roster');
    expect(logs).toEqual([JSON.stringify({ event: 'hub_agent_guides_unavailable', kept: 3 })]);
    expect(load).toHaveBeenCalledTimes(2);
    await instance.top('export roster');
    expect(load).toHaveBeenCalledTimes(2);
    advance(61_000);
    await instance.top('export roster');
    expect(load).toHaveBeenCalledTimes(3);
    expect(logs.join()).not.toContain('Pat Example');
  });

  it('offers nothing, without failing, when the list was never readable or is not a list', async () => {
    const never = library();
    never.load.mockRejectedValue(new Error('down'));
    expect(await never.instance.top('export roster')).toEqual([]);
    const odd = library();
    odd.load.mockResolvedValue({ not: 'a list' });
    expect(await odd.instance.top('export roster')).toEqual([]);
  });
});
