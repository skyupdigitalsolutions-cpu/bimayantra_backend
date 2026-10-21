// The premium engine and the quotation checks shared by best fit (P-26), normal quotations (P-27) and
// comparisons (P-30). Section 11.1: the server always calculates; the order is fixed (base → riders →
// override → discount → GST) and the final payable is rounded once, half-up, to 2 decimals (GR-24).
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.js';
import {
  advisorProfiles,
  customers,
  familyMembers,
  insuranceTypes,
  insurerMappings,
  insurers,
  priceVersions,
  products,
  productVersions,
  templateVersions,
  vehicles,
} from '../../db/schema.js';
import { formatDate, istToday } from '../../lib/clock.js';
import type { FieldError } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import { add, cmp, money, pct, round2, sub, type Money } from '../../lib/money.js';
import type { Params } from '../../messages/messages.js';
import { effectiveStatus } from '../catalogue/products.service.js';
import { parseFeatureValue, type ProductData } from '../catalogue/productData.js';
import { priceInEffect, type RateRow } from '../catalogue/prices.service.js';
import { bandLabel, type Factor, type Feature, type Question } from '../catalogue/types.service.js';
import { settings } from '../settings/settings.service.js';

export const CUSTOMER_KEY = 'customer';
// A dependent child is a son, daughter, grandson or granddaughter inside the child age band (document change 34)
const CHILD_RELATIONS = ['Son', 'Daughter', 'Grandson', 'Granddaughter'];

export type Person = { key: string; name: string; relationship: string; dateOfBirth: string | null; age: number | null; mobile: string | null; active: boolean };
export type Inputs = {
  typeId?: string;
  insurerId?: string;
  productId?: string;
  people?: string[];
  sumInsured?: string;
  term?: string | number;
  startDate?: string;
  answers?: Record<string, string>;
  factors?: Record<string, string>;
  vehicleId?: string | null;
  riders?: string[];
  manual?: { netPremium?: string; taxAmount?: string } | null;
  override?: { amount?: string; reason?: string } | null;
  discount?: { kind?: string; value?: string; reference?: string } | null;
};

export type Breakdown = {
  mode: 'RATE_TABLE' | 'MANUAL_ENTRY';
  base: string;
  riders: { key: string; name: string; amount: string }[];
  calculated: string;
  override: { amount: string; reason: string } | null;
  beforeDiscount: string;
  discount: { kind: string; value: string; reference: string; amount: string } | null;
  afterDiscount: string;
  taxPercent: string;
  tax: string;
  finalPayable: string;
  priceVersion: { id: string; name: string; effectiveFrom: string } | null;
  eldestAge: number | null;
  calculatedOn: string;
};

/** Whole years on a date (IST calendar dates, P-27 backend rules). */
export function ageOn(dob: string | null, on: string): number | null {
  if (!dob) return null;
  const [y, m, d] = dob.split('-').map(Number);
  const [ty, tm, td] = on.split('-').map(Number);
  let age = ty! - y!;
  if (tm! < m! || (tm === m && td! < d!)) age -= 1;
  return age;
}

export async function loadPeople(dbx: DbOrTx, accountId: string, customerId: string, on = istToday()): Promise<Person[]> {
  const [c] = await dbx.select().from(customers).where(and(eq(customers.id, customerId), eq(customers.accountId, accountId)));
  if (!c) return [];
  const members = await dbx.select().from(familyMembers).where(eq(familyMembers.customerId, customerId)).orderBy(asc(familyMembers.createdAt));
  return [
    { key: CUSTOMER_KEY, name: c.fullName, relationship: 'Self', dateOfBirth: c.dateOfBirth, age: ageOn(c.dateOfBirth, on), mobile: c.mobile, active: c.status === 'ACTIVE' },
    ...members.map((m) => ({ key: m.id, name: m.fullName, relationship: m.relationship, dateOfBirth: m.dateOfBirth, age: ageOn(m.dateOfBirth, on), mobile: m.mobile, active: m.status === 'ACTIVE' })),
  ];
}

export function childBand(data: ProductData) {
  const band = settings.get('CFG-153');
  return { min: data.childMinAge ?? band.min, max: data.childMaxAge ?? band.max };
}
export const isChild = (p: Person, data: ProductData) => p.age !== null && CHILD_RELATIONS.includes(p.relationship) && p.age <= childBand(data).max;

/** QT-05 / QT-06 for one person against the product's adult or child band. */
export function bandIssue(p: Person, data: ProductData): { code: string; params: Params } | null {
  if (p.age === null) return { code: 'QT-05', params: { name: p.name } };
  const child = isChild(p, data) && data.coversChildren;
  const min = child ? childBand(data).min : data.adultMinAge;
  const max = child ? childBand(data).max : data.adultMaxAge;
  if (min === null || max === null) return null;
  if (p.age < min || p.age > max) return { code: 'QT-06', params: { Name: p.name, age: p.age, min, max } };
  return null;
}

export function coverage(people: Person[], data: ProductData) {
  const out = people.filter((p) => bandIssue(p, data) !== null);
  return { n: people.length - out.length, m: people.length, notCovered: out.map((p) => p.name) };
}

export const sumInsuredAllowed = (data: ProductData, v: string) => {
  const si = data.sumInsured;
  if (!si) return false;
  if (si.mode === 'OPTIONS') return si.options.some((o) => Number(o) === Number(v));
  return Number(v) >= Number(si.min) && Number(v) <= Number(si.max);
};

// ---------- product context ----------
export type ProductCtx = {
  productId: string;
  kind: string;
  code: string;
  insurerId: string;
  insurerName: string;
  insurerStatus: string;
  paymentDomains: string[];
  typeId: string;
  typeName: string;
  typeStatus: string;
  status: string;
  versionId: string;
  versionNo: number;
  data: ProductData;
  features: Feature[];
  factors: Factor[];
  questions: Question[];
};

export async function productCtx(dbx: DbOrTx, accountId: string, productId: string): Promise<ProductCtx | null> {
  if (!/^[0-9a-f-]{36}$/.test(productId)) return null;
  const [r] = await dbx
    .select({ p: products, v: productVersions, t: templateVersions, i: insurers, ty: insuranceTypes })
    .from(products)
    .innerJoin(productVersions, eq(productVersions.id, products.publishedVersionId))
    .innerJoin(templateVersions, eq(templateVersions.id, productVersions.templateVersionId))
    .innerJoin(insurers, eq(insurers.id, products.insurerId))
    .innerJoin(insuranceTypes, eq(insuranceTypes.id, products.typeId))
    .where(and(eq(products.id, productId), or(isNull(products.accountId), eq(products.accountId, accountId))));
  if (!r) return null;
  return {
    productId: r.p.id,
    kind: r.p.kind,
    code: r.p.code,
    insurerId: r.i.id,
    insurerName: r.i.name,
    insurerStatus: r.i.status,
    paymentDomains: r.i.paymentDomains,
    typeId: r.ty.id,
    typeName: r.ty.name,
    typeStatus: r.ty.status,
    status: effectiveStatus(r.p, r.v),
    versionId: r.v.id,
    versionNo: r.v.versionNo,
    data: r.v.data as ProductData,
    features: r.t.features as Feature[],
    factors: r.t.factors as Factor[],
    questions: r.t.questions as Question[],
  };
}

/** Products of a type the account can see, with their context (for best fit and the wizard lists). */
export async function productsOfType(accountId: string, typeId: string, insurerId?: string): Promise<ProductCtx[]> {
  const rows = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.typeId, typeId), or(isNull(products.accountId), eq(products.accountId, accountId)), insurerId ? eq(products.insurerId, insurerId) : undefined));
  const out: ProductCtx[] = [];
  for (const r of rows) {
    const c = await productCtx(db, accountId, r.id);
    if (c) out.push(c);
  }
  return out.sort((a, b) => a.data.name.localeCompare(b.data.name));
}

export type Mapping = { agentCode: string; codeValidUntil: string | null; status: string };
export async function mappingFor(dbx: DbOrTx, accountId: string, insurerId: string): Promise<Mapping | null> {
  const [m] = await dbx.select().from(insurerMappings).where(and(eq(insurerMappings.accountId, accountId), eq(insurerMappings.insurerId, insurerId)));
  return m ? { agentCode: m.agentCode, codeValidUntil: m.codeValidUntil, status: m.status } : null;
}

/** QT-12 / PRF-11 for the advisor's mapping to an insurer. */
export function mappingIssue(m: Mapping | null, insurerName: string, insurerStatus: string): { code: string; params: Params } | null {
  if (!m || m.status !== 'ACTIVE' || insurerStatus !== 'ACTIVE') return { code: 'QT-12', params: { insurer: insurerName } };
  if (m.codeValidUntil && m.codeValidUntil < istToday()) return { code: 'PRF-11', params: { insurer: insurerName, date: formatDate(m.codeValidUntil) } };
  return null;
}

export async function advisorFacts(dbx: DbOrTx, accountId: string) {
  const [p] = await dbx.select().from(advisorProfiles).where(eq(advisorProfiles.accountId, accountId));
  return {
    name: p?.fullName ?? '',
    businessName: p?.businessName ?? null,
    logoFileId: p?.logoFileId ?? null,
    email: p?.email ?? null,
    licenceNumber: p?.licenceNumber ?? null,
    licenceValidUntil: p?.licenceValidUntil ?? null,
    authorisedTypeIds: p?.authorisedTypeIds ?? [],
  };
}

export const licenceIssue = (validUntil: string | null): { code: string; params: Params } | null =>
  validUntil && validUntil < istToday() ? { code: 'PRF-17', params: { date: formatDate(validUntil) } } : null;

/** QT-11 / QT-07: can this product be quoted now? A renewal quotation may use a WITHDRAWN product (P-38). */
export async function productIssue(accountId: string, ctx: ProductCtx, opts: { renewal?: boolean } = {}): Promise<{ code: string; params: Params } | null> {
  const name = ctx.data.name;
  const insurerOk = ctx.insurerStatus === 'ACTIVE' || opts.renewal;
  const typeOk = ctx.typeStatus === 'ACTIVE' || opts.renewal;
  if (ctx.status === 'UPCOMING' || (ctx.status === 'WITHDRAWN' && !opts.renewal) || !insurerOk || !typeOk) return { code: 'QT-11', params: { Product: name } };
  if (ctx.data.pricingMode === 'RATE_TABLE' && !(await priceInEffect(db, accountId, ctx.productId))) return { code: 'QT-07', params: { Product: name } };
  if (!ctx.data.pricingMode) return { code: 'QT-07', params: { Product: name } };
  return null;
}

// ---------- the calculation ----------
const sameValue = (a: string, b: string) => a === b || (/^\d+(\.\d+)?$/.test(a) && /^\d+(\.\d+)?$/.test(b) && Number(a) === Number(b));

function factorValue(f: Factor, people: Person[], all: Person[], inputs: Inputs, data: ProductData): string | null {
  const ages = people.map((p) => p.age ?? -1);
  const pickBand = (n: number) => f.bands.find((b) => n >= b.min && n <= b.max);
  switch (f.filledFrom) {
    case 'ELDEST_AGE': {
      const b = pickBand(Math.max(...ages));
      return b ? bandLabel(b) : null;
    }
    case 'PROPOSER_AGE': {
      const age = all.find((p) => p.key === CUSTOMER_KEY)?.age ?? -1;
      const b = pickBand(age);
      return b ? bandLabel(b) : null;
    }
    case 'ADULTS':
    case 'CHILDREN': {
      const n = people.filter((p) => (f.filledFrom === 'CHILDREN') === isChild(p, data)).length;
      return f.kind === 'BAND' ? (pickBand(n) ? bandLabel(pickBand(n)!) : null) : String(n);
    }
    case 'SUM_INSURED':
      return inputs.sumInsured ?? null;
    case 'POLICY_TERM':
      return inputs.term !== undefined ? String(inputs.term) : null;
    default:
      return inputs.factors?.[f.key] ?? null;
  }
}

export type CalcResult = { ok: true; breakdown: Breakdown; finalPayable: Money; beforeDiscount: Money } | { ok: false; errors: FieldError[] };

/**
 * Price one product for the selected people. RATE_TABLE: the row of the account's price version in effect
 * whose factors match; MANUAL_ENTRY: the typed net premium and tax. Returns field errors (QT-08, QT-09,
 * QT-19, QT-37, VAL-09 …) rather than throwing, so a comparison can show each option's own problem.
 */
export async function calculate(accountId: string, ctx: ProductCtx, people: Person[], all: Person[], inputs: Inputs, role: string, on = istToday()): Promise<CalcResult> {
  const errors: FieldError[] = [];
  const data = ctx.data;
  const selected = (inputs.riders ?? []).filter((k) => data.riders.some((r) => r.key === k));
  let base: Money;
  let ridersOut: Breakdown['riders'];
  let taxPercent = '0.00';
  let tax: Money | null = null;
  let priceVersion: Breakdown['priceVersion'] = null;
  if (data.pricingMode === 'RATE_TABLE') {
    const pv = await priceInEffect(db, accountId, ctx.productId, on);
    if (!pv) return { ok: false, errors: [{ field: 'productId', code: 'QT-07', params: { Product: data.name } }] };
    const wanted = ctx.factors.map((f) => [f.key, factorValue(f, people, all, inputs, data)] as const);
    const row = (pv.rows as RateRow[]).find((r) => wanted.every(([k, v]) => v !== null && r.factors[k] !== undefined && sameValue(r.factors[k], v)));
    if (!row) return { ok: false, errors: [{ field: 'premium', code: 'QT-08' }] };
    base = money(row.basePremium);
    const riderPrices = pv.riderPrices as { key: string; priceType: string; value: string }[];
    ridersOut = selected.map((k) => {
      const r = data.riders.find((x) => x.key === k)!;
      const price = riderPrices.find((x) => x.key === k) ?? { priceType: r.priceType, value: r.value };
      const amt = price.priceType === 'PERCENT' ? pct(base, price.value) : money(price.value);
      return { key: k, name: r.name, amount: round2(amt), exact: amt };
    });
    taxPercent = pv.taxPercent;
    priceVersion = { id: pv.id, name: `V${pv.seq}`, effectiveFrom: pv.effectiveFrom };
  } else {
    const m = inputs.manual ?? {};
    const net = m.netPremium !== undefined && String(m.netPremium).trim() !== '' ? F.amount()(String(m.netPremium)) : null;
    const tx = m.taxAmount !== undefined && String(m.taxAmount).trim() !== '' ? F.amount({ allowZero: true })(String(m.taxAmount)) : null;
    if (!net) errors.push({ field: 'manual.netPremium', code: 'GEN-01', params: { 'Field label': 'Net premium' } });
    else if (!net.ok) errors.push({ field: 'manual.netPremium', code: net.code, ...(net.params ? { params: net.params } : {}) });
    if (!tx) errors.push({ field: 'manual.taxAmount', code: 'GEN-01', params: { 'Field label': 'Tax amount' } });
    else if (!tx.ok) errors.push({ field: 'manual.taxAmount', code: tx.code, ...(tx.params ? { params: tx.params } : {}) });
    if (errors.length) return { ok: false, errors };
    base = money((net as { value: string }).value);
    tax = money((tx as { value: string }).value);
    ridersOut = selected.map((k) => ({ key: k, name: data.riders.find((x) => x.key === k)!.name, amount: '0.00' }));
  }
  const riderSum = add(...ridersOut.map((r) => ((r as unknown as { exact?: Money }).exact ?? 0n)));
  const calculated = add(base, riderSum);

  // Price override (ADV only, RATE_TABLE only)
  let override: Breakdown['override'] = null;
  let beforeDiscount = calculated;
  const ov = inputs.override;
  if (ov && (ov.amount || ov.reason)) {
    if (role !== 'ADV') errors.push({ field: 'override.amount', code: 'GEN-03' });
    else if (data.pricingMode !== 'RATE_TABLE') errors.push({ field: 'override.amount', code: 'GEN-03' });
    else {
      const a = F.amount()(String(ov.amount ?? ''));
      if (!ov.amount) errors.push({ field: 'override.amount', code: 'GEN-01', params: { 'Field label': 'Override amount' } });
      else if (!a.ok) errors.push({ field: 'override.amount', code: a.code, ...(a.params ? { params: a.params } : {}) });
      const reason = String(ov.reason ?? '').trim();
      if (!reason) errors.push({ field: 'override.reason', code: 'GEN-01', params: { 'Field label': 'Override reason' } });
      else {
        const r = F.notes(reason);
        if (!r.ok) errors.push({ field: 'override.reason', code: r.code, ...(r.params ? { params: r.params } : {}) });
      }
      if (a.ok && reason) {
        beforeDiscount = money(a.value);
        override = { amount: a.value, reason };
      }
    }
  }

  // Discount with a mandatory reference (ADV only)
  let discount: Breakdown['discount'] = null;
  let discountAmt: Money = 0n;
  const d = inputs.discount;
  if (d && (d.value || d.reference)) {
    if (role !== 'ADV') errors.push({ field: 'discount.value', code: 'GEN-03' });
    else {
      const kind = d.kind === 'PERCENT' ? 'PERCENT' : 'AMOUNT';
      const r = kind === 'PERCENT' ? F.percentage(String(d.value ?? '')) : F.amount()(String(d.value ?? ''));
      if (!d.value) errors.push({ field: 'discount.value', code: 'GEN-01', params: { 'Field label': 'Discount' } });
      else if (!r.ok) errors.push({ field: 'discount.value', code: r.code, ...(r.params ? { params: r.params } : {}) });
      const reference = String(d.reference ?? '').trim();
      if (!reference) errors.push({ field: 'discount.reference', code: 'QT-37' });
      else {
        const rr = F.shortText(reference);
        if (!rr.ok) errors.push({ field: 'discount.reference', code: rr.code, ...(rr.params ? { params: rr.params } : {}) });
      }
      if (r.ok && reference) {
        discountAmt = kind === 'PERCENT' ? pct(beforeDiscount, r.value) : money(r.value);
        if (cmp(discountAmt, beforeDiscount) > 0) errors.push({ field: 'discount.value', code: 'QT-09' });
        else if (cmp(discountAmt, calculated) > 0) errors.push({ field: 'discount.value', code: 'QT-19' });
        discount = { kind, value: r.value, reference, amount: round2(discountAmt) };
      }
    }
  }
  if (errors.length) return { ok: false, errors };
  const afterDiscount = sub(beforeDiscount, discountAmt);
  const taxAmt = tax ?? pct(afterDiscount, taxPercent);
  if (tax !== null) taxPercent = afterDiscount > 0n ? round2((taxAmt * 100n * 10n ** 10n) / afterDiscount) : '0.00';
  const final = add(afterDiscount, taxAmt);
  const eldest = people.length ? Math.max(...people.map((p) => p.age ?? 0)) : null;
  return {
    ok: true,
    finalPayable: money(round2(final)),
    beforeDiscount,
    breakdown: {
      mode: data.pricingMode as Breakdown['mode'],
      base: round2(base),
      riders: ridersOut.map(({ key, name, amount }) => ({ key, name, amount })),
      calculated: round2(calculated),
      override,
      beforeDiscount: round2(beforeDiscount),
      discount,
      afterDiscount: round2(afterDiscount),
      taxPercent,
      tax: round2(taxAmt),
      finalPayable: round2(final),
      priceVersion,
      eldestAge: eldest,
      calculatedOn: on,
    },
  };
}

// ---------- step checks (P-27 wizard) ----------
export type Ctx = {
  accountId: string;
  role: string;
  customerId: string;
  customerActive: boolean;
  people: Person[];
  advisor: Awaited<ReturnType<typeof advisorFacts>>;
  product: ProductCtx | null;
  mapping: Mapping | null;
  renewal: boolean;
};

export async function loadCtx(accountId: string, role: string, customerId: string, inputs: Inputs, renewal = false, on = istToday()): Promise<Ctx> {
  const [c] = await db.select({ status: customers.status }).from(customers).where(and(eq(customers.id, customerId), eq(customers.accountId, accountId)));
  const product = inputs.productId ? await productCtx(db, accountId, inputs.productId) : null;
  return {
    accountId,
    role,
    customerId,
    customerActive: c?.status === 'ACTIVE',
    people: await loadPeople(db, accountId, customerId, on),
    advisor: await advisorFacts(db, accountId),
    product,
    mapping: inputs.insurerId ? await mappingFor(db, accountId, inputs.insurerId) : null,
    renewal,
  };
}

const push = (errors: FieldError[], field: string, issue: { code: string; params?: Params } | null) => {
  if (issue) errors.push({ field, code: issue.code, ...(issue.params ? { params: issue.params } : {}) });
};
const required = (errors: FieldError[], field: string, label: string, v: unknown) => {
  const empty = v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);
  if (empty) errors.push({ field, code: 'GEN-01', params: { 'Field label': label } });
  return !empty;
};

export const selectedPeople = (ctx: Ctx, inputs: Inputs) => (inputs.people ?? []).map((k) => ctx.people.find((p) => p.key === k && p.active)).filter((p): p is Person => !!p);

/** The checks of steps 1..upTo (P-27 wizard table). */
export async function checkSteps(ctx: Ctx, inputs: Inputs, upTo: number): Promise<FieldError[]> {
  const e: FieldError[] = [];
  if (upTo >= 1) {
    if (!ctx.customerActive) e.push({ field: 'customerId', code: 'CU-20' });
    push(e, 'customerId', licenceIssue(ctx.advisor.licenceValidUntil));
  }
  if (upTo >= 3 && required(e, 'typeId', 'Insurance type', inputs.typeId)) {
    const [t] = await db.select().from(insuranceTypes).where(eq(insuranceTypes.id, inputs.typeId!));
    if (!t || (t.status !== 'ACTIVE' && !ctx.renewal)) e.push({ field: 'typeId', code: 'VAL-22' });
    else if (!ctx.advisor.authorisedTypeIds.includes(t.id)) e.push({ field: 'typeId', code: 'PRF-18', params: { 'Insurance type': t.name } });
  }
  if (upTo >= 4 && required(e, 'insurerId', 'Insurer', inputs.insurerId)) {
    const [i] = await db.select().from(insurers).where(eq(insurers.id, inputs.insurerId!));
    if (!i) e.push({ field: 'insurerId', code: 'VAL-22' });
    else push(e, 'insurerId', mappingIssue(ctx.mapping, i.name, ctx.renewal ? 'ACTIVE' : i.status));
  }
  if (upTo >= 5 && required(e, 'productId', 'Product', inputs.productId)) {
    const p = ctx.product;
    if (!p || p.insurerId !== inputs.insurerId || p.typeId !== inputs.typeId) e.push({ field: 'productId', code: 'VAL-22' });
    else push(e, 'productId', await productIssue(ctx.accountId, p, { renewal: ctx.renewal }));
  }
  if (e.length || upTo < 6) return e;
  const data = ctx.product!.data;
  // Step 6 Details
  if (required(e, 'people', 'People to insure', inputs.people)) {
    const chosen = selectedPeople(ctx, inputs);
    if (chosen.length !== (inputs.people ?? []).length) e.push({ field: 'people', code: 'VAL-22' });
    for (const p of chosen) push(e, `people.${p.key}`, bandIssue(p, data));
  }
  if (required(e, 'sumInsured', 'Sum insured', inputs.sumInsured)) {
    const a = F.amount()(String(inputs.sumInsured));
    if (!a.ok || !sumInsuredAllowed(data, a.value)) e.push({ field: 'sumInsured', code: 'VAL-22' });
  }
  if (required(e, 'term', 'Policy term', inputs.term)) {
    if (!data.policyTerms.includes(Number(inputs.term))) e.push({ field: 'term', code: 'VAL-22' });
  }
  if (required(e, 'startDate', 'Planned start date', inputs.startDate)) {
    const r = F.date(String(inputs.startDate));
    if (!r.ok) push(e, 'startDate', r);
    else if (r.value < istToday()) e.push({ field: 'startDate', code: 'VAL-07' });
  }
  for (const q of ctx.product!.questions) {
    const v = inputs.answers?.[q.key];
    if (v === undefined || String(v).trim() === '') {
      if (q.required) e.push({ field: `answers.${q.key}`, code: 'GEN-01', params: { 'Field label': q.label } });
      continue;
    }
    const r = parseFeatureValue(q, String(v));
    if (!r.ok) push(e, `answers.${q.key}`, r);
  }
  for (const f of ctx.product!.factors.filter((x) => x.filledFrom === 'ASKED')) {
    const v = inputs.factors?.[f.key];
    const allowed = f.kind === 'BAND' ? f.bands.map(bandLabel) : f.values;
    if (!v) e.push({ field: `factors.${f.key}`, code: 'GEN-01', params: { 'Field label': f.name } });
    else if (!allowed.includes(v)) e.push({ field: `factors.${f.key}`, code: 'VAL-22' });
  }
  if (/motor/i.test(ctx.product!.typeName)) {
    if (required(e, 'vehicleId', 'Vehicle', inputs.vehicleId)) {
      const [v] = await db.select().from(vehicles).where(and(eq(vehicles.id, String(inputs.vehicleId)), eq(vehicles.customerId, ctx.customerId), eq(vehicles.status, 'ACTIVE')));
      if (!v) e.push({ field: 'vehicleId', code: 'VAL-22' });
    }
  }
  if (e.length || upTo < 7) return e;
  // Step 7 Riders
  for (const k of inputs.riders ?? []) if (!data.riders.some((r) => r.key === k)) e.push({ field: 'riders', code: 'VAL-22' });
  return e;
}

/** Rider list, sum-insured options, terms and questions for step 6–7 screens. */
export function productChoices(p: ProductCtx) {
  return {
    sumInsured: p.data.sumInsured,
    policyTerms: p.data.policyTerms,
    riders: p.data.riders.map((r) => ({ key: r.key, name: r.name, description: r.description })),
    questions: p.questions,
    askedFactors: p.factors.filter((f) => f.filledFrom === 'ASKED').map((f) => ({ key: f.key, name: f.name, values: f.kind === 'BAND' ? f.bands.map(bandLabel) : f.values })),
    pricingMode: p.data.pricingMode,
    taxPercent: p.data.taxPercent,
    isMotor: /motor/i.test(p.typeName),
    adultBand: { min: p.data.adultMinAge, max: p.data.adultMaxAge },
    childBand: p.data.coversChildren ? childBand(p.data) : null,
  };
}

/** Insurers the advisor can quote (ACTIVE mapping, insurer ACTIVE), with the reason when they cannot. */
export async function insurerChoices(accountId: string) {
  const rows = await db
    .select({ m: insurerMappings, i: insurers })
    .from(insurerMappings)
    .innerJoin(insurers, eq(insurers.id, insurerMappings.insurerId))
    .where(eq(insurerMappings.accountId, accountId))
    .orderBy(asc(insurers.name));
  return rows.map(({ m, i }) => {
    const issue = mappingIssue({ agentCode: m.agentCode, codeValidUntil: m.codeValidUntil, status: m.status }, i.name, i.status);
    return { id: i.id, name: i.name, agentCode: m.agentCode, available: !issue, issue };
  });
}

export async function typeChoices(accountId: string) {
  const adv = await advisorFacts(db, accountId);
  const rows = await db.select().from(insuranceTypes).where(eq(insuranceTypes.status, 'ACTIVE')).orderBy(asc(insuranceTypes.position), asc(insuranceTypes.name));
  return rows.map((t) => ({ id: t.id, name: t.name, authorised: adv.authorisedTypeIds.includes(t.id) }));
}

export async function vehicleChoices(customerId: string) {
  return db
    .select({ id: vehicles.id, registration: vehicles.registration, make: vehicles.make, model: vehicles.model })
    .from(vehicles)
    .where(and(eq(vehicles.customerId, customerId), eq(vehicles.status, 'ACTIVE')));
}

export async function priceVersionName(id: string | null) {
  if (!id) return null;
  const [p] = await db.select({ seq: priceVersions.seq, effectiveFrom: priceVersions.effectiveFrom }).from(priceVersions).where(eq(priceVersions.id, id));
  return p ? `V${p.seq}` : null;
}

export async function typeNames(ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  const rows = await db.select({ id: insuranceTypes.id, name: insuranceTypes.name }).from(insuranceTypes).where(inArray(insuranceTypes.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}
