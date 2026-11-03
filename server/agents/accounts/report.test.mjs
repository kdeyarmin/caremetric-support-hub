import { describe, expect, it } from 'vitest';
import { renderOwnerEmail } from '../notify.mjs';
import { account, iso, item, now, snapshot, subscription } from './fixtures.mjs';
import { composeAccountsReport, rowLimit } from './report.mjs';

const origin = 'https://hub.example.test';
// Names and an amount distinctive enough that finding them anywhere they should not be is unmistakable.
const book = [
  account({ slug: 'maple-grove', name: 'Maple Grove Senior Living', subscriptions: [subscription({ items: [item({ quantity: 2 })] })] }),
  account({ slug: 'cedar-ridge', name: 'Cedar Ridge Care', subscriptions: [subscription({ status: 'past_due' })], invoices: { open: 2, overdue: 2, remainingCents: 9800 } }),
  account({ slug: 'birch-hollow', name: 'Birch Hollow Manor', createdAt: iso(-5), subscriptions: [subscription({ status: 'trialing', trial_end: iso(3), created: iso(-5) })] }),
  account({ slug: 'oak-meadow', name: 'Oak Meadow Residence', subscriptions: [subscription({ cancel_at_period_end: true })] }),
  account({ slug: 'pine-court', name: 'Pine Court Homes', subscriptions: [subscription({ items: [item({ unit_amount: 120000, interval: 'year' })], current_period_end: iso(20) })] }),
  account({ slug: 'elm-street', name: 'Elm Street Home', usage: [{ app: 'carebase', metric: 'active_users', latest: 15, baseline: 10 }] }),
  account({ slug: 'old-tenant', name: 'Closed And Gone', status: 'closed', subscriptions: [subscription({ status: 'canceled', canceled_at: iso(-90), ended_at: iso(-90) })] }),
  account({ slug: 'zombie', name: 'Closed But Billing', status: 'closed' }),
  account({ slug: 'left-us', name: 'Walnut Place', subscriptions: [subscription({ status: 'canceled', canceled_at: iso(-3), ended_at: iso(-3) })] }),
  account({ slug: 'just-signed', name: 'Hickory Lane', createdAt: iso(-2), subscriptions: [subscription({ created: iso(-2) })] }),
];
const compose = (accounts = book, over = {}, input = {}) => composeAccountsReport({ snapshot: snapshot(accounts, over), now, publicOrigin: origin, ...input });
const rowsOf = (report, title) => {
  const at = report.blocks.findIndex(block => block.type === 'paragraph' && block.text === title);
  return at < 0 ? null : report.blocks[at + 1].rows;
};

describe('the weekly account report', () => {
  it('says who needs the owner, most serious first, with the dates and amounts that make it actionable', () => {
    const report = compose();
    expect(rowsOf(report, 'Needs you')).toEqual([
      ['Cedar Ridge Care', 'Payment past due; 2 overdue invoices, $98.00 remaining'],
      ['Oak Meadow Residence', 'Cancels Nov 22'],
      ['Closed But Billing', 'Account closed but still billing'],
      ['Birch Hollow Manor', 'Trial ends Nov 5'],
    ]);
    expect(rowsOf(report, 'Renewing in the next 30 days')).toEqual([['Pine Court Homes', 'Renews Nov 22, $1,200.00 a year']]);
    expect(rowsOf(report, 'Growing')).toEqual([['Elm Street Home', 'Usage is growing']]);
  });

  it('names the date that raised each flag when an account has several subscriptions', () => {
    const annual = (over = {}) => subscription({ items: [item({ unit_amount: 120000, interval: 'year' })], ...over });
    const report = compose([
      // A monthly plan renewing in 200 days comes first; the annual plan renewing in 3 days is the one that earned the flag.
      account({ slug: 'two-plans', name: 'Two Plans Home', subscriptions: [subscription({ current_period_end: iso(200), created: iso(-300) }), annual({ current_period_end: iso(3) })] }),
      // Of two annual renewals, the sooner one leads the section.
      account({ slug: 'later', name: 'Later Renewal', subscriptions: [annual({ current_period_end: iso(25) })] }),
      account({ slug: 'sooner', name: 'Sooner Renewal', subscriptions: [annual({ current_period_end: iso(9) })] }),
      // The first trial is 60 days out; the second, two days out, is the one that needs the owner.
      account({ slug: 'trials', name: 'Two Trials Home', createdAt: iso(-90), subscriptions: [
        subscription({ status: 'trialing', trial_end: iso(60), created: iso(-90) }), subscription({ status: 'trialing', trial_end: iso(2), created: iso(-60) })] }),
      // A past cancel_at is not a scheduled cancellation, and the one in the future is the date to show.
      account({ slug: 'cancel', name: 'Cancel Dates Home', subscriptions: [subscription({ cancel_at: iso(-10), created: iso(-300) }), subscription({ cancel_at: iso(12) })] }),
    ]);
    expect(rowsOf(report, 'Renewing in the next 30 days')).toEqual([
      ['Two Plans Home', 'Renews Nov 5, $1,200.00 a year'],
      ['Sooner Renewal', 'Renews Nov 11, $1,200.00 a year'],
      ['Later Renewal', 'Renews Nov 27, $1,200.00 a year'],
    ]);
    const needs = Object.fromEntries(rowsOf(report, 'Needs you'));
    expect(needs['Two Trials Home']).toBe('Trial ends Nov 4');
    expect(needs['Cancel Dates Home']).toBe('Cancels Nov 14');
  });

  it('shows the cancellation that takes effect first, counting the end of the period for one set to cancel then', () => {
    const report = compose([
      // The first plan cancels at the end of its period, in two days; the second has an explicit date much later.
      account({ slug: 'period-end', name: 'Period End Home', subscriptions: [subscription({ cancel_at_period_end: true, current_period_end: iso(2), created: iso(-300) }), subscription({ cancel_at: iso(60) })] }),
      // A stale explicit date does not stand in for the period end of a plan set to cancel then.
      account({ slug: 'stale', name: 'Stale Date Home', subscriptions: [subscription({ cancel_at: iso(-4), cancel_at_period_end: true, current_period_end: iso(9) })] }),
    ]);
    const needs = Object.fromEntries(rowsOf(report, 'Needs you'));
    expect(needs['Period End Home']).toBe('Cancels Nov 4');
    expect(needs['Stale Date Home']).toBe('Cancels Nov 11');
  });

  it('adds up every plan that renews in the window, and says how many there are', () => {
    const annual = (amount, over = {}) => subscription({ items: [item({ unit_amount: amount, interval: 'year' })], ...over });
    const report = compose([
      account({ slug: 'two-annual', name: 'Two Annual Home', subscriptions: [annual(120000, { current_period_end: iso(20), created: iso(-300) }), annual(240000, { current_period_end: iso(20) })] }),
      account({ slug: 'staggered', name: 'Staggered Home', subscriptions: [annual(120000, { current_period_end: iso(25), created: iso(-300) }), annual(60000, { current_period_end: iso(8) })] }),
    ]);
    expect(rowsOf(report, 'Renewing in the next 30 days')).toEqual([
      ['Staggered Home', 'Renews Nov 10 (2 plans), $1,800.00 a year'],
      ['Two Annual Home', 'Renews Nov 22 (2 plans), $3,600.00 a year'],
    ]);
  });

  it('reports revenue with the Billing screen\'s figures, and new and lost subscriptions this week', () => {
    const report = compose();
    const revenue = rowsOf(report, 'Revenue');
    // Active and past-due subscriptions: 2 x $49, the past-due $49, the cancelling $49, $1,200 a year ($100), Elm Street $49, the closed-but-billing $49 and the new $49.
    expect(revenue).toEqual([
      ['MRR', '$443.00'], ['ARR', '$5,316.00'], ['Trial MRR, not yet paying', '$49.00'],
      ['New subscriptions this week', '2'], ['Lost this week', '1'], ['Past due', '1'],
    ]);
    expect(rowsOf(report, 'Accounts')).toEqual([['Healthy', '3'], ['Adoption unknown', '0'], ['Watch', '3'], ['At risk', '0'], ['New, not scored', '2'], ['No live subscription', '1']]);
  });

  it('leaves a closed account with nothing live out, and keeps one that still bills', () => {
    const report = compose();
    expect(JSON.stringify(report.blocks)).not.toContain('Closed And Gone');
    expect(JSON.stringify(report.blocks)).toContain('Closed But Billing');
    expect(report.result.accounts).toBe(9);
  });

  it('keeps names and money out of everything that is stored: the subject, the body and the result carry counts only', () => {
    const report = compose();
    expect(report.subject).toBe('Weekly accounts: 9 accounts, 4 need you');
    expect(report.body).toBe('9 accounts: 3 healthy, 3 watch, 0 at risk, 2 new. 4 need you.');
    expect(report.result).toEqual({
      accounts: 9, needsYou: 4, healthy: 3, unknown: 0, watch: 3, atRisk: 0, newAccounts: 2, inactive: 1, renewals: 1, expansion: 1, trialsEnding: 1, truncated: false,
    });
    const stored = JSON.stringify([report.subject, report.body, report.result]);
    for (const secret of ['Maple Grove', 'Cedar Ridge', 'Birch Hollow', 'Oak Meadow', 'Pine Court', 'Elm Street', 'Walnut', 'Hickory', '$', '443', '98.00', 'carebase']) expect(stored, secret).not.toContain(secret);
    expect(JSON.stringify(report.blocks)).toContain('Cedar Ridge Care');
    expect(Buffer.byteLength(JSON.stringify(report.result))).toBeLessThan(1024);
  });

  it('says plainly when nothing needs the owner, and when there is nothing to report', () => {
    const calm = compose([account({ name: 'Quiet Acres' })]);
    expect(calm.subject).toBe('Weekly accounts: 1 account, none need you');
    expect(calm.blocks[0]).toMatchObject({ type: 'callout', tone: 'success', text: 'Nothing needs you this week across 1 account.' });
    expect(rowsOf(calm, 'Needs you')).toBeNull();
    expect(calm.blocks.some(block => block.type === 'button')).toBe(false);
    const empty = compose([]);
    expect(empty.result.accounts).toBe(0);
    expect(empty.blocks[0].text).toBe('There are no accounts to report yet.');
  });

  it('warns about test and unverified Stripe data and about a partial list', () => {
    expect(compose(book, { mode: 'test' }).blocks[0]).toMatchObject({ tone: 'warning', title: 'Test data.' });
    expect(compose(book, { mode: 'unverified' }).blocks[0]).toMatchObject({ tone: 'warning', title: 'Stripe mode not verified.' });
    const partial = compose(book, { total: 400, truncated: true });
    expect(partial.blocks[0]).toMatchObject({ tone: 'info', title: 'Partial list.', text: 'Showing 10 of 400 accounts. The figures below cover only these.' });
    expect(partial.result.truncated).toBe(true);
    expect(compose().blocks[0].title).not.toBe('Test data.');
  });

  it('notes mixed currencies and carries the Billing-screen and scoring footnotes', () => {
    const text = blocks => blocks.filter(block => block.type === 'paragraph').map(block => block.text).join('\n');
    expect(text(compose().blocks)).toContain('Revenue uses the same figures as the Billing screen');
    expect(text(compose().blocks)).toContain('Scoring version health.2');
    expect(text(compose().blocks)).not.toContain('more than one currency');
    const euro = account({ name: 'Euro Home', subscriptions: [subscription({ items: [item({ currency: 'eur' })] })] });
    expect(text(compose([...book, euro]).blocks)).toContain('more than one currency');
  });

  it('shows at most ten rows a section and says how many more there are', () => {
    const many = Array.from({ length: 25 }, (_, index) => account({ slug: `late-${index}`, name: `Late Payer ${String(index).padStart(2, '0')}`, subscriptions: [subscription({ status: 'past_due' })] }));
    const report = compose(many);
    expect(rowsOf(report, 'Needs you')).toHaveLength(rowLimit);
    expect(rowLimit).toBe(10);
    expect(report.blocks.some(block => block.type === 'paragraph' && block.text === 'And 15 more.')).toBe(true);
    expect(report.result.needsYou).toBe(25);
  });

  it('links to the AI team only when something needs the owner and the origin is https', () => {
    expect(compose().blocks.at(-1)).toEqual({ type: 'button', label: 'Open the AI team', url: 'https://hub.example.test/admin/team' });
    expect(composeAccountsReport({ snapshot: snapshot(book), now, publicOrigin: 'http://hub.example.test' }).blocks.some(block => block.type === 'button')).toBe(false);
    expect(composeAccountsReport({ snapshot: snapshot(book), now }).blocks.some(block => block.type === 'button')).toBe(false);
  });

  it('renders through the real owner email, with hostile names escaped, for empty, 50 and 500 accounts', () => {
    const hostile = account({ name: '<script>alert(1)</script> & "Quote"\nSecond line', subscriptions: [subscription({ status: 'past_due' })] });
    for (const count of [0, 50, 500]) {
      const accounts = [hostile, ...Array.from({ length: Math.max(count - 1, 0) }, (_, index) => account({ slug: `a-${index}`, name: `Account ${index}`, subscriptions: [subscription({ status: 'past_due' })] }))].slice(0, count);
      const report = compose(accounts);
      const { html, text } = renderOwnerEmail({ subject: report.subject, body: report.body, severity: 'info', publicOrigin: origin, blocks: report.blocks });
      expect(html.length).toBeLessThan(100_000);
      expect(html).not.toContain('<script>');
      if (count > 0) {
        expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Quote&quot; Second line');
        expect(text).toContain('Weekly accounts');
      }
    }
  });

  it('clips a very long name', () => {
    const report = compose([account({ name: 'N'.repeat(300), subscriptions: [subscription({ status: 'past_due' })] })]);
    const [[label]] = rowsOf(report, 'Needs you');
    expect(label).toHaveLength(60);
    expect(label.endsWith('…')).toBe(true);
  });
});
