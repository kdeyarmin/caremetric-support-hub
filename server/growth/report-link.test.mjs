import { describe, expect, it, vi } from 'vitest';
import { reportLinkDays, reportLinks, reportMissingMs, reportOpensMs, reportToken, rosterAgency } from './report-link.mjs';
import { growthEmail, growthExecutors } from './worker.mjs';
import { draftMessage, draftProblem } from './draft.mjs';
import { readCampaign } from './campaign.mjs';
import { nursingHomeAngles, reportTouchAngle, reviewFollowupAngle, reviewTouchAngle } from './playbook.mjs';

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

  it('carries a declared web report from an untracked probe through all three branded emails', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const path = new URL(url).pathname;
      const claims = JSON.parse(Buffer.from(path.split('/report/')[1].split('.')[0], 'base64url').toString());
      expect(claims.r).toBeUndefined();
      return new Response('%PDF', { headers: { 'Content-Type': 'application/pdf', Link: `<${path}/view>; rel="alternate"; type="text/html"` } });
    });
    const reports = reportLinks({ key, fetchImpl });
    const opportunity = {
      id: 'o-hospice', contact_id: 'contact-fixture', product: 'caremetric-intel', name: 'Riverbend Hospice', evidence: [roster('391500', 'hospice')],
      policy: { approved_claim: 'CareMetric Intel helps hospice teams plan their outreach.' },
    };
    const report = await reports.checkedLinkFor(opportunity);
    expect(report.url).toBe(`${reports.linkFor(opportunity).url}/view`);
    expect(reports.accepts(report.url)).toBe(true);
    expect(reports.accepts(`${report.url}?view=1`)).toBe(false);
    const work = { kind: 'outreach', action: 'Share the report', success: 'Reply' };
    for (const touches of [0, 1, 2]) {
      const draft = await draftMessage({ opportunity: { ...opportunity, touches }, work, task: {}, report });
      expect(readCampaign(draft.body, { reports })).toMatchObject({ version: 3, touch: touches + 1, ownReport: true, reportUrl: report.url });
      const { html, text } = growthEmail({ ...draft, product: opportunity.product, purpose: 'marketing', reports,
        postalAddress: 'CareMetric, 100 Example Ave', unsubscribeUrl: 'https://example.com/preferences/fixture' });
      expect(html).toContain('data-caremetric-email="branded"');
      expect(html).toContain(`href="${report.url}"`);
      // The first email asks for one thing, the report (the Nov 24 measurement): the trial comes in the second and the last.
      if (touches === 0) expect(html).not.toContain('login?signup=true');
      else expect(html).toContain('login?signup=true&amp;utm_source=caremetric');
      expect(html).toContain('Opt out of these emails');
      expect(text.split(report.url)).toHaveLength(2);
      expect(text.match(/Start your 30-day free trial/g) ?? []).toHaveLength(touches === 0 ? 0 : 1);
      if (touches === 0) expect(text).toContain('For hospice teams');
    }
    const fallback = await draftMessage({ opportunity, work, task: {} });
    // Without a report of its own, the agency is offered Intel's free county report: a state, a county and an email address.
    expect(fallback.body).toContain('\nhttps://www.caremetricintel.com/county-report?');
    expect(fallback.body).toContain('Get your free county report\nChoose your state and county. We’ll email the report as a PDF.');
    expect(fallback.body).not.toMatch(/agency name|certification number|market-review/i);
    expect(readCampaign(fallback.body)).toMatchObject({ version: 3, ownReport: false });
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
    const body = `I put together a free market report for Riverbend Home Health from Medicare data. It opens as a PDF, with nothing to sign up for:\n${link.url}\n\nI manage a home health and hospice company, and I built CareMetric Intel to see my own market this way.\n\nIt is a quick way to see who leads the county before you plan next month's visits.`;
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

  it('has the writer open with the agency\'s own market report and adds what the software does below it (owner direction 2026-11-17), with the trial in the second email (the Nov 24 measurement)', async () => {
    const link = reportLinks({ key }).linkFor(opportunity);
    const body = `I put together a free market report for Riverbend Home Health from Medicare data. It opens as a PDF, with nothing to sign up for:\n${link.url}\n\nIt shows where your agency stands among the agencies located in its county and which agencies lead the county. It also shows the hospitals the county's residents use most and the highest-ranked physicians for outreach.\n\nI manage a home health and hospice company, and I built CareMetric Intel to see my own market this way.\n\nIt is a quick way to see who leads the county before you plan next month's visits.`;
    const model = reply(body);
    const draft = await draftMessage({ opportunity, work, task: {}, model, report: link });
    expect(draft).toMatchObject({ modelGenerated: true });
    const input = JSON.parse(model.run.mock.calls[0][1].user);
    expect(input.touchPlan).toBe(reportTouchAngle);
    expect(input.touchPlan).toMatch(/you put together a free market report for this agency, by name, from Medicare data/);
    expect(input.touchPlan).toMatch(/Ask for one thing only: that the reader open the report\. Ask no question for them to answer by reply/);
    expect(input.touchPlan).toMatch(/No other link, no free trial, no price and no story about yourself in your words\./);
    // The longer email it replaces asked three questions and stated the trial's card terms.
    expect(input.touchPlan).not.toMatch(/credit card|managers and marketing team|three questions|one hundred seventy words/);
    expect(input.style).toBe('Write two or three sentences, never more than 120 words.');
    // The stored email is the writer's opening, then the sections every agency gets: what the software does and the founder's words. It
    // asks for one thing, the report: the trial comes in the second email.
    expect(draft.body.startsWith(body)).toBe(true);
    expect(draft.body).toContain('For home health teams');
    expect(draft.body).not.toMatch(/free trial|signup=true/);
    // A question for the reader is a second ask in a first email, and is refused.
    expect(await draftMessage({ opportunity, work, task: {}, model: reply(`${body} Does it match what your team sees in the field?`), report: link })).toBeNull();
    expect(draft.arms).toMatchObject({ length: 'report', form: 'short' });
    expect(draft.variant).toBe('report');
    // The trial is the email's to offer, not the writer's: in the opening it is refused, with or without its link.
    expect(await draftMessage({ opportunity, work, task: {}, model: reply(`${body}\n\nYou can try it free for 30 days:\nhttps://www.caremetricintel.com/`), report: link })).toBeNull();
    expect(await draftMessage({ opportunity, work, task: {}, model: reply(body.replace("It is a quick way to see who leads the county before you plan next month's visits.", 'A free trial on your county would help too.')), report: link })).toBeNull();
    // The second email offers it in its own sections, in plain words: an opening that offers it again is refused, risk-free or not, with
    // "no credit card needed" (true since 2026-11-23, but the trial is the email's to offer) or with a card called required.
    const second = async opening => {
      const written = reply(opening);
      const sent = await draftMessage({ opportunity: { ...opportunity, touches: 1 }, work, task: {}, model: written, report: link });
      return { sent, plan: JSON.parse(written.run.mock.calls[0][1].user).touchPlan };
    };
    const offered = await second("Does your team plan the week around the hospitals your county's residents use?");
    expect(offered.sent).toMatchObject({ modelGenerated: true });
    expect(offered.sent.body).toMatch(/Start your 30-day free trial\nhttps:\/\/www\.caremetricintel\.com\/login\?signup=true&utm_source=caremetric&utm_medium=email&utm_campaign=growth-intel-touch2/);
    expect(offered.plan).toMatch(/founding member pricing, the 30-day free trial button, and a link back to the report/);
    expect(offered.sent.body).toContain('A week of outreach');
    expect(offered.sent.body).toContain('Founding member pricing: your price never goes up');
    expect((await second('You can try it risk-free for 30 days on one county:')).sent).toBeNull();
    expect((await second(`See the report.\n${link.url}`)).sent).toBeNull();
    expect((await second('You can try it free for 30 days, with no credit card needed:')).sent).toBeNull();
    expect((await second('You can try it free for 30 days. A credit card is required to start the trial:')).sent).toBeNull();
  });

  it('sends an agency with no roster record to Intel\'s free county report, never asking for its name or certification number (owner direction 2026-11-19)', async () => {
    const web = { ...opportunity, evidence: [{ id: 'web-1', source_url: 'https://riverbend.example', observed_at: new Date().toISOString(), confidence: 'medium', claim: 'Riverbend Home Health serves Riverton County.' }] };
    const model = reply('A free report on Riverton County, built from Medicare and Census data, is one step away. Choose the state and county and it is emailed to you as a PDF:\nhttps://www.caremetricintel.com/county-report\n\nIt shows which hospitals Riverton County residents use.', ['web-1']);
    const draft = await draftMessage({ opportunity: web, work, task: {}, model });
    expect(draft).toMatchObject({ modelGenerated: true, arms: { form: 'short' } });
    const input = JSON.parse(model.run.mock.calls[0][1].user);
    expect(input.touchPlan).toBe(reviewTouchAngle);
    expect(input.touchPlan).toMatch(/put the county report page's link on its own line/);
    expect(input.reportAccess).toBe('Intel’s free county report: the reader chooses the state and county and enters an email address, and the report is emailed as a PDF.');
    expect(input.links.map(item => item.url)).toContain('https://www.caremetricintel.com/county-report');
    expect(input.links.map(item => item.url)).not.toContain('https://www.caremetricintel.com/market-review');
    // The retired market review's page, or words asking for the agency's number, are refused.
    expect(await draftMessage({ opportunity: web, work, task: {}, model: reply('A free market report for Riverbend Home Health is one step away:\nhttps://www.caremetricintel.com/market-review\n\nDoes your team know which agencies lead Riverton County?', ['web-1']) })).toBeNull();
    expect(await draftMessage({ opportunity: web, work, task: {}, model: reply('A free report on Riverton County is one step away. Enter your CMS certification number on this page:\nhttps://www.caremetricintel.com/county-report\n\nDoes your team know which hospitals Riverton County residents use?', ['web-1']) })).toBeNull();
    // Its one link is that page: the trial's page in its place, or beside it, is refused.
    expect(await draftMessage({ opportunity: web, work, task: {}, model: reply('A free report on Riverton County is one step away:\nhttps://www.caremetricintel.com/\n\nDoes your team know which hospitals Riverton County residents use?', ['web-1']) })).toBeNull();
    // Its second email points to the page again and offers the trial.
    const second = reply('A different angle.', ['web-1']);
    await draftMessage({ opportunity: { ...web, touches: 1 }, work, task: {}, model: second });
    expect(JSON.parse(second.run.mock.calls[0][1].user).touchPlan).toBe(reviewFollowupAngle);
    expect(reviewFollowupAngle).toMatch(/different angle/);
  });

  it('gives a nursing home an email in a nursing home\'s own words, with no market report, and never withholds the free county report from it (owner decisions 2026-11-16, 2026-11-17 and 2026-11-19)', async () => {
    const home = { ...opportunity, name: 'Sunrise Nursing & Rehabilitation Center',
      evidence: [{ id: 'web-1', source_url: 'https://sunrise.example', observed_at: new Date().toISOString(), confidence: 'medium', claim: 'Sunrise is a 120-bed nursing home in Riverton County.' }] };
    // A first email asks for one thing (the Nov 24 measurement): for a nursing home, the trial below the opening, so the opening asks no question.
    const opening = 'CareMetric Intel shows an admissions team which hospitals its county\'s residents use.\n\nIt also plans who your team visits each week.';
    const model = reply(opening, ['web-1']);
    const draft = await draftMessage({ opportunity: home, work, task: {}, model });
    expect(draft).toMatchObject({ modelGenerated: true });
    const input = JSON.parse(model.run.mock.calls[0][1].user);
    // The writer writes the opening; the email adds what Intel does for a nursing home, and the trial.
    expect(input.touchPlan).toBe(nursingHomeAngles[0]);
    expect(input.touchPlan).toContain('Never mention a market report, home health or hospice agencies, or how any of them rank.');
    expect(draft.body.startsWith(`${opening}\n\nWhat CareMetric Intel does for your nursing home, every day\n`)).toBe(true);
    expect(draft.body).toContain('1. Finds your hospital sources');
    expect(draft.body).toMatch(/Try CareMetric Intel free for 30 days on one county, with your own team\..*\nhttps:\/\/www\.caremetricintel\.com\/\?utm_source=caremetric&utm_medium=email&utm_campaign=growth-intel-touch1/);
    expect(draft.body).not.toMatch(/market report|home health agenc|hospices? in your/i);
    // Intel ranks nursing homes too (since 2026-11-17), so a nursing home reads about its own competitors, ranked.
    expect(draft.body).toContain('Every nursing home in your territory, ranked by Medicare share');
    expect(draft.arms.form).toBeUndefined();
    expect(await draftMessage({ opportunity: home, work, task: {}, model: reply(`${opening}\n\nAre your hospital relationships bringing the admissions you need?`, ['web-1']) })).toBeNull();
    // An opening that carries a link, or offers the trial itself, is not the opening: the email adds both.
    expect(await draftMessage({ opportunity: home, work, task: {}, model: reply(`${opening}\n\nhttps://www.caremetricintel.com/`, ['web-1']) })).toBeNull();
    expect(input.organization).toMatchObject({ name: 'Sunrise Nursing & Rehabilitation Center', setting: 'nursing home' });
    // Intel's free county report serves every kind of organization (2026-11-19): it is among a nursing home's pages like any other
    // organization's. The retired market review is offered to nobody.
    const offered = input.links.map(item => item.url);
    expect(offered).toContain('https://www.caremetricintel.com/county-report');
    expect(offered).not.toContain('https://www.caremetricintel.com/market-review');
    // The first email's opening carries no link at all, the county report's included: the email's sections follow it.
    expect(await draftMessage({ opportunity: home, work, task: {}, model: reply(`${opening}\n\nhttps://www.caremetricintel.com/county-report`, ['web-1']) })).toBeNull();
    const linked = reply('Get your free market report:\nhttps://www.caremetricintel.com/market-review', ['web-1']);
    expect(await draftMessage({ opportunity: home, work, task: {}, model: linked })).toBeNull();
    expect(draftProblem({ subject: 'Your market', body: 'See it:\nhttps://www.caremetricintel.com/market-review', citations: ['web-1'], needsHuman: false },
      { product: 'caremetric-intel', sources: home.evidence, outreach: true })).toBe('link');
    expect(draftProblem({ subject: 'Your county', body: 'See it:\nhttps://www.caremetricintel.com/county-report', citations: ['web-1'], needsHuman: false },
      { product: 'caremetric-intel', sources: home.evidence, outreach: true, organization: home.name })).toBeNull();
  });
});


it('renders signed report links in actual outgoing HTML without widening the draft allowlist', async () => {
  const reports = reportLinks({ key });
  const link = reports.linkFor({ id: 'o1', product: 'caremetric-intel', evidence: [roster()] });
  const render = (url, product = 'caremetric-intel', verifier = reports) => growthEmail({ product, subject: 'Report', body: `Your report:\n${url}`, reports: verifier,
    postalAddress: '', unsubscribeUrl: 'https://hub.example/u/test' }).html;
  expect(render(link.url)).toContain(`href="${link.url}"`);
  for (const url of [link.url + '?next=https://evil.example', link.url + '#fragment', link.url.replace('www.caremetricintel.com', 'evil.example'),
    link.url.replace('https:', 'http:'), link.url.replace('/report/', '/report/../'), link.url.slice(0, -4) + 'AAAA',
    'https://www.caremetricintel.com/report/arbitrary',
    `https://www.caremetricintel.com/report/${reportToken({ ccn: '397001', expires: 1 }, key)}`]) {
    expect(render(url)).not.toContain(`href="${url.replaceAll('&', '&amp;')}"`);
  }
  expect(render(link.url, 'carebase')).not.toContain(`href="${link.url}"`);
  expect(render(link.url, 'caremetric-intel', reportLinks())).not.toContain(`href="${link.url}"`);
  const mail = { configured: true, send: vi.fn(async () => ({ delivery: 'sent', id: 'sent' })) };
  const growth = { configured: () => true, reports, unsubscribeToken: () => 'u', store: {
    claim: vi.fn(async () => ({ send: true, product: 'caremetric-intel', subject: 'Report', body: link.url, workId: 'w', id: 'm', to: 'test@example.org' })), finish: vi.fn(),
  } };
  await growthExecutors({ growth, mail, publicOrigin: 'https://hub.example', postalAddress: '' })['growth.message']({ input: { messageId: 'm' }, id: 'a' });
  expect(mail.send.mock.calls[0][0].html).toContain(`href="${link.url}"`);
});
