/**
 * Who growth email comes from (docs/CUSTOMER_GROWTH.md, "A separate sender for prospecting").
 *
 * Cold email and sales follow-ups (the `growth.message` executor) can come from their own address, normally on a subdomain such as
 * hello@go.caremetric.ai, so complaints or bounces from prospecting are scored against that subdomain and never against the support
 * address that support replies, owner alerts, Account Manager emails and bulk email keep using. Reply-To stays on the support inbox,
 * so a prospect's answer still reaches the signed inbound route and the Sales Executive.
 *
 * HUB_GROWTH_FROM_EMAIL unset keeps today's behavior: growth email comes from the support sender. A value that is not an email
 * address is ignored with a warning, the same way an unusable HUB_SUPPORT_REPLY_TO is, rather than making SendGrid refuse every message.
 */
const emailAddress = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
export const defaultGrowthFromName = 'CareMetric';

/** The one address test the service and the integration setup panel share. */
export const validGrowthFromEmail = value => typeof value === 'string' && value.trim().length <= 254 && emailAddress.test(value.trim());
/** A display name SendGrid accepts as is: printable, without quotes, angle brackets or line breaks, at most 64 characters. */
export const validGrowthFromName = value => typeof value === 'string' && /^[^\p{Cc}"<>]{1,64}$/u.test(value.trim());

/**
 * @param {Record<string, string|undefined>} env
 * @param {{ supportFrom: string, supportReplyTo: string }} support the support sender and its Reply-To
 * @returns {{ from: string, fromName: string, replyTo: string, separate: boolean, warnings: string[] }}
 */
export function growthSender(env, { supportFrom, supportReplyTo }) {
  const warnings = [];
  const email = env.HUB_GROWTH_FROM_EMAIL?.trim() || '';
  const name = env.HUB_GROWTH_FROM_NAME?.trim() || '';
  let from = supportFrom;
  if (email && validGrowthFromEmail(email)) from = email;
  else if (email) warnings.push('HUB_GROWTH_FROM_EMAIL is not an email address; growth email comes from the support sender.');
  const separate = from.toLowerCase() !== supportFrom.toLowerCase();
  if (separate && domainOf(from) === domainOf(supportFrom)) {
    warnings.push('HUB_GROWTH_FROM_EMAIL shares the support address\'s domain; use a subdomain (for example go.caremetric.ai) to keep prospecting reputation apart.');
  }
  let fromName = defaultGrowthFromName;
  if (name && validGrowthFromName(name)) fromName = name.trim();
  else if (name) warnings.push('HUB_GROWTH_FROM_NAME is not a usable display name (at most 64 characters, no quotes or angle brackets); growth email uses "CareMetric".');
  // Replies always go to the support inbox: the address Inbound Parse receives, so the Sales Executive sees the answer.
  return { from, fromName, replyTo: supportReplyTo, separate, warnings };
}
const domainOf = address => address.slice(address.lastIndexOf('@') + 1).toLowerCase();
