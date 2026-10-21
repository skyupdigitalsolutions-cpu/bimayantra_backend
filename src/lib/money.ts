// Exact money arithmetic (GR-24): amounts are fixed-point integers with 10 decimal places, so every step of the
// premium calculation (base → riders → override → discount → GST) keeps full precision. The final payable is
// rounded once, half-up, to 2 decimals. Never use JavaScript floating point for money.
const SCALE = 10n ** 10n;

export type Money = bigint;

/** "12500.5" or "12500.50" → fixed-point. Accepts up to 10 decimals; throws on anything else. */
export function money(v: string | number): Money {
  const s = typeof v === 'number' ? v.toFixed(2) : v.trim();
  const m = /^(-)?(\d+)(?:\.(\d{1,10}))?$/.exec(s);
  if (!m) throw new Error(`Not an amount: ${s}`);
  const frac = (m[3] ?? '').padEnd(10, '0');
  const n = BigInt(m[2]!) * SCALE + BigInt(frac);
  return m[1] ? -n : n;
}

export const add = (...xs: Money[]): Money => xs.reduce((a, b) => a + b, 0n);
export const sub = (a: Money, b: Money): Money => a - b;
/** a × p% where p is a percentage string with up to 2 decimals ("18", "12.5"). Exact at this scale. */
export const pct = (a: Money, p: string): Money => (a * money(p)) / (100n * SCALE);

/** Round half-up to 2 decimals and format as "12345.67". */
export function round2(a: Money): string {
  const neg = a < 0n;
  const abs = neg ? -a : a;
  const unit = SCALE / 100n;
  let cents = abs / unit;
  if (abs % unit >= unit / 2n) cents += 1n;
  const s = `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}

export const cmp = (a: Money, b: Money): number => (a === b ? 0 : a > b ? 1 : -1);
export const absDiff = (a: Money, b: Money): Money => (a > b ? a - b : b - a);

/** Indian grouping for display: 1234567.5 → "12,34,567.50". */
export function inr(v: string | Money): string {
  const s = typeof v === 'bigint' ? round2(v) : round2(money(v));
  const [i, f] = s.replace('-', '').split('.');
  const last3 = i!.slice(-3);
  const rest = i!.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${s.startsWith('-') ? '-' : ''}${rest ? `${rest},` : ''}${last3}.${f}`;
}
