/** A non-negative Stripe minor-unit amount as an exact decimal string (never a JavaScript Number). */
export function parseMinorAmount(value: unknown): string {
  if (typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n) return value;
  throw new Error("Invalid minor-unit amount");
}

// Stripe charge/invoice units, reviewed 2026-09-11:
// https://docs.stripe.com/currencies#zero-decimal and #special-cases.
// ISO/Intl currency exponents do not represent Stripe's ISK/UGX compatibility units.
const zeroDecimal = new Set("bif clp djf gnf jpy kmf krw mga pyg rwf vnd vuv xaf xof xpf".split(" "));
const twoDecimal = new Set((
  "usd aed afn all amd ang aoa ars aud awg azn bam bbd bdt bgn bmd bnd bob brl bsd bwp byn bzd cad cdf chf cny cop crc cve czk dkk dop dzd egp etb eur fjd fkp gbp gel gip gmd gtq gyd hkd hnl htg huf idr ils inr isk jmd kes kgs khr kyd kzt lak lbp lkr lrd lsl mad mdl mkd mmk mnt mop mur mvr mwk mxn myr mzn nad ngn nio nok npr nzd pab pen pgk php pkr pln qar ron rsd rub sar sbd scr sek sgd shp sle sos srd std szl thb tjs top try ttd twd tzs uah ugx uyu uzs wst xcd xcg yer zar zmw"
).split(" "));
function group(value: string) { return value.replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

/** Exact string arithmetic; unsupported currency rules retain the raw minor-unit value. */
export function formatBillingMoney(amount: string, currency: string): string {
  const digits = parseMinorAmount(amount);
  if (!/^[a-z]{3}$/.test(currency)) throw new Error("Invalid currency");
  const code = currency.toUpperCase();
  if (zeroDecimal.has(currency)) return `${code} ${group(digits)}`;
  if (!twoDecimal.has(currency)) return `${code} ${digits} minor units`;
  const padded = digits.padStart(3, "0");
  return `${code} ${group(padded.slice(0, -2))}.${padded.slice(-2)}`;
}
