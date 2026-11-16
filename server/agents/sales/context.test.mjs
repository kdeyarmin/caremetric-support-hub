import { describe, expect, it, vi } from 'vitest';
import { salesContextFor, salesGrowthContextReader } from './context.mjs';
import { salesHandlers } from './index.mjs';

// Fake data only: example.test addresses and 555-01xx numbers.
describe('a growth prospect\'s account context for the Sales Executive (review 2026-11-17, row 2.9)', () => {
  it('keeps the brief\'s plain fields and leaves out any sentence with an address, a phone number, an identifier or the agency\'s standing', () => {
    const context = salesContextFor({
      brief: { summary: 'A hospice serving three counties. Reach the owner at owner@agency.example.test. It is rated 4 stars.', angle: 'referral_growth',
        pains: ['Which hospitals send the most?', 'Call 412-555-0142?', '', 7], hook: 'It hired a <b>new</b> liaison & opened an office.' },
      answered: { touch: 3, purpose: 'marketing', subject: 'A <short> note', form: 'short' }, reportOpened: false,
    });
    expect(context).toEqual({
      brief: { summary: 'A hospice serving three counties.', angle: 'referral growth', pains: ['Which hospitals send the most?'],
        hook: 'It hired a &lt;b&gt;new&lt;/b&gt; liaison &amp; opened an office.' },
      answered: { touch: 3, purpose: 'marketing', subject: 'A &lt;short&gt; note', form: 'short' }, reportOpened: false,
    });
  });

  it('is null when nothing usable came back, and drops malformed parts', () => {
    expect(salesContextFor(null)).toBeNull();
    expect(salesContextFor({})).toBeNull();
    expect(salesContextFor({ brief: { summary: 'Call 412-555-0142.' }, answered: { touch: 0 } })).toBeNull();
    expect(salesContextFor({ answered: { touch: 1, purpose: 'other', form: 'DROP TABLE' } }))
      .toEqual({ brief: null, answered: { touch: 1, purpose: 'marketing', subject: null, form: null }, reportOpened: null });
  });

  it('reads the database\'s operation for the server in one call', async () => {
    const client = { query: vi.fn(async () => ({ rows: [{ result: { reportOpened: true } }] })) };
    const pool = { connect: vi.fn(async () => ({ ...client, release: vi.fn() })) };
    const read = salesGrowthContextReader(pool);
    expect(await read('c-1', 'm-1')).toEqual({ reportOpened: true });
    expect(client.query).toHaveBeenCalledWith('select private.sales_growth_context($1, $2) as result', ['c-1', 'm-1']);
  });

  it('is used only with the owner\'s switch on and the database\'s reading declared', async () => {
    const declared = ['platform.agents.sales-executive.v1', 'platform.agents.growth-priority.v1'];
    const run = async ({ features, salesContext }) => {
      const growthContext = vi.fn(async () => ({ reportOpened: true }));
      const model = { configured: true, run: vi.fn(async () => ({ outcome: 'completed', output: { intent: 'interested', objection: 'none', possiblePhi: false,
        needsOwner: false, nextStep: 'start_trial', reply: 'You can start a 30-day free trial here:\nhttps://www.caremetricintel.com/' } })) };
      const store = {
        communicationSnapshot: vi.fn(async () => ({ id: '11111111-1111-4111-8111-111111111111', reference: 7, channel: 'email', status: 'new', inquiryType: 'sales',
          sourceSystem: 'hub.email', productSlug: 'caremetric-intel', canEmail: true, canText: false, subject: null, headMessageId: '22222222-2222-4222-8222-222222222222',
          latestInboundId: '22222222-2222-4222-8222-222222222222', answered: false, inboundCount: 1, outboundCount: 0,
          messages: [{ id: '22222222-2222-4222-8222-222222222222', direction: 'inbound', at: '2026-11-08T14:55:00Z', body: 'Tell me more about the referral data.' }] })),
        notificationCount: vi.fn(async () => 0), startRun: vi.fn(async () => 'run'), finishRun: vi.fn(async () => undefined),
        proposeAction: vi.fn(async () => ({ id: 'a', status: 'proposed', created: true })),
      };
      const handlers = salesHandlers({ store, notifier: null, model, features, customerTextToAi: true, salesContext, growthContext, log: () => {} });
      await handlers['sales.reply']({ id: 't', agentKey: 'sales_executive', kind: 'sales.reply', attempts: 1, agent: { autonomy: 'propose', config: {} },
        payload: { communicationId: '11111111-1111-4111-8111-111111111111', messageId: '22222222-2222-4222-8222-222222222222', product: 'caremetric-intel' } });
      return { asked: growthContext.mock.calls.length, user: model.run.mock.calls[0][1].user };
    };
    expect(await run({ features: declared, salesContext: () => true })).toMatchObject({ asked: 1, user: expect.stringContaining('report_opened: yes') });
    expect((await run({ features: declared, salesContext: () => false })).asked).toBe(0);
    expect((await run({ features: ['platform.agents.sales-executive.v1'], salesContext: () => true })).asked).toBe(0);
  });
});
