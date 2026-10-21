// P-30 Comparison quotation: CFG-44 to CFG-45 products of one type, priced for the same people, sum insured
// and term, shown side by side from catalogue facts. It never carries a payment link. Choosing a product
// creates a separate normal quotation that runs every P-27 check again (AC-P30-3).
import { randomBytes } from 'node:crypto';
import type { Request } from 'express';
import { and, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db, type DbOrTx } from '../../db/client.js';
import { comparisons, customers, insuranceTypes, quotationRevisions, quotations, shareEvents, users } from '../../db/schema.js';
import { addDays, clock, formatDate, istToday } from '../../lib/clock.js';
import { AppError, fieldErrors, notFound, stateConflict, versionConflict, type FieldError } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import { logger } from '../../lib/logger.js';
import { inr, money } from '../../lib/money.js';
import { msg, render } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { isUuid, nextNumber, readVersion } from '../clients/common.js';
import { fileLink, storeGenerated } from '../files/files.service.js';
import { consentState, dailyLimit, dispatch, queueMessage, sentToday } from '../messages/messages.service.js';
import { sharingBlock } from '../profile/profile.service.js';
import { settings } from '../settings/settings.service.js';
import {
  advisorFacts,
  bandIssue,
  calculate,
  checkSteps,
  coverage,
  insurerChoices,
  loadCtx,
  mappingFor,
  mappingIssue,
  productCtx,
  productIssue,
  productsOfType,
  sumInsuredAllowed,
  typeChoices,
  type Breakdown,
  type Inputs,
  type Person,
  type ProductCtx,
} from './engine.js';
import { fact, roleKeys, ROLE_LABELS, type Role } from './features.js';
import { displayValue } from '../catalogue/productData.js';
import { comparisonPdf } from './pdf.js';
import { disclaimer, pdfHeader, sharesToday } from './quotations.service.js';

type Cmp = typeof comparisons.$inferSelect;
type CInputs = { typeId?: string; people?: string[]; sumInsured?: string; term?: string; startDate?: string; answers?: Record<string, string>; factors?: Record<string, string> };
type OptionIn = { productId: string; riders?: string[]; manual?: Inputs['manual']; override?: Inputs['override']; discount?: Inputs['discount'] };
export type OptionOut = OptionIn & {
  ok: boolean;
  error: { code: string; text: string } | null;
  fieldErrors: (FieldError & { text: string })[];
  breakdown: Breakdown | null;
  coverage: { n: number; m: number; notCovered: string[]; text: string | null } | null;
  product: { name: string; uin: string; insurerName: string; insurerId: string; agentCode: string | null; pricingMode: string | null; riders: { key: string; name: string }[] } | null;
};
const STATUS_TEXT: Record<string, string> = { DRAFT: 'Draft', READY: 'Ready', SHARED: 'Shared', PRODUCT_CHOSEN: 'Product chosen', EXPIRED: 'Expired', CANCELLED: 'Cancelled' };

function cleanC(raw: unknown): CInputs {
  const b = (raw ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : undefined);
  const strMap = (v: unknown): Record<string, string> => Object.fromEntries(Object.entries((v && typeof v === 'object' ? v : {}) as Record<string, unknown>).map(([k, x]): [string, string] => [k, s(x) ?? '']).filter(([, x]) => x !== ''));
  return {
    typeId: s(b.typeId) || undefined,
    people: Array.isArray(b.people) ? [...new Set(b.people.filter((x): x is string => typeof x === 'string'))] : [],
    sumInsured: s(b.sumInsured) || undefined,
    term: s(b.term) || undefined,
    startDate: s(b.startDate) || undefined,
    answers: strMap(b.answers),
    factors: strMap(b.factors),
  };
}
function cleanOptions(raw: unknown): OptionIn[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object' && typeof (o as Record<string, unknown>).productId === 'string')
    .map((o) => {
      const s = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : undefined);
      const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);
      const mn = obj(o.manual);
      const ov = obj(o.override);
      const dc = obj(o.discount);
      return {
        productId: String(o.productId),
        riders: Array.isArray(o.riders) ? o.riders.filter((x): x is string => typeof x === 'string') : [],
        manual: mn ? { netPremium: s(mn.netPremium), taxAmount: s(mn.taxAmount) } : null,
        override: ov && (s(ov.amount) || s(ov.reason)) ? { amount: s(ov.amount), reason: s(ov.reason) } : null,
        discount: dc && (s(dc.value) || s(dc.reference)) ? { kind: s(dc.kind) === 'PERCENT' ? 'PERCENT' : 'AMOUNT', value: s(dc.value), reference: s(dc.reference) } : null,
      };
    });
}

async function loadCmp(dbx: DbOrTx, auth: AuthContext, id: string, lock = false): Promise<Cmp> {
  if (!isUuid(id)) throw notFound();
  const base = dbx.select().from(comparisons).where(and(eq(comparisons.id, id), eq(comparisons.accountId, auth.accountId!)));
  const [c] = lock ? await base.for('update') : await base;
  if (!c) throw notFound();
  return c;
}

const isExpired = (c: Cmp) => c.status === 'EXPIRED' || (c.status === 'SHARED' && !!c.validUntil && c.validUntil < istToday());

/** Price every option for the shared details. Problems stay on the option (never silently dropped). */
async function priceOptions(auth: AuthContext, customerId: string, inputs: CInputs, options: OptionIn[]): Promise<{ out: OptionOut[]; people: Person[] }> {
  const ctx = await loadCtx(auth.accountId!, auth.role, customerId, { typeId: inputs.typeId, people: inputs.people });
  const people = (inputs.people ?? []).map((k) => ctx.people.find((p) => p.key === k && p.active)).filter((p): p is Person => !!p);
  const seen = new Set<string>();
  const out: OptionOut[] = [];
  for (const o of options) {
    const p = await productCtx(db, auth.accountId!, o.productId);
    const fail = (code: string, params: Record<string, string | number>, prod: ProductCtx | null = p) =>
      out.push({ ...o, ok: false, error: { code, text: render(code, params) }, fieldErrors: [], breakdown: null, coverage: null, product: prod ? summary(prod, null) : null });
    if (!p) {
      fail('QT-32', { Product: '—', reason: 'not found' }, null);
      continue;
    }
    if (seen.has(p.productId)) {
      fail('QT-36', { Product: p.data.name });
      continue;
    }
    seen.add(p.productId);
    if (p.typeId !== inputs.typeId) {
      fail('QT-31', {});
      continue;
    }
    const m = await mappingFor(db, auth.accountId!, p.insurerId);
    const mi = mappingIssue(m, p.insurerName, p.insurerStatus);
    const pi = await productIssue(auth.accountId!, p);
    const issue = mi ?? pi;
    if (issue) {
      fail('QT-32', { Product: p.data.name, reason: render(issue.code, issue.params) });
      continue;
    }
    if (inputs.sumInsured && !sumInsuredAllowed(p.data, inputs.sumInsured)) {
      fail('QT-32', { Product: p.data.name, reason: `sum insured ₹${F.groupIndian(inputs.sumInsured)} is not offered` });
      continue;
    }
    if (inputs.term && !p.data.policyTerms.includes(Number(inputs.term))) {
      fail('QT-32', { Product: p.data.name, reason: `a ${inputs.term} year term is not offered` });
      continue;
    }
    const cov = coverage(people, p.data);
    const covered = people.filter((x) => !bandIssue(x, p.data));
    if (!covered.length) {
      fail('QT-32', { Product: p.data.name, reason: 'none of the selected people is inside its age limits' });
      continue;
    }
    const res = await calculate(auth.accountId!, p, covered, ctx.people, { ...inputs, ...o, typeId: inputs.typeId, insurerId: p.insurerId, productId: p.productId }, auth.role);
    const covText = cov.n < cov.m ? render('QT-41', { n: cov.n, m: cov.m, names: cov.notCovered.join(', ') }) : null;
    if (!res.ok) {
      const premiumIssue = res.errors.find((e) => e.code === 'QT-08' || e.code === 'QT-07');
      out.push({
        ...o,
        ok: false,
        error: premiumIssue ? { code: 'QT-32', text: render('QT-32', { Product: p.data.name, reason: render(premiumIssue.code, premiumIssue.params) }) } : null,
        fieldErrors: res.errors.filter((e) => e !== premiumIssue).map((e) => ({ ...e, text: render(e.code, e.params) })),
        breakdown: null,
        coverage: { ...cov, text: covText },
        product: summary(p, m?.agentCode ?? null),
      });
      continue;
    }
    out.push({ ...o, ok: true, error: null, fieldErrors: [], breakdown: res.breakdown, coverage: { ...cov, text: covText }, product: summary(p, m?.agentCode ?? null) });
  }
  return { out, people };
}

function summary(p: ProductCtx, agentCode: string | null) {
  return { name: p.data.name, uin: p.data.uin, insurerName: p.insurerName, insurerId: p.insurerId, agentCode, pricingMode: p.data.pricingMode, riders: p.data.riders.map((r) => ({ key: r.key, name: r.name })) };
}

async function view(auth: AuthContext, c: Cmp, withOptions = false) {
  const [cu] = await db.select().from(customers).where(eq(customers.id, c.customerId));
  const inputs = c.inputs as CInputs;
  const opts = c.options as OptionOut[];
  const [linked] = c.linkedQuotationId
    ? await db.select({ id: quotationRevisions.id, number: quotations.number }).from(quotations).innerJoin(quotationRevisions, eq(quotationRevisions.quotationId, quotations.id)).where(eq(quotations.id, c.linkedQuotationId)).orderBy(desc(quotationRevisions.revisionNo)).limit(1)
    : [];
  const expired = isExpired(c);
  let choices = null;
  if (withOptions && c.status === 'DRAFT') {
    const ctx = await loadCtx(auth.accountId!, auth.role, c.customerId, {});
    const products = inputs.typeId ? await productsOfType(auth.accountId!, inputs.typeId) : [];
    const insurerList = await insurerChoices(auth.accountId!);
    const tpl = products[0];
    choices = {
      types: await typeChoices(auth.accountId!),
      people: ctx.people.filter((p) => p.active).map((p) => ({ key: p.key, name: p.name, relationship: p.relationship, age: p.age, issue: p.age === null ? msg('QT-05', { name: p.name }) : null })),
      products: await Promise.all(
        products
          .filter((p) => p.status === 'ACTIVE')
          .map(async (p) => {
            const ins = insurerList.find((i) => i.id === p.insurerId);
            const issue = !ins || !ins.available ? (ins?.issue ?? { code: 'QT-12', params: { insurer: p.insurerName } }) : await productIssue(auth.accountId!, p);
            return { id: p.productId, name: p.data.name, insurerName: p.insurerName, pricingMode: p.data.pricingMode, sumInsured: p.data.sumInsured, policyTerms: p.data.policyTerms, available: !issue, issue: issue ? msg(issue.code, issue.params) : null };
          }),
      ),
      questions: tpl?.questions ?? [],
      askedFactors: (tpl?.factors ?? []).filter((f) => f.filledFrom === 'ASKED').map((f) => ({ key: f.key, name: f.name, values: f.kind === 'BAND' ? f.bands.map((b) => `${b.min}-${b.max}`) : f.values })),
      min: settings.get('CFG-44'),
      max: settings.get('CFG-45'),
      reasonLength: settings.get('CFG-157'),
    };
  }
  const lowest = opts.filter((o) => o.ok && o.breakdown).sort((a, b) => Number(a.breakdown!.finalPayable) - Number(b.breakdown!.finalPayable))[0];
  return {
    id: c.id,
    number: c.number,
    status: c.status,
    statusText: STATUS_TEXT[c.status],
    expired,
    step: c.step,
    inputs,
    options: opts.map((o) => ({ ...o, lowest: !!lowest && o.productId === lowest.productId })),
    recommendedProductId: (c.snapshot as { recommendedProductId?: string } | null)?.recommendedProductId ?? (c.inputs as { recommendedProductId?: string }).recommendedProductId ?? null,
    recommendedReason: c.reason,
    table: (c.snapshot as { table?: unknown } | null)?.table ?? null,
    calculatedOn: c.calculatedOn,
    validUntil: c.validUntil,
    pdfFileId: c.pdfFileId,
    shareUrl: c.status === 'SHARED' && c.viewToken ? `${env.APP_URL}/c/${c.viewToken}` : null,
    viewedAt: c.viewedAt?.toISOString() ?? null,
    chosenProductId: c.chosenProductId,
    linkedQuotation: linked ? { revisionId: linked.id, number: linked.number } : null,
    customer: cu ? { id: cu.id, name: cu.fullName, number: cu.number, email: cu.email, status: cu.status } : null,
    actions: {
      canEditDraft: c.status === 'DRAFT',
      canEdit: c.status === 'READY',
      canShare: (c.status === 'READY' || c.status === 'SHARED') && !expired,
      canChoose: (c.status === 'READY' || c.status === 'SHARED') && !expired,
      canCreateQuotation: c.status === 'PRODUCT_CHOSEN' && !c.linkedQuotationId,
      canCancel: c.status === 'DRAFT' || c.status === 'READY',
      canDelete: c.status === 'DRAFT' && !c.firstSharedAt,
    },
    choices,
    version: c.version,
  };
}

export async function startComparison(req: Request, auth: AuthContext, body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const customerId = typeof b.customerId === 'string' ? b.customerId : '';
  if (!customerId) throw fieldErrors([{ field: 'customerId', code: 'GEN-01', params: { 'Field label': 'Customer' } }]);
  const inputs = cleanC(b.inputs);
  const ctx = await loadCtx(auth.accountId!, auth.role, customerId, {});
  if (!ctx.people.length) throw fieldErrors([{ field: 'customerId', code: 'VAL-22' }]);
  const errs = await checkSteps(ctx, {}, 1);
  if (errs.length) throw fieldErrors(errs);
  const options = cleanOptions(b.options);
  const now = clock.now();
  const [c] = await db.insert(comparisons).values({ accountId: auth.accountId!, customerId, typeId: inputs.typeId ?? null, inputs, options, step: options.length ? 2 : 1, createdBy: auth.userId, createdAt: now, updatedAt: now }).returning();
  await audit(db, req, { action: 'COMPARISON_DRAFT_STARTED', entity: 'comparison', entityId: c!.id, newValue: { customerId } });
  return { id: c!.id, message: msg('GEN-14') };
}

function checkDetails(inputs: CInputs): FieldError[] {
  const e: FieldError[] = [];
  const req = (field: string, label: string, v: unknown) => {
    if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) {
      e.push({ field, code: 'GEN-01', params: { 'Field label': label } });
      return false;
    }
    return true;
  };
  req('typeId', 'Insurance type', inputs.typeId);
  req('people', 'People to insure', inputs.people);
  if (req('sumInsured', 'Sum insured', inputs.sumInsured)) {
    const a = F.amount()(inputs.sumInsured!);
    if (!a.ok) e.push({ field: 'sumInsured', code: a.code, ...(a.params ? { params: a.params } : {}) });
  }
  req('term', 'Policy term', inputs.term);
  if (req('startDate', 'Planned start date', inputs.startDate)) {
    const r = F.date(inputs.startDate!);
    if (!r.ok) e.push({ field: 'startDate', code: r.code });
    else if (r.value < istToday()) e.push({ field: 'startDate', code: 'VAL-07' });
  }
  return e;
}

export async function saveComparison(req: Request, auth: AuthContext, id: string, body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const c = await loadCmp(db, auth, id);
  if (c.status !== 'DRAFT') throw stateConflict('comparison', c.status);
  if (c.version !== readVersion(body)) throw versionConflict('comparison');
  const inputs = cleanC(b.inputs);
  const options = cleanOptions(b.options);
  const step = Math.min(Math.max(Number(b.step) || 1, 1), 4);
  if (step >= 2) {
    const ctx = await loadCtx(auth.accountId!, auth.role, c.customerId, { typeId: inputs.typeId });
    const errs = [...(await checkSteps(ctx, { typeId: inputs.typeId }, 3)).filter((x) => x.field !== 'insurerId'), ...checkDetails(inputs)];
    for (const k of inputs.people ?? []) {
      const p = ctx.people.find((x) => x.key === k);
      if (p && p.age === null) errs.push({ field: `people.${k}`, code: 'QT-05', params: { name: p.name } });
    }
    if (errs.length) throw fieldErrors(errs);
  }
  if (step >= 3 && (options.length < settings.get('CFG-44') || options.length > settings.get('CFG-45'))) throw fieldErrors([{ field: 'options', code: 'QT-30' }]);
  const priced = step >= 3 ? (await priceOptions(auth, c.customerId, inputs, options)).out : options.map((o) => ({ ...o, ok: false, error: null, fieldErrors: [], breakdown: null, coverage: null, product: null }));
  const recommendedProductId = typeof b.recommendedProductId === 'string' && options.some((o) => o.productId === b.recommendedProductId) ? b.recommendedProductId : null;
  const reason = typeof b.recommendedReason === 'string' ? b.recommendedReason.trim() : '';
  const [saved] = await db
    .update(comparisons)
    .set({ inputs: { ...inputs, recommendedProductId }, options: priced, typeId: inputs.typeId ?? null, reason: reason || null, step, updatedAt: clock.now(), version: c.version + 1 })
    .where(and(eq(comparisons.id, c.id), eq(comparisons.version, c.version)))
    .returning();
  if (!saved) throw versionConflict('comparison');
  return { ...(await view(auth, saved, true)), message: msg('GEN-14') };
}

export async function getComparison(auth: AuthContext, id: string) {
  return view(auth, await loadCmp(db, auth, id), true);
}

const money2 = (v: string | null | undefined) => (v ? `₹${inr(v)}` : '—');

/** Comparison table in the fixed order of P-30 step 6. */
function buildTable(opts: OptionOut[], ctxs: ProductCtx[], sumInsured: string) {
  const lowest = opts.reduce<OptionOut | null>((a, o) => (!a || money(o.breakdown!.finalPayable) < money(a.breakdown!.finalPayable) ? o : a), null);
  const fixedRoles: Role[] = ['roomRent', 'coPay', 'pedWait', 'restore', 'csr', 'network'];
  const rows: { label: string; cells: string[]; bold?: boolean }[] = [
    { label: 'Insurer and product', cells: opts.map((o) => `${o.product!.insurerName}\n${o.product!.name}\nUIN ${o.product!.uin}`), bold: true },
    { label: 'Agent code', cells: opts.map((o) => o.product!.agentCode ?? '—') },
    {
      label: 'Annual premium',
      cells: opts.map((o) => {
        const b = o.breakdown!;
        const parts = [`${money2(b.finalPayable)}${o === lowest ? ' (lowest)' : ''}`, `Base ${money2(b.base)}`];
        for (const r of b.riders) parts.push(`${r.name} ${b.mode === 'MANUAL_ENTRY' ? 'included' : money2(r.amount)}`);
        if (b.discount) parts.push(`Discount −${money2(b.discount.amount)}`);
        parts.push(`GST ${b.taxPercent}% ${money2(b.tax)}`);
        return parts.join('\n');
      }),
      bold: true,
    },
    { label: 'Members covered', cells: opts.map((o) => (o.coverage!.n < o.coverage!.m ? `Covers ${o.coverage!.n} of ${o.coverage!.m}: ${o.coverage!.notCovered.join(', ')} not covered` : `All ${o.coverage!.m}`)) },
    { label: 'Sum insured', cells: opts.map(() => money2(sumInsured)) },
    ...fixedRoles.map((r) => ({ label: ROLE_LABELS[r], cells: ctxs.map((p) => fact(p.features, p.data, r).text) })),
  ];
  // Remaining template features, then riders and exclusions
  const seen = new Set<string>();
  const done = new Set(ctxs.flatMap((p) => [...roleKeys(p.features)]));
  for (const p of ctxs) {
    for (const f of [...p.features].sort((a, b) => a.order - b.order)) {
      if (done.has(f.key) || seen.has(f.key) || f.group === 'EXCLUSIONS') continue;
      seen.add(f.key);
      rows.push({
        label: f.name,
        cells: ctxs.map((x) => {
          const xf = x.features.find((y) => y.key === f.key);
          const v = xf ? x.data.features[f.key] : undefined;
          return !xf || !v || v.notStated || v.value === null ? 'Not stated by insurer' : (displayValue(xf, v) ?? 'Not stated by insurer');
        }),
      });
    }
  }
  rows.push({ label: 'Riders and add-ons', cells: ctxs.map((p, i) => (opts[i]!.riders?.length ? p.data.riders.filter((r) => opts[i]!.riders!.includes(r.key)).map((r) => r.name).join(', ') : p.data.riders.length ? 'Available: ' + p.data.riders.map((r) => r.name).join(', ') : 'None')) });
  const exclusionKeys = new Set(ctxs.flatMap((p) => p.features.filter((f) => f.group === 'EXCLUSIONS').map((f) => f.key)));
  for (const k of exclusionKeys) {
    const name = ctxs.flatMap((p) => p.features).find((f) => f.key === k)!.name;
    rows.push({ label: `Exclusion: ${name}`, cells: ctxs.map((p) => p.data.features[k]?.value ?? 'Not stated by insurer') });
  }
  return rows;
}

export async function generateComparison(req: Request, auth: AuthContext, id: string, body: unknown) {
  const c = await loadCmp(db, auth, id);
  if (c.status !== 'DRAFT') throw stateConflict('comparison', c.status);
  if (c.version !== readVersion(body)) throw versionConflict('comparison');
  const inputs = c.inputs as CInputs & { recommendedProductId?: string | null };
  const options = cleanOptions(c.options);
  const ctx = await loadCtx(auth.accountId!, auth.role, c.customerId, { typeId: inputs.typeId });
  const errs = [...(await checkSteps(ctx, { typeId: inputs.typeId }, 3)).filter((x) => x.field !== 'insurerId'), ...checkDetails(inputs)];
  if (errs.length) throw fieldErrors(errs);
  if (options.length < settings.get('CFG-44') || options.length > settings.get('CFG-45')) throw fieldErrors([{ field: 'options', code: 'QT-30' }]);
  const { out, people } = await priceOptions(auth, c.customerId, inputs, options);
  const bad = out.filter((o) => !o.ok);
  if (bad.length) {
    const fields: FieldError[] = bad.flatMap((o) => (o.error ? [{ field: `options.${o.productId}`, code: o.error.code }] : o.fieldErrors.map((e) => ({ ...e, field: `options.${o.productId}.${e.field}` }))));
    throw new AppError(422, 'QT-04', { list: bad.map((o) => o.error?.text ?? o.fieldErrors.map((e) => e.text).join('; ')).join('; ') }, fields);
  }
  const rec = inputs.recommendedProductId ? out.find((o) => o.productId === inputs.recommendedProductId) : null;
  if (rec) {
    const len = settings.get('CFG-157');
    const reason = c.reason ?? '';
    if (reason.length < len.min || reason.length > len.max) throw fieldErrors([{ field: 'recommendedReason', code: 'QT-40', params: { product: rec.product!.name } }]);
  }
  const ctxs = (await Promise.all(out.map((o) => productCtx(db, auth.accountId!, o.productId)))) as ProductCtx[];
  const table = buildTable(out, ctxs, inputs.sumInsured!);
  const today = istToday();
  let number = c.number;
  if (!number) {
    number = await db.transaction(async (tx) => {
      const [l] = await tx.select().from(comparisons).where(eq(comparisons.id, c.id)).for('update');
      if (l!.number) return l!.number;
      const n = await nextNumber(tx, auth.accountId!, 'CQ');
      await tx.update(comparisons).set({ number: n }).where(eq(comparisons.id, c.id));
      return n;
    });
  }
  const [cu] = await db.select().from(customers).where(eq(customers.id, c.customerId));
  let file: { id: string; sha256: string };
  try {
    const pdf = await comparisonPdf({
      header: await pdfHeader(auth.accountId!),
      number,
      calculatedOn: today,
      customer: { name: cu!.fullName },
      people: people.map((p) => `${p.name} (${p.age})`).join(', '),
      sumInsured: inputs.sumInsured!,
      term: String(inputs.term),
      validity: `Valid for ${settings.get('CFG-46')} days from the day it is first shared with you.`,
      columns: out.map((o) => ({ title: `${o.product!.insurerName}\n${o.product!.name}`, recommended: o.productId === rec?.productId, reason: o.productId === rec?.productId ? c.reason : null })),
      rows: table,
      disclaimer: disclaimer(today),
    });
    file = await storeGenerated(auth.accountId, auth.userId, 'COMPARISON_PDF', `${number}.pdf`, pdf, 'application/pdf');
  } catch (err) {
    logger.error({ err }, 'Comparison PDF failed');
    throw new AppError(503, 'QT-13');
  }
  const token = randomBytes(Math.ceil(settings.get('CFG-134') / 8)).toString('base64url');
  return db.transaction(async (tx) => {
    const l = await loadCmp(tx, auth, c.id, true);
    if (l.status !== 'DRAFT' || l.version !== c.version) throw versionConflict('comparison');
    const snapshot = { people: people.map((p) => ({ key: p.key, name: p.name, relationship: p.relationship, age: p.age })), table, recommendedProductId: rec?.productId ?? null, options: out };
    await tx
      .update(comparisons)
      .set({ status: 'READY', step: 4, options: out, snapshot, calculatedOn: today, pdfFileId: file.id, viewToken: token, statusAt: clock.now(), updatedAt: clock.now(), version: l.version + 1 })
      .where(eq(comparisons.id, c.id));
    await audit(tx, req, { action: 'COMPARISON_GENERATED', entity: 'comparison', entityId: c.id, newValue: { number, products: out.map((o) => o.product!.name) } });
    return { id: c.id, message: msg('QT-33', { number, customer: cu!.fullName }) };
  });
}

export async function editComparison(req: Request, auth: AuthContext, id: string, body: unknown) {
  return db.transaction(async (tx) => {
    const c = await loadCmp(tx, auth, id, true);
    if (c.version !== readVersion(body)) throw versionConflict('comparison');
    if (c.status !== 'READY') throw stateConflict('comparison', c.status);
    await tx.update(comparisons).set({ status: 'DRAFT', step: 3, pdfFileId: null, viewToken: null, snapshot: null, version: c.version + 1 }).where(eq(comparisons.id, c.id));
    await audit(tx, req, { action: 'COMPARISON_EDITED', entity: 'comparison', entityId: c.id });
    return { message: msg('GEN-14') };
  });
}

export async function cancelComparison(req: Request, auth: AuthContext, id: string, body: unknown) {
  const v = F.parseFields(body, { reason: { label: 'Reason', required: true, rule: F.notes } }) as { reason: string };
  return db.transaction(async (tx) => {
    const c = await loadCmp(tx, auth, id, true);
    if (c.version !== readVersion(body)) throw versionConflict('comparison');
    if (c.status !== 'DRAFT' && c.status !== 'READY') throw stateConflict('comparison', c.status);
    await tx.update(comparisons).set({ status: 'CANCELLED', reason: v.reason, viewToken: null, statusAt: clock.now(), version: c.version + 1 }).where(eq(comparisons.id, c.id));
    await audit(tx, req, { action: 'COMPARISON_CANCELLED', entity: 'comparison', entityId: c.id, newValue: { reason: v.reason } });
    return { message: msg('QT-28') };
  });
}

export async function deleteComparison(req: Request, auth: AuthContext, id: string, body: unknown) {
  return db.transaction(async (tx) => {
    const c = await loadCmp(tx, auth, id, true);
    if (c.version !== readVersion(body)) throw versionConflict('comparison');
    if (c.status !== 'DRAFT' || c.firstSharedAt) throw stateConflict('comparison', c.status);
    await tx.delete(comparisons).where(eq(comparisons.id, c.id));
    await audit(tx, req, { action: 'COMPARISON_DRAFT_DELETED', entity: 'comparison', entityId: c.id, oldValue: { number: c.number } });
    return { message: msg('QT-29') };
  });
}

export async function shareComparison(req: Request, auth: AuthContext, id: string, body: unknown) {
  const v = F.parseFields(body, { channel: { label: 'Share by', required: true, oneOf: ['EMAIL', 'WHATSAPP', 'LINK', 'PDF'] } }) as { channel: string };
  const result = await db.transaction(async (tx) => {
    const c = await loadCmp(tx, auth, id, true);
    if (c.status !== 'READY' && c.status !== 'SHARED') throw stateConflict('comparison', c.status);
    if (isExpired(c)) throw stateConflict('comparison', 'EXPIRED');
    const block = await sharingBlock(auth.accountId!);
    if (block) throw block;
    const [cu] = await tx.select().from(customers).where(eq(customers.id, c.customerId));
    if (cu!.status !== 'ACTIVE') throw new AppError(409, 'CU-20');
    const now = clock.now();
    if (v.channel === 'PDF') {
      await tx.insert(shareEvents).values({ accountId: auth.accountId!, recordType: 'COMPARISON', recordId: c.id, channel: 'PDF', userId: auth.userId, at: now });
      return { file: fileLink(auth.userId, auth.sessionId, c.pdfFileId!), message: null, dispatchId: null as string | null };
    }
    if ((await sharesToday(tx, auth.accountId!)) >= settings.get('CFG-117')) throw new AppError(429, 'QT-24');
    const first = c.status === 'READY';
    const validUntil = first ? addDays(istToday(), settings.get('CFG-46')) : c.validUntil!;
    const url = `${env.APP_URL}/c/${c.viewToken}`;
    const advisor = await advisorFacts(tx, auth.accountId!);
    const [adv] = await tx.select({ mobile: users.mobile }).from(users).where(and(eq(users.accountId, auth.accountId!), eq(users.role, 'ADV')));
    const [type] = await tx.select({ name: insuranceTypes.name }).from(insuranceTypes).where(eq(insuranceTypes.id, c.typeId!));
    const first_name = cu!.fullName.split(' ')[0]!;
    const text = `Dear ${first_name}, here is a comparison of ${(c.options as OptionOut[]).length} ${type?.name ?? ''} plans for you, valid until ${formatDate(validUntil)}. View it here: ${url}\n\n${advisor.name}, ${(adv?.mobile ?? '').replace('+91', '+91 ')}`;
    let out: { message: { code: string; text: string } | null; whatsappUrl?: string; url?: string; dispatchId: string | null };
    if (v.channel === 'EMAIL') {
      if (!cu!.email) throw new AppError(409, 'QT-23', { customer: cu!.fullName });
      if ((await consentState(tx, cu!.id, null, 'EMAIL', cu!.email)) === 'WITHDRAWN') throw new AppError(409, 'QT-22', { Customer: cu!.fullName });
      if ((await sentToday(tx, auth.accountId!, 'EMAIL')) >= dailyLimit('EMAIL')) throw new AppError(429, 'QT-24');
      const m = await queueMessage(tx, {
        accountId: auth.accountId!,
        customerId: cu!.id,
        personName: cu!.fullName,
        channel: 'EMAIL',
        purpose: 'COMPARISON_EMAIL',
        recipient: cu!.email,
        variables: { 'advisor email': advisor.email ?? '' },
        subject: `Your ${type?.name ?? 'insurance'} comparison from ${advisor.name}`,
        body: text,
        attachmentFileId: c.pdfFileId,
        occurrenceKey: `cq:${c.id}:email:${randomBytes(6).toString('hex')}`,
        relatedType: 'COMPARISON',
        relatedId: c.id,
        createdBy: auth.userId,
      });
      await tx.insert(shareEvents).values({ accountId: auth.accountId!, recordType: 'COMPARISON', recordId: c.id, channel: 'EMAIL', messageId: m!.id, userId: auth.userId, at: now });
      out = { message: msg('QT-15', { email: cu!.email }), dispatchId: m!.id };
    } else if (v.channel === 'WHATSAPP') {
      await tx.insert(shareEvents).values({ accountId: auth.accountId!, recordType: 'COMPARISON', recordId: c.id, channel: 'WHATSAPP', userId: auth.userId, at: now });
      await queueMessage(tx, { accountId: auth.accountId!, customerId: cu!.id, personName: cu!.fullName, channel: 'WHATSAPP', purpose: 'COMPARISON_WHATSAPP', recipient: cu!.mobile, body: text, occurrenceKey: `cq:${c.id}:wa:${randomBytes(6).toString('hex')}`, relatedType: 'COMPARISON', relatedId: c.id, createdBy: auth.userId, status: 'SHARED_MANUALLY' });
      out = { message: msg('QT-16'), whatsappUrl: `https://wa.me/${cu!.mobile.replace('+', '')}?text=${encodeURIComponent(text)}`, url, dispatchId: null };
    } else {
      await tx.insert(shareEvents).values({ accountId: auth.accountId!, recordType: 'COMPARISON', recordId: c.id, channel: 'LINK', userId: auth.userId, at: now });
      out = { message: msg('GEN-16'), url, dispatchId: null };
    }
    if (first) await tx.update(comparisons).set({ status: 'SHARED', firstSharedAt: now, validUntil, statusAt: now, version: c.version + 1 }).where(eq(comparisons.id, c.id));
    await audit(tx, req, { action: 'COMPARISON_SHARED', entity: 'comparison', entityId: c.id, newValue: { channel: v.channel } });
    return { ...out, validUntil };
  });
  if (result.dispatchId) await dispatch(result.dispatchId);
  return { ...result, dispatchId: undefined };
}

/** Customer chose this (QT-34): PRODUCT_CHOSEN and, at once, a new normal quotation draft with the same inputs. */
export async function chooseProduct(req: Request, auth: AuthContext, id: string, body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const productId = typeof b.productId === 'string' ? b.productId : '';
  const res = await db.transaction(async (tx) => {
    const c = await loadCmp(tx, auth, id, true);
    if (c.version !== readVersion(body)) throw versionConflict('comparison');
    if (c.status !== 'READY' && c.status !== 'SHARED') throw stateConflict('comparison', c.status);
    if (isExpired(c)) throw stateConflict('comparison', 'EXPIRED');
    const opt = (c.options as OptionOut[]).find((o) => o.productId === productId);
    if (!opt) throw fieldErrors([{ field: 'productId', code: 'VAL-22' }]);
    await tx.update(comparisons).set({ status: 'PRODUCT_CHOSEN', chosenProductId: productId, statusAt: clock.now(), version: c.version + 1 }).where(eq(comparisons.id, c.id));
    await audit(tx, req, { action: 'COMPARISON_PRODUCT_CHOSEN', entity: 'comparison', entityId: c.id, newValue: { product: opt.product?.name } });
    const [cu] = await tx.select({ name: customers.fullName }).from(customers).where(eq(customers.id, c.customerId));
    return { message: msg('QT-34', { Customer: cu!.name, product: opt.product?.name ?? '' }) };
  });
  const created = await createLinkedQuotation(req, auth, id).catch((err: unknown) => {
    logger.warn({ err }, 'Linked quotation not created; Create quotation can be retried');
    return null;
  });
  return { ...res, quotation: created };
}

/** Create quotation from the chosen product (retry-safe; P-27 recalculates, never copies the premium). */
export async function createLinkedQuotation(req: Request, auth: AuthContext, id: string) {
  const c = await loadCmp(db, auth, id);
  if (c.status !== 'PRODUCT_CHOSEN') throw stateConflict('comparison', c.status);
  if (c.linkedQuotationId) {
    const [r] = await db.select({ id: quotationRevisions.id }).from(quotationRevisions).where(eq(quotationRevisions.quotationId, c.linkedQuotationId)).orderBy(desc(quotationRevisions.revisionNo)).limit(1);
    return { revisionId: r!.id };
  }
  const inputs = c.inputs as CInputs;
  const opt = (c.options as OptionOut[]).find((o) => o.productId === c.chosenProductId)!;
  const p = await productCtx(db, auth.accountId!, opt.productId);
  if (!p) throw notFound();
  return db.transaction(async (tx) => {
    const now = clock.now();
    const qInputs: Inputs = { typeId: inputs.typeId, insurerId: p.insurerId, productId: p.productId, people: inputs.people, sumInsured: inputs.sumInsured, term: inputs.term, startDate: inputs.startDate, answers: inputs.answers, factors: inputs.factors, riders: opt.riders ?? [] };
    const [q] = await tx.insert(quotations).values({ accountId: auth.accountId!, customerId: c.customerId, productId: p.productId, insurerId: p.insurerId, typeId: p.typeId, fromComparisonId: c.id, createdBy: auth.userId, createdAt: now }).returning();
    const [r] = await tx.insert(quotationRevisions).values({ quotationId: q!.id, accountId: auth.accountId!, revisionNo: 1, status: 'DRAFT', step: 6, inputs: qInputs, createdBy: auth.userId, createdAt: now, updatedAt: now }).returning();
    await tx.update(comparisons).set({ linkedQuotationId: q!.id }).where(eq(comparisons.id, c.id));
    await audit(tx, req, { action: 'QUOTATION_DRAFT_STARTED', entity: 'quotation', entityId: q!.id, newValue: { fromComparison: c.number } });
    return { revisionId: r!.id };
  });
}

export async function publicComparison(token: string) {
  if (!/^[A-Za-z0-9_-]{16,}$/.test(token)) throw notFound();
  const [c] = await db.select().from(comparisons).where(eq(comparisons.viewToken, token));
  if (!c) throw notFound();
  const advisor = await advisorFacts(db, c.accountId);
  const [adv] = await db.select({ mobile: users.mobile }).from(users).where(and(eq(users.accountId, c.accountId), eq(users.role, 'ADV')));
  const contact = { name: advisor.name, businessName: advisor.businessName, mobile: adv?.mobile ?? '', email: advisor.email, logoUrl: advisor.logoFileId ? `/api/v1/public/logo/${c.accountId}` : null };
  if (!['SHARED', 'PRODUCT_CHOSEN'].includes(c.status) || isExpired(c) || (c.validUntil && c.validUntil < istToday())) {
    return { valid: false, advisor: contact, message: msg('QT-20', { 'advisor name': advisor.name, 'advisor mobile': contact.mobile.replace('+91', '+91 ') }) };
  }
  const now = clock.now();
  if (!c.viewedAt || now.getTime() - c.viewedAt.getTime() > 10 * 60_000) {
    await db.update(comparisons).set({ viewedAt: now }).where(eq(comparisons.id, c.id));
    await db.insert(shareEvents).values({ accountId: c.accountId, recordType: 'COMPARISON', recordId: c.id, channel: 'VIEWED', at: now });
  }
  const snap = c.snapshot as { table: { label: string; cells: string[] }[]; recommendedProductId: string | null; options: OptionOut[] };
  return {
    valid: true,
    advisor: contact,
    number: c.number,
    columns: snap.options.map((o) => ({ title: `${o.product!.insurerName} · ${o.product!.name}`, recommended: o.productId === snap.recommendedProductId })),
    recommendedReason: c.reason,
    table: snap.table,
    validUntil: c.validUntil,
    disclaimer: disclaimer(c.calculatedOn ?? istToday()),
  };
}

export async function listComparisons(auth: AuthContext, f: { status?: string; q?: string; customerId?: string; page?: number }) {
  const conds: SQL[] = [eq(comparisons.accountId, auth.accountId!)];
  if (f.status && STATUS_TEXT[f.status]) conds.push(eq(comparisons.status, f.status));
  if (f.customerId && isUuid(f.customerId)) conds.push(eq(comparisons.customerId, f.customerId));
  if (f.q) {
    const t = `%${f.q.replace(/[%_\\]/g, '')}%`;
    conds.push(or(ilike(comparisons.number, t), ilike(customers.fullName, t))!);
  }
  const page = Math.max(1, f.page ?? 1);
  const size = settings.get('CFG-23');
  const rows = await db
    .select({ c: comparisons, customerName: customers.fullName, typeName: insuranceTypes.name })
    .from(comparisons)
    .innerJoin(customers, eq(customers.id, comparisons.customerId))
    .leftJoin(insuranceTypes, eq(insuranceTypes.id, comparisons.typeId))
    .where(and(...conds))
    .orderBy(desc(comparisons.updatedAt))
    .limit(size)
    .offset((page - 1) * size);
  const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(comparisons).innerJoin(customers, eq(customers.id, comparisons.customerId)).where(and(...conds))) as [{ n: number }];
  return {
    items: rows.map(({ c, customerName, typeName }) => ({
      id: c.id,
      number: c.number,
      status: c.status,
      expired: isExpired(c),
      customerId: c.customerId,
      customerName,
      typeName,
      products: (c.options as OptionOut[]).map((o) => o.product?.name).filter(Boolean),
      validUntil: c.validUntil,
      updatedAt: (c.updatedAt ?? c.createdAt).toISOString(),
    })),
    total: n,
    page,
    pageSize: size,
  };
}

/** SYS-01 for comparisons. */
export async function expireComparisons(): Promise<number> {
  const rows = await db
    .update(comparisons)
    .set({ status: 'EXPIRED', statusAt: clock.now() })
    .where(and(eq(comparisons.status, 'SHARED'), sql`${comparisons.validUntil} < ${istToday()}`))
    .returning({ id: comparisons.id });
  return rows.length;
}

export const comparisonStatuses = () => Object.keys(STATUS_TEXT);
