import { describe, expect, it, vi } from 'vitest';
import { growthSender, validGrowthFromEmail, validGrowthFromName } from './sender.mjs';
import { sendgridBulkMail } from '../bulk-email.mjs';

const support = { supportFrom: 'support@caremetric.ai', supportReplyTo: 'support@inbound.caremetric.ai' };
async function sentWith(sender) {
  const fetchImpl = vi.fn(async () => new Response(null, { status: 202, headers: { 'x-message-id': 'g.1' } }));
  const mail = sendgridBulkMail({ apiKey: 'SG.key', from: sender.from, fromName: sender.fromName, replyTo: sender.replyTo, fetchImpl });
  expect(mail.configured).toBe(true);
  expect(await mail.send({ to: 'director@agency.test', subject: 'Hello', text: 'Body', unsubscribeUrl: 'https://hub.example/u', messageId: 'm-1' })).toEqual({ delivery: 'sent', id: 'g.1' });
  return JSON.parse(fetchImpl.mock.calls[0][1].body);
}

describe('the growth sender', () => {
  it('keeps today\'s behavior when HUB_GROWTH_FROM_EMAIL is unset: the support address and its Reply-To', async () => {
    for (const env of [{}, { HUB_GROWTH_FROM_EMAIL: '  ', HUB_GROWTH_FROM_NAME: '' }]) {
      const sender = growthSender(env, support);
      expect(sender).toEqual({ from: 'support@caremetric.ai', fromName: 'CareMetric', replyTo: 'support@inbound.caremetric.ai', separate: false, warnings: [] });
      const body = await sentWith(sender);
      expect(body.from).toEqual({ email: 'support@caremetric.ai', name: 'CareMetric' });
      expect(body.reply_to).toEqual({ email: 'support@inbound.caremetric.ai' });
    }
  });

  it('sends growth email from its own address and name while replies still go to the support inbox', async () => {
    const sender = growthSender({ HUB_GROWTH_FROM_EMAIL: ' hello@go.caremetric.ai ', HUB_GROWTH_FROM_NAME: ' CareMetric Sales ' }, support);
    expect(sender).toEqual({ from: 'hello@go.caremetric.ai', fromName: 'CareMetric Sales', replyTo: 'support@inbound.caremetric.ai', separate: true, warnings: [] });
    const body = await sentWith(sender);
    expect(body.from).toEqual({ email: 'hello@go.caremetric.ai', name: 'CareMetric Sales' });
    expect(body.reply_to).toEqual({ email: 'support@inbound.caremetric.ai' });
    // The unsubscribe headers and the message id the delivery webhook matches on are unchanged.
    expect(body.personalizations[0].headers).toEqual({ 'List-Unsubscribe': '<https://hub.example/u>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
    expect(body.custom_args).toEqual({ growth_message_id: 'm-1' });
  });

  it('ignores an address or name SendGrid would refuse, with a warning, instead of stopping growth email', () => {
    for (const email of ['not an address', 'hello@', '<hello@go.caremetric.ai>', 'a"b@go.caremetric.ai', `${'x'.repeat(250)}@go.caremetric.ai`]) {
      const sender = growthSender({ HUB_GROWTH_FROM_EMAIL: email }, support);
      expect(sender, email).toMatchObject({ from: 'support@caremetric.ai', separate: false });
      expect(sender.warnings, email).toEqual([expect.stringMatching(/^HUB_GROWTH_FROM_EMAIL is not an email address/)]);
      expect(validGrowthFromEmail(email), email).toBe(false);
    }
    for (const name of ['x'.repeat(65), 'Sales "Team"', 'Sales <team>', 'Sales\r\nBcc: x']) {
      const sender = growthSender({ HUB_GROWTH_FROM_EMAIL: 'hello@go.caremetric.ai', HUB_GROWTH_FROM_NAME: name }, support);
      expect(sender.fromName, name).toBe('CareMetric');
      expect(sender.warnings, name).toEqual([expect.stringMatching(/^HUB_GROWTH_FROM_NAME is not a usable display name/)]);
      expect(validGrowthFromName(name), name).toBe(false);
    }
    expect(validGrowthFromName('CareMetric Sales')).toBe(true);
  });

  it('warns when the growth address shares the support domain, since reputation would not be kept apart', () => {
    const sender = growthSender({ HUB_GROWTH_FROM_EMAIL: 'sales@caremetric.ai' }, support);
    expect(sender).toMatchObject({ from: 'sales@caremetric.ai', separate: true });
    expect(sender.warnings).toEqual([expect.stringMatching(/use a subdomain/)]);
    expect(growthSender({ HUB_GROWTH_FROM_EMAIL: 'Support@CareMetric.ai' }, support)).toMatchObject({ separate: false, warnings: [] });
  });
});
