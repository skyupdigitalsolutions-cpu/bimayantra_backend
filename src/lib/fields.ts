// Field format dictionary (Section 2A): FLD-01 … FLD-37, each with its exact VAL message.
// GR-06: values are cleaned before checking (trim, collapse spaces in names, upper/lower case, no control
// characters or emoji). GR-01: the server repeats every check, whatever the browser did.
import { settings } from '../modules/settings/settings.service.js';
import { fieldErrors, type FieldError } from './errors.js';
import { addDays, istToday } from './clock.js';
import { verhoeffValid } from './verhoeff.js';
import type { Params } from '../messages/messages.js';

export type RuleResult<T> = { ok: true; value: T } | { ok: false; code: string; params?: Params };
export type Rule<T> = (raw: string) => RuleResult<T>;

const ok = <T>(value: T): RuleResult<T> => ({ ok: true, value });
const bad = (code: string, params?: Params): RuleResult<never> => ({ ok: false, code, ...(params ? { params } : {}) });

const CONTROL_OR_EMOJI = /[\p{Cc}\p{Cf}\p{Extended_Pictographic}]/u;
const len = (s: string) => [...s].length;
const inRange = (s: string, r: { min: number; max: number }) => len(s) >= r.min && len(s) <= r.max;

// ---- FLD-01 Indian mobile number → stored as +91XXXXXXXXXX ----
export const mobile: Rule<string> = (raw) => {
  let d = raw.replace(/[\s\-()]/g, '');
  if (d.startsWith('+91')) d = d.slice(3);
  else if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? ok(`+91${d}`) : bad('VAL-01');
};

// ---- FLD-02 Person name ----
export const personName: Rule<string> = (raw) => {
  const v = raw.trim().replace(/\s+/g, ' ');
  const okChars = /^\p{L}[\p{L}\p{M} .'-]*$/u.test(v) && !CONTROL_OR_EMOJI.test(v);
  const letters = (v.match(/\p{L}/gu) ?? []).length;
  const r = { min: settings.get('CFG-11'), max: settings.get('CFG-12') };
  return okChars && letters >= 2 && inRange(v, r) ? ok(v) : bad('VAL-02');
};

// ---- FLD-03 Email ----
export const email: Rule<string> = (raw) => {
  const v = raw.trim().toLowerCase();
  const parts = v.split('@');
  const valid =
    !/\s/.test(v) &&
    len(v) <= settings.get('CFG-112') &&
    parts.length === 2 &&
    parts[0]!.length >= 1 &&
    parts[0]!.length <= 64 &&
    /^[^.][^@]*\.[a-z]{2,}$/.test(parts[1]!) &&
    !CONTROL_OR_EMOJI.test(v);
  return valid ? ok(v) : bad('VAL-03');
};

// ---- FLD-04 Date (DD-MM-YYYY typed, or YYYY-MM-DD from a date picker) → ISO YYYY-MM-DD ----
export const date: Rule<string> = (raw) => {
  const v = raw.trim();
  let y: number, m: number, d: number;
  let mt = /^(\d{2})-(\d{2})-(\d{4})$/.exec(v);
  if (mt) [d, m, y] = [Number(mt[1]), Number(mt[2]), Number(mt[3])];
  else if ((mt = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v))) [y, m, d] = [Number(mt[1]), Number(mt[2]), Number(mt[3])];
  else return bad('VAL-04');
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return bad('VAL-04');
  return ok(dt.toISOString().slice(0, 10));
};

// ---- FLD-05 Date of birth ----
export const dateOfBirth: Rule<string> = (raw) => {
  const r = date(raw);
  if (!r.ok) return r;
  const today = istToday();
  if (r.value > today) return bad('VAL-05');
  const oldest = shiftYears(today, -settings.get('CFG-14'));
  return r.value < oldest ? bad('VAL-06') : r;
};

// ---- FLD-06 Future date (today or later) ----
export const futureDate: Rule<string> = (raw) => {
  const r = date(raw);
  if (!r.ok) return r;
  return r.value < istToday() ? bad('VAL-07') : r;
};

// ---- FLD-32 Past or today date ----
export const pastOrToday: Rule<string> = (raw) => {
  const r = date(raw);
  if (!r.ok) return r;
  return r.value > istToday() ? bad('VAL-35') : r;
};

// ---- FLD-07 Date range ----
export function dateRange(start: string, end: string): RuleResult<true> {
  return end >= start ? ok(true) : bad('VAL-08');
}

// ---- FLD-08 Amount in rupees → exact decimal string "12500.00" (GR-24) ----
export const amount =
  (opts: { allowZero?: boolean; min?: string; max?: string } = {}): Rule<string> =>
  (raw) => {
    const v = raw.trim();
    // plain digits, or Indian grouping (12,34,567), with up to 2 decimals
    if (!/^(\d+|\d{1,2}(,\d{2})*,\d{3})(\.\d{1,2})?$/.test(v)) return bad('VAL-09');
    const plain = v.replace(/,/g, '');
    const cents = toPaise(plain);
    const min = opts.min ? toPaise(opts.min) : opts.allowZero ? 0n : 1n;
    const max = toPaise(String(opts.max ?? settings.get('CFG-16')));
    if (cents < min || cents > max) return bad('VAL-10', { min: groupIndian(fromPaise(min)), max: groupIndian(fromPaise(max)) });
    return ok(fromPaise(cents));
  };

// ---- FLD-09 Percentage ----
export const percentage: Rule<string> = (raw) => {
  const v = raw.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(v)) return bad('VAL-11');
  const n = toPaise(v);
  return n > 10000n ? bad('VAL-11') : ok(fromPaise(n));
};

// ---- FLD-10 Whole number ----
export const wholeNumber =
  (min: number, max: number): Rule<number> =>
  (raw) => {
    const v = raw.trim();
    if (!/^\d+$/.test(v)) return bad('VAL-12', { min, max });
    const n = Number(v);
    return n >= min && n <= max ? ok(n) : bad('VAL-12', { min, max });
  };

// ---- FLD-11 Address line ----
export const addressLine: Rule<string> = (raw) => {
  const v = raw.trim().replace(/\s+/g, ' ');
  return /^[\p{L}\p{M}\d ,./\-#&()']+$/u.test(v) && inRange(v, { min: 3, max: settings.get('CFG-15') }) ? ok(v) : bad('VAL-13');
};

// ---- FLD-12 City or town ----
export const city: Rule<string> = (raw) => {
  const v = raw.trim().replace(/\s+/g, ' ');
  return /^[\p{L}\p{M} .-]+$/u.test(v) && inRange(v, { min: 2, max: settings.get('CFG-104') }) ? ok(v) : bad('VAL-14');
};

// ---- FLD-13 State or union territory ----
export const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh',
  'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland',
  'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand',
  'West Bengal', 'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi',
  'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
] as const;
export const indianState: Rule<string> = (raw) => {
  const v = raw.trim();
  return (INDIAN_STATES as readonly string[]).includes(v) ? ok(v) : bad('VAL-22');
};

// ---- FLD-14 PIN code ----
export const pinCode: Rule<string> = (raw) => (/^[1-9]\d{5}$/.test(raw.trim()) ? ok(raw.trim()) : bad('VAL-15'));

// ---- FLD-15 PAN of an individual (4th letter P) ----
export const pan: Rule<string> = (raw) => {
  const v = raw.trim().toUpperCase();
  return /^[A-Z]{3}P[A-Z]\d{4}[A-Z]$/.test(v) ? ok(v) : bad('VAL-16');
};

const codeLike = (r: { min: number; max: number }, code: string, pattern = /^[A-Z0-9/-]+$/): Rule<string> => (raw) => {
  const v = raw.trim().toUpperCase();
  return pattern.test(v) && inRange(v, r) ? ok(v) : bad(code);
};

// ---- FLD-16 IRDAI licence / POSP certificate number ----
export const licenceNumber: Rule<string> = (raw) => codeLike(settings.get('CFG-105'), 'VAL-17')(raw);
// ---- FLD-17 Agent code ----
export const agentCode: Rule<string> = (raw) => codeLike(settings.get('CFG-106'), 'VAL-18')(raw);
// ---- FLD-19 Policy number ----
export const policyNumber: Rule<string> = (raw) => codeLike(settings.get('CFG-107'), 'VAL-20')(raw);
// ---- FLD-25 Transaction or receipt reference ----
export const transactionRef: Rule<string> = (raw) => codeLike(settings.get('CFG-108'), 'VAL-30')(raw);
// ---- FLD-28 Product or company code ----
export const code: Rule<string> = (raw) => codeLike(settings.get('CFG-111'), 'VAL-33', /^[A-Z0-9-]+$/)(raw);
// ---- FLD-31 IRDAI product UIN ----
export const productUin: Rule<string> = (raw) => codeLike(settings.get('CFG-105'), 'VAL-37', /^[A-Z0-9]+$/)(raw);

// ---- FLD-18 OTP ----
export const otp: Rule<string> = (raw) => {
  const v = raw.trim();
  return new RegExp(`^\\d{${settings.get('CFG-01')}}$`).test(v) ? ok(v) : bad('VAL-19');
};

// ---- FLD-21 Notes ----
export const notes: Rule<string> = (raw) => {
  const v = raw.trim();
  return len(v) <= settings.get('CFG-13') ? ok(v) : bad('VAL-21');
};

// ---- FLD-23 Web address ----
export const url: Rule<string> = (raw) => {
  const v = raw.trim();
  if (!/^https:\/\/\S+$/.test(v) || len(v) > settings.get('CFG-110')) return bad('VAL-28');
  try {
    new URL(v);
    return ok(v);
  } catch {
    return bad('VAL-28');
  }
};

// ---- FLD-26 Referral code (no 0, O, 1, I) ----
export const referralCode: Rule<string> = (raw) => {
  const v = raw.trim().toUpperCase();
  return new RegExp(`^[A-HJ-NP-Z2-9]{${settings.get('CFG-73')}}$`).test(v) ? ok(v) : bad('VAL-31');
};

// ---- FLD-27 Time of day → "HH:MM" (24 h); accepts "10:30 AM" or "22:30" ----
export const timeOfDay: Rule<string> = (raw) => {
  const v = raw.trim().toUpperCase();
  let m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/.exec(v);
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2]);
    if (h < 1 || h > 12 || min > 59) return bad('VAL-32');
    if (m[3] === 'AM' && h === 12) h = 0;
    if (m[3] === 'PM' && h !== 12) h += 12;
    return ok(`${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`);
  }
  m = /^(\d{2}):(\d{2})$/.exec(v);
  if (m && Number(m[1]) <= 23 && Number(m[2]) <= 59) return ok(v);
  return bad('VAL-32');
};

// ---- FLD-29 Short text (titles, labels, reasons) ----
export const shortText: Rule<string> = (raw) => {
  const v = raw.trim().replace(/\s+/g, ' ');
  return inRange(v, settings.get('CFG-109')) && !/[\p{Cc}]/u.test(v) ? ok(v) : bad('VAL-34');
};

// ---- FLD-30 Indian phone (toll-free, landline or mobile) ----
export const phone: Rule<string> = (raw) => {
  const d = raw.replace(/[\s-]/g, '');
  if (/^(1800|1860)\d{7}$/.test(d)) return ok(d);
  // 11 digits starting with 0 is a landline (area codes such as 080 also start with 8)
  if (/^0[1-9]\d{9}$/.test(d)) return ok(d);
  const m = mobile(raw);
  return m.ok ? m : bad('VAL-36');
};

// ---- FLD-33 Aadhaar (12 digits, first 2–9, Verhoeff check digit) ----
export const aadhaar: Rule<string> = (raw) => {
  const v = raw.replace(/\s/g, '');
  return /^[2-9]\d{11}$/.test(v) && verhoeffValid(v) ? ok(v) : bad('VAL-38');
};

// ---- FLD-34 GSTIN (optional) ----
export const gstin: Rule<string> = (raw) => {
  const v = raw.trim().toUpperCase();
  return /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(v) ? ok(v) : bad('VAL-39');
};

// ---- FLD-35 Vehicle registration number (standard or Bharat series) ----
export const vehicleRegistration: Rule<string> = (raw) => {
  const v = raw.toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}$/.test(v) || /^\d{2}BH\d{4}[A-Z]{1,2}$/.test(v) ? ok(v) : bad('VAL-40');
};

// ---- FLD-36 Cheque number ----
export const chequeNumber: Rule<string> = (raw) => (/^\d{6}$/.test(raw.trim()) ? ok(raw.trim()) : bad('VAL-41'));

// ---- FLD-37 Document label ----
export const documentLabel: Rule<string> = (raw) => {
  const v = raw.trim().replace(/\s+/g, ' ');
  return /^[\p{L}\p{M}\d \-_.,()/]+$/u.test(v) && inRange(v, settings.get('CFG-172')) ? ok(v) : bad('VAL-42');
};

// ---------- form helper ----------
// A field spec: label (for GEN-01 "{Field label} is required."), whether required, and its rule.
// Booleans use `checkbox` (FLD-24 → VAL-29); choices use `oneOf` (FLD-20 → VAL-22).
export type FieldSpec = {
  label: string;
  required?: boolean;
  rule?: Rule<unknown>;
  checkbox?: boolean;
  oneOf?: readonly string[];
};

/**
 * Check a request body against field specs. Collects every error (GR-03 shows them all at once) and
 * throws 422 with the field list; returns the cleaned values otherwise.
 */
export function parseFields<S extends Record<string, FieldSpec>>(body: unknown, specs: S): { [K in keyof S]: unknown } {
  const input = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const errors: FieldError[] = [];
  for (const [name, spec] of Object.entries(specs)) {
    const raw = input[name];
    if (spec.checkbox) {
      if (raw !== true) errors.push({ field: name, code: 'VAL-29' });
      else out[name] = true;
      continue;
    }
    const empty = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
    if (empty) {
      if (spec.required) errors.push({ field: name, code: 'GEN-01', params: { 'Field label': spec.label } });
      else out[name] = undefined;
      continue;
    }
    const str = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : null;
    if (str === null) {
      errors.push({ field: name, code: spec.oneOf ? 'VAL-22' : 'GEN-01', params: { 'Field label': spec.label } });
      continue;
    }
    if (spec.oneOf) {
      if (!spec.oneOf.includes(str.trim())) errors.push({ field: name, code: 'VAL-22' });
      else out[name] = str.trim();
      continue;
    }
    if (spec.rule) {
      const r = spec.rule(str);
      if (r.ok) out[name] = r.value;
      else errors.push({ field: name, code: r.code, ...(r.params ? { params: r.params } : {}) });
    } else out[name] = str.trim();
  }
  if (errors.length) throw fieldErrors(errors);
  return out as { [K in keyof S]: unknown };
}

// ---------- money helpers (exact decimals, GR-24) ----------
function toPaise(v: string): bigint {
  const [whole, frac = ''] = v.split('.');
  return BigInt(whole!) * 100n + BigInt((frac + '00').slice(0, 2));
}
function fromPaise(p: bigint): string {
  const s = p.toString().padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}
/** Indian digit grouping with 2 decimals, no symbol: 1,23,456.00 (the message text adds the ₹) */
export function groupIndian(v: string): string {
  const [whole, frac] = v.split('.');
  const w = whole!;
  const last3 = w.slice(-3);
  const rest = w.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest ? `${rest},` : ''}${last3}.${(frac ?? '00').padEnd(2, '0')}`;
}
/** ₹ with Indian digit grouping and 2 decimals: ₹1,23,456.00 (GR-24) */
export const formatRupees = (v: string): string => `₹${groupIndian(v)}`;

function shiftYears(isoDate: string, years: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const target = new Date(Date.UTC(y! + years, m! - 1, d));
  // 29 February in a non-leap year falls back to 28 February
  if (target.getUTCMonth() !== m! - 1) return addDays(target.toISOString().slice(0, 10), -target.getUTCDate());
  return target.toISOString().slice(0, 10);
}
