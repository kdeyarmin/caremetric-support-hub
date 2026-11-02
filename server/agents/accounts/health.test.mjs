import { describe, expect, it } from 'vitest';
import { assess, attentionReasons, healthVersion, reasonWords, thresholds, weights } from './health.mjs';
import { account, iso, item, now, subscription } from './fixtures.mjs';

const rated = (over, at = now) => assess(account(over), at);

describe('how an account is doing', () => {
  it('scores a quiet, paying account 100 and says nothing about it', () => {
    expect(rated({})).toEqual({ version: healthVersion, band: 'healthy', score: 100, penalty: 0, reasons: [], flags: [], attention: false, ageDays: 120 });
    expect(healthVersion).toBe('health.1');
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
    const usage = (latest, baseline) => rated({ usage: [{ app: 'carebase', metric: 'facility', latest, baseline }] });
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
