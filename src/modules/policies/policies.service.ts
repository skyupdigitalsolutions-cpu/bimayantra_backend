// P-33 Record an issued policy, P-34 Record an existing policy, P-35 Nominees, P-36 Correct or cancel.
// ISSUED status, the renewal cycle and the quotation link are saved in one transaction. Renewal date =
// next premium due date when set, otherwise end date; grace from the product, or CFG-62.
import type { Request } from 'express';
import { and, desc, eq, ilike, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.js';
import { customers, familyMembers, insuranceTypes, insurers, nomineeVersions, payments, policies, policyHistory, proposals, renewalCycles, renewalEvents, quotationRevisions, outgoingMessages } from '../../db/schema.js';
import { addDays, clock, formatDate, istToday } from '../../lib/clock.js';
import { AppError, fieldError, fieldErrors, forbidden, notFound, stateConflict, versionConflict, type FieldError } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import { msg } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { commissionFor } from '../catalogue/products.service.js';
import { isUnique, isUuid, nextNumber, readVersion } from '../clients/common.js';
import { ownFile } from '../files/files.service.js';
import { settings } from '../settings/settings.service.js';
import { CUSTOMER_KEY, loadPeople, productCtx } from '../quotations/engine.js';
import { money, pct, round2 } from '../../lib/money.js';
import { nomineeSummary, parseNominees, type Nominee } from './nominees.js';

type Policy = typeof policies.$inferSelect;
export const FREQUENCIES = ['SINGLE', 'YEARLY', 'HALF_YEARLY', 'QUARTERLY', 'MONTHLY'] as const;
export const FREQUENCY_NAMES: Record<string, string> = { SINGLE: 'Single', YEARLY: 'Yearly', HALF_YEARLY: 'Half-yearly', QUARTERLY: 'Quarterly', MONTHLY: 'Monthly' };
export const CANCEL_REASONS = ['Free-look cancellation', 'Cancelled by insurer', 'Cancelled by customer', 'Recorded by mistake', 'Insurer declined the proposal'] as const;
export const STATUS_TEXT: Record<string, string> = { AWAITING_ISSUANCE: 'Awaiting issuance', ISSUED: 'Issued', EXPIRED: 'Expired', RENEWED: 'Renewed', CANCELLED: 'Cancelled' };
const normPolicy = (v: string) => v.toUpperCase().replace(/[\s/-]/g, '');

export function addYears(iso: string, years: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y! + years, m! - 1, d));
  if (t.getUTCMonth() !== m! - 1) return addDays(t.toISOString().slice(0, 10), -t.getUTCDate());
  return t.toISOString().slice(0, 10);
}

// ---------- renewal cycles (shared with P-37 / P-38) ----------
export const renewalDateOf = (p: Pick<Policy, 'nextDueDate' | 'endDate'>) => p.nextDueDate ?? p.endDate!;
export const graceDaysOf = (p: Pick<Policy, 'graceDays'>) => p.graceDays ?? settings.get('CFG-62');
export function cycleStatusFor(renewalDate: string, graceEnd: string, today = istToday()): 'UPCOMING' | 'DUE' | 'LAPSED' {
  if (today > graceEnd) return 'LAPSED';
  if (addDays(today, settings.get('CFG-59')) >= renewalDate) return 'DUE';
  return 'UPCOMING';
}

/** One cycle per policy and renewal date (repeat-safe). */
export async function createCycle(tx: DbOrTx, p: Policy) {
  const renewalDate = renewalDateOf(p);
  const graceEnd = addDays(renewalDate, graceDaysOf(p));
  const [c] = await tx
    .insert(renewalCycles)
    .values({ accountId: p.accountId, policyId: p.id, customerId: p.customerId, kind: p.nextDueDate ? 'PREMIUM_DUE' : 'END_DATE', renewalDate, graceEnd, status: cycleStatusFor(renewalDate, graceEnd), createdAt: clock.now() })
    .onConflictDoNothing()
    .returning();
  return c;
}

export async function openCycle(dbx: DbOrTx, policyId: string) {
  const [c] = await dbx
    .select()
    .from(renewalCycles)
    .where(and(eq(renewalCycles.policyId, policyId), inArray(renewalCycles.status, ['UPCOMING', 'DUE', 'IN_FOLLOW_UP', 'NOT_RENEWING', 'LAPSED'])))
    .orderBy(desc(renewalCycles.renewalDate))
    .limit(1);
  return c;
}

/** Cancel the QUEUED reminders of a cycle (P-36, P-38). */
export async function cancelCycleMessages(tx: DbOrTx, cycleId: string, reason: string) {
  await tx.update(outgoingMessages).set({ status: 'CANCELLED', reason, statusAt: clock.now() }).where(and(eq(outgoingMessages.relatedType, 'RENEWAL'), eq(outgoingMessages.relatedId, cycleId), eq(outgoingMessages.status, 'QUEUED')));
}

// ---------- shared field checks ----------
type Fields = {
  insurerPolicyNumber: string;
  issueDate: string;
  startDate: string;
  endDate: string;
  frequency: string;
  nextDueDate: string | null;
  sumInsured: string;
  sumInsuredReason: string | null;
  premium: string;
  documentFileId: string | null;
  notes: string | null;
  expectedCommission: string | null;
};

async function parseFields(auth: AuthContext, body: unknown, opts: { documentRequired: boolean; quotedSumInsured?: string | null; paymentDate?: string | null; partial?: Partial<Fields> }): Promise<Fields> {
  const b = { ...(opts.partial ?? {}), ...((body ?? {}) as Record<string, unknown>) } as Record<string, unknown>;
  const v = F.parseFields(b, {
    insurerPolicyNumber: { label: 'Policy number', required: true, rule: F.policyNumber },
    issueDate: { label: 'Issue date', required: true, rule: F.pastOrToday },
    startDate: { label: 'Policy start date', required: true, rule: F.date },
    endDate: { label: 'Policy end date', required: true, rule: F.date },
    frequency: { label: 'Premium payment frequency', required: true, oneOf: FREQUENCIES },
    nextDueDate: { label: 'Next premium due date', rule: F.date },
    sumInsured: { label: 'Sum insured', required: true, rule: F.amount() },
    sumInsuredReason: { label: 'Reason', rule: F.notes },
    premium: { label: 'Premium', required: true, rule: F.amount() },
    notes: { label: 'Notes', rule: F.notes },
    expectedCommission: { label: 'Expected commission', rule: F.amount({ allowZero: true }) },
  }) as Omit<Fields, 'documentFileId'> & { nextDueDate?: string; sumInsuredReason?: string; notes?: string; expectedCommission?: string };
  const e: FieldError[] = [];
  if (v.endDate < v.startDate) e.push({ field: 'endDate', code: 'VAL-08' });
  else if (v.endDate > addYears(v.startDate, settings.get('CFG-58'))) e.push({ field: 'endDate', code: 'POL-04' });
  if (opts.paymentDate && v.issueDate < opts.paymentDate) e.push({ field: 'issueDate', code: 'POL-03', params: { date: formatDate(opts.paymentDate) } });
  const longerThanYear = v.endDate > addDays(addYears(v.startDate, 1), -1);
  if (v.frequency !== 'SINGLE' && longerThanYear && !v.nextDueDate) e.push({ field: 'nextDueDate', code: 'GEN-01', params: { 'Field label': 'Next premium due date' } });
  if (v.nextDueDate && (v.nextDueDate <= v.startDate || v.nextDueDate > v.endDate)) e.push({ field: 'nextDueDate', code: 'POL-05' });
  if (opts.quotedSumInsured && money(v.sumInsured) !== money(opts.quotedSumInsured) && !v.sumInsuredReason) e.push({ field: 'sumInsuredReason', code: 'POL-06' });
  let documentFileId: string | null = null;
  if (b.documentFileId) documentFileId = (await ownFile(auth, b.documentFileId, ['POLICY_DOCUMENT', 'CLIENT_DOCUMENT'], 'documentFileId')).id;
  else if (opts.documentRequired) e.push({ field: 'documentFileId', code: 'GEN-01', params: { 'Field label': 'Policy document' } });
  if (e.length) throw fieldErrors(e);
  return { ...v, nextDueDate: v.frequency === 'SINGLE' ? null : (v.nextDueDate ?? null), sumInsuredReason: v.sumInsuredReason ?? null, notes: v.notes ?? null, expectedCommission: v.expectedCommission ?? null, documentFileId };
}

async function loadPolicy(dbx: DbOrTx, auth: AuthContext, id: string, lock = false): Promise<Policy> {
  if (!isUuid(id)) throw notFound();
  const base = dbx.select().from(policies).where(and(eq(policies.id, id), eq(policies.accountId, auth.accountId!)));
  const [p] = lock ? await base.for('update') : await base;
  if (!p) throw notFound();
  return p;
}

async function duplicateCheck(tx: DbOrTx, accountId: string, insurerId: string, number: string, exceptId: string | null) {
  const [d] = await tx
    .select({ name: customers.fullName })
    .from(policies)
    .innerJoin(customers, eq(customers.id, policies.customerId))
    .where(and(eq(policies.accountId, accountId), eq(policies.insurerId, insurerId), eq(policies.policyNumberNorm, normPolicy(number)), exceptId ? ne(policies.id, exceptId) : undefined));
  if (d) throw fieldError('insurerPolicyNumber', 'POL-02', { number, customer: d.name });
}

async function currentNominees(dbx: DbOrTx, policyId: string) {
  const [n] = await dbx.select().from(nomineeVersions).where(and(eq(nomineeVersions.policyId, policyId), eq(nomineeVersions.status, 'CURRENT')));
  return n;
}

// ---------- P-33 ----------
export async function issuePolicy(req: Request, auth: AuthContext, id: string, body: unknown) {
  if (auth.role !== 'ADV') throw forbidden();
  const b = (body ?? {}) as Record<string, unknown>;
  const pre = await loadPolicy(db, auth, id);
  if (pre.status !== 'AWAITING_ISSUANCE') throw stateConflict('policy', pre.status);
  const [pay] = pre.paymentId ? await db.select().from(payments).where(eq(payments.id, pre.paymentId)) : [];
  const v = await parseFields(auth, body, { documentRequired: true, quotedSumInsured: pre.sumInsured, paymentDate: pay?.paidOn ?? null });
  return db.transaction(async (tx) => {
    const p = await loadPolicy(tx, auth, id, true);
    if (p.version !== readVersion(body)) throw versionConflict('policy');
    if (p.status !== 'AWAITING_ISSUANCE') throw stateConflict('policy', p.status);
    await duplicateCheck(tx, auth.accountId!, p.insurerId, v.insurerPolicyNumber, p.id);
    const [c] = await tx.select().from(customers).where(eq(customers.id, p.customerId));
    let nom = await currentNominees(tx, p.id);
    if (Array.isArray(b.nominees) && b.nominees.length) {
      const list = await parseNominees(tx, c!, b.nominees, p.maxNominees);
      if (nom) await tx.update(nomineeVersions).set({ status: 'PREVIOUS' }).where(eq(nomineeVersions.id, nom.id));
      [nom] = await tx.insert(nomineeVersions).values({ accountId: p.accountId, policyId: p.id, customerId: p.customerId, versionNo: (nom?.versionNo ?? 0) + 1, status: 'CURRENT', nominees: list, createdBy: auth.userId, createdAt: clock.now() }).returning();
    }
    if (p.nomineeRequired && !(nom && (nom.nominees as Nominee[]).length)) throw fieldErrors([{ field: 'nominees', code: 'POL-07' }]);
    // Expected commission defaults to the advisor's commission % × premium before tax (P-22 commercials)
    let expected = v.expectedCommission;
    if (expected === null && p.productId) {
      const pctV = await commissionFor(auth.accountId!, p.productId);
      const beforeTax = (p.snapshot as { fromQuotation?: { breakdown?: { afterDiscount?: string } } } | null)?.fromQuotation?.breakdown?.afterDiscount;
      if (pctV && beforeTax) expected = round2(pct(money(beforeTax), pctV));
    }
    const now = clock.now();
    let updated: Policy;
    try {
      [updated] = (await tx
        .update(policies)
        .set({ ...v, expectedCommission: expected, policyNumberNorm: normPolicy(v.insurerPolicyNumber), status: 'ISSUED', statusAt: now, updatedAt: now, version: p.version + 1 })
        .where(eq(policies.id, p.id))
        .returning()) as [Policy];
    } catch (err) {
      if (isUnique(err, 'policies_insurer_number')) throw fieldError('insurerPolicyNumber', 'POL-02', { number: v.insurerPolicyNumber, customer: c!.fullName });
      throw err;
    }
    const cycle = await createCycle(tx, updated);
    if (p.proposalId) await tx.update(proposals).set({ status: 'ISSUED', updatedAt: now }).where(eq(proposals.id, p.proposalId));
    await tx.insert(policyHistory).values({ policyId: p.id, kind: 'RECORDED', newValue: v, userId: auth.userId, at: now });
    let renewal: { code: string; text: string } | null = null;
    if (p.renewalOfPolicyId && b.isRenewal !== false) renewal = await closeAsRenewed(tx, auth, p.renewalOfPolicyId, updated);
    await audit(tx, req, { action: 'POLICY_ISSUED', entity: 'policy', entityId: p.id, newValue: { number: p.number, insurerPolicyNumber: v.insurerPolicyNumber, endDate: v.endDate } });
    return { message: msg('POL-01', { 'policy number': v.insurerPolicyNumber }), renewal, cycleId: cycle?.id ?? null };
  });
}

/** The renewed policy becomes RENEWED and its open cycle RENEWED (P-38 Record renewal policy, REN-03). */
async function closeAsRenewed(tx: DbOrTx, auth: AuthContext, oldPolicyId: string, renewal: Policy) {
  const [old] = await tx.select().from(policies).where(and(eq(policies.id, oldPolicyId), eq(policies.accountId, auth.accountId!))).for('update');
  if (!old) return null;
  const c = await openCycle(tx, old.id);
  const now = clock.now();
  if (c && ['DUE', 'IN_FOLLOW_UP', 'LAPSED', 'UPCOMING', 'NOT_RENEWING'].includes(c.status)) {
    await tx.update(renewalCycles).set({ status: 'RENEWED', renewedByPolicyId: renewal.id, closedAt: now, version: c.version + 1 }).where(eq(renewalCycles.id, c.id));
    await tx.insert(renewalEvents).values({ cycleId: c.id, kind: 'STATUS', fromStatus: c.status, toStatus: 'RENEWED', note: `Renewal policy ${renewal.insurerPolicyNumber}`, userId: auth.userId, at: now });
    await cancelCycleMessages(tx, c.id, 'Renewed');
  }
  if (['ISSUED', 'EXPIRED'].includes(old.status)) await tx.update(policies).set({ status: 'RENEWED', statusAt: now, version: old.version + 1 }).where(eq(policies.id, old.id));
  await tx.insert(policyHistory).values({ policyId: old.id, kind: 'RENEWED', newValue: { by: renewal.number }, userId: auth.userId, at: now });
  return msg('REN-03', { date: formatDate(renewalDateOf(renewal)) });
}

// ---------- P-34 ----------
export async function recordExisting(req: Request, auth: AuthContext, body: unknown) {
  if (auth.role !== 'ADV') throw forbidden();
  const b = (body ?? {}) as Record<string, unknown>;
  const customerId = typeof b.customerId === 'string' ? b.customerId : '';
  if (!isUuid(customerId)) throw fieldErrors([{ field: 'customerId', code: 'GEN-01', params: { 'Field label': 'Customer' } }]);
  const [c] = await db.select().from(customers).where(and(eq(customers.id, customerId), eq(customers.accountId, auth.accountId!)));
  if (!c) throw notFound();
  if (c.status !== 'ACTIVE') throw new AppError(409, 'CU-20');
  const e: FieldError[] = [];
  const insurerId = typeof b.insurerId === 'string' ? b.insurerId : '';
  const [ins] = isUuid(insurerId) ? await db.select().from(insurers).where(and(eq(insurers.id, insurerId), eq(insurers.status, 'ACTIVE'))) : [];
  if (!ins) e.push({ field: 'insurerId', code: insurerId ? 'VAL-22' : 'GEN-01', params: { 'Field label': 'Insurer' } });
  let productId: string | null = null;
  let productName = '';
  let typeId: string | null = typeof b.typeId === 'string' && isUuid(b.typeId) ? b.typeId : null;
  let grace: number | null = null;
  let nomineeRequired = false;
  let maxNominees: number | null = null;
  if (typeof b.productId === 'string' && b.productId) {
    const p = await productCtx(db, auth.accountId!, b.productId);
    if (!p || (ins && p.insurerId !== ins.id)) e.push({ field: 'productId', code: 'VAL-22' });
    else {
      productId = p.productId;
      productName = p.data.name;
      typeId = p.typeId;
      grace = p.data.graceDays;
      nomineeRequired = p.data.nomineeRequired;
      maxNominees = p.data.maxNominees;
    }
  } else {
    const r = F.shortText(typeof b.productName === 'string' ? b.productName : '');
    if (!b.productName) e.push({ field: 'productName', code: 'GEN-01', params: { 'Field label': 'Product name' } });
    else if (!r.ok) e.push({ field: 'productName', code: r.code });
    else productName = r.value;
  }
  if (!typeId) e.push({ field: 'typeId', code: 'GEN-01', params: { 'Field label': 'Insurance type' } });
  const keys = Array.isArray(b.insured) ? b.insured.filter((x): x is string => typeof x === 'string') : [];
  const people = (await loadPeople(db, auth.accountId!, customerId)).filter((p) => p.active);
  const insured = keys.map((k) => people.find((p) => p.key === k)).filter((x) => !!x);
  if (!insured.length) e.push({ field: 'insured', code: 'GEN-01', params: { 'Field label': 'Insured persons' } });
  let fields: Fields | null = null;
  try {
    fields = await parseFields(auth, body, { documentRequired: false });
  } catch (err) {
    if (err instanceof AppError) e.push(...err.fields);
    else throw err;
  }
  if (e.length) throw fieldErrors(e);
  const v = fields!;
  const renewalDate = v.nextDueDate ?? v.endDate;
  const past = renewalDate < istToday();
  if (past && b.confirmExpired !== true) throw new AppError(409, 'POL-08', {}, [], { confirm: 'confirmExpired' });
  return db.transaction(async (tx) => {
    await duplicateCheck(tx, auth.accountId!, ins!.id, v.insurerPolicyNumber, null);
    const nominees = Array.isArray(b.nominees) && b.nominees.length ? await parseNominees(tx, c, b.nominees, maxNominees) : [];
    const now = clock.now();
    const number = await nextNumber(tx, auth.accountId!, 'PL');
    let p: Policy;
    try {
      [p] = (await tx
        .insert(policies)
        .values({
          accountId: auth.accountId!,
          customerId,
          number,
          source: 'EXISTING',
          soldByMe: b.soldByMe !== false,
          insurerId: ins!.id,
          productId,
          productName,
          typeId,
          ...v,
          policyNumberNorm: normPolicy(v.insurerPolicyNumber),
          insured: insured.map((x) => ({ key: x.key, name: x.name, relationship: x.relationship, dateOfBirth: x.dateOfBirth, age: x.age })),
          graceDays: grace,
          nomineeRequired,
          maxNominees,
          status: past ? 'EXPIRED' : 'ISSUED',
          statusAt: now,
          createdBy: auth.userId,
          createdAt: now,
          updatedAt: now,
        })
        .returning()) as [Policy];
    } catch (err) {
      if (isUnique(err, 'policies_insurer_number')) throw fieldError('insurerPolicyNumber', 'POL-02', { number: v.insurerPolicyNumber, customer: c.fullName });
      throw err;
    }
    if (nominees.length) await tx.insert(nomineeVersions).values({ accountId: p.accountId, policyId: p.id, customerId, versionNo: 1, status: 'CURRENT', nominees, createdBy: auth.userId, createdAt: now });
    await createCycle(tx, p);
    await tx.insert(policyHistory).values({ policyId: p.id, kind: 'RECORDED', newValue: { ...v, source: 'EXISTING' }, userId: auth.userId, at: now });
    await audit(tx, req, { action: 'POLICY_RECORDED_EXISTING', entity: 'policy', entityId: p.id, newValue: { number, insurerPolicyNumber: v.insurerPolicyNumber } });
    return { id: p.id, message: msg('POL-09', { 'policy number': v.insurerPolicyNumber }) };
  });
}

// ---------- P-35 ----------
export async function checkNominees(auth: AuthContext, id: string, body: unknown) {
  const p = await loadPolicy(db, auth, id);
  const [c] = await db.select().from(customers).where(eq(customers.id, p.customerId));
  const list = await parseNominees(db, c!, (body as { nominees?: unknown } | null)?.nominees, p.maxNominees);
  return { summary: nomineeSummary(p.insurerPolicyNumber ?? p.number, list), nominees: list };
}

export async function saveNominees(req: Request, auth: AuthContext, id: string, body: unknown) {
  if (auth.role !== 'ADV') throw forbidden();
  const b = (body ?? {}) as Record<string, unknown>;
  return db.transaction(async (tx) => {
    const p = await loadPolicy(tx, auth, id, true);
    if (!['AWAITING_ISSUANCE', 'ISSUED'].includes(p.status)) throw stateConflict('policy', p.status);
    const cur = await currentNominees(tx, p.id);
    if ((cur?.versionNo ?? 0) !== Number(b.nomineeVersion ?? 0)) throw versionConflict('nominee list');
    const [c] = await tx.select().from(customers).where(eq(customers.id, p.customerId));
    const list = await parseNominees(tx, c!, b.nominees, p.maxNominees);
    let endorsementRef: string | null = null;
    let effectiveDate: string | null = null;
    let endorsementFileId: string | null = null;
    if (p.status === 'ISSUED') {
      const e: FieldError[] = [];
      const ref = typeof b.endorsementRef === 'string' ? b.endorsementRef.trim() : '';
      if (!ref) e.push({ field: 'endorsementRef', code: 'GEN-01', params: { 'Field label': 'Insurer endorsement reference' } });
      else {
        const r = F.transactionRef(ref);
        if (!r.ok) e.push({ field: 'endorsementRef', code: r.code });
        else endorsementRef = r.value;
      }
      const ed = typeof b.effectiveDate === 'string' ? b.effectiveDate : '';
      if (!ed) e.push({ field: 'effectiveDate', code: 'GEN-01', params: { 'Field label': 'Effective date' } });
      else {
        const r = F.date(ed);
        if (!r.ok) e.push({ field: 'effectiveDate', code: r.code });
        else effectiveDate = r.value;
      }
      if (e.length) throw fieldErrors(e);
      if (b.endorsementFileId) endorsementFileId = (await ownFile(auth, b.endorsementFileId, ['ENDORSEMENT', 'POLICY_DOCUMENT'], 'endorsementFileId')).id;
    }
    if (cur) await tx.update(nomineeVersions).set({ status: 'PREVIOUS' }).where(eq(nomineeVersions.id, cur.id));
    await tx.insert(nomineeVersions).values({ accountId: p.accountId, policyId: p.id, customerId: p.customerId, versionNo: (cur?.versionNo ?? 0) + 1, status: 'CURRENT', nominees: list, endorsementRef, effectiveDate, endorsementFileId, createdBy: auth.userId, createdAt: clock.now() });
    await audit(tx, req, { action: 'NOMINEES_SAVED', entity: 'policy', entityId: p.id, newValue: { names: list.map((n) => `${n.name} ${n.sharePercent}%`), endorsementRef } });
    return { message: msg('POL-10', { 'policy number': p.insurerPolicyNumber ?? p.number }) };
  });
}

// ---------- P-36 ----------
export async function correctPolicy(req: Request, auth: AuthContext, id: string, body: unknown) {
  if (auth.role !== 'ADV') throw forbidden();
  const reason = F.parseFields(body, { reason: { label: 'Reason', required: true, rule: F.notes } }) as { reason: string };
  const pre = await loadPolicy(db, auth, id);
  if (!['AWAITING_ISSUANCE', 'ISSUED'].includes(pre.status)) throw stateConflict('policy', pre.status);
  const current: Partial<Fields> = {
    insurerPolicyNumber: pre.insurerPolicyNumber ?? undefined,
    issueDate: pre.issueDate ?? undefined,
    startDate: pre.startDate ?? undefined,
    endDate: pre.endDate ?? undefined,
    frequency: pre.frequency ?? undefined,
    nextDueDate: pre.nextDueDate,
    sumInsured: pre.sumInsured ?? undefined,
    premium: pre.premium ?? undefined,
    documentFileId: pre.documentFileId,
    notes: pre.notes,
    expectedCommission: pre.expectedCommission,
  };
  const v = await parseFields(auth, body, { documentRequired: pre.source === 'QUOTATION', partial: current });
  return db.transaction(async (tx) => {
    const p = await loadPolicy(tx, auth, id, true);
    if (p.version !== readVersion(body)) throw versionConflict('policy');
    if (!['AWAITING_ISSUANCE', 'ISSUED'].includes(p.status)) throw stateConflict('policy', p.status);
    await duplicateCheck(tx, auth.accountId!, p.insurerId, v.insurerPolicyNumber, p.id);
    const now = clock.now();
    const [updated] = (await tx
      .update(policies)
      .set({ ...v, policyNumberNorm: normPolicy(v.insurerPolicyNumber), updatedAt: now, version: p.version + 1 })
      .where(eq(policies.id, p.id))
      .returning()) as [Policy];
    // A changed end or due date moves the open cycle and its reminders, in the same transaction
    if (p.status === 'ISSUED' && renewalDateOf(updated) !== renewalDateOf(p)) {
      const c = await openCycle(tx, p.id);
      if (c && c.status !== 'RENEWED') {
        const renewalDate = renewalDateOf(updated);
        const graceEnd = addDays(renewalDate, graceDaysOf(updated));
        const status = ['UPCOMING', 'DUE', 'LAPSED'].includes(c.status) ? cycleStatusFor(renewalDate, graceEnd) : c.status;
        await tx.update(renewalCycles).set({ renewalDate, graceEnd, kind: updated.nextDueDate ? 'PREMIUM_DUE' : 'END_DATE', status, version: c.version + 1 }).where(eq(renewalCycles.id, c.id));
        await cancelCycleMessages(tx, c.id, 'Renewal date changed');
      }
    }
    await tx.insert(policyHistory).values({ policyId: p.id, kind: 'CORRECTED', oldValue: current, newValue: v, reason: reason.reason, userId: auth.userId, at: now });
    await audit(tx, req, { action: 'POLICY_CORRECTED', entity: 'policy', entityId: p.id, oldValue: current, newValue: v });
    return { message: msg('POL-18') };
  });
}

export async function cancelPolicy(req: Request, auth: AuthContext, id: string, body: unknown) {
  if (auth.role !== 'ADV') throw forbidden();
  const v = F.parseFields(body, {
    reason: { label: 'Reason', required: true, oneOf: CANCEL_REASONS },
    cancelDate: { label: 'Cancellation date', required: true, rule: F.pastOrToday },
    refundAmount: { label: 'Refund amount', rule: F.amount({ allowZero: true }) },
    note: { label: 'Note', rule: F.notes },
  }) as { reason: string; cancelDate: string; refundAmount?: string; note?: string };
  return db.transaction(async (tx) => {
    const p = await loadPolicy(tx, auth, id, true);
    if (p.version !== readVersion(body)) throw versionConflict('policy');
    if (!['AWAITING_ISSUANCE', 'ISSUED'].includes(p.status)) throw stateConflict('policy', p.status);
    const now = clock.now();
    await tx.update(policies).set({ status: 'CANCELLED', cancelReason: v.reason, cancelDate: v.cancelDate, refundAmount: v.refundAmount ?? null, cancelNote: v.note ?? null, statusAt: now, updatedAt: now, version: p.version + 1 }).where(eq(policies.id, p.id));
    const c = await openCycle(tx, p.id);
    if (c && c.status !== 'RENEWED') {
      await tx.update(renewalCycles).set({ status: 'NOT_RENEWING', reason: 'Policy cancelled', closedAt: now, version: c.version + 1 }).where(eq(renewalCycles.id, c.id));
      await tx.insert(renewalEvents).values({ cycleId: c.id, kind: 'STATUS', fromStatus: c.status, toStatus: 'NOT_RENEWING', note: 'Policy cancelled', userId: auth.userId, at: now });
      await cancelCycleMessages(tx, c.id, 'Policy cancelled');
    }
    await tx.insert(policyHistory).values({ policyId: p.id, kind: 'CANCELLED', newValue: v, reason: v.reason, userId: auth.userId, at: now });
    await audit(tx, req, { action: 'POLICY_CANCELLED', entity: 'policy', entityId: p.id, newValue: v });
    return { message: msg('POL-19') };
  });
}

// ---------- views ----------
export async function getPolicy(auth: AuthContext, id: string) {
  const p = await loadPolicy(db, auth, id);
  const [c] = await db.select().from(customers).where(eq(customers.id, p.customerId));
  const [ins] = await db.select().from(insurers).where(eq(insurers.id, p.insurerId));
  const [type] = p.typeId ? await db.select({ name: insuranceTypes.name }).from(insuranceTypes).where(eq(insuranceTypes.id, p.typeId)) : [];
  const noms = await db.select().from(nomineeVersions).where(eq(nomineeVersions.policyId, p.id)).orderBy(desc(nomineeVersions.versionNo));
  const hist = await db.select().from(policyHistory).where(eq(policyHistory.policyId, p.id)).orderBy(desc(policyHistory.at));
  const cycles = await db.select().from(renewalCycles).where(eq(renewalCycles.policyId, p.id)).orderBy(desc(renewalCycles.renewalDate));
  const [pay] = p.paymentId ? await db.select().from(payments).where(eq(payments.id, p.paymentId)) : [];
  const [rev] = p.revisionId ? await db.select({ quotationId: quotationRevisions.quotationId }).from(quotationRevisions).where(eq(quotationRevisions.id, p.revisionId)) : [];
  const family = await db.select({ id: familyMembers.id, name: familyMembers.fullName, relationship: familyMembers.relationship, dateOfBirth: familyMembers.dateOfBirth }).from(familyMembers).where(and(eq(familyMembers.customerId, p.customerId), eq(familyMembers.status, 'ACTIVE')));
  const quoted = p.snapshot as { fromQuotation?: { inputs?: { term?: string; startDate?: string } } } | null;
  const isAdv = auth.role === 'ADV';
  const live = ['AWAITING_ISSUANCE', 'ISSUED'].includes(p.status);
  return {
    id: p.id,
    number: p.number,
    status: p.status,
    statusText: STATUS_TEXT[p.status],
    source: p.source,
    soldByMe: p.soldByMe,
    customer: { id: c!.id, name: c!.fullName, number: c!.number },
    insurer: { id: ins!.id, name: ins!.name },
    productId: p.productId,
    productName: p.productName,
    typeName: type?.name ?? null,
    insurerPolicyNumber: p.insurerPolicyNumber,
    issueDate: p.issueDate,
    startDate: p.startDate,
    endDate: p.endDate,
    frequency: p.frequency,
    nextDueDate: p.nextDueDate,
    sumInsured: p.sumInsured,
    premium: p.premium,
    insured: p.insured,
    documentFileId: p.documentFileId,
    notes: p.notes,
    expectedCommission: isAdv ? p.expectedCommission : null,
    cancelReason: p.cancelReason,
    cancelDate: p.cancelDate,
    refundAmount: p.refundAmount,
    nomineeRequired: p.nomineeRequired,
    maxNominees: Math.min(p.maxNominees ?? settings.get('CFG-53'), settings.get('CFG-53')),
    nominees: noms.map((n) => ({ versionNo: n.versionNo, status: n.status, nominees: n.nominees, endorsementRef: n.endorsementRef, effectiveDate: n.effectiveDate, createdAt: n.createdAt.toISOString() })),
    nomineeVersion: noms.find((n) => n.status === 'CURRENT')?.versionNo ?? 0,
    history: hist.map((h) => ({ kind: h.kind, oldValue: h.oldValue, newValue: h.newValue, reason: h.reason, at: h.at.toISOString() })),
    cycles: cycles.map((x) => ({ id: x.id, renewalDate: x.renewalDate, graceEnd: x.graceEnd, status: x.status, kind: x.kind })),
    payment: pay ? { id: pay.id, mode: pay.mode, amount: pay.amount, paidOn: pay.paidOn, label: 'as recorded by the advisor' } : null,
    quotationId: rev?.quotationId ?? null,
    proposalId: p.proposalId,
    renewalOfPolicyId: p.renewalOfPolicyId,
    defaults: p.status === 'AWAITING_ISSUANCE' ? { premium: pay?.amount ?? p.premium, sumInsured: p.sumInsured, startDate: quoted?.fromQuotation?.inputs?.startDate ?? null, term: quoted?.fromQuotation?.inputs?.term ?? null, isRenewal: !!p.renewalOfPolicyId } : null,
    family,
    actions: { canIssue: isAdv && p.status === 'AWAITING_ISSUANCE', canCorrect: isAdv && live, canCancel: isAdv && live, canEditNominees: isAdv && live },
    version: p.version,
  };
}

export async function listPolicies(auth: AuthContext, f: { status?: string; q?: string; customerId?: string; productId?: string; page?: number }) {
  const conds: SQL[] = [eq(policies.accountId, auth.accountId!)];
  if (f.status && STATUS_TEXT[f.status]) conds.push(eq(policies.status, f.status));
  if (f.customerId && isUuid(f.customerId)) conds.push(eq(policies.customerId, f.customerId));
  if (f.productId && isUuid(f.productId)) conds.push(eq(policies.productId, f.productId));
  if (f.q) {
    const t = `%${f.q.replace(/[%_\\]/g, '')}%`;
    conds.push(or(ilike(policies.number, t), ilike(policies.insurerPolicyNumber, t), ilike(customers.fullName, t), ilike(policies.productName, t))!);
  }
  const page = Math.max(1, f.page ?? 1);
  const size = settings.get('CFG-23');
  const rows = await db
    .select({ p: policies, customerName: customers.fullName, insurerName: insurers.name })
    .from(policies)
    .innerJoin(customers, eq(customers.id, policies.customerId))
    .innerJoin(insurers, eq(insurers.id, policies.insurerId))
    .where(and(...conds))
    .orderBy(desc(policies.updatedAt))
    .limit(size)
    .offset((page - 1) * size);
  const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(policies).innerJoin(customers, eq(customers.id, policies.customerId)).where(and(...conds))) as [{ n: number }];
  return {
    items: rows.map(({ p, customerName, insurerName }) => ({ id: p.id, number: p.number, insurerPolicyNumber: p.insurerPolicyNumber, status: p.status, source: p.source, customerId: p.customerId, customerName, insurerName, productId: p.productId, productName: p.productName, endDate: p.endDate, nextDueDate: p.nextDueDate, premium: p.premium })),
    total: n,
    page,
    pageSize: size,
  };
}

export function policyOptions() {
  return { frequencies: FREQUENCIES.map((f) => ({ value: f, label: FREQUENCY_NAMES[f] })), cancelReasons: CANCEL_REASONS, relationships: settings.get('CFG-36'), customerKey: CUSTOMER_KEY };
}

