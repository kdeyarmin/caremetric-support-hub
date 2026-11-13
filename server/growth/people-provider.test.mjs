import { describe, expect, it, vi } from 'vitest';
import { apolloPeople, decisionTitles, peopleProvider } from './people-provider.mjs';

const answer = (body, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('Apollo people', () => {
  it('searches a business\'s domain for deciding titles in the query string, free, and keeps only ids, first names and titles', async () => {
    const fetchImpl = answer({ people: [{ id: 'p1', first_name: 'Jane', last_name_obfuscated: 'D***', title: 'Administrator', email: 'should-not-be-read@x.org' }, { id: 'bad id!', first_name: 'X' }, { id: 'p3' }] });
    const found = await apolloPeople({ apiKey: 'apollo-key-1234', fetchImpl }).search({ domain: 'valleyhospice.org' });
    const [url, init] = fetchImpl.mock.calls[0];
    const params = new URL(url).searchParams;
    expect(new URL(url).origin + new URL(url).pathname).toBe('https://api.apollo.io/api/v1/mixed_people/api_search');
    expect(params.getAll('q_organization_domains_list[]')).toEqual(['valleyhospice.org']);
    expect(params.getAll('person_titles[]')).toEqual([...decisionTitles]);
    expect(params.get('per_page')).toBe('10');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(init.headers['x-api-key']).toBe('apollo-key-1234');
    expect(found).toEqual([{ ref: 'p1', firstName: 'Jane', lastName: 'D***', title: 'Administrator' }]);
  });

  it('keeps only a verified work address, and never asks for personal addresses or phones', async () => {
    const fetchImpl = answer({ person: { email: 'Jane@ValleyHospice.org', email_status: 'verified', name: 'Jane Doe', title: 'Administrator' } });
    const people = apolloPeople({ apiKey: 'apollo-key-1234', fetchImpl });
    expect(await people.enrich({ ref: 'p1', domain: 'valleyhospice.org' })).toEqual({ email: 'jane@valleyhospice.org', name: 'Jane Doe', title: 'Administrator' });
    const params = new URL(fetchImpl.mock.calls[0][0]).searchParams;
    expect([params.get('id'), params.get('reveal_personal_emails'), params.get('reveal_phone_number')]).toEqual(['p1', 'false', 'false']);
    expect(await apolloPeople({ apiKey: 'apollo-key-1234', fetchImpl: answer({ person: { email: 'jane@valleyhospice.org', email_status: 'guessed' } }) }).enrich({ ref: 'p1' })).toBeNull();
    expect(await apolloPeople({ apiKey: 'apollo-key-1234', fetchImpl: answer({ person: null }) }).enrich({ ref: 'p1' })).toBeNull();
  });

  it('maps failures to codes and is not configured without a key or the owner\'s choice', async () => {
    await expect(apolloPeople({ apiKey: 'apollo-key-1234', fetchImpl: answer({}, 401) }).search({ domain: 'x.org' })).rejects.toMatchObject({ code: 'people_not_permitted' });
    await expect(apolloPeople({ apiKey: 'apollo-key-1234', fetchImpl: answer({}, 429) }).search({ domain: 'x.org' })).rejects.toMatchObject({ code: 'people_rate_limited', transient: true });
    const unused = vi.fn();
    await expect(apolloPeople({ apiKey: '', fetchImpl: unused }).search({ domain: 'x.org' })).rejects.toMatchObject({ code: 'people_not_configured' });
    expect(unused).not.toHaveBeenCalled();
    expect(peopleProvider('none', { apolloKey: 'apollo-key-1234' })).toBeNull();
    expect(peopleProvider('apollo', { apolloKey: 'apollo-key-1234' })).toMatchObject({ provider: 'apollo', configured: true });
  });
});
