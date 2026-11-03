/** Percent-encodes everything but RFC 3986's unreserved characters (A–Z, a–z, 0–9, "-", ".", "_", "~"). */
function encodePart(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * A mailto: link to exactly one address (RFC 6068). The local part and the domain are percent-encoded separately and
 * only the "@" between them stays literal, so nothing stored in an address ("?", "&", "#", "%", ",", ";" and the like)
 * can become mail headers, a body or another recipient. A value without a usable "@" is encoded whole.
 */
export function mailtoHref(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return `mailto:${encodePart(address)}`;
  return `mailto:${encodePart(address.slice(0, at))}@${encodePart(address.slice(at + 1))}`;
}
