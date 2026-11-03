import { describe, expect, it } from 'vitest';
import { assess, attentionReasons, cancelDate, cancellationDate, healthVersion, reasonWords, renewingSubscriptions, thresholds, weights } from './health.mjs';
import { account, iso, item, now, subscription } from './fixtures.mjs';

const rated = (over, at = now) => assess(account(over), at);
it('combines native activity and usage reports across products without losing an adoption decline',()=>{
 const result=rated({products:[{slug:'carebase',status:'active'},{slug:'caremetric-intel',status:'active'}],activity:[{app:'carebase',metric:'active_days',latest:7,baseline:7,latestAt:iso(-1),baselineAt:iso(-29)}],usage:[{app:'caremetric-intel',metric:'active_users',latest:0,baseline:10}]});
 expect(result.reasons).toContain('usage_stopped');expect(result.attention).toBe(true);
 expect(result.evidenceByProduct).toEqual({carebase:'fresh','caremetric-intel':'no_activity'});
});
it('uses the newest observation when native activity and usage both report the same metric',()=>{
 const result=rated({activity:[{app:'carebase',metric:'active_users',latest:10,baseline:10,latestAt:iso(-1),baselineAt:iso(-29)}],usage:[{app:'carebase',metric:'active_users',latest:0,baseline:10,latestAt:iso(-2)}]});
 expect(result.reasons).not.toContain('usage_stopped');expect(result.band).toBe('healthy');
});

describe('how an account is doing', () => {
  it('scores a quiet, paying account 100 and says nothing about it', () => {
    expect(rated({})).toEqual({ version: healthVersion, band: 'healthy', score: 100, penalty: 0, reasons: [], flags: [], attention: false, ageDays: 120, evidence: 'fresh', evidenceByProduct:{carebase:'fresh'} });
    expect(healthVersion).toBe('health.2');
  });

  it('gives an account under 14 days old no score, but still reports what is wrong', () => {
    const fresh = rated({ createdAt: iso(-5), subscriptions: [subscription({ created: iso(-5), status: 'past_due' })] });
    expect(fresh).toMatchObject({ band: 'new', score: null, reasons: ['past_due'], attention: true });
    expect(rated({ createdAt: iso(-13), subscriptions: [subscription({ created: iso(-13) })] }).band).toBe('new');
    expect(rated({ createdAt: iso(-15), subscriptions: [subscription({ created: iso(-15) })] }).band).toBe('healthy');
  });

  it('takes the account\'s age from when it started billing, or from the tenant when there is no subscription', () => {
    expect(rated({ createdAt: iso(-300), subscriptions: [subscription({ created: iso(-3) })] }).band).toBe('new');
    expect(rated({ createdAt: iso(-3), subscriptions: [subscription({ created: iso(-90) }), subscription({ created: iso(-2) })] })).toMatchObject({ band: 'healthy', ageDays: expect.closeTo(90, 0) });
    expect(rated({ createdAt: iso(-40), subscriptions: [] }).ageDays).toBeCloseTo(40, 0);
    expect(rated({ createdAt: 'not a date', subscriptions: [subscription({ created: undefined })] }).ageDays).toBeNull();
  });

  it('counts payment trouble once, by its largest signal, and lists every signal', () => {
    const trouble = rated({ subscriptions: [subscription({ status: 'past_due' })], invoices: { open: 2, overdue: 2, remainingCents: 9800 }, customer: { delinquent: true, hasEmail: true } });
    expect(trouble).toMatchObject({ reasons: ['past_due', 'invoice_overdue', 'delinquent'], penalty: weights.payment.past_due, score: 60, band: 'watch', attention: true });
    expect(rated({ subscriptions: [subscription({ status: 'unpaid' })] })).toMatchObject({ reasons: ['unpaid'], score: 50, band: 'watch' });
    expect(rated({ invoices: { overdue: 1 } })).toMatchObject({ reasons: ['invoice_overdue'], penalty: 25 });
    expect(rated({ customer: { delinquent: true, hasEmail: true } })).toMatchObject({ reasons: ['delinquent'], penalty: 20 });
  });

  it('flags a scheduled cancellation, whether Stripe says at period end or on a date still ahead', () => {
    expect(rated({ subscriptions: [subscription({ cancel_at_period_end: true })] })).toMatchObject({ reasons: ['cancel_scheduled'], attention: true, score: 65 });
    expect(rated({ subscriptions: [subscription({ cancel_at: iso(10) })] }).reasons).toEqual(['cancel_scheduled']);
    expect(rated({ subscriptions: [subscription({ cancel_at: iso(-10) })] }).reasons).toEqual([]);
    expect(rated({ subscriptions: [subscription({ status: 'canceled', cancel_at_period_end: true })] })).toMatchObject({ band: 'inactive', reasons: [] });
  });

  it('flags a trial that ends within a week, and neither a later one nor one long over', () => {
    const trial = days => rated({ subscriptions: [subscription({ status: 'trialing', trial_end: iso(days) })] }).reasons;
    expect(trial(3)).toEqual(['trial_ending']);
    expect(trial(7)).toEqual(['trial_ending']);
    expect(trial(8)).toEqual([]);
    expect(trial(-0.5)).toEqual(['trial_ending']);
    expect(trial(-3)).toEqual([]);
    expect(rated({ subscriptions: [subscription({ status: 'trialing', trial_end: null })] }).reasons).toEqual([]);
    expect(rated({ subscriptions: [subscription({ status: 'active', trial_end: iso(2) })] }).reasons).toEqual([]);
  });

  it('reports a closed account that still bills, a suspended one and a paused subscription, and skips a closed account with nothing live', () => {
    expect(rated({ status: 'closed' })).toMatchObject({ reasons: ['closed_but_billing'], attention: true, score: 70 });
    expect(rated({ status: 'closed', subscriptions: [subscription({ status: 'canceled' })] })).toMatchObject({ band: 'inactive', reasons: [] });
    expect(rated({ status: 'suspended' })).toMatchObject({ reasons: ['suspended'], attention: true });
    expect(rated({ subscriptions: [subscription({ status: 'paused' })] })).toMatchObject({ reasons: ['paused'], attention: false, score: 90 });
  });

  it('compares usage with the newest report at or before 28 days earlier, needing both a ratio and a real change', () => {
    const usage = (latest, baseline) => rated({ usage: [{ app: 'carebase', metric: 'active_users', latest, baseline }] });
    expect(usage(0, 12)).toMatchObject({ reasons: ['usage_stopped'], penalty: 25 });
    expect(usage(8, 12)).toMatchObject({ reasons: ['usage_dropped'], penalty: 15 });
    expect(usage(9, 12).reasons).toEqual(['usage_dropped']);
    expect(usage(10, 12).reasons).toEqual([]);
    expect(usage(2, 3).reasons).toEqual([]);
    expect(usage(1, 2).reasons).toEqual([]);
    expect(usage(0, 1).reasons).toEqual([]);
    expect(usage(12, null).reasons).toEqual([]);
    expect(usage(null, 12).reasons).toEqual([]);
    expect(usage(15, 12)).toMatchObject({ reasons: [], flags: ['usage_up'] });
    expect(usage(14, 12).flags).toEqual([]);
    expect(usage(3, 2).flags).toEqual([]);
    expect(usage(4, 2)).toMatchObject({ flags: ['usage_up'] });
    expect(rated({ usage: [{ latest: 20, baseline: 10 }], subscriptions: [subscription({ status: 'trialing' })] }).flags).toEqual([]);
  });

  it('counts open cases waiting on us, not the ones waiting on the customer', () => {
    const cases = over => rated({ cases: { waitingOnYou: 0, highOrUrgent: 0, waitingOnCustomer: 0, oldestOpenAt: null, ...over } });
    expect(cases({ waitingOnYou: 3 })).toMatchObject({ reasons: ['many_open_cases'], attention: false, score: 90 });
    expect(cases({ waitingOnYou: 2 }).reasons).toEqual([]);
    expect(cases({ waitingOnCustomer: 9 }).reasons).toEqual([]);
    expect(cases({ highOrUrgent: 1 })).toMatchObject({ reasons: ['urgent_case_waiting'], attention: true, score: 85 });
  });

  it('weighs a missing billing email more while Stripe\'s own emails are the only way to reach a past-due or trialing customer', () => {
    const noEmail = over => rated({ customer: { delinquent: false, hasEmail: false }, ...over });
    expect(noEmail({})).toMatchObject({ reasons: ['no_billing_email'], penalty: 5, attention: false });
    expect(noEmail({ subscriptions: [subscription({ status: 'past_due' })] })).toMatchObject({ reasons: ['past_due', 'no_billing_email'], penalty: 55 });
    expect(noEmail({ subscriptions: [subscription({ status: 'trialing', trial_end: iso(30) })] })).toMatchObject({ reasons: ['no_billing_email'], penalty: 15 });
    expect(rated({ customer: null }).reasons).toEqual([]);
  });

  it('flags annual and multi-month plans that renew within 30 days, and no other plan', () => {
    const renews = (over, days = 20) => rated({ subscriptions: [subscription({ current_period_end: iso(days), ...over })] }).flags;
    expect(renews({ items: [item({ interval: 'year' })] })).toEqual(['renewing_soon']);
    expect(renews({ items: [item({ interval: 'month', interval_count: 3 })] })).toEqual(['renewing_soon']);
    expect(renews({ items: [item({ interval: 'month', interval_count: 1 })] })).toEqual([]);
    expect(renews({ items: [item({ interval: 'year' })] }, 31)).toEqual([]);
    expect(renews({ items: [item({ interval: 'year' })] }, -2)).toEqual([]);
    expect(renews({ items: [item({ interval: 'year' })], cancel_at_period_end: true })).toEqual([]);
    // An explicit cancellation date at or before the period end means it stops instead of renewing; one after it renews once more first.
    expect(renews({ items: [item({ interval: 'year' })], cancel_at: iso(10) })).toEqual([]);
    expect(renews({ items: [item({ interval: 'year' })], cancel_at: iso(20) })).toEqual([]);
    expect(renews({ items: [item({ interval: 'year' })], cancel_at: iso(60) })).toEqual(['renewing_soon']);
    expect(renews({ items: [item({ interval: 'year' })], cancel_at: iso(-5) })).toEqual(['renewing_soon']);
    // The same account is cancelling, not renewing: never both.
    const both = rated({ subscriptions: [subscription({ current_period_end: iso(20), items: [item({ interval: 'year' })], cancel_at: iso(10) })] });
    expect(both.reasons).toContain('cancel_scheduled');
    expect(both.flags).not.toContain('renewing_soon');
    expect(renews({ items: [item({ interval: 'year' })], status: 'trialing' })).toEqual([]);
  });

  it('puts the score in a band, with 75 healthy, 50 watch and below that at risk', () => {
    expect(thresholds).toMatchObject({ healthy: 75, watch: 50 });
    const penalised = subscriptions => rated({ subscriptions });
    expect(penalised([subscription({ status: 'past_due', cancel_at_period_end: true })])).toMatchObject({ score: 25, band: 'at_risk', attention: true });
    expect(rated({ status: 'suspended', cases: { waitingOnYou: 3, highOrUrgent: 0 } })).toMatchObject({ score: 70, band: 'watch' });
    expect(rated({ cases: { waitingOnYou: 0, highOrUrgent: 1 }, customer: { hasEmail: false, delinquent: false } })).toMatchObject({ score: 80, band: 'healthy' });
    expect(rated({ status: 'suspended', customer: { hasEmail: false, delinquent: false }, cases: { waitingOnYou: 0, highOrUrgent: 1 } })).toMatchObject({ score: 60, band: 'watch' });
    expect(rated({ subscriptions: [subscription({ status: 'unpaid', cancel_at_period_end: true })] })).toMatchObject({ score: 15, band: 'at_risk' });
    const lowest = rated({
      status: 'closed', subscriptions: [subscription({ status: 'unpaid', cancel_at_period_end: true })], cases: { waitingOnYou: 5, highOrUrgent: 2 },
      usage: [{ latest: 0, baseline: 10 }], customer: { hasEmail: false, delinquent: true },
    });
    expect(lowest.score).toBe(0);
    expect(lowest.band).toBe('at_risk');
  });

  it('has no account with no live subscription, and does not fail on odd data', () => {
    expect(rated({ subscriptions: [] })).toMatchObject({ band: 'inactive', score: null, attention: false });
    expect(assess({ name: 'Bare', status: 'active' }, now)).toMatchObject({ band: 'inactive' });
    expect(() => rated({ subscriptions: [subscription({ trial_end: 'x', current_period_end: 'y', cancel_at: 'z', created: 'w' })], usage: [{ latest: 'a', baseline: 'b' }], invoices: null, cases: null })).not.toThrow();
  });

  it('words every reason it can give and keeps its tables closed', () => {
    for (const reason of [...Object.keys(weights.payment), 'cancel_scheduled', 'closed_but_billing', 'suspended', 'trial_ending', 'paused', 'usage_stopped', 'usage_dropped', 'urgent_case_waiting', 'many_open_cases', 'no_billing_email', 'renewing_soon', 'usage_up']) {
      expect(reasonWords[reason], reason).toMatch(/\w/);
    }
    for (const reason of attentionReasons) expect(reasonWords[reason], reason).toBeDefined();
    expect(Object.isFrozen(weights) && Object.isFrozen(thresholds) && Object.isFrozen(attentionReasons)).toBe(true);
  });
});

describe('which subscription and date raised a flag', () => {
  const at = new Date('2026-11-02T12:00:00Z');
  const days = count => new Date(at.getTime() + count * 86_400_000).toISOString();
  const sub = (over = {}) => ({ status: 'active', items: [{ interval: 'year', interval_count: 1, unit_amount: 100000, quantity: 1 }], current_period_end: days(20), created: days(-300), ...over });

  it('dates a cancellation by when it takes effect: the explicit date while it is ahead, else the end of the period', () => {
    expect(cancelDate(sub({ cancel_at: days(10) }), at.getTime())).toBe(Date.parse(days(10)));
    expect(cancelDate(sub({ cancel_at_period_end: true }), at.getTime())).toBe(Date.parse(days(20)));
    // A date that has passed is stale: it does not stand in for the period end, and a plan not set to cancel has no date.
    expect(cancelDate(sub({ cancel_at: days(-3), cancel_at_period_end: true }), at.getTime())).toBe(Date.parse(days(20)));
    expect(cancelDate(sub({ cancel_at: days(-3) }), at.getTime())).toBeNull();
    expect(cancelDate(sub(), at.getTime())).toBeNull();
  });

  it('picks the cancellation that takes effect first across an account\'s plans', () => {
    const account = { subscriptions: [sub({ cancel_at: days(60) }), sub({ cancel_at_period_end: true, current_period_end: days(2) })] };
    expect(cancellationDate(account, at)).toBe(days(2));
    expect(cancellationDate({ subscriptions: [sub()] }, at)).toBeNull();
  });

  it('lists every plan that renews in the window, earliest first', () => {
    const account = { subscriptions: [sub({ current_period_end: days(25) }), sub({ current_period_end: days(8) }), sub({ current_period_end: days(90) })] };
    expect(renewingSubscriptions(account, at).map(subscription => subscription.current_period_end)).toEqual([days(8), days(25)]);
    expect(renewingSubscriptions({ subscriptions: [] }, at)).toEqual([]);
  });
});

describe('adoption confidence and recovery',()=>{
 it('never reports missing or stale data as proven healthy adoption',()=>{
  expect(rated({usage:[]})).toMatchObject({band:'unknown',score:null,evidence:'missing'});
  expect(rated({usage:[{metric:'active_users',latest:10,baseline:10,latestAt:iso(-90),baselineAt:iso(-120)}]})).toMatchObject({band:'unknown',score:null,evidence:'stale',reasons:[]});
  expect(rated({usage:[{metric:'facility',latest:10,baseline:10}]})).toMatchObject({band:'unknown',evidence:'billing_only'});
 });
 it('requires action when fresh meaningful usage stops, independently of a score threshold',()=>{
  expect(rated({usage:[{app:'carebase',metric:'active_users',latest:0,baseline:10}]})).toMatchObject({score:75,band:'watch',attention:true,reasons:['usage_stopped'],evidence:'no_activity'});
 });
 it('does not infer a decline from an invalid or very old comparison window',()=>{
  expect(rated({usage:[{metric:'active_users',latest:0,baseline:10,baselineAt:iso(-200)}]}).reasons).toEqual([]);
  expect(rated({usage:[{metric:'active_users',latest:0,baseline:10,baselineAt:iso(1)}]}).reasons).toEqual([]);
 });
});

it('does not let one product mask missing adoption in another',()=>{expect(rated({products:[{slug:'carebase',status:'active'},{slug:'caremetric-intel',status:'active'}]})).toMatchObject({band:'unknown',evidence:'partial',evidenceByProduct:{carebase:'fresh','caremetric-intel':'missing'}});});
