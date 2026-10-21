// P-55 Create and submit a proposal. Members lock to the quotation (PRP-06); declarations belong to this
// proposal and its policy only; nominees pre-fill from the customer's default nominee (never from another
// policy); KYC is read from the document vault; a PAID payment is required before submission (PAY-18).
// Submission, the AWAITING_ISSUANCE policy and the frozen copies are written in one transaction.
import type { Request } from 'express';
import { and, desc, eq, inArray, notInArray, sql, type SQL } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.js';
import { customers, documents, documentVersions, familyMembers, insurers, nomineeVersions, payments, policies, proposals, quotationRevisions, quotations } from '../../db/schema.js';
import { clock, istToday } from '../../lib/clock.js';
import { AppError, fieldErrors, forbidden, notFound, stateConflict, versionConflict, type FieldError } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import { msg, render } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { isUuid, nextNumber, readVersion } from '../clients/common.js';
import { settings } from '../settings/settings.service.js';
import { parseNominees, type Nominee } from './nominees.js';

type Prop = typeof proposals.$inferSelect;
type Member = { key: string; name: string; relationship: string; dateOfBirth: string | null; age: number | null };
type Answer = { answer: 'YES' | 'NO'; condition?: string; since?: string; treatment?: string };
type Declarations = Record<string, Record<string, Answer>>;
type Snap = { people: Member[]; product: { name: string; nomineeRequired: boolean; maxNominees: number | null }; insurer: { id: string; name: string }; type: { id: string; name: string }; inputs: { sumInsured: string; term: string; startDate: string }; breakdown: { finalPayable: string; afterDiscount: string } };

/** CFG-174 questions for the insurance type; {CFG-175} filled from configuration. */
export function questionsFor(typeName: string): string[] {
  const all = settings.get('CFG-174') as Record<string, string[]>;
  const key = Object.keys(all).find((k) => k.toLowerCase() === typeName.toLowerCase()) ?? Object.keys(all).find((k) => typeName.toLowerCase().includes(k.toLowerCase()));
  return (key ? all[key]! : []).map((q) => q.replace('{CFG-175}', String(settings.get('CFG-175'))));
}

async function loadProp(dbx: DbOrTx, auth: AuthContext, id: string, lock = false): Promise<Prop> {
  if (!isUuid(id)) throw notFound();
  const base = dbx.select().from(proposals).where(and(eq(proposals.id, id), eq(proposals.accountId, auth.accountId!)));
  const [p] = lock ? await base.for('update') : await base;
  if (!p) throw notFound();
  return p;
}

/** Aadhaar and PAN of the policyholder CONFIRMED in the vault (P-55 step 5). */
export async function kycCheck(dbx: DbOrTx, customerId: string) {
  const rows = await dbx
    .select({ type: documents.type })
    .from(documents)
    .innerJoin(documentVersions, eq(documentVersions.documentId, documents.id))
    .where(and(eq(documents.customerId, customerId), sql`${documents.familyMemberId} is null`, inArray(documents.type, ['Aadhaar', 'PAN']), eq(documentVersions.status, 'CONFIRMED')));
  const have = new Set(rows.map((r) => r.type));
  return { aadhaar: have.has('Aadhaar'), pan: have.has('PAN'), ok: have.has('Aadhaar') && have.has('PAN') };
}

function checkDeclarations(members: Member[], questions: string[], decl: Declarations): FieldError[] {
  const e: FieldError[] = [];
  for (const m of members) {
    const answers = decl[m.key] ?? {};
    if (questions.some((q) => !answers[q] || !['YES', 'NO'].includes(answers[q].answer))) {
      e.push({ field: `declarations.${m.key}`, code: 'PRP-02', params: { name: m.name } });
      continue;
    }
    for (const q of questions) {
      const a = answers[q]!;
      if (a.answer === 'YES' && !(a.condition ?? '').trim()) e.push({ field: `declarations.${m.key}.${q}`, code: 'GEN-01', params: { 'Field label': 'Condition details' } });
    }
  }
  return e;
}

function cleanDeclarations(raw: unknown, members: Member[], questions: string[]): Declarations {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, Record<string, Record<string, unknown>>>;
  const out: Declarations = {};
  for (const m of members) {
    const answers: Record<string, Answer> = {};
    for (const q of questions) {
      const a = b[m.key]?.[q];
      if (!a || (a.answer !== 'YES' && a.answer !== 'NO')) continue;
      const t = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 500) : '');
      answers[q] = a.answer === 'YES' ? { answer: 'YES', condition: t(a.condition), since: t(a.since), treatment: t(a.treatment) } : { answer: 'NO' };
    }
    out[m.key] = answers;
  }
  return out;
}

async function view(auth: AuthContext, p: Prop) {
  const [r] = await db.select().from(quotationRevisions).where(eq(quotationRevisions.id, p.revisionId));
  const [q] = await db.select().from(quotations).where(eq(quotations.id, p.quotationId));
  const [c] = await db.select().from(customers).where(eq(customers.id, p.customerId));
  const snap = r!.snapshot as Snap;
  const questions = questionsFor(snap.type.name);
  const decl = p.declarations as Declarations;
  const [paid] = await db.select().from(payments).where(and(eq(payments.quotationId, p.quotationId), eq(payments.status, 'PAID')));
  const kyc = await kycCheck(db, p.customerId);
  const members = p.members as Member[];
  const declErrors = checkDeclarations(members, questions, decl);
  const anyCondition = members.some((m) => Object.values(decl[m.key] ?? {}).some((a) => a.answer === 'YES'));
  const family = await db.select({ id: familyMembers.id, name: familyMembers.fullName, relationship: familyMembers.relationship, dateOfBirth: familyMembers.dateOfBirth }).from(familyMembers).where(and(eq(familyMembers.customerId, p.customerId), eq(familyMembers.status, 'ACTIVE')));
  const missing: string[] = [];
  if (declErrors.length) missing.push(render(declErrors[0]!.code, declErrors[0]!.params));
  if (!kyc.ok) missing.push(render('PRP-04', { customer: c!.fullName }));
  if (!paid) missing.push(render('PAY-18'));
  if (snap.product.nomineeRequired && !(p.nominees as Nominee[]).length) missing.push(render('POL-07'));
  return {
    id: p.id,
    number: p.number,
    status: p.status,
    step: p.step,
    quotation: { id: q!.id, revisionId: r!.id, number: q!.number, revisionNo: r!.revisionNo, status: r!.status, finalPayable: r!.finalPayable },
    customer: { id: c!.id, name: c!.fullName, number: c!.number },
    product: snap.product.name,
    insurer: snap.insurer.name,
    type: snap.type.name,
    members,
    membersLocked: msg('PRP-06'),
    questions,
    declarations: decl,
    conditionWarning: anyCondition ? msg('PRP-03') : null,
    nominees: p.nominees,
    nomineeRules: { required: snap.product.nomineeRequired, max: Math.min(snap.product.maxNominees ?? settings.get('CFG-53'), settings.get('CFG-53')), total: settings.get('CFG-54'), minShare: settings.get('CFG-55'), appointeeUnder: settings.get('CFG-56'), relationships: settings.get('CFG-36') },
    family,
    kyc: { ...kyc, message: kyc.ok ? null : msg('PRP-04', { customer: c!.fullName }) },
    payment: paid ? { id: paid.id, mode: paid.mode, amount: paid.amount, paidOn: paid.paidOn, label: 'as recorded by the advisor' } : null,
    policyId: p.policyId,
    reason: p.reason,
    missing,
    canSubmit: p.status === 'DRAFT' && auth.role === 'ADV' && !missing.length,
    canEdit: p.status === 'DRAFT',
    version: p.version,
  };
}

export async function startProposal(req: Request, auth: AuthContext, rid: string) {
  if (!isUuid(rid)) throw notFound();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ r: quotationRevisions, q: quotations })
      .from(quotationRevisions)
      .innerJoin(quotations, eq(quotations.id, quotationRevisions.quotationId))
      .where(and(eq(quotationRevisions.id, rid), eq(quotationRevisions.accountId, auth.accountId!)))
      .for('update', { of: quotationRevisions });
    if (!row) throw notFound();
    const { r, q } = row;
    const expired = r.status === 'EXPIRED' || (!!r.validUntil && r.validUntil < istToday());
    if (expired) throw new AppError(409, 'QT-44');
    if (!['SHARED', 'ACCEPTED'].includes(r.status)) throw stateConflict('quotation', r.status);
    const [open] = await tx.select().from(proposals).where(and(eq(proposals.quotationId, q.id), inArray(proposals.status, ['DRAFT', 'SUBMITTED'])));
    if (open) return { id: open.id, message: msg('PRP-01', { number: open.number, 'quotation number': q.number ?? '' }) };
    const now = clock.now();
    if (r.status === 'SHARED') await tx.update(quotationRevisions).set({ status: 'ACCEPTED', statusAt: now, version: r.version + 1 }).where(eq(quotationRevisions.id, r.id));
    const snap = r.snapshot as Snap;
    const [c] = await tx.select().from(customers).where(eq(customers.id, q.customerId));
    // Default nominee pre-fills only (never copied from another policy)
    const dn = c!.defaultNominee as { familyMemberId?: string | null; name: string; relationship: string; sharePercent?: string } | null;
    let prefill: Partial<Nominee>[] = [];
    if (dn) {
      const [m] = dn.familyMemberId ? await tx.select().from(familyMembers).where(eq(familyMembers.id, dn.familyMemberId)) : [];
      prefill = [{ familyMemberId: dn.familyMemberId ?? null, name: dn.name, relationship: dn.relationship, dateOfBirth: m?.dateOfBirth ?? '', sharePercent: String(settings.get('CFG-54')), appointee: null, mobile: null }];
    }
    const number = await nextNumber(tx, auth.accountId!, 'PR');
    const [p] = await tx
      .insert(proposals)
      .values({ accountId: auth.accountId!, number, quotationId: q.id, revisionId: r.id, customerId: q.customerId, status: 'DRAFT', step: 2, members: snap.people, nominees: prefill, createdBy: auth.userId, createdAt: now, updatedAt: now })
      .returning();
    await audit(tx, req, { action: 'PROPOSAL_STARTED', entity: 'proposal', entityId: p!.id, newValue: { number, quotation: q.number } });
    return { id: p!.id, message: msg('PRP-01', { number, 'quotation number': q.number ?? '' }) };
  });
}

export async function getProposal(auth: AuthContext, id: string) {
  return view(auth, await loadProp(db, auth, id));
}

export async function saveProposal(req: Request, auth: AuthContext, id: string, body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const p = await loadProp(db, auth, id);
  if (p.status !== 'DRAFT') throw stateConflict('proposal', p.status);
  if (p.version !== readVersion(body)) throw versionConflict('proposal');
  const [r] = await db.select().from(quotationRevisions).where(eq(quotationRevisions.id, p.revisionId));
  const snap = r!.snapshot as Snap;
  const members = p.members as Member[];
  const questions = questionsFor(snap.type.name);
  const step = Math.min(Math.max(Number(b.step) || p.step, 1), 7);
  const declarations = b.declarations !== undefined ? cleanDeclarations(b.declarations, members, questions) : (p.declarations as Declarations);
  let nominees = p.nominees as Nominee[];
  if (step >= 4) {
    const e = checkDeclarations(members, questions, declarations);
    if (e.length) throw fieldErrors(e);
  }
  if (b.nominees !== undefined) {
    const [c] = await db.select().from(customers).where(eq(customers.id, p.customerId));
    const list = Array.isArray(b.nominees) ? b.nominees : [];
    if (step >= 5) nominees = await parseNominees(db, c!, list, snap.product.maxNominees);
    else nominees = list as Nominee[];
  }
  if (step >= 5 && snap.product.nomineeRequired && !nominees.length) throw fieldErrors([{ field: 'nominees', code: 'POL-07' }]);
  const [saved] = await db
    .update(proposals)
    .set({ declarations, nominees, step, updatedAt: clock.now(), version: p.version + 1 })
    .where(and(eq(proposals.id, p.id), eq(proposals.version, p.version)))
    .returning();
  if (!saved) throw versionConflict('proposal');
  void req;
  return { ...(await view(auth, saved)), message: msg('GEN-14') };
}

export async function submitProposal(req: Request, auth: AuthContext, id: string, body: unknown) {
  if (auth.role !== 'ADV') throw forbidden();
  return db.transaction(async (tx) => {
    const p = await loadProp(tx, auth, id, true);
    if (p.version !== readVersion(body)) throw versionConflict('proposal');
    if (p.status !== 'DRAFT') throw stateConflict('proposal', p.status);
    const [r] = await tx.select().from(quotationRevisions).where(eq(quotationRevisions.id, p.revisionId));
    const [q] = await tx.select().from(quotations).where(eq(quotations.id, p.quotationId));
    const [c] = await tx.select().from(customers).where(eq(customers.id, p.customerId));
    const snap = r!.snapshot as Snap;
    const members = p.members as Member[];
    const errors = checkDeclarations(members, questionsFor(snap.type.name), p.declarations as Declarations);
    if (errors.length) throw fieldErrors(errors);
    const nominees = (p.nominees as Nominee[]).length ? await parseNominees(tx, c!, p.nominees, snap.product.maxNominees) : [];
    if (snap.product.nomineeRequired && !nominees.length) throw fieldErrors([{ field: 'nominees', code: 'POL-07' }]);
    const kyc = await kycCheck(tx, p.customerId);
    if (!kyc.ok) throw new AppError(409, 'PRP-04', { customer: c!.fullName });
    const [paid] = await tx.select().from(payments).where(and(eq(payments.quotationId, p.quotationId), eq(payments.status, 'PAID')));
    if (!paid) throw new AppError(409, 'PAY-18');
    const now = clock.now();
    const number = await nextNumber(tx, auth.accountId!, 'PL');
    const [pol] = await tx
      .insert(policies)
      .values({
        accountId: auth.accountId!,
        customerId: p.customerId,
        number,
        source: 'QUOTATION',
        soldByMe: true,
        insurerId: snap.insurer.id,
        productId: q!.productId,
        productName: snap.product.name,
        typeId: snap.type.id,
        quotationId: q!.id,
        revisionId: r!.id,
        proposalId: p.id,
        paymentId: paid.id,
        renewalOfPolicyId: q!.renewalOfPolicyId,
        sumInsured: snap.inputs.sumInsured,
        premium: paid.amount,
        insured: members,
        declarations: p.declarations,
        nomineeRequired: snap.product.nomineeRequired,
        maxNominees: snap.product.maxNominees,
        graceDays: (r!.snapshot as { product: { graceDays: number | null } }).product.graceDays,
        status: 'AWAITING_ISSUANCE',
        snapshot: { fromQuotation: { number: q!.number, revision: r!.revisionNo, breakdown: snap.breakdown, inputs: snap.inputs } },
        statusAt: now,
        createdBy: auth.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (nominees.length) await tx.insert(nomineeVersions).values({ accountId: auth.accountId!, policyId: pol!.id, customerId: p.customerId, versionNo: 1, status: 'CURRENT', nominees, createdBy: auth.userId, createdAt: now });
    await tx.update(proposals).set({ status: 'SUBMITTED', nominees, policyId: pol!.id, submittedAt: now, submittedBy: auth.userId, updatedAt: now, version: p.version + 1 }).where(eq(proposals.id, p.id));
    await audit(tx, req, { action: 'PROPOSAL_SUBMITTED', entity: 'proposal', entityId: p.id, newValue: { number: p.number, policy: number } });
    return { policyId: pol!.id, message: msg('PRP-05', { number: p.number, insurer: snap.insurer.name }) };
  });
}

export async function declineProposal(req: Request, auth: AuthContext, id: string, body: unknown) {
  if (auth.role !== 'ADV') throw forbidden();
  const v = F.parseFields(body, { reason: { label: 'Reason', required: true, rule: F.notes } }) as { reason: string };
  return db.transaction(async (tx) => {
    const p = await loadProp(tx, auth, id, true);
    if (p.version !== readVersion(body)) throw versionConflict('proposal');
    if (p.status !== 'SUBMITTED') throw stateConflict('proposal', p.status);
    const now = clock.now();
    await tx.update(proposals).set({ status: 'DECLINED', reason: v.reason, updatedAt: now, version: p.version + 1 }).where(eq(proposals.id, p.id));
    if (p.policyId) await tx.update(policies).set({ status: 'CANCELLED', cancelReason: 'Insurer declined the proposal', cancelDate: istToday(), cancelNote: v.reason, statusAt: now, updatedAt: now }).where(and(eq(policies.id, p.policyId), eq(policies.status, 'AWAITING_ISSUANCE')));
    await audit(tx, req, { action: 'PROPOSAL_DECLINED', entity: 'proposal', entityId: p.id, newValue: { reason: v.reason } });
    const [r] = await tx.select().from(quotationRevisions).where(eq(quotationRevisions.id, p.revisionId));
    return { message: msg('PRP-07', { number: p.number, insurer: (r!.snapshot as Snap).insurer.name }) };
  });
}

export async function cancelProposal(req: Request, auth: AuthContext, id: string, body: unknown) {
  if (auth.role !== 'ADV') throw forbidden();
  const v = F.parseFields(body, { reason: { label: 'Reason', required: true, rule: F.notes } }) as { reason: string };
  return db.transaction(async (tx) => {
    const p = await loadProp(tx, auth, id, true);
    if (p.version !== readVersion(body)) throw versionConflict('proposal');
    if (p.status !== 'DRAFT') throw stateConflict('proposal', p.status);
    await tx.update(proposals).set({ status: 'CANCELLED', reason: v.reason, updatedAt: clock.now(), version: p.version + 1 }).where(eq(proposals.id, p.id));
    await audit(tx, req, { action: 'PROPOSAL_CANCELLED', entity: 'proposal', entityId: p.id, newValue: { reason: v.reason } });
    return { message: msg('GEN-08', { 'Record type': 'Proposal' }) };
  });
}

/** Proposals list; tab READY = accepted quotations that have no open proposal yet. */
export async function listProposals(auth: AuthContext, f: { tab?: string; customerId?: string }) {
  if (f.tab === 'READY') {
    const open = db.select({ id: proposals.quotationId }).from(proposals).where(and(eq(proposals.accountId, auth.accountId!), inArray(proposals.status, ['DRAFT', 'SUBMITTED', 'ISSUED'])));
    const rows = await db
      .select({ r: quotationRevisions, q: quotations, customerName: customers.fullName })
      .from(quotationRevisions)
      .innerJoin(quotations, eq(quotations.id, quotationRevisions.quotationId))
      .innerJoin(customers, eq(customers.id, quotations.customerId))
      .where(and(eq(quotationRevisions.accountId, auth.accountId!), eq(quotationRevisions.status, 'ACCEPTED'), notInArray(quotations.id, open), sql`(${quotationRevisions.validUntil} is null or ${quotationRevisions.validUntil} >= ${istToday()})`))
      .orderBy(desc(quotationRevisions.statusAt));
    return {
      items: rows.map(({ r, q, customerName }) => ({ kind: 'READY', revisionId: r.id, quotationNumber: q.number, revisionNo: r.revisionNo, customerName, product: (r.snapshot as Snap).product.name, finalPayable: r.finalPayable, validUntil: r.validUntil })),
    };
  }
  const conds: SQL[] = [eq(proposals.accountId, auth.accountId!)];
  if (f.tab && ['DRAFT', 'SUBMITTED', 'ISSUED', 'DECLINED', 'CANCELLED'].includes(f.tab)) conds.push(eq(proposals.status, f.tab));
  if (f.customerId && isUuid(f.customerId)) conds.push(eq(proposals.customerId, f.customerId));
  const rows = await db
    .select({ p: proposals, q: quotations, customerName: customers.fullName, insurerName: insurers.name })
    .from(proposals)
    .innerJoin(quotations, eq(quotations.id, proposals.quotationId))
    .innerJoin(customers, eq(customers.id, proposals.customerId))
    .leftJoin(insurers, eq(insurers.id, quotations.insurerId))
    .where(and(...conds))
    .orderBy(desc(proposals.updatedAt))
    .limit(200);
  return { items: rows.map(({ p, q, customerName, insurerName }) => ({ kind: 'PROPOSAL', id: p.id, number: p.number, status: p.status, step: p.step, quotationNumber: q.number, customerName, insurerName, policyId: p.policyId, updatedAt: (p.updatedAt ?? p.createdAt).toISOString() })) };
}
