import { describe, expect, it } from 'vitest';
import { conversationKinds, detailRows, digestKinds, followupAlert, kindList, kindWord, leadKinds, leadProduct, sourceWords, span, trialAlert } from './words.mjs';

describe('the words for a lead', () => {
  it('names every kind, one and many', () => {
    expect(leadKinds).toEqual(['demo_request', 'consultation', 'contact', 'trial_signup', 'newsletter', 'savings_model', 'county_report']);
    expect([...conversationKinds, ...digestKinds, 'trial_signup'].sort()).toEqual([...leadKinds].sort());
    expect(leadKinds.map(kind => kindWord(kind))).toEqual(['demo request', 'consultation request', 'contact request', 'trial sign-up', 'newsletter sign-up', 'savings model request', 'county report request']);
    expect(kindWord('demo_request', 2)).toBe('demo requests');
    expect(kindWord('mystery')).toBe('mystery');
  });

  it('lists kinds in the report\'s order and leaves out the ones with none', () => {
    expect(kindList({ newsletter: 2, demo_request: 1 })).toBe('1 demo request and 2 newsletter sign-ups');
    expect(kindList({ demo_request: 2, contact: 1, trial_signup: 3 })).toBe('2 demo requests, 1 contact request and 3 trial sign-ups');
    expect(kindList({ county_report: 1 })).toBe('1 county report request');
    expect(kindList({ demo_request: 0 })).toBe('');
    expect(kindList(null)).toBe('');
  });

  it('says how long in words, rounded down', () => {
    expect([0, 1, 45, 60, 95, 120, 179, 180, 1440, 2879, 2880, 10_000].map(span)).toEqual([
      '1 minute', '1 minute', '45 minutes', '1 hour', '1 hour 35 minutes', '2 hours', '2 hours 59 minutes', '3 hours', '24 hours', '47 hours', '2 days', '6 days',
    ]);
  });

  it('names the product by its registered slug, else by its website', () => {
    expect(leadProduct({ productSlug: 'carebase' })).toBe('CareBase');
    expect(leadProduct({ product: 'caremetric-intel' })).toBe('CareMetric Intel');
    expect(leadProduct({ source: 'intel' })).toBe('CareMetric Intel');
    expect(leadProduct({ source: 'advisors' })).toBe('Healthcare Advisors');
    expect(leadProduct({})).toBe('a CareMetric product');
  });

  it('says where a visitor came from in a few words', () => {
    expect(sourceWords({ source: 'google', medium: 'cpc', campaign: 'fall-launch', landingPath: '/pricing' })).toBe('google (cpc), campaign fall-launch, landing page /pricing');
    expect(sourceWords({ source: 'direct' })).toBe('a direct visit');
    expect(sourceWords(undefined)).toBe('a direct visit');
    expect(sourceWords({ source: 'x'.repeat(300) }).length).toBeLessThan(70);
  });

  it('shows at most six facts, the plan first, labelled the way the lead desk labels them', () => {
    expect(detailRows({ facilityCount: 3, plan: 'complete', hasEmr: true, state: 'PA' })).toEqual([['Plan', 'complete'], ['Facility count', '3'], ['Has emr', 'Yes'], ['State', 'PA']]);
    expect(detailRows({ a: '1', b: '2', c: '3', d: '4', e: '5', f: '6', g: '7' })).toHaveLength(6);
    expect(detailRows({ nested: { a: 1 }, list: [1] })).toEqual([]);
    expect(detailRows(null)).toEqual([]);
  });
});

describe('the trial alert', () => {
  const lead = { id: 'l1', kind: 'trial_signup', source: 'carebase', productSlug: 'carebase', organization: 'Sunrise Assisted Living Facility', receivedAt: '2026-11-03T14:05:00Z',
    details: { plan: 'complete', facilityCount: 2 }, attribution: { source: 'google', medium: 'cpc', campaign: null, landingPath: '/pricing' }, reference: null };

  it('names the organization, the product, the plan and where the visitor came from', () => {
    const alert = trialAlert(lead, { publicOrigin: 'https://hub.example.test/' });
    expect(alert.subject).toBe('New CareBase trial: Sunrise Assisted Living Facility');
    expect(alert.body).toBe('Sunrise Assisted Living Facility started a CareBase trial (received Nov 3, 9:05 AM Eastern).\n\n'
      + 'Product: CareBase. Plan: complete. Came from google (cpc), landing page /pricing.\n\n'
      + 'Any cold email to their business has stopped. The Account Manager drafts the welcome and trial check-ins (for your approval until you hand them over). Open Leads for their details.');
    expect(alert.blocks[1]).toEqual({ type: 'details', rows: [['Product', 'CareBase'], ['Plan', 'complete'], ['Facility count', '2'], ['Came from', 'google (cpc), landing page /pricing']] });
    expect(alert.blocks.at(-1)).toEqual({ type: 'button', label: 'Open Leads', url: 'https://hub.example.test/admin/leads' });
  });

  it('copes with a trial that names no organization or plan, and offers no link without an https address', () => {
    const alert = trialAlert({ kind: 'trial_signup', source: 'intel', details: {}, attribution: { source: 'direct' } }, { publicOrigin: 'http://localhost:8080' });
    expect(alert.subject).toBe('New CareMetric Intel trial');
    expect(alert.body).toContain('A new organization started a CareMetric Intel trial.');
    expect(alert.body).toContain('Came from a direct visit.');
    expect(alert.body).not.toContain('Plan:');
    expect(alert.blocks.some(block => block.type === 'button')).toBe(false);
  });

  it('clips a long organization name', () => {
    expect(trialAlert({ ...lead, organization: 'A'.repeat(150) }).subject.length).toBeLessThan(110);
  });
});

describe('the follow-up reminder', () => {
  it('names the reference, the kind, the product, the step and how long it has waited', () => {
    expect(followupAlert({ leadId: 'l1', kind: 'demo_request', product: 'carebase', reference: 'CM-1042', minutesWaiting: 95 }, 60)).toEqual({
      subject: 'Still unanswered after 1 hour: demo request CM-1042',
      body: 'A CareBase demo request (CM-1042) has waited 1 hour 35 minutes for a first reply.\n\n'
        + 'Open CM-1042 in Communications to answer it. If you have been in touch another way, set the lead\'s status on Leads and the reminders stop.\n\n'
        + 'Nothing has been sent to them.',
    });
    expect(followupAlert({ kind: 'consultation', product: 'advisors', reference: 'CM-7', minutesWaiting: 1500 }, 1440).subject).toBe('Still unanswered after 24 hours: consultation request CM-7');
  });
});
