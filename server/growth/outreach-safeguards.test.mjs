import assert from 'node:assert/strict';
import { it } from 'vitest';
import { draftProblem } from './draft.mjs';
import { planOpportunity } from './policy.mjs';
import { chooseSite } from './roster.mjs';

const sources = [{ id: 'agency', claim: 'Your team serves 12 counties.' }];
function check(body, subject = 'Your counties') {
  return draftProblem({ body, subject, citations: ['agency'], needsHuman: false },
    { product: 'caremetric-intel', sources, outreach: true });
}

it('blocks a founder or product claim using the agency count in the subject or body', () => {
  for (const claim of ['WE cover 12 counties.', 'OUR data covers 12 counties.', 'The platform covers 12 counties.']) {
    assert.equal(check(claim), 'claim', claim);
    assert.equal(check('Your team serves 12 counties.', claim), 'claim', claim);
  }
  assert.equal(check('Your team serves 12 counties in the US.'), null);
});

it('waits for renewed verification and still permits only one re-ask', () => {
  const now = new Date('2026-11-13T12:00:00Z');
  const prospect = { product: 'caremetric-intel', stage: 'qualified', owner_agent: 'marketing_manager',
    next_at: now.toISOString(), touches: 3, memory: { reengagedAt: now.toISOString(), touchesBefore: 3 } };
  const plan = changes => planOpportunity({ ...prospect, ...changes }, now).map(work => work.kind);
  assert.deepEqual(plan({ verified_at: '2026-07-01T12:00:00Z' }), []);
  assert.deepEqual(plan({ verified_at: now.toISOString() }), ['outreach']);
  assert.deepEqual(plan({ verified_at: now.toISOString(), touches: 4 }), []);
  assert.deepEqual(plan({ verified_at: now.toISOString(), events: [{ kind: 'negative_reply' }] }), []);
});

it('rejects a wrong-state search result before ranking matching names or choosing a site', () => {
  const target = { name: 'Valley Hospice', city: 'Columbus', state: 'GA', setting: 'hospice' };
  const row = (domain, claim) => ({ domain, url: 'https://' + domain, name: 'Valley Hospice', claim });
  const right = row('valleyhospicega.org', 'Hospice in Columbus, Georgia.');
  for (const claim of ['Hospice in Columbus, Ohio.', 'Hospice in Columbus, OH.', 'OH 43215']) {
    const wrong = row('valleyhospice.org', claim);
    assert.equal(chooseSite(target, [wrong]), null, claim);
    assert.equal(chooseSite(target, [wrong, right])?.domain, right.domain, claim);
  }
  assert.ok(chooseSite(target, [row(right.domain, 'Serving Georgia and Alabama.')]));
  assert.ok(chooseSite({ ...target, city: 'Indiana', state: 'PA' }, [row(right.domain, 'Serving Indiana, PA.')]));
});
