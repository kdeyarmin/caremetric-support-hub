import { describe, expect, it, vi } from 'vitest';
import { checkDates, defaultTemplate, excludedCounties, ownerSequences, parseCsv, preparePeople, readSendList, sequenceHandlers, sequenceLinkDays, taggedUrl, templates } from './owner-sequence.mjs';
import { reportLinks, reportToken } from './report-link.mjs';
import { callsDataPublic, foundersAgency } from './draft.mjs';

const copy = templates[defaultTemplate];
const person = { ref: 'pa-b1-01', firstName: 'Jane', agency: 'Valley Home Health', county: 'Erie', reportUrl: 'https://www.caremetricintel.com/report/abc.def/view' };
const signature = 'Kevin Deyarmin\nCareMetric Healthcare Advisors\n117 Jennings Rd, South Fork, PA 15956\n\nNot relevant? Reply "no thanks" and I won\'t write again.';

describe('the owner\'s copy', () => {
  it('is the handoff\'s words, with blank lines between paragraphs and nothing else', () => {
    const [one, two, three] = copy.render(person, { campaign: 'pa-cold-email' });
    expect(one.subject).toBe('Valley Home Health in Erie County');
    expect(one.body).toBe(`Hi Jane,

I've managed a home health and hospice company in western Pennsylvania for 17 years. Finding referral sources, keeping them and watching competitors is most of the job, so I built CareMetric Intel to put that work in one place.

I ran Valley Home Health through it. Your report shows where you stand in Erie County, your largest competitors there, the hospitals the county's residents use most and your CMS ratings:
https://www.caremetricintel.com/report/abc.def/view

There's nothing to sign up for to read it.

${signature}`);
    expect(two.subject).toBe('When a referral source goes quiet');
    expect(two.body).toBe(`Hi Jane,

When a physician who used to refer stops sending patients, how soon does your team find out?

Intel keeps each referral source's visits and referrals in one record, and its weekly email flags any source that starts sending fewer referrals, so you know who needs a visit.

There's a 74-second walkthrough on our home page:
https://www.caremetricintel.com/?utm_source=caremetric&utm_medium=email&utm_campaign=pa-cold-email&utm_content=email-2&utm_term=pa-b1-01

${signature}`);
    expect(three.subject).toBe('Last note on Erie County');
    expect(three.body).toBe(`Hi Jane,

Last note from me.

Intel also ranks agencies by share in each county, and alerts you when a competitor's star rating, owner or service area changes.

You can try it on Erie County free for 30 days, with no card:
https://www.caremetricintel.com/login?signup=true&utm_source=caremetric&utm_medium=email&utm_campaign=pa-cold-email&utm_content=email-3&utm_term=pa-b1-01

If you have a question first, reply here and I'll answer in writing.

${signature}`);
  });

  it('offers the free county report when the agency has no report of its own, and greets "Hi there" without a first name', () => {
    const [one] = copy.render({ ...person, firstName: null, reportUrl: null }, { campaign: 'pa-cold-email' });
    expect(one.subject).toBe('Which hospitals Erie County residents use most');
    expect(one.body).toBe(`Hi there,

I've managed a home health and hospice company in western Pennsylvania for 17 years, and I built CareMetric Intel for that work.

Do you know which hospitals Erie County's residents use most?

The free county report answers that. It also covers the county's older population and Medicare enrollment, and the home health agencies, hospices and nursing homes located there. It arrives by email as a PDF:
https://www.caremetricintel.com/county-report?utm_source=caremetric&utm_medium=email&utm_campaign=pa-cold-email&utm_content=email-1&utm_term=pa-b1-01

Intel is the tool behind it. It keeps that research and your marketers' accounts and visits in one place.

${signature}`);
    for (const message of copy.render({ ...person, firstName: null }, { campaign: 'pa-cold-email' })) expect(message.body.startsWith('Hi there,\n\n')).toBe(true);
  });

  it('never has the founder own an agency, never calls the data public, and adds no price, sale or demo', () => {
    for (const reportUrl of [person.reportUrl, null]) {
      for (const message of copy.render({ ...person, reportUrl }, { campaign: 'pa-cold-email' })) {
        const words = `${message.subject}\n${message.body}`;
        expect(words).not.toMatch(foundersAgency);
        expect(callsDataPublic('caremetric-intel', words)).toBe(false);
        expect(words).not.toMatch(/\$|%|founders sale|discount|demo|call me|meeting|<[a-z]/i);
        expect(message.subject).not.toMatch(/[\r\n]/);
        expect(message.subject.length).toBeLessThanOrEqual(150);
      }
    }
    expect(copy.fromName).toBe('Kevin Deyarmin');
    expect(taggedUrl('https://www.caremetricintel.com/', { campaign: 'c', content: 'email-2', ref: 'a b' })).toBe(
      'https://www.caremetricintel.com/?utm_source=caremetric&utm_medium=email&utm_campaign=c&utm_content=email-2&utm_term=a%20b');
  });
});

describe('the send list', () => {
  const header = 'ref,first_name,email,agency_display,agency_name_for_matching,city,county,state,setting,website';
  it('reads the handoff\'s columns, quoted fields and a county written with "County"', () => {
    const csv = `${header}\r\npa-b1-01,Jane,Jane@ValleyHH.com,Valley Home Health,"VALLEY HOME HEALTH, LLC",Erie,Erie County,PA,hha,https://www.valleyhh.com/\r\npa-b1-03,,info@ridgehospice.org,Ridge Hospice,Ridge Hospice,Altoona,Allegheny,Pennsylvania,Hospice,\r\n`;
    const { people, problems } = readSendList(csv);
    expect(problems).toEqual([]);
    expect(people).toEqual([
      { ref: 'pa-b1-01', email: 'jane@valleyhh.com', firstName: 'Jane', agency: 'Valley Home Health', matchName: 'VALLEY HOME HEALTH, LLC', city: 'Erie', county: 'Erie', setting: 'hha', domain: 'valleyhh.com', ccn: null },
      { ref: 'pa-b1-03', email: 'info@ridgehospice.org', firstName: null, agency: 'Ridge Hospice', matchName: 'Ridge Hospice', city: 'Altoona', county: 'Allegheny', setting: 'hospice', domain: 'ridgehospice.org', ccn: null },
    ]);
  });

  it('leaves out Cambria County and the seven counties bordering it, another state, bad fields and repeats', () => {
    expect(excludedCounties).toEqual(['Cambria', 'Clearfield', 'Centre', 'Blair', 'Bedford', 'Somerset', 'Westmoreland', 'Indiana']);
    const rows = [
      'r1,A,a@one.com,One,One,Ebensburg,Cambria,PA,hha,',
      'r2,B,b@two.com,Two,Two,Indiana,indiana county,PA,hospice,',
      'r3,C,c@three.com,Three,Three,Greensburg,Westmoreland,PA,hha,',
      'r4,D,d@four.com,Four,Four,Akron,Summit,OH,hha,',
      'r5,E,not-an-email,Five,Five,Erie,Erie,PA,hha,',
      'r6,F,f@six.com,Six,Six,Erie,Erie,PA,nursing home,',
      'r7,G,g@seven.com,Seven,Seven,Erie,Erie,PA,hha,',
      'r7,H,h@eight.com,Eight,Eight,Erie,Erie,PA,hha,',
      'r9,I,g@seven.com,Nine,Nine,Erie,Erie,PA,hha,',
      'r10,J,j@gmail.com,Ten,Ten,Erie,Erie,PA,hha,',
    ];
    const { people, problems } = readSendList(`${header}\n${rows.join('\n')}`);
    expect(problems.map(problem => `${problem.ref}:${problem.reason}`)).toEqual(['r1:home_area', 'r2:home_area', 'r3:home_area', 'r4:state', 'r5:email',
      'r6:setting', 'r7:duplicate_ref', 'r9:duplicate_email']);
    expect(people.map(row => row.ref)).toEqual(['r7', 'r10']);
    // A free mail service's domain says nothing about the agency.
    expect(people[1].domain).toBeNull();
    expect(readSendList('ref,email\nx,y@z.com').problems[0].reason).toBe('missing_columns:agency,county,setting');
  });

  it('parses quoted commas, doubled quotes and line breaks inside quotes', () => {
    expect(parseCsv('a,"b, c","say ""hi""","two\nlines"\n')).toEqual([['a', 'b, c', 'say "hi"', 'two\nlines']]);
    expect(() => parseCsv('a,"b')).toThrow(/unclosed/);
  });

  it('takes weekdays from today on, in order', () => {
    expect(checkDates(['2026-12-01', '2026-12-04', '2026-12-09'], '2026-11-27')).toBeNull();
    expect(checkDates(['2026-12-05'], '2026-11-27')).toBe('weekday');
    expect(checkDates(['2026-12-04', '2026-12-01'], '2026-11-27')).toBe('order');
    expect(checkDates(['2026-11-26'], '2026-11-27')).toBe('order');
    expect(checkDates(['2026-02-30'], '2026-01-01')).toBe('weekday');
    expect(checkDates([], '2026-11-27')).toBe('dates');
  });
});

describe('preparing people', () => {
  const secret = 'x'.repeat(32);
  const base = { email: 'jane@valleyhh.com', firstName: 'Jane', matchName: 'Valley Home Health', city: 'Erie', domain: 'valleyhh.com', ccn: null };
  const people = [
    { ...base, ref: 'pa-b1-01', agency: 'Valley Home Health', county: 'Erie', setting: 'hha' },
    { ...base, ref: 'pa-b1-02', email: 'b@ridge.org', domain: 'ridge.org', agency: 'Ridge Hospice', county: 'Crawford', setting: 'hospice' },
    { ...base, ref: 'pa-b1-03', email: 'c@lake.org', domain: 'lake.org', agency: 'Lake Home Care', county: 'Erie', setting: 'hha' },
    { ...base, ref: 'pa-b1-04', email: 'd@hill.org', domain: 'hill.org', agency: 'Hill Home Health', county: 'Allegheny', setting: 'hha' },
  ];
  const agency = setting => ({ ccn: 'X', setting, city: null, state: 'PA' });
  function harness({ opens = () => true } = {}) {
    const feed = {
      configured: true, paceMs: 0,
      agencyMatch: vi.fn(async () => ({ matches: [
        { key: 'pa-b1-01', ccn: '397001', matched_by: 'name_place', reason: null, agency: agency('home_health') },
        // Matched to the other setting: not taken.
        { key: 'pa-b1-02', ccn: '391501', matched_by: 'name_place', reason: null, agency: agency('home_health') },
        { key: 'pa-b1-03', ccn: null, matched_by: null, reason: 'no_match', agency: null },
        { key: 'pa-b1-04', ccn: '397004', matched_by: 'phone', reason: null, agency: agency('home_health') },
      ] })),
      agencyBrief: vi.fn(async ({ ccn }) => ({ found: true, brief: { county: ccn === '397004' ? { fips: '42111', name: 'Somerset', state: 'PA' } : { fips: '42049', name: 'Erie County', state: 'PA' } } })),
    };
    const requested = [];
    const fetchImpl = vi.fn(async url => { requested.push(url); return opens(url)
      ? new Response('%PDF', { status: 200, headers: { 'content-type': 'application/pdf', link: `<${new URL(url).pathname}/view>; rel="alternate"; type="text/html"` } })
      : new Response('no', { status: 404 }); });
    const reports = reportLinks({ key: secret, now: () => Date.UTC(2026, 10, 27, 15), fetchImpl });
    return { feed, reports, requested };
  }

  it('signs a 90-day link with the row\'s reference, checks it unreferenced, and corrects the county from the report', async () => {
    const { feed, reports, requested } = harness();
    const result = await preparePeople(people, { feed, reports, template: defaultTemplate, campaign: 'pa-cold-email', sendDates: ['2026-12-01', '2026-12-04', '2026-12-09'], wait: async () => {} });
    expect(feed.agencyMatch).toHaveBeenCalledOnce();
    expect(feed.agencyMatch.mock.calls[0][0].candidates[0]).toEqual({ key: 'pa-b1-01', name: 'Valley Home Health', state: 'PA', city: 'Erie', domain: 'valleyhh.com' });
    // A report in Somerset County (the owner's home area) leaves the person out, whatever the list said.
    expect(result.problems).toEqual([{ row: null, ref: 'pa-b1-04', agency: 'Hill Home Health', reason: 'home_area' }]);
    const [valley, ridge, lake] = result.people;
    const expires = Math.floor(Date.UTC(2026, 10, 27, 15) / 1000) + sequenceLinkDays * 86_400;
    expect(valley.reportUrl).toBe(`https://www.caremetricintel.com/report/${reportToken({ ccn: '397001', setting: 'hha', expires, ref: 'pa-b1-01' }, secret)}/view`);
    // The check never carries the reference, so Intel does not count it as an open.
    for (const url of requested) expect(JSON.parse(Buffer.from(new URL(url).pathname.split('/')[2].split('.')[0], 'base64url').toString())).not.toHaveProperty('r');
    expect(valley.county).toBe('Erie');
    expect(valley.messages.map(message => [message.step, message.sendOn])).toEqual([[1, '2026-12-01'], [2, '2026-12-04'], [3, '2026-12-09']]);
    expect(valley.messages[0].body).toContain(valley.reportUrl);
    expect(ridge).toMatchObject({ ccn: null, reportUrl: null, notes: { noMatch: 'other_setting' } });
    expect(ridge.messages[0].subject).toBe('Which hospitals Crawford County residents use most');
    expect(lake).toMatchObject({ ccn: null, reportUrl: null, notes: { noMatch: 'no_match' } });
  });

  it('uses the report\'s county in every email when it differs from the list', async () => {
    const { feed, reports } = harness();
    const result = await preparePeople([{ ...people[0], county: 'Crawford' }], { feed, reports, template: defaultTemplate, campaign: 'pa-cold-email', sendDates: ['2026-12-01', '2026-12-04', '2026-12-09'], wait: async () => {} });
    const [one] = result.people;
    expect(one).toMatchObject({ county: 'Erie', notes: { listCounty: 'Crawford' } });
    expect(one.messages.map(message => message.subject)).toEqual(['Valley Home Health in Erie County', 'When a referral source goes quiet', 'Last note on Erie County']);
  });

  it('sends the fallback email when Intel has no report for the agency', async () => {
    const { feed, reports } = harness({ opens: () => false });
    const result = await preparePeople([people[0]], { feed, reports, template: defaultTemplate, campaign: 'pa-cold-email', sendDates: ['2026-12-01', '2026-12-04', '2026-12-09'], wait: async () => {} });
    expect(result.people[0]).toMatchObject({ ccn: '397001', reportUrl: null, notes: { noReport: true } });
    expect(result.people[0].messages[0].subject).toBe('Which hospitals Erie County residents use most');
  });
});

describe('sending', () => {
  const claimed = { send: true, id: '11111111-1111-4111-8111-111111111111', to: 'jane@valleyhh.com', subject: 'S', body: 'Hi Jane,\n\nWords.', step: 1,
    recipientId: '22222222-2222-4222-8222-222222222222', sequenceId: '33333333-3333-4333-8333-333333333333', sender: { fromName: 'Kevin Deyarmin' } };
  const token = key => `t-${key}`; const hash = value => `h-${value}`;
  function service({ claim = claimed, delivery = 'sent', review = { stopped: [], opened: [] }, enabled = true } = {}) {
    const store = { review: vi.fn(async () => review), claim: vi.fn(async () => ({ ...claim, unsubscribeHash: hash(token(`owner-sequence:${claim.recipientId}`)) })), finish: vi.fn(async () => true) };
    const mail = { configured: true, send: vi.fn(async () => ({ delivery, id: delivery === 'sent' ? 'sg-1' : null })) };
    const notifier = { send: vi.fn(async () => []) };
    const sequences = ownerSequences({ store, features: new Set(['platform.agents.owner-sequences.v1']), enabled, mail, publicOrigin: 'https://hub.example.org/', unsubscribeToken: token, hash });
    return { store, mail, notifier, sequences };
  }

  it('sends the approved words as plain text in the owner\'s name, with the one-click unsubscribe and its own reference', async () => {
    const { store, mail, notifier, sequences } = service();
    const out = await sequenceHandlers({ sequences, notifier })['growth.sequences']({ agent: { autonomy: 'propose' }, agentKey: 'marketing_manager', id: 't1' });
    expect(out.result).toMatchObject({ sent: 1, status: 'accepted' });
    expect(mail.send).toHaveBeenCalledWith({ to: 'jane@valleyhh.com', subject: 'S', text: 'Hi Jane,\n\nWords.', html: null,
      unsubscribeUrl: 'https://hub.example.org/api/growth/preferences/t-owner-sequence:22222222-2222-4222-8222-222222222222', fromName: 'Kevin Deyarmin',
      customArgs: { owner_sequence_message_id: claimed.id } });
    expect(store.finish).toHaveBeenCalledWith(claimed.id, 'accepted', 'sg-1');
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it('holds everything while the setting is off or the agent only observes, and tells the owner when the mail service refuses', async () => {
    expect((await service({ enabled: false }).sequences.run({})).result).toEqual({ skipped: 'off' });
    expect((await service().sequences.run({ agent: { autonomy: 'observe' } })).result).toEqual({ skipped: 'observe_only' });
    const { store, notifier, sequences } = service({ delivery: 'failed' });
    expect((await sequences.run({ agent: { autonomy: 'act' } }, { notifier })).result).toMatchObject({ sent: 0, status: 'failed' });
    expect(store.finish).toHaveBeenCalledWith(claimed.id, 'failed', null);
    expect(notifier.send.mock.calls[0][0]).toMatchObject({ severity: 'warning', subject: 'An email in your sequence was not sent (step 1)' });
  });

  it('tells the owner about each reply, opt-out and first open before sending', async () => {
    const review = { stopped: [{ id: 'r1', sequence: 'Batch 1', ref: 'pa-b1-01', agency: 'Valley Home Health', reason: 'replied', at: '2026-12-01T16:00:00Z', sent: 1 },
      { id: 'r2', sequence: 'Batch 1', ref: 'pa-b1-02', agency: 'Ridge Hospice', reason: 'opted_out', at: '2026-12-01T17:00:00Z', sent: 1 }],
    opened: [{ id: 'r3', sequence: 'Batch 1', ref: 'pa-b1-03', agency: 'Lake Home Care', at: '2026-12-01T18:00:00Z' }] };
    const { notifier, sequences } = service({ review, claim: { send: false, status: 'none_due', recipientId: 'x' } });
    const out = await sequences.run({ agent: { autonomy: 'propose' } }, { notifier });
    expect(out.result).toMatchObject({ stopped: 2, opened: 1, sent: 0, status: 'none_due' });
    const subjects = notifier.send.mock.calls.map(call => call[0].subject);
    expect(subjects).toEqual(['Valley Home Health replied to your email (pa-b1-01)', 'Ridge Hospice said no thanks (pa-b1-02)', 'Lake Home Care opened its market report (pa-b1-03)']);
    expect(notifier.send.mock.calls[0][0].body).toContain('nothing is sent back unless you send it');
    expect(notifier.send.mock.calls[1][0].body).toContain('do-not-contact list for good');
  });

  it('refuses to send when the signing key changed since the sequence was prepared', async () => {
    const { store, mail, notifier, sequences } = service();
    store.claim.mockResolvedValueOnce({ ...claimed, unsubscribeHash: 'h-other' });
    expect((await sequences.run({ agent: { autonomy: 'act' } }, { notifier })).result).toMatchObject({ status: 'unsubscribe_key_changed' });
    expect(mail.send).not.toHaveBeenCalled();
    expect(store.finish).toHaveBeenCalledWith(claimed.id, 'failed', null);
  });

  it('registers its task only once the database declares the feature', () => {
    expect(sequenceHandlers({ sequences: ownerSequences({ store: {}, features: new Set() }) })).toEqual({});
    expect(Object.keys(sequenceHandlers({ sequences: ownerSequences({ store: {}, features: ['platform.agents.owner-sequences.v1'] }) }))).toEqual(['growth.sequences']);
  });
});

describe('requests an operator queued for the owner', () => {
  const header = 'ref,first_name,email,agency_display,agency_name_for_matching,city,county,setting';
  const csv = `${header}\npa-b1-01,Mario,mario@traditional.example,Traditional Home Health Care,Traditional Home Health Care,Dunmore,Lackawanna,hha\npa-b1-05,Mary,mtobin@gateway.example,Gateway Hospice,Gateway Hospice,Pittsburgh,Allegheny,hospice\n`;
  const payload = { name: 'Pennsylvania cold email, batch 1', csv, campaign: 'pa-cold-email', sendDates: ['2026-12-01', '2026-12-04', '2026-12-09'] };
  function service({ request = { id: 'req-1', payload, approve: true }, check = { 'pa-b1-05': 'growth_contacted' }, finish = { status: 'prepared', approved: true } } = {}) {
    const store = { requestNext: vi.fn(async () => request), requestCheck: vi.fn(async () => check), requestFinish: vi.fn(async () => finish),
      review: vi.fn(async () => ({ stopped: [], opened: [] })), claim: vi.fn(async () => ({ send: false, status: 'none_due' })) };
    const notifier = { send: vi.fn(async () => []) };
    const sequences = ownerSequences({ store, features: new Set(['platform.agents.owner-sequences.v1', 'platform.agents.owner-sequence-requests.v1']), enabled: true,
      mail: { configured: true, send: vi.fn() }, feed: null, reports: null, unsubscribeToken: key => `t-${key}`, hash: value => `h-${value}`, now: () => new Date('2026-11-27T20:00:00Z') });
    return { store, notifier, sequences };
  }

  it('prepares the queued send list as Growth does, through the server\'s own check, and tells the owner who was left out', async () => {
    const { store, notifier, sequences } = service();
    const out = await sequences.run({ agent: { autonomy: 'act' }, agentKey: 'marketing_manager', id: 't1' }, { notifier });
    expect(out.result.request).toEqual({ request: 'req-1', status: 'prepared', approved: true });
    expect(store.requestCheck).toHaveBeenCalledWith('req-1', [{ ref: 'pa-b1-01', email: 'mario@traditional.example', domain: 'traditional.example', ccn: null },
      { ref: 'pa-b1-05', email: 'mtobin@gateway.example', domain: 'gateway.example', ccn: null }]);
    const [id, record, problems, error] = store.requestFinish.mock.calls[0];
    expect([id, error]).toEqual(['req-1', null]);
    expect(problems).toEqual([{ row: null, ref: 'pa-b1-05', agency: 'Gateway Hospice', reason: 'growth_contacted' }]);
    expect(record.people.map(p => p.ref)).toEqual(['pa-b1-01']);
    expect(record).toMatchObject({ name: 'Pennsylvania cold email, batch 1', template: 'intel-pa-cold-2026-11', campaign: 'pa-cold-email', dailyLimit: 8, sender: { fromName: 'Kevin Deyarmin' } });
    // No feed: the agency gets the county report email; the unsubscribe hash is the server's signing of the person's own key.
    expect(record.people[0].messages[0].subject).toBe('Which hospitals Lackawanna County residents use most');
    expect(record.people[0].unsubscribeHash).toBe(`h-t-owner-sequence:${record.people[0].id}`);
    const told = notifier.send.mock.calls[0][0];
    expect(told.subject).toBe('"Pennsylvania cold email, batch 1" is approved and scheduled');
    expect(told.body).toContain('2026-12-01, 2026-12-04, 2026-12-09');
    expect(told.body).toContain('pa-b1-05 · Gateway Hospice: the Marketing Manager emailed this agency in the last 90 days');
  });

  it('fails a request it cannot prepare and says why, and does nothing without the feature', async () => {
    const bad = service({ request: { id: 'req-2', payload: { ...payload, sendDates: ['2026-12-05', '2026-12-08', '2026-12-09'] }, approve: true }, finish: { status: 'failed', error: 'weekday' } });
    const out = await bad.sequences.run({ agent: { autonomy: 'act' } }, { notifier: bad.notifier });
    expect(out.result.request).toEqual({ request: 'req-2', status: 'failed', approved: false });
    expect(bad.store.requestFinish).toHaveBeenCalledWith('req-2', null, [], 'weekday');
    expect(bad.notifier.send.mock.calls[0][0]).toMatchObject({ severity: 'warning', subject: '"Pennsylvania cold email, batch 1" could not be prepared' });
    const off = service();
    const without = ownerSequences({ store: off.store, features: new Set(['platform.agents.owner-sequences.v1']), enabled: true, mail: { configured: true, send: vi.fn() },
      unsubscribeToken: key => key, hash: value => value });
    expect((await without.run({ agent: { autonomy: 'act' } })).result.request).toBeUndefined();
    expect(off.store.requestNext).not.toHaveBeenCalled();
  });
});
