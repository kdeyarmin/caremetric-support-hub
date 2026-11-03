import { describe, expect, it } from "vitest";
import { mailtoHref } from "./mailto";

/** What a mail client reads from the link (RFC 6068): the recipients before "?", and headers after it. */
function parse(href: string) {
  const [to, query = ""] = href.slice("mailto:".length).split("?");
  return { to: to.split(",").map(decodeURIComponent), headers: query ? query.split("&") : [] };
}

describe("mailto links", () => {
  it("opens a message to the plain address it was given", () => {
    expect(mailtoHref("jordan.rivera@sunrise.example")).toBe("mailto:jordan.rivera@sunrise.example");
    expect(mailtoHref("o'brien+leads@mail-1.example.co.uk")).toBe("mailto:o%27brien%2Bleads@mail-1.example.co.uk");
    expect(parse(mailtoHref("o'brien+leads@mail-1.example.co.uk")).to).toEqual(["o'brien+leads@mail-1.example.co.uk"]);
  });

  it("never lets a stored value add headers, a body or another recipient", () => {
    for (const stored of [
      "jordan@example.org?bcc=other%40example.net",
      "jordan@example.org?cc=other@example.net&subject=Invoice&body=Pay%20now",
      "jordan@example.org,other@example.net",
      "jordan@example.org;other@example.net",
      "jordan@example.org#fragment",
      "jordan&bcc=other@example.net",
      "jordan@example.org\r\nBcc: other@example.net",
    ]) {
      const href = mailtoHref(stored);
      expect(href.slice("mailto:".length)).toMatch(/^[A-Za-z0-9\-._~%]*@?[A-Za-z0-9\-._~%]*$/);
      expect(parse(href)).toEqual({ to: [stored], headers: [] });
    }
  });

  it("encodes the whole value when it has no usable @", () => {
    expect(mailtoHref("not an address")).toBe("mailto:not%20an%20address");
    expect(mailtoHref("@example.org?bcc=x")).toBe("mailto:%40example.org%3Fbcc%3Dx");
    expect(mailtoHref("jordan@")).toBe("mailto:jordan%40");
  });
});
