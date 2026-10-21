// P-31 Add the insurer payment link, P-32 Record the premium payment. Bimayantra records payments; it never
// moves money. Every status shown is "as recorded by the advisor". At most one PAID payment per quotation
// and one AWAITING_PAYMENT per revision (database rules).
import type { Request } from 'express';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.js';
import { customers, insurers, payments, policies, proposals, quotationRevisions, quotations } from '../../db/schema.js';
import { clock, formatDate, istToday } from '../../lib/clock.js';
import { AppError, fieldError, fieldErrors, forbidden, notFound, stateConflict, versionConflict, type FieldError } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import { absDiff, money } from '../../lib/money.js';
import { msg } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { linkMatchesDomains } from '../catalogue/insurers.service.js';
import { isUnique, isUuid, readVersion } from '../clients/common.js';
import { ownFile } from '../files/files.service.js';
import { settings } from '../settings/settings.service.js';

export type Payment = typeof payments.$inferSelect;
export const METHODS = ['LINK', 'BRANCH', 'OTHER'] as const;
export const METHOD_NAMES: Record<string, string> = { LINK: 'Insurer payment link', BRANCH: 'Paid at insurer branch or by cheque', OTHER: 'Other insurer channel' };
export const DIFFERENCE_REASONS = ['Insurer changed premium after review', 'Customer changed riders on the portal', 'Other'] as const;
export const FAIL_REASONS = ['Customer did not pay', 'Payment declined', 'Link not working', 'Other'] as const;
export const UNDO_REASONS = ['Recorded by mistake', 'Cheque returned', 'Refunded by insurer'] as const;

const normRef = (v: string) => v.toUpperCase().replace(/[\s-]/g, '');

export type LinkInput = { method: string; link: string | null; linkValidUntil: string | null; portalAmount: string; note: string | null };

/** P-31 field checks: method, link on one of the insurer's domains (PAY-01), portal amount within CFG-52 (PAY-02). */
export function parsePaymentLink(body: unknown, insurer: { name: string; paymentDomains: string[] }, finalPayable: string): LinkInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const v = F.parseFields(b, {
    method: { label: 'Payment method', required: true, oneOf: METHODS },
    linkValidUntil: { label: 'Link valid until', rule: F.futureDate },
    portalAmount: { label: 'Amount shown on the insurer portal', required: true, rule: F.amount() },
    note: { label: 'Note', rule: F.notes },
  }) as { method: string; linkValidUntil?: string; portalAmount: string; note?: string };
  const errors: FieldError[] = [];
  let link: string | null = null;
  if (v.method === 'LINK') {
    const raw = typeof b.link === 'string' ? b.link.trim() : '';
    if (!raw) errors.push({ field: 'link', code: 'GEN-01', params: { 'Field label': 'Payment link' } });
    else {
      const r = F.url(raw);
      if (!r.ok) errors.push({ field: 'link', code: r.code });
      else if (!linkMatchesDomains(r.value, insurer.paymentDomains)) errors.push({ field: 'link', code: 'PAY-01', params: { insurer: insurer.name, 'allowed domains': insurer.paymentDomains.join(', ') || '—' } });
      else link = r.value;
    }
  }
  if (absDiff(money(v.portalAmount), money(finalPayable)) > money(String(settings.get('CFG-52')))) {
    errors.push({ field: 'portalAmount', code: 'PAY-02', params: { 'portal amount': F.groupIndian(v.portalAmount), 'final payable': F.groupIndian(finalPayable) } });
  }
  if (errors.length) throw fieldErrors(errors);
  return { method: v.method, link, linkValidUntil: v.method === 'LINK' ? (v.linkValidUntil ?? null) : null, portalAmount: v.portalAmount, note: v.note ?? null };
}

async function attempts(dbx: DbOrTx, quotationId: string) {
  const [r] = await dbx.select({ n: sql<number>`count(*)::int` }).from(payments).where(eq(payments.quotationId, quotationId));
  return r?.n ?? 0;
}
async function paidOn(dbx: DbOrTx, quotationId: string) {
  const [p] = await dbx.select().from(payments).where(and(eq(payments.quotationId, quotationId), eq(payments.status, 'PAID')));
  return p;
}

/** Create an AWAITING_PAYMENT payment (P-31 step 2, or Generate with a pasted link). */
export async function createAwaiting(tx: DbOrTx, auth: AuthContext, rev: { id: string; quotationId: string }, insurerId: string, input: LinkInput) {
  if ((await attempts(tx, rev.quotationId)) >= settings.get('CFG-50')) throw new AppError(409, 'PAY-03');
  const [p] = await tx
    .insert(payments)
    .values({
      accountId: auth.accountId!,
      quotationId: rev.quotationId,
      revisionId: rev.id,
      insurerId,
      method: input.method,
      link: input.link,
      linkValidUntil: input.linkValidUntil,
      portalAmount: input.portalAmount,
      note: input.note,
      status: 'AWAITING_PAYMENT',
      createdBy: auth.userId,
      createdAt: clock.now(),
    })
    .returning();
  return p!;
}

/** Revision superseded or cancelled: its AWAITING_PAYMENT payment becomes CANCELLED (P-31 backend rules). */
export async function cancelAwaiting(tx: DbOrTx, revisionId: string) {
  await tx.update(payments).set({ status: 'CANCELLED', updatedAt: clock.now() }).where(and(eq(payments.revisionId, revisionId), eq(payments.status, 'AWAITING_PAYMENT')));
}

export function paymentView(p: Payment, opts: { canAct?: boolean } = {}) {
  return {
    id: p.id,
    status: p.status,
    method: p.method,
    methodName: p.method ? METHOD_NAMES[p.method] : null,
    link: p.link,
    linkDomain: p.link ? new URL(p.link).hostname : null,
    linkValidUntil: p.linkValidUntil,
    portalAmount: p.portalAmount,
    note: p.note,
    mode: p.mode,
    amount: p.amount,
    paidOn: p.paidOn,
    reference: p.reference,
    chequeNumber: p.chequeNumber,
    chequeBank: p.chequeBank,
    chequeDate: p.chequeDate,
    differenceReason: p.differenceReason,
    differenceNote: p.differenceNote,
    receiptFileId: p.receiptFileId,
    reason: p.reason,
    recordedAt: p.recordedAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
    label: 'as recorded by the advisor',
    canAct: opts.canAct ?? false,
    version: p.version,
  };
}

export async function paymentsOf(quotationId: string) {
  return db.select().from(payments).where(eq(payments.quotationId, quotationId)).orderBy(asc(payments.createdAt));
}

async function loadRevision(dbx: DbOrTx, auth: AuthContext, rid: string, lock = false) {
  if (!isUuid(rid)) throw notFound();
  const q = dbx
    .select({ r: quotationRevisions, q: quotations })
    .from(quotationRevisions)
    .innerJoin(quotations, eq(quotations.id, quotationRevisions.quotationId))
    .where(and(eq(quotationRevisions.id, rid), eq(quotationRevisions.accountId, auth.accountId!)));
  const [row] = lock ? await q.for('update', { of: quotationRevisions }) : await q;
  if (!row) throw notFound();
  return row;
}

/** P-31 on a READY, SHARED or ACCEPTED revision (advisor and assistants, Section 3.2). */
export async function addPaymentLink(req: Request, auth: AuthContext, rid: string, body: unknown) {
  return db.transaction(async (tx) => {
    const { r, q } = await loadRevision(tx, auth, rid, true);
    if (!['READY', 'SHARED', 'ACCEPTED'].includes(r.status)) throw stateConflict('quotation', r.status);
    if (await paidOn(tx, q.id)) throw stateConflict('quotation', 'PAID');
    const [ins] = await tx.select().from(insurers).where(eq(insurers.id, q.insurerId!));
    const input = parsePaymentLink(body, ins!, r.finalPayable!);
    const [open] = await tx.select().from(payments).where(and(eq(payments.revisionId, r.id), eq(payments.status, 'AWAITING_PAYMENT')));
    if (open) throw stateConflict('payment', 'AWAITING_PAYMENT');
    const p = await createAwaiting(tx, auth, r, q.insurerId!, input);
    await audit(tx, req, { action: 'PAYMENT_LINK_ADDED', entity: 'payment', entityId: p.id, newValue: { quotation: q.number, method: input.method, portalAmount: input.portalAmount } });
    const [c] = await tx.select({ name: customers.fullName }).from(customers).where(eq(customers.id, q.customerId));
    return { payment: paymentView(p), message: msg('PAY-04', { customer: c!.name }) };
  });
}

async function loadPayment(dbx: DbOrTx, auth: AuthContext, id: string, lock = false) {
  if (!isUuid(id)) throw notFound();
  const q = dbx.select().from(payments).where(and(eq(payments.id, id), eq(payments.accountId, auth.accountId!)));
  const [p] = lock ? await q.for('update') : await q;
  if (!p) throw notFound();
  return p;
}

/** Replace link: the current payment becomes EXPIRED and a new AWAITING_PAYMENT one is created (P-31 step 4). */
export async function replaceLink(req: Request, auth: AuthContext, id: string, body: unknown) {
  return db.transaction(async (tx) => {
    const p = await loadPayment(tx, auth, id, true);
    if (p.version !== readVersion(body)) throw versionConflict('payment');
    if (p.status !== 'AWAITING_PAYMENT' || !p.revisionId) throw stateConflict('payment', p.status);
    const { r, q } = await loadRevision(tx, auth, p.revisionId, true);
    if (!['READY', 'SHARED', 'ACCEPTED'].includes(r.status)) throw stateConflict('quotation', r.status);
    const [ins] = await tx.select().from(insurers).where(eq(insurers.id, q.insurerId!));
    const input = parsePaymentLink(body, ins!, r.finalPayable!);
    await tx.update(payments).set({ status: 'EXPIRED', updatedAt: clock.now(), version: p.version + 1 }).where(eq(payments.id, p.id));
    const n = await createAwaiting(tx, auth, r, q.insurerId!, input);
    await audit(tx, req, { action: 'PAYMENT_LINK_REPLACED', entity: 'payment', entityId: n.id, oldValue: { payment: p.id }, newValue: { method: input.method } });
    const [c] = await tx.select({ name: customers.fullName }).from(customers).where(eq(customers.id, q.customerId));
    return { payment: paymentView(n), message: msg('PAY-04', { customer: c!.name }) };
  });
}

/** P-32 Record payment (advisor only). PAID + quotation ACCEPTED in one transaction. */
export async function recordPayment(req: Request, auth: AuthContext, rid: string, body: unknown) {
  if (auth.role !== 'ADV') throw forbidden();
  const b = (body ?? {}) as Record<string, unknown>;
  const modes = settings.get('CFG-166') as readonly string[];
  const needRef = settings.get('CFG-167') as readonly string[];
  const v = F.parseFields(b, {
    mode: { label: 'Mode', required: true, oneOf: modes },
    amount: { label: 'Amount', required: true, rule: F.amount() },
    paidOn: { label: 'Payment date', required: true, rule: F.date },
    differenceNote: { label: 'Note', rule: F.notes },
    declaration: { label: 'Declaration', checkbox: true },
  }) as { mode: string; amount: string; paidOn: string; differenceNote?: string };
  const errors: FieldError[] = [];
  let reference: string | null = null;
  if (needRef.includes(v.mode)) {
    const raw = typeof b.reference === 'string' ? b.reference.trim() : '';
    if (!raw) errors.push({ field: 'reference', code: 'PAY-16', params: { mode: v.mode } });
    else {
      const r = F.transactionRef(raw);
      if (!r.ok) errors.push({ field: 'reference', code: r.code, ...(r.params ? { params: r.params } : {}) });
      else reference = r.value;
    }
  }
  let cheque: { number: string; bank: string; date: string } | null = null;
  if (v.mode === 'Cheque') {
    const c = (() => {
      try {
        return F.parseFields(b, {
          chequeNumber: { label: 'Cheque number', required: true, rule: F.chequeNumber },
          chequeBank: { label: 'Bank', required: true, rule: F.shortText },
          chequeDate: { label: 'Cheque date', required: true, rule: F.date },
        }) as { chequeNumber: string; chequeBank: string; chequeDate: string };
      } catch (err) {
        if (err instanceof AppError) errors.push(...err.fields);
        return null;
      }
    })();
    if (c) cheque = { number: c.chequeNumber, bank: c.chequeBank, date: c.chequeDate };
  }
  if (v.paidOn > istToday()) errors.push({ field: 'paidOn', code: 'PAY-11' });
  let receiptFileId: string | null = null;
  if (b.receiptFileId) receiptFileId = (await ownFile(auth, b.receiptFileId, ['PAYMENT_RECEIPT'], 'receiptFileId')).id;
  else if (settings.get('CFG-51')) errors.push({ field: 'receiptFileId', code: 'GEN-01', params: { 'Field label': 'Receipt file' } });

  return db.transaction(async (tx) => {
    const { r, q } = await loadRevision(tx, auth, rid, true);
    if (!['SHARED', 'ACCEPTED'].includes(r.status)) throw stateConflict('quotation', r.status);
    if (await paidOn(tx, q.id)) throw stateConflict('quotation', 'PAID');
    if (v.paidOn < istToday(q.createdAt)) errors.push({ field: 'paidOn', code: 'PAY-12', params: { date: formatDate(istToday(q.createdAt)) } });
    if (r.validUntil && v.paidOn > r.validUntil) errors.push({ field: 'paidOn', code: 'PAY-15', params: { date: formatDate(r.validUntil) } });
    let differenceReason: string | null = null;
    if (absDiff(money(v.amount), money(r.finalPayable!)) > money(String(settings.get('CFG-52')))) {
      const dr = typeof b.differenceReason === 'string' ? b.differenceReason : '';
      if (!(DIFFERENCE_REASONS as readonly string[]).includes(dr)) errors.push({ field: 'differenceReason', code: 'PAY-13' });
      else if (dr === 'Other' && !v.differenceNote) errors.push({ field: 'differenceNote', code: 'GEN-01', params: { 'Field label': 'Note' } });
      else differenceReason = dr;
    }
    if (errors.length) throw fieldErrors(errors);
    const refNorm = reference ? normRef(reference) : null;
    if (refNorm) {
      const [dup] = await tx
        .select({ q: quotations.number, pol: policies.number })
        .from(payments)
        .leftJoin(quotations, eq(quotations.id, payments.quotationId))
        .leftJoin(policies, eq(policies.id, payments.policyId))
        .where(and(eq(payments.accountId, auth.accountId!), eq(payments.insurerId, q.insurerId!), eq(payments.referenceNorm, refNorm), eq(payments.status, 'PAID')));
      if (dup) throw fieldError('reference', 'PAY-08', { record: dup.q ?? dup.pol ?? '—' });
    }
    const now = clock.now();
    const values = {
      status: 'PAID',
      mode: v.mode,
      amount: v.amount,
      paidOn: v.paidOn,
      reference,
      referenceNorm: refNorm,
      chequeNumber: cheque?.number ?? null,
      chequeBank: cheque?.bank ?? null,
      chequeDate: cheque?.date ?? null,
      differenceReason,
      differenceNote: v.differenceNote ?? null,
      receiptFileId,
      recordedBy: auth.userId,
      recordedAt: now,
      updatedAt: now,
    };
    const [open] = await tx.select().from(payments).where(and(eq(payments.revisionId, r.id), eq(payments.status, 'AWAITING_PAYMENT')));
    let p: Payment;
    try {
      if (open) [p] = (await tx.update(payments).set({ ...values, version: open.version + 1 }).where(eq(payments.id, open.id)).returning()) as [Payment];
      else {
        if ((await attempts(tx, q.id)) >= settings.get('CFG-50')) throw new AppError(409, 'PAY-03');
        [p] = (await tx
          .insert(payments)
          .values({ ...values, accountId: auth.accountId!, quotationId: q.id, revisionId: r.id, insurerId: q.insurerId!, method: null, createdBy: auth.userId, createdAt: now })
          .returning()) as [Payment];
      }
    } catch (err) {
      if (isUnique(err, 'payments_one_paid')) throw stateConflict('quotation', 'PAID');
      if (isUnique(err, 'payments_reference')) throw fieldError('reference', 'PAY-08', { record: q.number ?? '—' });
      throw err;
    }
    if (r.status === 'SHARED') await tx.update(quotationRevisions).set({ status: 'ACCEPTED', statusAt: now, version: r.version + 1 }).where(eq(quotationRevisions.id, r.id));
    await audit(tx, req, { action: 'PAYMENT_RECORDED', entity: 'payment', entityId: p.id, newValue: { quotation: q.number, mode: v.mode, amount: v.amount, paidOn: v.paidOn } });
    const [c] = await tx.select({ name: customers.fullName }).from(customers).where(eq(customers.id, q.customerId));
    const [ins] = await tx.select({ name: insurers.name }).from(insurers).where(eq(insurers.id, q.insurerId!));
    return {
      payment: paymentView(p),
      message: msg('PAY-05'),
      warning: v.mode === 'Cash' ? msg('PAY-17', { customer: c!.name, insurer: ins!.name }) : null,
    };
  });
}

/** Mark as failed / link expired (AWAITING_PAYMENT only). */
export async function closeAwaiting(req: Request, auth: AuthContext, id: string, to: 'FAILED' | 'EXPIRED', body: unknown) {
  if (auth.role !== 'ADV') throw forbidden();
  let reason: string | null = null;
  if (to === 'FAILED') {
    const v = F.parseFields(body, { reason: { label: 'Reason', required: true, rule: F.notes } }) as { reason: string };
    reason = v.reason;
  }
  return db.transaction(async (tx) => {
    const p = await loadPayment(tx, auth, id, true);
    if (p.version !== readVersion(body)) throw versionConflict('payment');
    if (p.status !== 'AWAITING_PAYMENT') throw stateConflict('payment', p.status);
    await tx.update(payments).set({ status: to, reason, updatedAt: clock.now(), version: p.version + 1 }).where(eq(payments.id, p.id));
    await audit(tx, req, { action: to === 'FAILED' ? 'PAYMENT_FAILED' : 'PAYMENT_LINK_EXPIRED', entity: 'payment', entityId: p.id, newValue: { reason } });
    return { message: msg(to === 'FAILED' ? 'PAY-06' : 'PAY-07') };
  });
}

/** Undo payment: allowed while the proposal is not SUBMITTED, or after the insurer declined it (PAY-10). */
export async function undoPayment(req: Request, auth: AuthContext, id: string, body: unknown) {
  if (auth.role !== 'ADV') throw forbidden();
  const v = F.parseFields(body, { reason: { label: 'Reason', required: true, oneOf: UNDO_REASONS } }) as { reason: string };
  return db.transaction(async (tx) => {
    const p = await loadPayment(tx, auth, id, true);
    if (p.version !== readVersion(body)) throw versionConflict('payment');
    if (p.status !== 'PAID' || p.kind !== 'QUOTATION') throw stateConflict('payment', p.status);
    const open = await tx.select({ status: proposals.status }).from(proposals).where(and(eq(proposals.quotationId, p.quotationId!), inArray(proposals.status, ['SUBMITTED', 'ISSUED'])));
    if (open.length) throw new AppError(409, 'PAY-10');
    await tx.update(payments).set({ status: 'REVERSED', reason: v.reason, updatedAt: clock.now(), version: p.version + 1 }).where(eq(payments.id, p.id));
    await audit(tx, req, { action: 'PAYMENT_REVERSED', entity: 'payment', entityId: p.id, newValue: { reason: v.reason } });
    return { message: msg('PAY-09') };
  });
}

export function paymentOptions() {
  return {
    methods: METHODS.map((m) => ({ value: m, label: METHOD_NAMES[m] })),
    modes: settings.get('CFG-166'),
    modesNeedingReference: settings.get('CFG-167'),
    differenceReasons: DIFFERENCE_REASONS,
    failReasons: FAIL_REASONS,
    undoReasons: UNDO_REASONS,
    receiptRequired: settings.get('CFG-51'),
    allowedDifference: settings.get('CFG-52'),
  };
}

export const paidPaymentOf = (dbx: DbOrTx, quotationId: string) => paidOn(dbx, quotationId);
