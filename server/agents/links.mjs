/**
 * Campaign tags on the product links the AI team puts in front of a person, so a lead that arrives through one shows which agent and
 * channel produced it (the Growth Manager's weekly report groups leads by utm_source and utm_campaign; Intel and the product sites
 * record the tags with each lead, and the Hub keeps them in private.leads).
 *
 * Only the company's own product pages are tagged (`productPages` in content/facts.mjs, matched exactly): never a citation, a
 * help-center link, an unsubscribe link or the booking link. A tag value is short, lowercase letters, digits, "-" and "_": it can
 * hold no address, no "@", no "%" escape and no personal data.
 *
 * Every link check reads a tagged link through `untaggedUrl` first: a tagged address passes only when its query is nothing but
 * well-formed utm tags and what remains is, character for character, a page the check already allows. A tag can therefore never
 * carry another host, another path or any other parameter.
 */
import { productPages } from './content/facts.mjs';

export const tagKeys = Object.freeze(['source', 'medium', 'campaign', 'content']);
const valuePattern = /^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])?$/;
const pageUrls = new Set(productPages.map(page => page.url));
// A tagged product link: the page's address without query or fragment, the utm tags, then the page's own fragment if it has one.
const taggedPattern = /^(https:\/\/[^\s?#<>"'()[\]]+)\?((?:utm_[a-z]+=[^&#\s]*)(?:&utm_[a-z]+=[^&#\s]*)*)(#[A-Za-z0-9_-]+)?$/;

/** True when `value` is an allowed tag value: 1 to 40 lowercase letters, digits, "-" or "_", starting and ending with a letter or digit. */
export const validTagValue = value => typeof value === 'string' && valuePattern.test(value);

/** The product page `url` names exactly (no query added), or null. */
export const productPageFor = url => (pageUrls.has(url) ? productPages.find(page => page.url === url) : null);

/**
 * A tag value made from parts: lowercased, anything but letters and digits turned into "-", joined with "-" and cut to 40 characters.
 * For values built from fixed words and keys (a product, a touch number); never from a person's or an organization's name.
 */
export function tagValue(...parts) {
  const value = parts.map(part => String(part ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')).filter(Boolean).join('-').slice(0, 40).replace(/-+$/, '');
  if (!validTagValue(value)) throw new TypeError('A campaign tag needs at least one letter or digit.');
  return value;
}

/**
 * `url` with utm_source, utm_medium, utm_campaign and (when given) utm_content added, when `url` is exactly one of the product pages;
 * any other address is returned as it is. Source, medium and campaign are required; a value that is not a valid tag throws.
 */
export function taggedUrl(url, { source, medium, campaign, content = null } = {}) {
  const value = String(url ?? '');
  if (!pageUrls.has(value)) return value;
  const tags = { source, medium, campaign, ...(content == null ? {} : { content }) };
  for (const key of ['source', 'medium', 'campaign']) if (tags[key] == null) throw new TypeError(`A tagged link needs utm_${key}.`);
  for (const [key, tag] of Object.entries(tags)) if (!validTagValue(tag)) throw new TypeError(`utm_${key} must be short, lowercase letters, digits, "-" or "_".`);
  const hashAt = value.indexOf('#');
  const [base, hash] = hashAt === -1 ? [value, ''] : [value.slice(0, hashAt), value.slice(hashAt)];
  return `${base}?${Object.entries(tags).map(([key, tag]) => `utm_${key}=${tag}`).join('&')}${hash}`;
}

/**
 * The product page a tagged link points to, or null when `url` is not a well-formed tagged product link: a query of anything but
 * utm_source, utm_medium, utm_campaign and utm_content (each at most once, each a valid tag value, source, medium and campaign present),
 * or an address that without its tags is not exactly a product page, is never read as one.
 */
export function untaggedUrl(url) {
  const match = taggedPattern.exec(String(url ?? ''));
  if (!match) return null;
  const [, base, query, hash = ''] = match;
  const seen = new Set();
  for (const pair of query.split('&')) {
    // Exactly one "=": a value is everything after it, so "x=name@example.com" is read whole and fails.
    const parts = pair.split('=');
    if (parts.length !== 2) return null;
    const [name, tag] = parts;
    const key = name.slice('utm_'.length);
    if (!tagKeys.includes(key) || seen.has(key) || !validTagValue(tag)) return null;
    seen.add(key);
  }
  if (!['source', 'medium', 'campaign'].every(key => seen.has(key))) return null;
  const page = `${base}${hash}`;
  return pageUrls.has(page) ? page : null;
}

// Addresses in plain text or Markdown; the end of a sentence (and a closing bracket) is not part of the address.
const addressPattern = /https?:\/\/[^\s<>"'()[\]]+/g;
const trailing = /[.,;:!?]+$/;

/**
 * `text` with every product-page address in it tagged (`taggedUrl`); a page that already carries well-formed tags gets these tags
 * instead. Every other address, and every other word, is left exactly as written.
 */
export function tagLinks(text, tags) {
  return String(text ?? '').replace(addressPattern, match => {
    const address = match.replace(trailing, '');
    return `${taggedUrl(untaggedUrl(address) ?? address, tags)}${match.slice(address.length)}`;
  });
}

/** `text` with every well-formed tagged product link turned back into the page's own address, for a link check; nothing else changes. */
export function untagLinks(text) {
  return String(text ?? '').replace(addressPattern, match => {
    const address = match.replace(trailing, '');
    return `${untaggedUrl(address) ?? address}${match.slice(address.length)}`;
  });
}

/** The product's short key in a campaign: carebase, intel or advisors (a growth or social product slug, or a facts key). */
export const campaignProduct = product => ({ carebase: 'carebase', 'caremetric-intel': 'intel', intel: 'intel', advisors: 'advisors' })[product] ?? 'caremetric';

/**
 * The tags each agent and channel uses. One place, so the weekly report's groups stay stable:
 * - growth outreach email:    caremetric / email / growth-<product>-touch<n>
 * - Account Manager email:    caremetric / email / account-<product>-<moment>
 * - Sales Executive answer:   caremetric / email, chat or sms / sales-<product>
 * - Social post, reply, ad:   facebook, instagram or linkedin / social or paid_social / social-<product>, content post, reply or ad
 * - Content Marketer article: help_center / article / content-<product>
 * - Monthly outreach drafts:  a directory listing <directory> / directory / outreach-<product>; a partner pitch caremetric / email /
 *                             outreach-<product>, content <partner kind>
 */
export const linkTags = Object.freeze({
  growthOutreach: (product, touch) => ({ source: 'caremetric', medium: 'email', campaign: tagValue('growth', campaignProduct(product), `touch${Number(touch) || 1}`) }),
  // The one check-in months later (private.growth_checkin_due): its own campaign, so a reply or trial it brings is told apart.
  growthCheckin: product => ({ source: 'caremetric', medium: 'email', campaign: tagValue('growth', campaignProduct(product), 'checkin') }),
  accountEmail: (product, moment) => ({ source: 'caremetric', medium: 'email', campaign: tagValue('account', campaignProduct(product), moment) }),
  sales: (product, route) => ({ source: 'caremetric', medium: ['email', 'chat', 'sms'].includes(route) ? route : 'email', campaign: tagValue('sales', campaignProduct(product)) }),
  social: (platform, product, content, { paid = false } = {}) => ({
    source: platform === 'linkedin' ? 'linkedin' : platform === 'instagram' ? 'instagram' : 'facebook',
    medium: paid ? 'paid_social' : 'social', campaign: tagValue('social', campaignProduct(product)), content,
  }),
  article: product => ({ source: 'help_center', medium: 'article', campaign: tagValue('content', campaignProduct(product)) }),
  listing: (directory, product) => ({ source: tagValue(directory), medium: 'directory', campaign: tagValue('outreach', campaignProduct(product)) }),
  pitch: (audience, product) => ({ source: 'caremetric', medium: 'email', campaign: tagValue('outreach', campaignProduct(product)), content: tagValue(audience) }),
});
