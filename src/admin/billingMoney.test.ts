import { describe, expect, it } from "vitest";
import { formatBillingMoney } from "./billingMoney";

describe("Stripe invoice minor units", () => {
  it.each([
    ["0", "usd", "USD 0.00"], ["1", "usd", "USD 0.01"], ["123456", "eur", "EUR 1,234.56"],
    ["9223372036854775807", "usd", "USD 92,233,720,368,547,758.07"], ["9007199254740993", "jpy", "JPY 9,007,199,254,740,993"],
    ["500", "isk", "ISK 5.00"], ["500", "ugx", "UGX 5.00"], ["1045", "huf", "HUF 10.45"], ["80045", "twd", "TWD 800.45"],
    ["1234", "mga", "MGA 1,234"], ["1234", "kwd", "KWD 1234 minor units"], ["1234", "zzz", "ZZZ 1234 minor units"],
  ])("formats %s %s without rounding", (amount, currency, expected) => expect(formatBillingMoney(amount, currency)).toBe(expected));
  it.each(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "vnd", "vuv", "xaf", "xof", "xpf"])("keeps Stripe zero-decimal %s amounts intact", currency => expect(formatBillingMoney("501", currency)).toBe(`${currency.toUpperCase()} 501`));
  it.each(["1e3", "01", "-1", "1.50", "9223372036854775808"])("refuses invalid amounts %s", amount => expect(() => formatBillingMoney(amount, "usd")).toThrow());
});
