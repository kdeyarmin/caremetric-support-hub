import { describe, expect, it, vi } from 'vitest';
import { growthSender, validGrowthFromEmail, validGrowthFromName } from './sender.mjs';
import { sendgridBulkMail } from '../bulk-email.mjs';
import { founder } from '../agents/content/facts.mjs';

const support = { supportFrom: 'support@caremetric.ai', supportReplyTo: 'support@inbound.caremetric.ai' };
// As server/main.mjs wires it: the sender's name, and whether one is saved in Settings (`fromNameLocked`). `message` adds one message's own
// fields, such as a founder-signed email's `fromName`.
async function sentWith(sender, message = {}) {
  const fetchImpl = vi.fn(async () => new Response(null, { status: 202, headers: { 'x-message-id': 'g.1' } }));
  const mail = sendgridBulkMail({ apiKey: 'SG.key', from: sender.from, fromName: sender.fromName, fromNameLocked: () => sender.fromNameSet, replyTo: sender.replyTo, fetchImpl });
  expect(mail.configured).toBe(true);
  expect(await mail.send({ to: 'director@agency.test', subject: 'Hello', text: 'Body', unsubscribeUrl: 'https://hub.example/u', messageId: 'm-1', ...message })).toEqual({ delivery: 'sent', id: 'g.1' });
  return JSON.parse(fetchImpl.mock.calls[0][1].body);
}

describe('the growth sender', () => {
  it('keeps today\'s behavior when HUB_GROWTH_FROM_EMAIL is unset: the support address and its Reply-To', async () => {
    for (const env of [{}, { HUB_GROWTH_FROM_EMAIL: '  ', HUB_GROWTH_FROM_NAME: '' }]) {
      const sender = growthSender(env, support);
      expect(sender).toEqual({ from: 'support@caremetric.ai', fromName: 'CareMetric', fromNameSet: false, replyTo: 'support@inbound.caremetric.ai', separate: false, warnings: [] });
      const body = await sentWith(sender);
      expect(body.from).toEqual({ email: 'support@caremetric.ai', name: 'CareMetric' });
      expect(body.reply_to).toEqual({ email: 'support@inbound.caremetric.ai' });
    }
  });

  it('sends growth email from its own address and name while replies still go to the support inbox', async () => {
    const sender = growthSender({ HUB_GROWTH_FROM_EMAIL: ' hello@go.caremetric.ai ', HUB_GROWTH_FROM_NAME: ' CareMetric Sales ' }, support);
    expect(sender).toEqual({ from: 'hello@go.caremetric.ai', fromName: 'CareMetric Sales', fromNameSet: true, replyTo: 'support@inbound.caremetric.ai', separate: true, warnings: [] });
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
      expect(sender.warnings, email).toEqual([expect.stringMatching(/^The growth email sender \(Settings → Email\) is not an email address/)]);
      expect(validGrowthFromEmail(email), email).toBe(false);
    }
    for (const name of ['x'.repeat(65), 'Sales "Team"', 'Sales <team>', 'Sales\r\nBcc: x']) {
      const sender = growthSender({ HUB_GROWTH_FROM_EMAIL: 'hello@go.caremetric.ai', HUB_GROWTH_FROM_NAME: name }, support);
      expect(sender.fromName, name).toBe('CareMetric');
      expect(sender.warnings, name).toEqual([expect.stringMatching(/^The growth email display name \(Settings → Email\) is not usable/)]);
      expect(validGrowthFromName(name), name).toBe(false);
    }
    expect(validGrowthFromName('CareMetric Sales')).toBe(true);
  });

  it('says whether a usable display name is saved in Settings, and only then', () => {
    expect(growthSender({}, support).fromNameSet).toBe(false);
    expect(growthSender({ HUB_GROWTH_FROM_NAME: '   ' }, support).fromNameSet).toBe(false);
    expect(growthSender({ HUB_GROWTH_FROM_NAME: ' CareMetric Sales ' }, support)).toMatchObject({ fromName: 'CareMetric Sales', fromNameSet: true });
    // A saved name counts even when it is the default's own word: the owner chose it.
    expect(growthSender({ HUB_GROWTH_FROM_NAME: 'CareMetric' }, support)).toMatchObject({ fromName: 'CareMetric', fromNameSet: true });
    // A name no mail service accepts is not a saved name: the default stands, and a founder-signed email may still use its own.
    for (const name of ['x'.repeat(65), 'Sales "Team"', 'Sales <team>', 'Sales\r\nBcc: x'])
      expect(growthSender({ HUB_GROWTH_FROM_NAME: name }, support), name).toMatchObject({ fromName: 'CareMetric', fromNameSet: false });
  });

  it('sends a founder-signed email from the founder\'s name unless a display name is saved (owner decision 2026-11-17)', async () => {
    expect(founder.fromName).toBe('Dr. Kevin Deyarmin, CareMetric');
    expect(validGrowthFromName(founder.fromName)).toBe(true);
    const unset = growthSender({ HUB_GROWTH_FROM_EMAIL: 'hello@go.caremetric.ai' }, support);
    expect((await sentWith(unset, { fromName: founder.fromName })).from).toEqual({ email: 'hello@go.caremetric.ai', name: 'Dr. Kevin Deyarmin, CareMetric' });
    // A message with no name of its own (a customer's) keeps the sender's.
    expect((await sentWith(unset)).from).toEqual({ email: 'hello@go.caremetric.ai', name: 'CareMetric' });
    // A name saved in Settings wins over the message's.
    const saved = growthSender({ HUB_GROWTH_FROM_EMAIL: 'hello@go.caremetric.ai', HUB_GROWTH_FROM_NAME: 'CareMetric Sales' }, support);
    expect((await sentWith(saved, { fromName: founder.fromName })).from).toEqual({ email: 'hello@go.caremetric.ai', name: 'CareMetric Sales' });
    // A name a mail service would refuse is never used, whatever sent it.
    for (const fromName of ['Dr. "K" Deyarmin', 'Kevin <founder>', 'x'.repeat(65), 'Kevin\r\nBcc: x', '   ', '', null, 42])
      expect((await sentWith(unset, { fromName })).from.name, String(fromName)).toBe('CareMetric');
    // The address and Reply-To never change with the name.
    const body = await sentWith(unset, { fromName: founder.fromName });
    expect(body.reply_to).toEqual({ email: 'support@inbound.caremetric.ai' });
  });

  it('warns when the growth address shares the support domain, since reputation would not be kept apart', () => {
    const sender = growthSender({ HUB_GROWTH_FROM_EMAIL: 'sales@caremetric.ai' }, support);
    expect(sender).toMatchObject({ from: 'sales@caremetric.ai', separate: true });
    expect(sender.warnings).toEqual([expect.stringMatching(/use a subdomain/)]);
    expect(growthSender({ HUB_GROWTH_FROM_EMAIL: 'Support@CareMetric.ai' }, support)).toMatchObject({ separate: false, warnings: [] });
  });
});
