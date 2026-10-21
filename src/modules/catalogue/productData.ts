// P-22 product fields: parsing, the checks before save or submit (CAT-13), the field-by-field comparison
// used by approvers (P-25), and the advisor view where "Not stated in source" reads "Not stated by insurer"
// (AC-P22-5). Numbers come from configuration: ages CFG-150, child band CFG-153, policy term CFG-58,
// add-ons CFG-40, nominees CFG-53, grace period CFG-62.
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { formatDate } from '../../lib/clock.js';
import { files } from '../../db/schema.js';
import { AppError, fieldErrors, type FieldError } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import type { Params } from '../../messages/messages.js';
import { settings } from '../settings/settings.service.js';
import { isUuid, scalar } from './common.js';
import type { Feature } from './types.service.js';

export const PRICING_MODES = ['RATE_TABLE', 'MANUAL_ENTRY'] as const;
export const RIDER_PRICE_TYPES = ['FIXED', 'PERCENT'] as const;

export type FeatureValue = { value: string | null; notStated: boolean; sourcePage: number | null; ocrCheckedBy?: string | null };
export type Rider = { key: string; name: string; description: string | null; priceType: (typeof RIDER_PRICE_TYPES)[number]; value: string };
export type SumInsured = { mode: 'OPTIONS'; options: string[] } | { mode: 'RANGE'; min: string; max: string };
export type ProductData = {
  name: string;
  shortDescription: string;
  uin: string;
  launchDate: string | null;
  adultMinAge: number | null;
  adultMaxAge: number | null;
  coversChildren: boolean;
  childMinAge: number | null;
  childMaxAge: number | null;
  sumInsured: SumInsured | null;
  policyTerms: number[];
  features: Record<string, FeatureValue>;
  riders: Rider[];
  pricingMode: (typeof PRICING_MODES)[number] | null;
  taxPercent: string | null;
  nomineeRequired: boolean;
  maxNominees: number | null;
  graceDays: number | null;
  brochureFileId: string | null;
  wordingFileId: string | null;
  sourceLink: string | null;
  sourceCheckedOn: string | null;
};

export const FIELD_LABELS: Record<string, string> = {
  name: 'Product name',
  shortDescription: 'Short description',
  uin: 'IRDAI product UIN',
  launchDate: 'Launch date',
  adultMinAge: 'Adult entry age minimum',
  adultMaxAge: 'Adult entry age maximum',
  coversChildren: 'Covers children',
  childMinAge: 'Child entry age minimum',
  childMaxAge: 'Child entry age maximum',
  sumInsured: 'Sum insured',
  policyTerms: 'Policy term options',
  riders: 'Riders and add-ons',
  pricingMode: 'Pricing mode',
  taxPercent: 'Tax %',
  nomineeRequired: 'Nominee required',
  maxNominees: 'Most nominees',
  graceDays: 'Grace period in days',
  brochureFileId: 'Brochure',
  wordingFileId: 'Policy wording',
  sourceLink: 'Insurer page link',
  sourceCheckedOn: 'Date checked',
};

/** Validate one feature value by its data type (Section P-21 data types). */
export function parseFeatureValue(f: Pick<Feature, 'dataType'>, raw: string): F.RuleResult<string> {
  const v = raw.trim();
  switch (f.dataType) {
    case 'YES_NO':
      return /^(yes|no)$/i.test(v) ? { ok: true, value: v.toLowerCase() === 'yes' ? 'Yes' : 'No' } : { ok: false, code: 'VAL-22' };
    case 'NUMBER': {
      const r = F.wholeNumber(0, 999_999_999)(v);
      return r.ok ? { ok: true, value: String(r.value) } : r;
    }
    case 'AMOUNT':
      return F.amount({ allowZero: true })(v);
    case 'PERCENT':
      return F.percentage(v);
    case 'DAYS':
    case 'MONTHS':
    case 'YEARS': {
      const r = F.wholeNumber(0, 36_500)(v);
      return r.ok ? { ok: true, value: String(r.value) } : r;
    }
    default:
      return F.notes(v);
  }
}

const UNIT: Record<string, string> = { DAYS: 'days', MONTHS: 'months', YEARS: 'years' };
/** How a value reads to an advisor. */
export function displayValue(f: Pick<Feature, 'dataType'>, fv: FeatureValue | undefined): string | null {
  if (!fv) return null;
  if (fv.notStated) return 'Not stated by insurer';
  if (fv.value === null) return null;
  if (f.dataType === 'AMOUNT') return F.formatRupees(fv.value);
  if (f.dataType === 'PERCENT') return `${fv.value}%`;
  if (UNIT[f.dataType]) return `${fv.value} ${UNIT[f.dataType]}`;
  return fv.value;
}

type Ctx = { kind: 'VERIFIED' | 'OWN'; accountId: string | null; features: Feature[] };

/**
 * Parse the product form. Format errors throw 422 with every field (GR-03); a missing UIN throws CAT-33
 * (a product without a UIN is never saved, AC-P22-1). Missing items are returned for the CAT-13 check.
 */
export async function parseProductData(body: unknown, ctx: Ctx, previous?: ProductData): Promise<ProductData> {
  const b = (body ?? {}) as Record<string, unknown>;
  const errors: FieldError[] = [];
  const push = (field: string, r: { code: string; params?: Params }) => errors.push({ field, code: r.code, ...(r.params ? { params: r.params } : {}) });
  const has = (v: unknown) => v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '');
  const str = (v: unknown) => (typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '');
  function opt<T>(field: string, rule: F.Rule<T>): T | null {
    if (!has(b[field])) return null;
    const r = rule(str(b[field]));
    if (!r.ok) {
      push(field, r);
      return null;
    }
    return r.value;
  }

  // Identity
  const uinRaw = b.uin;
  let uin = '';
  if (!has(uinRaw)) errors.push({ field: 'uin', code: 'CAT-33' });
  else {
    const r = F.productUin(str(uinRaw));
    if (r.ok) uin = r.value;
    else push('uin', r);
  }
  const name = opt('name', F.shortText) ?? '';
  const shortDescription = opt('shortDescription', F.shortText) ?? '';
  const launchDate = opt('launchDate', F.date);

  // Eligibility
  const maxAge = settings.get('CFG-150');
  const adultMinAge = opt('adultMinAge', F.wholeNumber(0, maxAge));
  const adultMaxAge = opt('adultMaxAge', F.wholeNumber(0, maxAge));
  if (adultMinAge !== null && adultMaxAge !== null && adultMinAge > adultMaxAge) errors.push({ field: 'adultMaxAge', code: 'CAT-16' });
  const coversChildren = b.coversChildren === true;
  let childMinAge: number | null = null;
  let childMaxAge: number | null = null;
  if (coversChildren) {
    const band = settings.get('CFG-153');
    childMinAge = has(b.childMinAge) ? opt('childMinAge', F.wholeNumber(0, maxAge)) : band.min;
    childMaxAge = has(b.childMaxAge) ? opt('childMaxAge', F.wholeNumber(0, maxAge)) : band.max;
    if (childMinAge !== null && childMaxAge !== null) {
      if (childMinAge > childMaxAge) errors.push({ field: 'childMaxAge', code: 'CAT-16' });
      else if (adultMaxAge !== null && childMaxAge > adultMaxAge) errors.push({ field: 'childMaxAge', code: 'CAT-34' });
    }
  }
  let sumInsured: SumInsured | null = null;
  const si = b.sumInsured as Record<string, unknown> | null | undefined;
  if (si && typeof si === 'object') {
    const amt = F.amount();
    if (si.mode === 'RANGE') {
      const min = has(si.min) ? amt(str(si.min)) : null;
      const max = has(si.max) ? amt(str(si.max)) : null;
      if (min && !min.ok) push('sumInsured.min', min);
      if (max && !max.ok) push('sumInsured.max', max);
      if (min?.ok && max?.ok) {
        if (Number(min.value) > Number(max.value)) errors.push({ field: 'sumInsured.max', code: 'CAT-16' });
        else sumInsured = { mode: 'RANGE', min: min.value, max: max.value };
      }
    } else if (si.mode === 'OPTIONS') {
      const raw = Array.isArray(si.options) ? si.options : [];
      const options: string[] = [];
      raw.forEach((o, i) => {
        const r = amt(str(o));
        if (r.ok) options.push(r.value);
        else push(`sumInsured.options.${i}`, r);
      });
      if (options.length) sumInsured = { mode: 'OPTIONS', options: [...new Set(options)].sort((x, y) => Number(x) - Number(y)) };
    } else errors.push({ field: 'sumInsured.mode', code: 'VAL-22' });
  }
  const policyTerms: number[] = [];
  (Array.isArray(b.policyTerms) ? b.policyTerms : []).forEach((t, i) => {
    const r = F.wholeNumber(1, settings.get('CFG-58'))(str(t));
    if (r.ok) policyTerms.push(r.value);
    else push(`policyTerms.${i}`, r);
  });

  // Features: one value per template feature
  const featIn = (b.features ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const features: Record<string, FeatureValue> = {};
  for (const f of ctx.features) {
    const fv = featIn[f.key];
    if (!fv) continue;
    const notStated = fv.notStated === true;
    let value: string | null = null;
    if (!notStated && has(fv.value)) {
      const r = parseFeatureValue(f, str(fv.value));
      if (r.ok) value = r.value;
      else push(`features.${f.key}`, r);
    }
    let sourcePage: number | null = null;
    if (has(fv.sourcePage)) {
      const r = F.wholeNumber(1, 9999)(str(fv.sourcePage));
      if (r.ok) sourcePage = r.value;
      else push(`features.${f.key}.sourcePage`, r);
    }
    // "Read by OCR, checked by {name}" stays only while the value is unchanged (P-23 step 5)
    const prev = previous?.features[f.key];
    const ocrCheckedBy = prev?.ocrCheckedBy && prev.value === value && prev.notStated === notStated ? prev.ocrCheckedBy : null;
    if (notStated || value !== null || sourcePage !== null) features[f.key] = { value: notStated ? null : value, notStated, sourcePage, ...(ocrCheckedBy ? { ocrCheckedBy } : {}) };
  }

  // Riders and add-ons
  const ridersIn = Array.isArray(b.riders) ? (b.riders as Record<string, unknown>[]) : [];
  const maxRiders = settings.get('CFG-40');
  if (ridersIn.length > maxRiders) errors.push({ field: 'riders', code: 'CAT-15' });
  const riders: Rider[] = [];
  ridersIn.slice(0, maxRiders).forEach((r, i) => {
    const n = has(r.name) ? F.shortText(str(r.name)) : null;
    if (!n) errors.push({ field: `riders.${i}.name`, code: 'GEN-01', params: { 'Field label': 'Rider name' } });
    else if (!n.ok) push(`riders.${i}.name`, n);
    const d = has(r.description) ? F.shortText(str(r.description)) : null;
    if (d && !d.ok) push(`riders.${i}.description`, d);
    const priceType = r.priceType === 'PERCENT' ? 'PERCENT' : r.priceType === 'FIXED' ? 'FIXED' : null;
    if (!priceType) errors.push({ field: `riders.${i}.priceType`, code: 'VAL-22' });
    const val = has(r.value) ? (priceType === 'PERCENT' ? F.percentage(str(r.value)) : F.amount()(str(r.value))) : null;
    if (!val) errors.push({ field: `riders.${i}.value`, code: 'GEN-01', params: { 'Field label': 'Rider price' } });
    else if (!val.ok) push(`riders.${i}.value`, val);
    if (n?.ok && priceType && val?.ok)
      riders.push({ key: typeof r.key === 'string' && /^[a-z0-9_]{1,40}$/.test(r.key) ? r.key : `r_${randomBytes(3).toString('hex')}`, name: n.value, description: d?.ok ? d.value : null, priceType, value: val.value });
  });

  // Pricing, nominees, renewal
  let pricingMode: ProductData['pricingMode'] = null;
  if (has(b.pricingMode)) {
    if ((PRICING_MODES as readonly string[]).includes(str(b.pricingMode))) pricingMode = str(b.pricingMode) as ProductData['pricingMode'];
    else errors.push({ field: 'pricingMode', code: 'VAL-22' });
  }
  const taxPercent = opt('taxPercent', F.percentage);
  const maxNominees = opt('maxNominees', F.wholeNumber(1, settings.get('CFG-53')));
  const graceDays = opt('graceDays', F.wholeNumber(0, 365));

  // Documents and source
  const fileOk = async (field: string, purpose: string): Promise<string | null> => {
    if (!has(b[field])) return null;
    const id = b[field];
    const [f] = isUuid(id) ? await db.select().from(files).where(eq(files.id, id)) : [];
    if (!f || f.purpose !== purpose || f.accountId !== ctx.accountId) {
      errors.push({ field, code: 'VAL-22' });
      return null;
    }
    return f.id;
  };
  const brochureFileId = await fileOk('brochureFileId', 'BROCHURE');
  const wordingFileId = await fileOk('wordingFileId', 'POLICY_WORDING');
  const sourceLink = opt('sourceLink', F.url);
  const sourceCheckedOn = opt('sourceCheckedOn', F.date);

  if (errors.length) throw fieldErrors(errors);
  return {
    name,
    shortDescription,
    uin,
    launchDate,
    adultMinAge,
    adultMaxAge,
    coversChildren,
    childMinAge,
    childMaxAge,
    sumInsured,
    policyTerms: [...new Set(policyTerms)].sort((x, y) => x - y),
    features,
    riders,
    pricingMode,
    taxPercent,
    nomineeRequired: b.nomineeRequired === true,
    maxNominees,
    graceDays,
    brochureFileId,
    wordingFileId,
    sourceLink,
    sourceCheckedOn,
  };
}

/** Everything still missing before save (own) or submit (verified). Returns field + human label. */
export function missingItems(d: ProductData, ctx: { kind: 'VERIFIED' | 'OWN'; features: Feature[] }): { field: string; label: string }[] {
  const m: { field: string; label: string }[] = [];
  const need = (ok: unknown, field: string, label = FIELD_LABELS[field]!) => {
    if (!ok) m.push({ field, label: label.toLowerCase() });
  };
  need(d.name, 'name');
  need(d.shortDescription, 'shortDescription');
  need(d.launchDate, 'launchDate');
  need(d.adultMinAge !== null && d.adultMaxAge !== null, 'adultMinAge', 'Adult entry age range');
  need(!d.coversChildren || (d.childMinAge !== null && d.childMaxAge !== null), 'childMinAge', 'Child entry band');
  need(d.sumInsured, 'sumInsured');
  need(d.policyTerms.length > 0, 'policyTerms', 'Policy term');
  need(d.pricingMode, 'pricingMode');
  need(d.taxPercent !== null, 'taxPercent');
  need(d.maxNominees !== null, 'maxNominees');
  need(d.brochureFileId || d.sourceLink, 'brochureFileId', 'Brochure or source link');
  if (ctx.kind === 'VERIFIED') need(d.sourceCheckedOn, 'sourceCheckedOn');
  for (const f of ctx.features) {
    if (!f.requiredToPublish) continue;
    const v = d.features[f.key];
    if (!v || (!v.notStated && v.value === null)) m.push({ field: `features.${f.key}`, label: f.name });
  }
  return m;
}

/** CAT-13 with the list, and each missing field marked so the form can show where. */
export function cannotSave(items: { field: string; label: string }[]): AppError {
  const list = items.map((i) => i.label).join(', ');
  return new AppError(422, 'CAT-13', { list }, items.map((i) => ({ field: i.field, code: 'GEN-01', params: { 'Field label': i.label } })));
}

/** Field-by-field changes against the published version (P-25 step 2). */
export function diffData(oldD: ProductData | null, newD: ProductData, features: Feature[]) {
  const out: { field: string; label: string; old: string | null; new: string | null }[] = [];
  const show = (v: unknown): string | null => {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (Array.isArray(v)) return v.length ? v.map((x: unknown) => (typeof x === 'object' ? JSON.stringify(x) : scalar(x))).join(', ') : null;
    if (typeof v === 'object') {
      const s = v as SumInsured;
      if ('mode' in s) return s.mode === 'RANGE' ? `${F.formatRupees(s.min)} to ${F.formatRupees(s.max)}` : s.options.map(F.formatRupees).join(', ');
      return JSON.stringify(v);
    }
    return scalar(v);
  };
  const PRICING: Record<string, string> = { RATE_TABLE: 'Rate table', MANUAL_ENTRY: 'Manual entry' };
  const shown = (k: string, v: unknown): string | null => {
    if ((k === 'launchDate' || k === 'sourceCheckedOn') && typeof v === 'string') return formatDate(v);
    if (k === 'pricingMode' && typeof v === 'string') return PRICING[v] ?? v;
    if (k === 'taxPercent' && typeof v === 'string') return `${v}%`;
    if (k === 'policyTerms' && Array.isArray(v) && v.length) return `${v.join(', ')} years`;
    return show(v);
  };
  for (const [k, label] of Object.entries(FIELD_LABELS)) {
    if (k === 'riders') continue;
    const a = shown(k, oldD ? (oldD as Record<string, unknown>)[k] : null);
    const b = shown(k, (newD as Record<string, unknown>)[k]);
    if (a !== b) out.push({ field: k, label, old: a, new: b });
  }
  const riderText = (d: ProductData | null) => (d?.riders.length ? d.riders.map((r) => `${r.name} (${r.priceType === 'PERCENT' ? `${r.value}%` : F.formatRupees(r.value)})`).join('; ') : null);
  if (riderText(oldD) !== riderText(newD)) out.push({ field: 'riders', label: FIELD_LABELS.riders!, old: riderText(oldD), new: riderText(newD) });
  for (const f of features) {
    const a = displayValue(f, oldD?.features[f.key]);
    const b = displayValue(f, newD.features[f.key]);
    if (a !== b) out.push({ field: `features.${f.key}`, label: f.name, old: a, new: b });
  }
  return out;
}

/** The advisor's view of features, grouped and in comparison order. */
export function featureView(d: ProductData, features: Feature[]) {
  return [...features]
    .sort((a, b) => a.order - b.order)
    .map((f) => ({
      key: f.key,
      name: f.name,
      group: f.group,
      dataType: f.dataType,
      help: f.help,
      value: displayValue(f, d.features[f.key]),
      sourcePage: d.features[f.key]?.sourcePage ?? null,
      checkedNote: d.features[f.key]?.ocrCheckedBy ? `Read by OCR, checked by ${d.features[f.key]!.ocrCheckedBy}` : null,
    }));
}
