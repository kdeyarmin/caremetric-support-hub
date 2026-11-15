import { describe, expect, it, vi } from 'vitest';
import { reportLinkDays, reportLinks, reportToken, rosterAgency } from './report-link.mjs';
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
