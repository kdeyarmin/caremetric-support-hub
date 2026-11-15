import { describe, expect, it, vi } from 'vitest';
import { reportLinkDays, reportLinks, reportMissingMs, reportOpensMs, reportToken, rosterAgency } from './report-link.mjs';
import { draftMessage, draftProblem } from './draft.mjs';

const key = 'k'.repeat(40);
const roster = (ccn = '397001', setting = 'home health agency') => ({
  id: 'roster-1', source_url: 'https://data.cms.gov/provider-characteristics/hospitals-and-other-facilities/provider-of-services-file',
  observed_at: new Date().toISOString(), confidence: 'high',
  claim: `CMS Provider of Services file, 2026Q3: Riverbend Home Health (CCN ${ccn}) is a Medicare-certified ${setting} in Riverton, PA; certified June 27, 2024.`,
});

describe('agency report links', () => {
  it('signs exactly as Intel verifies (the same vector as Intel tests/agencyReport.test.ts)', () => {
    expect(reportToken({ ccn: '397001', setting: 'hha', expires: 1_800_000_000, ref: 'abc123' }, 'x'.repeat(32)))
      .toBe('eyJ2IjoxLCJjIjoiMzk3MDAxIiwicyI6ImhoYSIsImUiOjE4MDAwMDAwMDAsInIiOiJhYmMxMjMifQ.h66vqv89QWcLMaTDJI7xXQ');
  });

  it('offers a link only once Intel answers it with the PDF, and keeps that answer for a while', async () => {
    let now = Date.parse('2026-11-15T15:00:00Z');
    const answers = { '397001': { status: 200, type: 'application/pdf' }, '398405': { status: 404, type: 'text/html; charset=utf-8' } };
    const fetchImpl = vi.fn(async url => {
      const ccn = JSON.parse(Buffer.from(String(url).split('/report/')[1].split('.')[0], 'base64url').toString()).c;
      const answer = answers[ccn];
      if (!answer) throw new TypeError('fetch failed');
      return new Response(answer.status === 200 ? '%PDF-1.3' : '<h1>No report for this link</h1>', { status: answer.status, headers: { 'content-type': answer.type } });
    });
    const links = reportLinks({ key, now: () => now, fetchImpl });
    const prospect = ccn => ({ id: `o-${ccn}`, product: 'caremetric-intel', name: 'Riverbend Home Health', evidence: [roster(ccn)] });
    expect((await links.checkedLinkFor(prospect('397001'))).url).toMatch(/\/report\//);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' });
    // Medicare's directory doesn't list this agency yet, so Intel has no report: no link, and the email offers the review page.
    expect(await links.checkedLinkFor(prospect('398405'))).toBeNull();
    // A failed request is no report either.
    expect(await links.checkedLinkFor(prospect('397777'))).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // Each answer is kept: a report that opens for longer than one that doesn't.
    await links.checkedLinkFor(prospect('397001'));
    await links.checkedLinkFor(prospect('398405'));
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    now += reportMissingMs + 1;
    answers['398405'] = { status: 200, type: 'application/pdf' };
    expect(await links.checkedLinkFor(prospect('398405'))).not.toBeNull();
    await links.checkedLinkFor(prospect('397001'));
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    now += reportOpensMs;
    await links.checkedLinkFor(prospect('397001'));
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    // No roster record, another product or no secret: nothing is fetched.
    expect(await links.checkedLinkFor({ product: 'caremetric-intel', evidence: [] })).toBeNull();
    expect(await reportLinks({ key: 'short', fetchImpl }).checkedLinkFor(prospect('397001'))).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    // The sweep stopping stops the check too.
    const stopped = new AbortController();
    stopped.abort(new Error('sweep stopped'));
    const hanging = reportLinks({ key, fetchImpl: vi.fn(async (_url, init) => { init.signal.throwIfAborted(); return new Response('%PDF'); }) });
    await expect(hanging.checkedLinkFor(prospect('397001'), { signal: stopped.signal })).rejects.toThrow('sweep stopped');
  });

  it('reads the agency from its Medicare roster record, and nothing else', () => {
    expect(rosterAgency([{ claim: 'A home health agency serving Allegheny County.' }, roster()])).toEqual({ ccn: '397001', setting: 'hha' });
    expect(rosterAgency([roster('391500', 'hospice')])).toEqual({ ccn: '391500', setting: 'hospice' });
    expect(rosterAgency([{ claim: 'Riverbend (CCN 397001) is a Medicare-certified home health agency.' }])).toBeNull();
    expect(rosterAgency([])).toBeNull();
  });

  it('gives an Intel prospect with a roster record a link that lives about five months', () => {
    const now = Date.parse('2026-11-15T15:00:00Z');
    const links = reportLinks({ key, now: () => now });
    const link = links.linkFor({ id: '7f1d2c3a-1111-4222-8333-944455556666', product: 'caremetric-intel', name: 'Riverbend Home Health', evidence: [roster()] });
    expect(link.label).toBe('Free market report for Riverbend Home Health');
    expect(link.url).toMatch(/^https:\/\/www\.caremetricintel\.com\/report\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
    const claims = JSON.parse(Buffer.from(link.url.split('/report/')[1].split('.')[0], 'base64url').toString());
    expect(claims).toEqual({ v: 1, c: '397001', s: 'hha', e: Math.floor(now / 1000) + reportLinkDays * 86_400, r: '7f1d2c3a-1111-4222-8333-944455556666' });
    expect(links.linkFor({ product: 'carebase', evidence: [roster()] })).toBeNull();
    expect(links.linkFor({ product: 'caremetric-intel', evidence: [] })).toBeNull();
    expect(reportLinks({ key: 'short' }).linkFor({ product: 'caremetric-intel', evidence: [roster()] })).toBeNull();
    expect(() => reportToken({ ccn: 'bad', expires: 1 }, key)).toThrow(/CCN/);
  });

  it('lets an outreach draft carry its own agency report link, and no other', async () => {
    const link = reportLinks({ key }).linkFor({ id: 'o1', product: 'caremetric-intel', name: 'Riverbend Home Health', evidence: [roster()] });
    const opportunity = { id: 'o1', product: 'caremetric-intel', name: 'Riverbend Home Health', version: 1, contact_id: 'c', touches: 0,
      policy: { approved_claim: 'CareMetric Intel helps home health agencies focus their marketing.' }, evidence: [roster()], events: [] };
    const work = { kind: 'outreach', action: 'First touch', success: 'Reply' };
    const body = `I run a home health and hospice agency, and I built CareMetric Intel to find every referral source.\n\nI put together a free market report for your agency:\n${link.url}`;
    const model = { configured: true, run: vi.fn(async () => ({ outcome: 'completed', output: { subject: 'Your county market', body, citations: ['roster-1'], needsHuman: false } })) };
    const draft = await draftMessage({ opportunity, work, task: {}, model, report: link });
    expect(draft).toMatchObject({ modelGenerated: true });
    expect(draft.body).toContain(link.url);
    const input = JSON.parse(model.run.mock.calls[0][1].user);
    expect(input.report).toBe(true);
    expect(input.links.map(item => item.url)).toContain(link.url);
    // Without the link it was given, the same body fails the link check; another agency's report never passes.
    expect(await draftMessage({ opportunity, work, task: {}, model })).toBeNull();
    const other = reportLinks({ key }).linkFor({ id: 'o2', product: 'caremetric-intel', evidence: [roster('397555')] });
    expect(draftProblem({ subject: 'Your county', body: `See it:\n${other.url}`, citations: ['roster-1'], needsHuman: false },
      { product: 'caremetric-intel', sources: opportunity.evidence, outreach: true, extraLinks: [link.url] })).toBe('link');
    // With no model, the first touch's template offers the report.
    expect((await draftMessage({ opportunity, work, task: {}, report: link })).body).toContain(link.url);
  });
});

describe('the report-led first email (owner direction 2026-11-15)', () => {
  const opportunity = { id: 'o1', product: 'caremetric-intel', name: 'Riverbend Home Health', version: 1, contact_id: 'c', touches: 0,
    policy: { approved_claim: 'CareMetric Intel helps home health agencies focus their marketing.' }, evidence: [roster()], events: [] };
  const work = { kind: 'outreach', action: 'First touch', success: 'Reply' };
  const reply = (body, citations = ['roster-1']) => ({ configured: true, run: vi.fn(async () => ({ outcome: 'completed', output: { subject: 'Your county referral market', body, citations, needsHuman: false } })) });

  it('asks about the reader\'s market, links its own report, then the trial with its card terms', async () => {
    const link = reportLinks({ key }).linkFor(opportunity);
    const body = `I run a home health and hospice agency, and I built CareMetric Intel to find every referral source.\n\nAre you getting your share of the referrals in your county? Does your team know every hospital and physician that refers in your territory? How well do you know the agencies you meet there?\n\nI put together a free market report for your agency from public Medicare data. Please review it with your managers and marketing team:\n${link.url}\n\nHow much could you grow if your team worked from the most current market intelligence? Try it free for 30 days. A credit card is required to start the trial, and canceling before it ends means no charge:\nhttps://www.caremetricintel.com/`;
    const model = reply(body);
    const draft = await draftMessage({ opportunity, work, task: {}, model, report: link });
    expect(draft).toMatchObject({ modelGenerated: true });
    const input = JSON.parse(model.run.mock.calls[0][1].user);
    expect(input.touchPlan).toMatch(/share of the referrals/);
    expect(input.touchPlan).toMatch(/managers and marketing team/);
    expect(input.touchPlan).toMatch(/credit card is required to start the trial/);
    expect(input.touchPlan).toMatch(/Never call it risk-free/);
    expect(input.style).toMatch(/one hundred seventy words/);
    // "Risk-free" is refused, as is "no credit card".
    expect(await draftMessage({ opportunity, work, task: {}, model: reply(body.replace('Try it free for 30 days.', 'Try it risk-free for 30 days.')), report: link })).toBeNull();
    expect(await draftMessage({ opportunity, work, task: {}, model: reply(body.replace('A credit card is required to start the trial, and canceling before it ends means no charge', 'No credit card needed')), report: link })).toBeNull();
  });

  it('sends an agency with no roster record to the page where it gets its own report', async () => {
    const web = { ...opportunity, evidence: [{ id: 'web-1', source_url: 'https://riverbend.example', observed_at: new Date().toISOString(), confidence: 'medium', claim: 'Riverbend Home Health serves Riverton County.' }] };
    const model = reply('Are you getting your share of referrals?\n\nGet your free market report:\nhttps://www.caremetricintel.com/market-review', ['web-1']);
    const draft = await draftMessage({ opportunity: web, work, task: {}, model });
    expect(draft).toMatchObject({ modelGenerated: true });
    const input = JSON.parse(model.run.mock.calls[0][1].user);
    expect(input.touchPlan).toMatch(/entering its CMS certification number on the market report page/);
    expect(input.links.map(item => item.url)).toContain('https://www.caremetricintel.com/market-review');
    // Later touches and other products keep their own plans.
    const second = reply('A different angle.\n\nhttps://www.caremetricintel.com/', ['web-1']);
    await draftMessage({ opportunity: { ...web, touches: 1 }, work, task: {}, model: second });
    expect(JSON.parse(second.run.mock.calls[0][1].user).touchPlan).toMatch(/different angle/);
  });
});
