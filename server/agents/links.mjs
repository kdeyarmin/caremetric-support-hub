/**
 * Campaign tags on the product links the AI team puts in front of a person, so a lead that arrives through one shows which agent
 * and channel produced it. Intel and CareBase record utm_source, utm_medium, utm_campaign and utm_content with each lead; the Hub
 * stores them (private.leads) and the Growth Manager's weekly report groups leads by source and campaign.
 *
 * What is tagged: only an https address on one of the company's product sites (the hosts of `productPages` in content/facts.mjs:
 * cmcarebase.com, www.caremetricintel.com, caremetricadvisors.com). Never a citation, the help center's own links, an unsubscribe
 * link or the owner's booking page. Tag values are short lowercase words (letters, digits, hyphens and underscores, at most 80
 * characters) built from fixed words, product codes, touch numbers and slugs: never a name, an address or anything about a person.
 *
 * How the checks treat a tagged link (`linkAllowed`): it passes when it is exactly an allowed address, or when it is an allowed
 * address on a product site with a query made of tags alone added before its fragment. The address is compared as written, with
 * nothing normalized, so a tag can never carry another host, another path, another query parameter or another fragment: anything
 * but `utm_source`, `utm_medium`, `utm_campaign` and `utm_content`, each once with a valid value, and the link fails.
 *
 * The campaign naming (`campaignTags`) is the one list of what each agent writes; docs/AI_TEAM.md ("Campaign tags") copies it.
 */
import { productPages, products } from './content/facts.mjs';

export const tagKeys = Object.freeze(['source', 'medium', 'campaign', 'content']);
const maxValue = 80;
const validValue = value => typeof value === 'string' && value.length <= maxValue && /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(value);

/** The hosts of the company's product sites, where a link may carry campaign tags. */
export const productHosts = Object.freeze([...new Set(productPages.map(page => new URL(page.url).hostname))]);

/** A tag value as it is written: lowercase, anything but letters, digits, hyphens and underscores made a hyphen, at most 80 characters. */
export function tagValue(value) {
  const text = String(value ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-_]+/, '');
  return text.slice(0, maxValue).replace(/[-_]+$/, '');
}

/** The short code a campaign names a product by: carebase, intel or advisors (the Hub's slug caremetric-intel is intel); null otherwise. */
export function productCode(product) {
  const key = Object.keys(products).find(name => name === product || products[name].slug === product);
  return key ?? null;
}

/** Whether `value` is an https address on a product site, with no credentials and no port. */
export function productSiteUrl(value) {
  let url;
  try { url = new URL(String(value ?? '')); } catch { return false; }
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && productHosts.includes(url.hostname);
}

// An address as written: what comes before its query, its query (null without a "?") and its fragment ("#..." or "").
function parts(value) {
  const text = String(value ?? '');
  const hashAt = text.indexOf('#');
  const head = hashAt < 0 ? text : text.slice(0, hashAt);
  const queryAt = head.indexOf('?');
  return { base: queryAt < 0 ? head : head.slice(0, queryAt), query: queryAt < 0 ? null : head.slice(queryAt + 1), hash: hashAt < 0 ? '' : text.slice(hashAt) };
}

// The tags of a query made of tags alone, or null: an unknown or repeated parameter, an empty query or a malformed value fails.
function readTags(query) {
  if (!query) return null;
  const tags = {};
  for (const pair of query.split('&')) {
    const match = /^utm_([a-z]+)=(.*)$/.exec(pair);
    if (!match || !tagKeys.includes(match[1]) || Object.hasOwn(tags, match[1]) || !validValue(match[2])) return null;
    tags[match[1]] = match[2];
  }
  return tags;
}

/** The campaign tags an address carries (`{ source, medium, campaign, content }`, the ones present), or null. */
export function tagsOf(value) {
  const { query } = parts(value);
  return query === null ? null : readTags(query);
}

/**
 * The address without its campaign tags: an address with no query is itself, a query of tags alone is removed (the fragment
 * stays), and any other query gives null, because then the address is not just a tagged one.
 */
export function untaggedUrl(value) {
  const { base, query, hash } = parts(value);
  if (query === null) return String(value ?? '');
  return readTags(query) ? `${base}${hash}` : null;
}

/**
 * `url` with campaign tags, in a fixed order (source, medium, campaign, content), placed before its fragment and replacing any it
 * carried; with no tags (all empty), `url` without the tags it carried. Only an address on a product site is changed: anything else,
 * and a product-site address with a query that is not tags alone, comes back as it was.
 */
export function taggedUrl(url, tags = {}) {
  const value = String(url ?? '');
  if (!productSiteUrl(value)) return value;
  const query = tagKeys.map(key => [key, tagValue(tags?.[key])]).filter(([, text]) => text).map(([key, text]) => `utm_${key}=${text}`).join('&');
  const { base, query: own, hash } = parts(value);
  if (own !== null && !readTags(own)) return value;
  if (!query) return `${base}${hash}`;
  // A bare origin gets its "/" (https://www.caremetricintel.com becomes https://www.caremetricintel.com/?utm_...).
  return `${base === new URL(base).origin ? `${base}/` : base}?${query}${hash}`;
}

/**
 * Whether `url` may stand in a message whose allowed addresses are `allowed` (exact addresses, as a Set or a list): it is one of
 * them exactly, or it is one of them on a product site with campaign tags added and nothing else changed. A tagged citation,
 * help-center link or booking page fails, and so does a tagged address that is not on the list.
 */
export function linkAllowed(url, allowed) {
  const list = allowed instanceof Set ? allowed : new Set(allowed ?? []);
  const value = String(url ?? '');
  if (list.has(value)) return true;
  const base = untaggedUrl(value);
  return base !== null && base !== value && list.has(base) && productSiteUrl(base);
}

// An https address as the checks read one in text, and the punctuation that ends a sentence after it rather than belonging to it.
const addressPattern = /\bhttps:\/\/[^\s<>"'`]+/g;
const trailing = /[.,;:!?)\]]+$/;

/**
 * `text` with every product-site address in it tagged with `tags`, replacing tags it carried (with no tags, removing them). Every
 * other address, and a product-site address with a query that is not tags alone, is left exactly as written, for the checks to judge.
 */
export function tagLinks(text, tags) {
  return String(text ?? '').replace(addressPattern, match => {
    const address = match.replace(trailing, '');
    const base = untaggedUrl(address);
    if (base === null || !productSiteUrl(base)) return match;
    return `${taggedUrl(base, tags)}${match.slice(address.length)}`;
  });
}

/** The addresses in `text`, as the checks read them (trailing sentence punctuation removed). */
export const addressesIn = text => (String(text ?? '').match(addressPattern) ?? []).map(address => address.replace(trailing, ''));

const code = product => productCode(product) ?? 'caremetric';
// Meta's Messenger is Facebook's inbox; Meta ads may also show on Instagram, but the ad account is Facebook's.
const socialSource = platform => (platform === 'instagram' || platform === 'linkedin' ? platform : 'facebook');

/**
 * What each agent writes, by where the link appears. `product` may be a product key or the Hub's slug.
 *
 * | Where                                   | source                         | medium          | campaign                         | content          |
 * | Marketing Manager outreach email        | caremetric                     | email           | growth-<product>-touch<n>        | the variant      |
 * | Account Manager success email (growth)  | caremetric                     | email           | success-<product>-<moment>       |                  |
 * | Account Manager customer email          | caremetric                     | email           | account-<product>-<template>     |                  |
 * | Sales Executive answer                  | caremetric                     | email/chat/sms  | sales-<product>                  |                  |
 * | Social Media Manager post               | facebook/instagram/linkedin    | social          | social-<product>                 | the pillar       |
 * | Social Media Manager reply              | facebook/instagram/linkedin    | social          | social-<product>-reply           | comment/message  |
 * | Social Media Manager ad                 | facebook/linkedin              | paid_social     | ads-<product>                    | <date>-<variant> |
 * | Content Marketer article link           | help-center                    | referral        | article-<product>                | the article slug |
 * | Content Marketer directory listing      | the directory                  | referral        | listing-<product>                |                  |
 * | Content Marketer partnership pitch      | partner                        | email           | pitch-<product>                  | the audience     |
 */
export const campaignTags = Object.freeze({
  outreach: ({ product, touch, variant = null }) => ({ source: 'caremetric', medium: 'email', campaign: `growth-${code(product)}-touch${Math.max(1, Math.floor(Number(touch) || 1))}`, content: variant }),
  success: ({ product, kind }) => ({ source: 'caremetric', medium: 'email', campaign: `success-${code(product)}-${kind}` }),
  account: ({ product, template }) => ({ source: 'caremetric', medium: 'email', campaign: `account-${code(product)}-${template}` }),
  sales: ({ product, route }) => ({ source: 'caremetric', medium: ['email', 'chat', 'sms'].includes(route) ? route : 'email', campaign: `sales-${code(product)}` }),
  socialPost: ({ platform, product, pillar = null }) => ({ source: socialSource(platform), medium: 'social', campaign: `social-${code(product)}`, content: pillar }),
  socialReply: ({ platform, product, kind }) => ({ source: socialSource(platform), medium: 'social', campaign: `social-${code(product)}-reply`, content: kind === 'message' ? 'message' : 'comment' }),
  ad: ({ platform, product, content = null }) => ({ source: platform === 'linkedin' ? 'linkedin' : 'facebook', medium: 'paid_social', campaign: `ads-${code(product)}`, content }),
  article: ({ product, slug }) => ({ source: 'help-center', medium: 'referral', campaign: `article-${code(product)}`, content: slug }),
  listing: ({ directory, product }) => ({ source: directory, medium: 'referral', campaign: `listing-${code(product)}` }),
  pitch: ({ audience, product }) => ({ source: 'partner', medium: 'email', campaign: `pitch-${code(product)}`, content: audience }),
});
