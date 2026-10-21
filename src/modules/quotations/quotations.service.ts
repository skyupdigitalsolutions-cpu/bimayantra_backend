// P-27 Create a normal quotation, P-28 Share it, P-29 Revise, cancel, accept, reject or expire it.
// The wizard saves a draft at every step (GR-14); Generate recalculates on the server, checks everything
// again, gives the QT number and revision, freezes the snapshot, builds the PDF and sets READY (QT-01).
import { randomBytes } from 'node:crypto';
import type { Request } from 'express';
import { and, asc, desc, eq, gte, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db, type DbOrTx } from '../../db/client.js';
import { customers, insuranceTypes, insurers, payments, policies, proposals, quotationRevisions, quotations, shareEvents, users, vehicles } from '../../db/schema.js';
import { addDays, clock, formatDate, istToday } from '../../lib/clock.js';
import { AppError, fieldErrors, notFound, stateConflict, versionConflict, type FieldError } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import { logger } from '../../lib/logger.js';
import { inr } from '../../lib/money.js';
import { msg, render } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { priceInEffect } from '../catalogue/prices.service.js';
import { isUuid, nextNumber, readVersion } from '../clients/common.js';
import { getFile, readStored, storeGenerated, fileLink } from '../files/files.service.js';
import { dispatch, queueMessage, consentState, dailyLimit, sentToday } from '../messages/messages.service.js';
import { activeTemplate, fill } from '../messages/templates.js';
import { notify } from '../notifications/notifications.service.js';
import { sharingBlock } from '../profile/profile.service.js';
import { settings } from '../settings/settings.service.js';
import { cancelAwaiting, createAwaiting, parsePaymentLink, paymentsOf, paymentView } from '../payments/payments.service.js';
import {
  advisorFacts,
  bandIssue,
  calculate,
  checkSteps,
  CUSTOMER_KEY,
  insurerChoices,
  loadCtx,
  mappingFor,
  mappingIssue,
  productChoices,
  productCtx,
  productIssue,
  productsOfType,
  selectedPeople,
  typeChoices,
  vehicleChoices,
  type Breakdown,
  type Inputs,
} from './engine.js';
import { quotationPdf, type PdfHeader } from './pdf.js';

type Rev = typeof quotationRevisions.$inferSelect;
type Q = typeof quotations.$inferSelect;
export const LIVE = ['READY', 'SHARED', 'ACCEPTED'] as const;
export const REJECT_REASONS = ['Premium too high', 'Chose another insurer', 'Not interested now', 'Other'] as const;
export const STATUS_TEXT: Record<string, string> = {
  DRAFT: 'Draft',
  READY: 'Ready',
  SHARED: 'Shared',
  ACCEPTED: 'Accepted',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired',
  SUPERSEDED: 'Superseded',
  CANCELLED: 'Cancelled',
};
export const disclaimer = (calculatedOn: string) =>
  `This quotation is based on the details you shared and the insurer's published rates on ${formatDate(calculatedOn)}. The insurer decides the final premium and whether to accept the proposal. Please read the policy wording before you buy.`;

/** Keep only the input keys the wizard uses (never trust extra fields). */
export function cleanInputs(raw: unknown): Inputs {
  const b = (raw ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : undefined);
  const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  const strMap = (v: unknown): Record<string, string> => Object.fromEntries(Object.entries(obj(v) ?? {}).map(([k, x]): [string, string] => [k, s(x) ?? '']).filter(([, x]) => x !== ''));
  const ov = obj(b.override);
  const dc = obj(b.discount);
  const mn = obj(b.manual);
  return {
    typeId: s(b.typeId) || undefined,
    insurerId: s(b.insurerId) || undefined,
    productId: s(b.productId) || undefined,
    people: Array.isArray(b.people) ? [...new Set(b.people.filter((x): x is string => typeof x === 'string'))] : [],
    sumInsured: s(b.sumInsured) || undefined,
    term: s(b.term) || undefined,
    startDate: s(b.startDate) || undefined,
    answers: strMap(b.answers),
    factors: strMap(b.factors),
    vehicleId: s(b.vehicleId) || null,
    riders: Array.isArray(b.riders) ? [...new Set(b.riders.filter((x): x is string => typeof x === 'string'))] : [],
    manual: mn ? { netPremium: s(mn.netPremium), taxAmount: s(mn.taxAmount) } : null,
    override: ov && (s(ov.amount) || s(ov.reason)) ? { amount: s(ov.amount), reason: s(ov.reason) } : null,
    discount: dc && (s(dc.value) || s(dc.reference)) ? { kind: s(dc.kind) === 'PERCENT' ? 'PERCENT' : 'AMOUNT', value: s(dc.value), reference: s(dc.reference) } : null,
  };
}

async function loadRev(dbx: DbOrTx, auth: AuthContext, rid: string, lock = false): Promise<{ r: Rev; q: Q }> {
  if (!isUuid(rid)) throw notFound();
  const base = dbx
    .select({ r: quotationRevisions, q: quotations })
    .from(quotationRevisions)
    .innerJoin(quotations, eq(quotations.id, quotationRevisions.quotationId))
    .where(and(eq(quotationRevisions.id, rid), eq(quotationRevisions.accountId, auth.accountId!)));
  const [row] = lock ? await base.for('update', { of: quotationRevisions }) : await base;
  if (!row) throw notFound();
  return row;
}

const isExpired = (r: Rev) => r.status === 'EXPIRED' || (['SHARED', 'ACCEPTED'].includes(r.status) && !!r.validUntil && r.validUntil < istToday());
const shareUrl = (token: string | null) => (token ? `${env.APP_URL}/q/${token}` : null);

/** Wizard lists for the current inputs (only for drafts). */
async function wizardOptions(auth: AuthContext, q: Q, inputs: Inputs, renewal: boolean) {
  const accountId = auth.accountId!;
  const ctx = await loadCtx(accountId, auth.role, q.customerId, inputs, renewal);
  const products = inputs.typeId && inputs.insurerId ? await productsOfType(accountId, inputs.typeId, inputs.insurerId) : [];
  const productList = [];
  for (const p of products) {
    const issue = await productIssue(accountId, p, { renewal });
    if (p.status === 'UPCOMING' || (p.status === 'WITHDRAWN' && !renewal)) continue;
    productList.push({ id: p.productId, name: p.data.name, uin: p.data.uin, kind: p.kind, pricingMode: p.data.pricingMode, available: !issue, issue: issue ? msg(issue.code, issue.params) : null });
  }
  return {
    types: await typeChoices(accountId),
    insurers: await insurerChoices(accountId),
    products: productList,
    people: ctx.people
      .filter((p) => p.active)
      .map((p) => {
        const issue = ctx.product ? bandIssue(p, ctx.product.data) : p.age === null ? { code: 'QT-05', params: { name: p.name } } : null;
        return { key: p.key, name: p.name, relationship: p.relationship, age: p.age, issue: issue ? msg(issue.code, issue.params) : null };
      }),
    product: ctx.product ? productChoices(ctx.product) : null,
    vehicles: ctx.product && /motor/i.test(ctx.product.typeName) ? await vehicleChoices(q.customerId) : [],
    licence: ctx.advisor.licenceValidUntil && ctx.advisor.licenceValidUntil < istToday() ? msg('PRF-17', { date: formatDate(ctx.advisor.licenceValidUntil) }) : null,
  };
}

export async function revisionView(auth: AuthContext, r: Rev, q: Q, opts: { withOptions?: boolean } = {}) {
  const [c] = await db.select().from(customers).where(eq(customers.id, q.customerId));
  const inputs = r.inputs as Inputs;
  const prodId = q.productId ?? inputs.productId;
  const pctx = prodId ? await productCtx(db, auth.accountId!, prodId) : null;
  const pays = await paymentsOf(q.id);
  const paid = pays.find((p) => p.status === 'PAID');
  const [prop] = await db.select().from(proposals).where(and(eq(proposals.quotationId, q.id), inArray(proposals.status, ['DRAFT', 'SUBMITTED', 'ISSUED'])));
  const revs = await db.select({ id: quotationRevisions.id, revisionNo: quotationRevisions.revisionNo, status: quotationRevisions.status }).from(quotationRevisions).where(eq(quotationRevisions.quotationId, q.id)).orderBy(asc(quotationRevisions.revisionNo));
  const [renewalOf] = q.renewalOfPolicyId ? await db.select({ number: policies.number, insurerPolicyNumber: policies.insurerPolicyNumber }).from(policies).where(eq(policies.id, q.renewalOfPolicyId)) : [];
  const expired = isExpired(r);
  const isAdv = auth.role === 'ADV';
  const awaiting = pays.find((p) => p.revisionId === r.id && p.status === 'AWAITING_PAYMENT');
  const timeline = await db.select().from(shareEvents).where(eq(shareEvents.recordId, r.id)).orderBy(desc(shareEvents.at)).limit(50);
  const snap = r.snapshot as { product?: { name: string; uin: string }; insurer?: { name: string }; agentCode?: string; type?: { name: string } } | null;
  return {
    id: r.id,
    quotationId: q.id,
    number: q.number,
    revisionNo: r.revisionNo,
    status: expired && r.status !== 'EXPIRED' ? r.status : r.status,
    expired,
    statusText: STATUS_TEXT[r.status],
    step: r.step,
    inputs,
    breakdown: r.breakdown as Breakdown | null,
    finalPayable: r.finalPayable,
    calculatedOn: r.calculatedOn,
    validUntil: r.validUntil,
    firstSharedAt: r.firstSharedAt?.toISOString() ?? null,
    viewedAt: r.viewedAt?.toISOString() ?? null,
    reason: r.reason,
    reasonNote: r.reasonNote,
    pdfFileId: r.pdfFileId,
    shareUrl: ['SHARED', 'ACCEPTED'].includes(r.status) ? shareUrl(r.viewToken) : null,
    customer: c ? { id: c.id, name: c.fullName, number: c.number, mobile: c.mobile, email: c.email, status: c.status } : null,
    product: pctx
      ? { id: pctx.productId, name: snap?.product?.name ?? pctx.data.name, uin: snap?.product?.uin ?? pctx.data.uin, insurerId: pctx.insurerId, insurerName: pctx.insurerName, typeName: pctx.typeName, pricingMode: pctx.data.pricingMode }
      : null,
    agentCode: snap?.agentCode ?? null,
    renewalOf: renewalOf ? { id: q.renewalOfPolicyId, number: renewalOf.number, insurerPolicyNumber: renewalOf.insurerPolicyNumber } : null,
    revisions: revs,
    payments: pays.map((p) => paymentView(p, { canAct: isAdv })),
    proposal: prop ? { id: prop.id, number: prop.number, status: prop.status } : null,
    timeline: timeline.map((t) => ({ channel: t.channel, at: t.at.toISOString() })),
    actions: {
      canEditDraft: r.status === 'DRAFT',
      canEdit: r.status === 'READY',
      canShare: LIVE.includes(r.status as (typeof LIVE)[number]) && !expired,
      canRevise: ['SHARED', 'EXPIRED', 'REJECTED'].includes(r.status) && !paid && !revs.some((x) => x.status === 'DRAFT'),
      canAccept: r.status === 'SHARED' && !expired,
      canReject: r.status === 'SHARED',
      canCancel: LIVE.includes(r.status as (typeof LIVE)[number]) && !paid,
      canDelete: r.status === 'DRAFT',
      canAddPaymentLink: LIVE.includes(r.status as (typeof LIVE)[number]) && !paid && !awaiting && !expired,
      canRecordPayment: isAdv && ['SHARED', 'ACCEPTED'].includes(r.status) && !paid && !expired,
      canStartProposal: ['SHARED', 'ACCEPTED'].includes(r.status) && !expired && !prop,
    },
    options: opts.withOptions && r.status === 'DRAFT' ? await wizardOptions(auth, q, inputs, !!q.renewalOfPolicyId) : null,
    version: r.version,
  };
}

// ---------- start, save, generate ----------
export async function startQuotation(req: Request, auth: AuthContext, body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const customerId = typeof b.customerId === 'string' ? b.customerId : '';
  if (!customerId) throw fieldErrors([{ field: 'customerId', code: 'GEN-01', params: { 'Field label': 'Customer' } }]);
  const inputs = cleanInputs(b.inputs);
  const ctx = await loadCtx(auth.accountId!, auth.role, customerId, inputs);
  if (!ctx.people.length) throw fieldErrors([{ field: 'customerId', code: 'VAL-22' }]);
  const errs = await checkSteps(ctx, inputs, 1);
  if (errs.length) throw fieldErrors(errs);
  const renewalOfPolicyId = isUuid(b.renewalOfPolicyId) ? b.renewalOfPolicyId : null;
  const fromComparisonId = isUuid(b.fromComparisonId) ? b.fromComparisonId : null;
  const step = Math.min(Math.max(Number(b.step) || 2, 1), 10);
  return db.transaction(async (tx) => {
    const now = clock.now();
    const [q] = await tx
      .insert(quotations)
      .values({ accountId: auth.accountId!, customerId, renewalOfPolicyId, fromComparisonId, productId: inputs.productId ?? null, insurerId: inputs.insurerId ?? null, typeId: inputs.typeId ?? null, createdBy: auth.userId, createdAt: now })
      .returning();
    const [r] = await tx.insert(quotationRevisions).values({ quotationId: q!.id, accountId: auth.accountId!, revisionNo: 1, status: 'DRAFT', step, inputs, createdBy: auth.userId, createdAt: now, updatedAt: now }).returning();
    await audit(tx, req, { action: 'QUOTATION_DRAFT_STARTED', entity: 'quotation', entityId: q!.id, newValue: { customerId } });
    return { id: r!.id, quotationId: q!.id, message: msg('GEN-14') };
  });
}

/** Which errors belong to the premium (step 8) and discount (step 9) parts. */
const premiumField = (f: string) => f === 'premium' || f.startsWith('manual.') || f.startsWith('override.') || f === 'productId';
const discountField = (f: string) => f.startsWith('discount.');

export async function saveDraft(req: Request, auth: AuthContext, rid: string, body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const inputs = cleanInputs(b.inputs);
  const step = Math.min(Math.max(Number(b.step) || 1, 1), 10);
  const { r, q } = await loadRev(db, auth, rid);
  if (r.status !== 'DRAFT') throw stateConflict('quotation', r.status);
  if (r.version !== readVersion(body)) throw versionConflict('quotation');
  const renewal = !!q.renewalOfPolicyId;
  if (renewal || r.revisionNo > 1) {
    // The customer and product of an existing quotation never change; a renewal keeps the renewed policy's product
    if (q.productId) inputs.productId = q.productId;
    if (q.insurerId) inputs.insurerId = q.insurerId;
    if (q.typeId) inputs.typeId = q.typeId;
  }
  const ctx = await loadCtx(auth.accountId!, auth.role, q.customerId, inputs, renewal);
  const errs = await checkSteps(ctx, inputs, Math.min(step - 1, 7));
  if (errs.length) throw fieldErrors(errs);
  let breakdown: Breakdown | null = null;
  let finalPayable: string | null = null;
  let calcErrors: FieldError[] = [];
  if (step >= 8) {
    const people = selectedPeople(ctx, inputs);
    const res = await calculate(auth.accountId!, ctx.product!, people, ctx.people, inputs, auth.role);
    if (res.ok) {
      breakdown = res.breakdown;
      finalPayable = res.breakdown.finalPayable;
    } else {
      calcErrors = res.errors;
      const blocking = res.errors.filter((e) => (step >= 9 && premiumField(e.field)) || (step >= 10 && discountField(e.field)));
      if (blocking.length) throw fieldErrors(blocking);
      // Show the premium without the discount while the advisor is still on step 9
      if (step === 9 || step === 8) {
        const noDisc = await calculate(auth.accountId!, ctx.product!, people, ctx.people, { ...inputs, discount: null, ...(step === 8 ? { override: inputs.override } : {}) }, auth.role);
        if (noDisc.ok) {
          breakdown = noDisc.breakdown;
          finalPayable = noDisc.breakdown.finalPayable;
        }
      }
    }
  }
  const now = clock.now();
  const [saved] = await db
    .update(quotationRevisions)
    .set({ inputs, step, breakdown, finalPayable, priceVersionId: breakdown?.priceVersion?.id ?? null, calculatedOn: breakdown ? istToday() : null, updatedAt: now, version: r.version + 1 })
    .where(and(eq(quotationRevisions.id, r.id), eq(quotationRevisions.version, r.version)))
    .returning();
  if (!saved) throw versionConflict('quotation');
  await db.update(quotations).set({ productId: inputs.productId ?? null, insurerId: inputs.insurerId ?? null, typeId: inputs.typeId ?? null }).where(and(eq(quotations.id, q.id), sql`${quotations.number} is null`));
  const view = await revisionView(auth, saved, { ...q, productId: inputs.productId ?? null }, { withOptions: true });
  return { ...view, calcErrors: calcErrors.map((e) => ({ ...e, text: render(e.code, e.params) })), message: msg('GEN-14') };
}

export async function getRevision(auth: AuthContext, rid: string) {
  const { r, q } = await loadRev(db, auth, rid);
  return revisionView(auth, r, q, { withOptions: true });
}

/** Shown at the top of the quotation: the latest live revision, else the latest one. */
export async function getQuotation(auth: AuthContext, qid: string) {
  if (!isUuid(qid)) throw notFound();
  const revs = await db.select().from(quotationRevisions).where(and(eq(quotationRevisions.quotationId, qid), eq(quotationRevisions.accountId, auth.accountId!))).orderBy(desc(quotationRevisions.revisionNo));
  if (!revs.length) throw notFound();
  const main = revs.find((r) => LIVE.includes(r.status as (typeof LIVE)[number])) ?? revs[0]!;
  const { r, q } = await loadRev(db, auth, main.id);
  return revisionView(auth, r, q, { withOptions: true });
}

async function pdfHeader(accountId: string): Promise<PdfHeader> {
  const a = await advisorFacts(db, accountId);
  const [u] = await db.select({ mobile: users.mobile }).from(users).where(and(eq(users.accountId, accountId), eq(users.role, 'ADV')));
  let logo: Buffer | null = null;
  if (a.logoFileId) {
    const f = await getFile(a.logoFileId);
    if (f) logo = await readStored(f.storageKey).catch(() => null);
  }
  return { businessName: a.businessName, advisorName: a.name, licenceNumber: a.licenceNumber, mobile: u?.mobile ?? '', email: a.email, logo };
}
export { pdfHeader };

/** Generate (step 10): recalculate, check everything, number, snapshot, PDF, READY. */
export async function generate(req: Request, auth: AuthContext, rid: string, body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const pre = await loadRev(db, auth, rid);
  if (pre.r.status !== 'DRAFT') throw stateConflict('quotation', pre.r.status);
  if (pre.r.version !== readVersion(body)) throw versionConflict('quotation');
  const inputs = pre.r.inputs as Inputs;
  const renewal = !!pre.q.renewalOfPolicyId;
  const ctx = await loadCtx(auth.accountId!, auth.role, pre.q.customerId, inputs, renewal);
  const errs = await checkSteps(ctx, inputs, 10);
  const people = selectedPeople(ctx, inputs);
  const calc = errs.length ? null : await calculate(auth.accountId!, ctx.product!, people, ctx.people, inputs, auth.role);
  const all = [...errs, ...(calc && !calc.ok ? calc.errors : [])];
  if (all.length) {
    const list = [...new Set(all.map((e) => render(e.code, e.params)))].join('; ');
    throw new AppError(422, 'QT-04', { list }, all);
  }
  const res = calc as Extract<typeof calc, { ok: true }>;
  if (pre.r.finalPayable && res.breakdown.finalPayable !== pre.r.finalPayable) {
    await db.update(quotationRevisions).set({ step: 8, breakdown: res.breakdown, finalPayable: res.breakdown.finalPayable, priceVersionId: res.breakdown.priceVersion?.id ?? null, calculatedOn: istToday(), version: pre.r.version + 1 }).where(eq(quotationRevisions.id, pre.r.id));
    throw new AppError(409, 'QT-10', {}, [], { old: pre.r.finalPayable, new: res.breakdown.finalPayable, step: 8 });
  }
  // Optional payment link pasted on step 10 (P-31 rules)
  const linkBody = b.payment && typeof b.payment === 'object' ? b.payment : null;
  const p = ctx.product!;
  const link = linkBody ? parsePaymentLink(linkBody, { name: p.insurerName, paymentDomains: p.paymentDomains }, res.breakdown.finalPayable) : null;

  // Number first (kept if the PDF fails, so a retry reuses it)
  let number = pre.q.number;
  if (!number) {
    number = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(quotations).where(eq(quotations.id, pre.q.id)).for('update');
      if (locked!.number) return locked!.number;
      const n = await nextNumber(tx, auth.accountId!, 'QT');
      await tx.update(quotations).set({ number: n, productId: p.productId, insurerId: p.insurerId, typeId: p.typeId }).where(eq(quotations.id, pre.q.id));
      return n;
    });
  }
  const [c] = await db.select().from(customers).where(eq(customers.id, pre.q.customerId));
  const mapping = await mappingFor(db, auth.accountId!, p.insurerId);
  const advisor = await advisorFacts(db, auth.accountId!);
  const today = istToday();
  const [veh] = inputs.vehicleId ? await db.select().from(vehicles).where(eq(vehicles.id, inputs.vehicleId)) : [];
  const answers = p.questions.filter((qq) => inputs.answers?.[qq.key]).map((qq) => ({ label: qq.label, value: inputs.answers![qq.key]! }));
  const snapshot = {
    customer: { id: c!.id, number: c!.number, name: c!.fullName, mobile: c!.mobile, email: c!.email },
    people: people.map((x) => ({ key: x.key, name: x.name, relationship: x.relationship, dateOfBirth: x.dateOfBirth, age: x.age })),
    product: { id: p.productId, versionId: p.versionId, versionNo: p.versionNo, name: p.data.name, uin: p.data.uin, kind: p.kind, features: p.data.features, nomineeRequired: p.data.nomineeRequired, maxNominees: p.data.maxNominees, graceDays: p.data.graceDays, policyTerms: p.data.policyTerms },
    insurer: { id: p.insurerId, name: p.insurerName },
    type: { id: p.typeId, name: p.typeName },
    priceVersion: res.breakdown.priceVersion,
    inputs,
    answers,
    vehicle: veh ? { id: veh.id, registration: veh.registration, make: veh.make, model: veh.model, year: veh.year } : null,
    breakdown: res.breakdown,
    advisor: { name: advisor.name, licenceNumber: advisor.licenceNumber, businessName: advisor.businessName },
    agentCode: mapping?.agentCode ?? '',
    disclaimer: disclaimer(today),
  };
  let file: { id: string; sha256: string };
  try {
    const pdf = await quotationPdf({
      header: await pdfHeader(auth.accountId!),
      number,
      revision: pre.r.revisionNo,
      calculatedOn: today,
      customer: { name: c!.fullName, mobile: c!.mobile, email: c!.email },
      people: snapshot.people,
      product: { name: p.data.name, uin: p.data.uin, insurerName: p.insurerName, typeName: p.typeName, agentCode: snapshot.agentCode },
      inputs: { sumInsured: inputs.sumInsured!, term: String(inputs.term), startDate: inputs.startDate!, answers, vehicle: veh ? `${veh.registration} · ${veh.make} ${veh.model} (${veh.year})` : null },
      breakdown: res.breakdown,
      priceVersion: res.breakdown.priceVersion ? `${res.breakdown.priceVersion.name} from ${formatDate(res.breakdown.priceVersion.effectiveFrom)}` : null,
      validity: `Valid for ${settings.get('CFG-46')} days from the day it is first shared with you.`,
      disclaimer: snapshot.disclaimer,
    });
    file = await storeGenerated(auth.accountId, auth.userId, 'QUOTATION_PDF', `${number}-R${pre.r.revisionNo}.pdf`, pdf, 'application/pdf');
  } catch (err) {
    logger.error({ err }, 'Quotation PDF failed');
    throw new AppError(503, 'QT-13');
  }
  const token = randomBytes(Math.ceil(settings.get('CFG-134') / 8)).toString('base64url');
  return db.transaction(async (tx) => {
    const { r, q } = await loadRev(tx, auth, rid, true);
    if (r.status !== 'DRAFT') throw stateConflict('quotation', r.status);
    if (r.version !== pre.r.version) throw versionConflict('quotation');
    // The earlier revision stays as it is until now; then it becomes SUPERSEDED and its link stops (P-29)
    const earlier = await tx.select().from(quotationRevisions).where(and(eq(quotationRevisions.quotationId, q.id), inArray(quotationRevisions.status, ['READY', 'SHARED', 'ACCEPTED', 'EXPIRED', 'REJECTED'])));
    for (const e of earlier) {
      if (e.status === 'ACCEPTED' || e.status === 'READY') throw stateConflict('quotation', e.status);
      await tx.update(quotationRevisions).set({ status: 'SUPERSEDED', statusAt: clock.now(), version: e.version + 1 }).where(eq(quotationRevisions.id, e.id));
      await cancelAwaiting(tx, e.id);
    }
    const now = clock.now();
    await tx
      .update(quotationRevisions)
      .set({ status: 'READY', step: 10, breakdown: res.breakdown, finalPayable: res.breakdown.finalPayable, priceVersionId: res.breakdown.priceVersion?.id ?? null, calculatedOn: today, snapshot, pdfFileId: file.id, pdfChecksum: file.sha256, viewToken: token, statusAt: now, updatedAt: now, version: r.version + 1 })
      .where(eq(quotationRevisions.id, r.id));
    if (link) await createAwaiting(tx, auth, r, p.insurerId, link);
    await audit(tx, req, { action: 'QUOTATION_GENERATED', entity: 'quotation', entityId: q.id, newValue: { number, revision: r.revisionNo, finalPayable: res.breakdown.finalPayable, override: res.breakdown.override, discount: res.breakdown.discount } });
    return {
      id: r.id,
      quotationId: q.id,
      message: msg('QT-01', { number, revision: r.revisionNo, customer: c!.fullName }),
      overrideNote: res.breakdown.override ? msg('QT-38', { amount: F.groupIndian(res.breakdown.calculated) }) : null,
    };
  });
}

// ---------- P-29 actions ----------
export async function editRevision(req: Request, auth: AuthContext, rid: string, body: unknown) {
  return db.transaction(async (tx) => {
    const { r, q } = await loadRev(tx, auth, rid, true);
    if (r.version !== readVersion(body)) throw versionConflict('quotation');
    if (r.status !== 'READY') throw stateConflict('quotation', r.status);
    await tx.update(quotationRevisions).set({ status: 'DRAFT', step: 9, pdfFileId: null, pdfChecksum: null, viewToken: null, snapshot: null, statusAt: clock.now(), version: r.version + 1 }).where(eq(quotationRevisions.id, r.id));
    await cancelAwaiting(tx, r.id);
    await audit(tx, req, { action: 'QUOTATION_EDITED', entity: 'quotation', entityId: q.id, newValue: { revision: r.revisionNo } });
    return { id: r.id, message: msg('GEN-14') };
  });
}

export async function reviseQuotation(req: Request, auth: AuthContext, rid: string, body: unknown) {
  return db.transaction(async (tx) => {
    const { r, q } = await loadRev(tx, auth, rid, true);
    if (r.version !== readVersion(body)) throw versionConflict('quotation');
    const [paid] = await tx.select({ id: payments.id }).from(payments).where(and(eq(payments.quotationId, q.id), eq(payments.status, 'PAID')));
    if (paid) throw new AppError(409, 'QT-21');
    if (!['SHARED', 'EXPIRED', 'REJECTED'].includes(r.status)) throw stateConflict('quotation', r.status);
    const all = await tx.select().from(quotationRevisions).where(eq(quotationRevisions.quotationId, q.id));
    const draft = all.find((x) => x.status === 'DRAFT');
    if (draft) return { id: draft.id, message: msg('QT-25', { n: draft.revisionNo, 'n-1': draft.revisionNo - 1 }) };
    if (all.length >= settings.get('CFG-47')) throw new AppError(409, 'QT-35');
    const n = Math.max(...all.map((x) => x.revisionNo)) + 1;
    const inputs = { ...(r.inputs as Inputs) };
    const now = clock.now();
    const [created] = await tx.insert(quotationRevisions).values({ quotationId: q.id, accountId: auth.accountId!, revisionNo: n, status: 'DRAFT', step: 6, inputs, createdBy: auth.userId, createdAt: now, updatedAt: now }).returning();
    await audit(tx, req, { action: 'QUOTATION_REVISED', entity: 'quotation', entityId: q.id, newValue: { revision: n } });
    return { id: created!.id, message: msg('QT-25', { n, 'n-1': n - 1 }) };
  });
}

export async function markAccepted(req: Request, auth: AuthContext, rid: string, body: unknown) {
  return db.transaction(async (tx) => {
    const { r, q } = await loadRev(tx, auth, rid, true);
    if (r.version !== readVersion(body)) throw versionConflict('quotation');
    if (r.status !== 'SHARED') throw stateConflict('quotation', r.status);
    if (isExpired(r)) throw stateConflict('quotation', 'EXPIRED');
    await tx.update(quotationRevisions).set({ status: 'ACCEPTED', statusAt: clock.now(), version: r.version + 1 }).where(eq(quotationRevisions.id, r.id));
    await audit(tx, req, { action: 'QUOTATION_ACCEPTED', entity: 'quotation', entityId: q.id, newValue: { revision: r.revisionNo } });
    return { message: msg('QT-26') };
  });
}

export async function markRejected(req: Request, auth: AuthContext, rid: string, body: unknown) {
  const v = F.parseFields(body, { reason: { label: 'Reason', required: true, oneOf: REJECT_REASONS }, note: { label: 'Note', rule: F.notes } }) as { reason: string; note?: string };
  if (v.reason === 'Other' && !v.note) throw fieldErrors([{ field: 'note', code: 'GEN-01', params: { 'Field label': 'Note' } }]);
  return db.transaction(async (tx) => {
    const { r, q } = await loadRev(tx, auth, rid, true);
    if (r.version !== readVersion(body)) throw versionConflict('quotation');
    if (r.status !== 'SHARED') throw stateConflict('quotation', r.status);
    await tx.update(quotationRevisions).set({ status: 'REJECTED', reason: v.reason, reasonNote: v.note ?? null, statusAt: clock.now(), version: r.version + 1 }).where(eq(quotationRevisions.id, r.id));
    await audit(tx, req, { action: 'QUOTATION_REJECTED', entity: 'quotation', entityId: q.id, newValue: { reason: v.reason } });
    return { message: msg('QT-27') };
  });
}

export async function cancelRevision(req: Request, auth: AuthContext, rid: string, body: unknown) {
  const v = F.parseFields(body, { reason: { label: 'Reason', required: true, rule: F.notes } }) as { reason: string };
  return db.transaction(async (tx) => {
    const { r, q } = await loadRev(tx, auth, rid, true);
    if (r.version !== readVersion(body)) throw versionConflict('quotation');
    if (!LIVE.includes(r.status as (typeof LIVE)[number])) throw stateConflict('quotation', r.status);
    const [paid] = await tx.select({ id: payments.id }).from(payments).where(and(eq(payments.quotationId, q.id), eq(payments.status, 'PAID')));
    if (paid) throw stateConflict('quotation', 'PAID');
    await tx.update(quotationRevisions).set({ status: 'CANCELLED', reason: v.reason, statusAt: clock.now(), version: r.version + 1 }).where(eq(quotationRevisions.id, r.id));
    await cancelAwaiting(tx, r.id);
    await audit(tx, req, { action: 'QUOTATION_CANCELLED', entity: 'quotation', entityId: q.id, newValue: { revision: r.revisionNo, reason: v.reason } });
    return { message: msg('QT-28') };
  });
}

export async function deleteDraft(req: Request, auth: AuthContext, rid: string, body: unknown) {
  return db.transaction(async (tx) => {
    const { r, q } = await loadRev(tx, auth, rid, true);
    if (r.version !== readVersion(body)) throw versionConflict('quotation');
    if (r.status !== 'DRAFT' || r.firstSharedAt) throw stateConflict('quotation', r.status);
    await tx.delete(quotationRevisions).where(eq(quotationRevisions.id, r.id));
    const [left] = await tx.select({ n: sql<number>`count(*)::int` }).from(quotationRevisions).where(eq(quotationRevisions.quotationId, q.id));
    if (!left?.n) await tx.delete(quotations).where(eq(quotations.id, q.id));
    await audit(tx, req, { action: 'QUOTATION_DRAFT_DELETED', entity: 'quotation', entityId: q.id, oldValue: { number: q.number, revision: r.revisionNo } });
    return { message: msg('QT-29') };
  });
}

// ---------- P-28 Share ----------
async function shareChecks(tx: DbOrTx, auth: AuthContext, r: Rev, q: Q) {
  const block = await sharingBlock(auth.accountId!);
  if (block) throw block;
  const [c] = await tx.select().from(customers).where(eq(customers.id, q.customerId));
  if (c!.status !== 'ACTIVE') throw new AppError(409, 'CU-20');
  const p = await productCtx(tx, auth.accountId!, q.productId!);
  if (!p) throw new AppError(409, 'QT-11', { Product: '—' });
  const pi = await productIssue(auth.accountId!, p, { renewal: !!q.renewalOfPolicyId });
  if (pi?.code === 'QT-11') throw new AppError(409, 'QT-11', pi.params);
  const mi = mappingIssue(await mappingFor(tx, auth.accountId!, p.insurerId), p.insurerName, q.renewalOfPolicyId ? 'ACTIVE' : p.insurerStatus);
  if (mi) throw new AppError(409, mi.code, mi.params);
  if (r.status === 'READY' && r.priceVersionId) {
    const now = await priceInEffect(tx, auth.accountId!, p.productId);
    if (!now || now.id !== r.priceVersionId) throw new AppError(409, 'QT-14', { date: formatDate(now?.effectiveFrom ?? istToday()) });
  }
  return { c: c!, p };
}

async function sharesToday(dbx: DbOrTx, accountId: string) {
  const start = new Date(`${istToday()}T00:00:00+05:30`);
  const [r] = await dbx
    .select({ n: sql<number>`count(*)::int` })
    .from(shareEvents)
    .where(and(eq(shareEvents.accountId, accountId), gte(shareEvents.at, start), inArray(shareEvents.channel, ['EMAIL', 'WHATSAPP', 'LINK'])));
  return r?.n ?? 0;
}
export { sharesToday };

export async function shareRevision(req: Request, auth: AuthContext, rid: string, body: unknown) {
  const v = F.parseFields(body, { channel: { label: 'Share by', required: true, oneOf: ['EMAIL', 'WHATSAPP', 'LINK', 'PDF'] } }) as { channel: string };
  const result = await db.transaction(async (tx) => {
    const { r, q } = await loadRev(tx, auth, rid, true);
    if (!LIVE.includes(r.status as (typeof LIVE)[number])) throw stateConflict('quotation', r.status);
    if (isExpired(r)) throw stateConflict('quotation', 'EXPIRED');
    const { c, p } = await shareChecks(tx, auth, r, q);
    const now = clock.now();
    if (v.channel === 'PDF') {
      await tx.insert(shareEvents).values({ accountId: auth.accountId!, recordType: 'QUOTATION', recordId: r.id, channel: 'PDF', userId: auth.userId, at: now });
      return { file: fileLink(auth.userId, auth.sessionId, r.pdfFileId!), message: null, dispatchId: null };
    }
    if ((await sharesToday(tx, auth.accountId!)) >= settings.get('CFG-117')) throw new AppError(429, 'QT-24');
    const first = r.status === 'READY';
    const validUntil = first ? addDays(istToday(), settings.get('CFG-46')) : r.validUntil!;
    const url = shareUrl(r.viewToken)!;
    const advisor = await advisorFacts(tx, auth.accountId!);
    const [adv] = await tx.select({ mobile: users.mobile }).from(users).where(and(eq(users.accountId, auth.accountId!), eq(users.role, 'ADV')));
    const firstName = c.fullName.split(' ')[0]!;
    const vars = {
      'customer first name': firstName,
      'insurance type': p.typeName,
      product: p.data.name,
      'final payable': `₹${inr(r.finalPayable!)}`,
      'valid until': formatDate(validUntil),
      'quotation link': url,
      'advisor name': advisor.name,
      'advisor mobile': (adv?.mobile ?? '').replace('+91', '+91 '),
      'advisor email': advisor.email ?? '',
    };
    let out: { message: { code: string; text: string } | null; whatsappUrl?: string; url?: string; dispatchId: string | null };
    if (v.channel === 'EMAIL') {
      if (!c.email) throw new AppError(409, 'QT-23', { customer: c.fullName });
      if ((await consentState(tx, c.id, null, 'EMAIL', c.email)) === 'WITHDRAWN') throw new AppError(409, 'QT-22', { Customer: c.fullName });
      if ((await sentToday(tx, auth.accountId!, 'EMAIL')) >= dailyLimit('EMAIL')) throw new AppError(429, 'QT-24');
      const t = await activeTemplate(tx, 'QUOTATION_EMAIL', 'EMAIL');
      const subject = fill(t?.subject ?? 'Your {insurance type} quotation from {advisor name}', vars);
      const text = fill(t?.body ?? 'Dear {customer first name},\n\nYour quotation for {product}: {final payable}, valid until {valid until}.\n\n{quotation link}\n\n{advisor name}, {advisor mobile}', vars);
      const m = await queueMessage(tx, {
        accountId: auth.accountId!,
        customerId: c.id,
        personName: c.fullName,
        channel: 'EMAIL',
        purpose: 'QUOTATION_EMAIL',
        recipient: c.email,
        templateId: t?.id ?? null,
        templateVersion: t?.templateVersion ?? null,
        variables: vars,
        subject,
        body: text,
        attachmentFileId: r.pdfFileId,
        occurrenceKey: `qt:${r.id}:email:${randomBytes(6).toString('hex')}`,
        relatedType: 'QUOTATION',
        relatedId: r.id,
        createdBy: auth.userId,
      });
      await tx.insert(shareEvents).values({ accountId: auth.accountId!, recordType: 'QUOTATION', recordId: r.id, channel: 'EMAIL', messageId: m!.id, userId: auth.userId, at: now });
      out = { message: msg('QT-15', { email: c.email }), dispatchId: m!.id };
    } else if (v.channel === 'WHATSAPP') {
      const text = `Dear ${firstName}, here is your ${p.typeName} quotation for ${p.data.name}: ₹${inr(r.finalPayable!)}, valid until ${formatDate(validUntil)}. View it here: ${url} — ${advisor.name}`;
      const m = await queueMessage(tx, {
        accountId: auth.accountId!,
        customerId: c.id,
        personName: c.fullName,
        channel: 'WHATSAPP',
        purpose: 'QUOTATION_WHATSAPP',
        recipient: c.mobile,
        variables: vars,
        body: text,
        occurrenceKey: `qt:${r.id}:wa:${randomBytes(6).toString('hex')}`,
        relatedType: 'QUOTATION',
        relatedId: r.id,
        createdBy: auth.userId,
        status: 'SHARED_MANUALLY',
      });
      await tx.insert(shareEvents).values({ accountId: auth.accountId!, recordType: 'QUOTATION', recordId: r.id, channel: 'WHATSAPP', messageId: m!.id, userId: auth.userId, at: now });
      out = { message: msg('QT-16'), whatsappUrl: `https://wa.me/${c.mobile.replace('+', '')}?text=${encodeURIComponent(text)}`, url, dispatchId: null };
    } else {
      await tx.insert(shareEvents).values({ accountId: auth.accountId!, recordType: 'QUOTATION', recordId: r.id, channel: 'LINK', userId: auth.userId, at: now });
      out = { message: msg('GEN-16'), url, dispatchId: null };
    }
    if (first) {
      // First share: SHARED, valid until the end of the IST day CFG-46 days later; later shares never extend it
      await tx.update(quotationRevisions).set({ status: 'SHARED', firstSharedAt: now, validUntil, statusAt: now, version: r.version + 1 }).where(eq(quotationRevisions.id, r.id));
    }
    await audit(tx, req, { action: 'QUOTATION_SHARED', entity: 'quotation', entityId: q.id, newValue: { revision: r.revisionNo, channel: v.channel } });
    return { ...out, validUntil };
  });
  if (result.dispatchId) await dispatch(result.dispatchId);
  return { ...result, dispatchId: undefined };
}

// ---------- the customer's view link (no login) ----------
export async function publicQuotation(token: string) {
  if (!/^[A-Za-z0-9_-]{16,}$/.test(token)) throw notFound();
  const [r] = await db.select().from(quotationRevisions).where(eq(quotationRevisions.viewToken, token));
  if (!r) throw notFound();
  const [q] = await db.select().from(quotations).where(eq(quotations.id, r.quotationId));
  const advisor = await advisorFacts(db, r.accountId);
  const [adv] = await db.select({ mobile: users.mobile }).from(users).where(and(eq(users.accountId, r.accountId), eq(users.role, 'ADV')));
  const contact = { name: advisor.name, businessName: advisor.businessName, mobile: adv?.mobile ?? '', email: advisor.email, logoUrl: advisor.logoFileId ? `/api/v1/public/logo/${r.accountId}` : null };
  const valid = ['SHARED', 'ACCEPTED'].includes(r.status) && !isExpired(r);
  if (!valid) return { valid: false, advisor: contact, message: msg('QT-20', { 'advisor name': advisor.name, 'advisor mobile': contact.mobile.replace('+91', '+91 ') }) };
  const now = clock.now();
  if (!r.viewedAt || now.getTime() - r.viewedAt.getTime() > 10 * 60_000) {
    await db.update(quotationRevisions).set({ viewedAt: now }).where(eq(quotationRevisions.id, r.id));
    await db.insert(shareEvents).values({ accountId: r.accountId, recordType: 'QUOTATION', recordId: r.id, channel: 'VIEWED', at: now });
  }
  const snap = r.snapshot as {
    customer: { name: string };
    people: { name: string; relationship: string; age: number | null }[];
    product: { name: string; uin: string };
    insurer: { name: string };
    type: { name: string };
    inputs: Inputs;
    breakdown: Breakdown;
    agentCode: string;
    disclaimer: string;
  };
  const pays = await paymentsOf(q!.id);
  const paid = pays.find((p) => p.status === 'PAID');
  const awaiting = pays.find((p) => p.revisionId === r.id && p.status === 'AWAITING_PAYMENT' && p.method === 'LINK' && p.link);
  return {
    valid: true,
    advisor: contact,
    number: q!.number,
    revision: r.revisionNo,
    customerFirstName: snap.customer.name.split(' ')[0],
    people: snap.people.map((p) => ({ name: p.name.split(' ')[0], relationship: p.relationship, age: p.age })),
    product: snap.product.name,
    uin: snap.product.uin,
    insurer: snap.insurer.name,
    type: snap.type.name,
    sumInsured: snap.inputs.sumInsured,
    term: snap.inputs.term,
    startDate: snap.inputs.startDate,
    breakdown: snap.breakdown,
    validUntil: r.validUntil,
    disclaimer: snap.disclaimer,
    pay: awaiting && !paid ? { link: awaiting.link, domain: new URL(awaiting.link!).hostname, insurer: snap.insurer.name } : null,
    paid: paid ? msg('PAY-14', { date: formatDate(paid.paidOn!) }) : null,
  };
}

// ---------- lists ----------
export async function listQuotations(auth: AuthContext, f: { status?: string; q?: string; customerId?: string; productId?: string; page?: number }) {
  const conds: SQL[] = [eq(quotations.accountId, auth.accountId!)];
  if (f.customerId && isUuid(f.customerId)) conds.push(eq(quotations.customerId, f.customerId));
  if (f.productId && isUuid(f.productId)) conds.push(eq(quotations.productId, f.productId));
  if (f.q) {
    const t = `%${f.q.replace(/[%_\\]/g, '')}%`;
    conds.push(or(ilike(quotations.number, t), ilike(customers.fullName, t))!);
  }
  // One row per quotation: its live revision, else its latest revision
  const main = db
    .selectDistinctOn([quotationRevisions.quotationId], { id: quotationRevisions.id, quotationId: quotationRevisions.quotationId })
    .from(quotationRevisions)
    .where(eq(quotationRevisions.accountId, auth.accountId!))
    .orderBy(quotationRevisions.quotationId, sql`(${quotationRevisions.status} in ('READY','SHARED','ACCEPTED')) desc`, desc(quotationRevisions.revisionNo))
    .as('main');
  if (f.status === 'DRAFT') conds.push(eq(quotationRevisions.status, 'DRAFT'));
  else if (f.status === 'OPEN') conds.push(inArray(quotationRevisions.status, ['READY', 'SHARED', 'ACCEPTED']));
  else if (f.status && STATUS_TEXT[f.status]) conds.push(eq(quotationRevisions.status, f.status));
  const page = Math.max(1, f.page ?? 1);
  const size = settings.get('CFG-23');
  const base = db
    .select({ r: quotationRevisions, q: quotations, customerName: customers.fullName, insurerName: insurers.name, typeName: insuranceTypes.name })
    .from(main)
    .innerJoin(quotationRevisions, eq(quotationRevisions.id, main.id))
    .innerJoin(quotations, eq(quotations.id, main.quotationId))
    .innerJoin(customers, eq(customers.id, quotations.customerId))
    .leftJoin(insurers, eq(insurers.id, quotations.insurerId))
    .leftJoin(insuranceTypes, eq(insuranceTypes.id, quotations.typeId))
    .where(and(...conds));
  const rows = await base.orderBy(desc(quotationRevisions.updatedAt)).limit(size).offset((page - 1) * size);
  const [{ n }] = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(main)
    .innerJoin(quotationRevisions, eq(quotationRevisions.id, main.id))
    .innerJoin(quotations, eq(quotations.id, main.quotationId))
    .innerJoin(customers, eq(customers.id, quotations.customerId))
    .where(and(...conds))) as [{ n: number }];
  const paidRows = rows.length
    ? await db.select({ q: payments.quotationId }).from(payments).where(and(inArray(payments.quotationId, rows.map((x) => x.q.id)), eq(payments.status, 'PAID')))
    : [];
  const paidSet = new Set(paidRows.map((p) => p.q));
  return {
    items: rows.map(({ r, q, customerName, insurerName, typeName }) => ({
      id: r.id,
      quotationId: q.id,
      number: q.number,
      revisionNo: r.revisionNo,
      status: r.status,
      expired: isExpired(r),
      step: r.step,
      customerId: q.customerId,
      customerName,
      insurerName,
      typeName,
      productId: q.productId,
      productName: (r.snapshot as { product?: { name: string } } | null)?.product?.name ?? null,
      finalPayable: r.finalPayable,
      validUntil: r.validUntil,
      paid: paidSet.has(q.id),
      isRenewal: !!q.renewalOfPolicyId,
      updatedAt: (r.updatedAt ?? r.createdAt).toISOString(),
    })),
    total: n,
    page,
    pageSize: size,
  };
}

// ---------- SYS-01 expiry ----------
export async function expireQuotations(): Promise<{ quotations: number }> {
  const today = istToday();
  const due = await db
    .select({ r: quotationRevisions, q: quotations, customerName: customers.fullName })
    .from(quotationRevisions)
    .innerJoin(quotations, eq(quotations.id, quotationRevisions.quotationId))
    .innerJoin(customers, eq(customers.id, quotations.customerId))
    .where(and(eq(quotationRevisions.status, 'SHARED'), sql`${quotationRevisions.validUntil} < ${today}`));
  let n = 0;
  for (const { r, q, customerName } of due) {
    await db.transaction(async (tx) => {
      const [paid] = await tx.select({ id: payments.id }).from(payments).where(and(eq(payments.quotationId, q.id), eq(payments.status, 'PAID')));
      if (paid) return;
      const done = await tx.update(quotationRevisions).set({ status: 'EXPIRED', statusAt: clock.now(), version: r.version + 1 }).where(and(eq(quotationRevisions.id, r.id), eq(quotationRevisions.status, 'SHARED'))).returning({ id: quotationRevisions.id });
      if (!done.length) return;
      n += 1;
      await audit(tx, null, { action: 'QUOTATION_EXPIRED', entity: 'quotation', entityId: q.id, accountId: q.accountId, actor: { job: 'SYS-01' } });
      const [adv] = await tx.select({ id: users.id }).from(users).where(and(eq(users.accountId, q.accountId), eq(users.role, 'ADV')));
      if (adv) await notify(tx, { userId: adv.id, accountId: q.accountId, messageId: 'DSH-15', params: { 'Quotation number': q.number ?? '', customer: customerName }, link: { type: 'QUOTATION', id: q.id }, dedupeKey: `qt-expired:${r.id}` });
    });
  }
  return { quotations: n };
}

export function quotationOptions() {
  return { rejectReasons: REJECT_REASONS, validityDays: settings.get('CFG-46'), maxRevisions: settings.get('CFG-47'), customerKey: CUSTOMER_KEY };
}
