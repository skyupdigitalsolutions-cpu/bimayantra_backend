// P-20 Manage insurers. STF or ADM makes; a different ADM approves with the extra OTP.
// DRAFT → PENDING_APPROVAL → ACTIVE; ACTIVE ↔ INACTIVE. An edit to an ACTIVE (or INACTIVE) insurer waits in
// pending_change: advisors keep seeing the old values until it is approved (AC-P20-3).
// The insurer ID never changes; deactivation never touches mappings, products, quotations or policies.
import type { Request } from 'express';
import { and, asc, countDistinct, eq, ilike, ne, or, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.js';
import { files, insurerMappings, insurers, products } from '../../db/schema.js';
import { clock } from '../../lib/clock.js';
import { AppError, fieldError, fieldErrors, notFound, stateConflict, versionConflict, type FieldError } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import { msg } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { consumeStepUp } from '../auth/auth.service.js';
import { notifyRoles } from '../notifications/notifications.service.js';
import { addMaker, assertChecker, isUnique, isUuid, namesOf, readReason, readVersion } from './common.js';

export const INSURER_CATEGORIES = ['LIFE', 'GENERAL', 'STANDALONE_HEALTH'] as const;
type Insurer = typeof insurers.$inferSelect;
export type InsurerData = {
  name: string;
  shortCode: string;
  category: (typeof INSURER_CATEGORIES)[number];
  irdaiRegNo: string;
  website: string | null;
  paymentDomains: string[];
  careNumber: string | null;
  careEmail: string | null;
  logoFileId: string | null;
};
type Pending = { data: InsurerData; status: 'PENDING' | 'REJECTED'; reason?: string | null; by: string; at: string };
const FIELDS: (keyof InsurerData)[] = ['name', 'shortCode', 'category', 'irdaiRegNo', 'website', 'paymentDomains', 'careNumber', 'careEmail', 'logoFileId'];
export const INSURER_LABELS: Record<keyof InsurerData, string> = {
  name: 'Insurer name',
  shortCode: 'Short code',
  category: 'Category',
  irdaiRegNo: 'IRDAI registration number',
  website: 'Website',
  paymentDomains: 'Payment link domains',
  careNumber: 'Customer care number',
  careEmail: 'Customer care email',
  logoFileId: 'Logo',
};

/** A bare domain such as insurer.com — no scheme, no path (CAT-10). Subdomains of it are accepted later. */
export function bareDomain(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (v.length > 253 || /[/:?#@\s]/.test(v)) return null;
  return /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(v) && /\.[a-z]{2,}$/.test(v) ? v : null;
}

/** Is this payment link on one of the insurer's domains (or a subdomain of one)? Used by P-29 later. */
export function linkMatchesDomains(link: string, domains: readonly string[]): boolean {
  try {
    const host = new URL(link).hostname.toLowerCase();
    return domains.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

async function parseInsurer(body: unknown): Promise<InsurerData> {
  const b = (body ?? {}) as Record<string, unknown>;
  const errors: FieldError[] = [];
  let v: Record<string, unknown> = {};
  try {
    v = F.parseFields(body, {
      name: { label: 'Insurer name', required: true, rule: F.shortText },
      shortCode: { label: 'Short code', required: true, rule: F.code },
      category: { label: 'Category', required: true, oneOf: INSURER_CATEGORIES },
      irdaiRegNo: { label: 'IRDAI registration number', required: true, rule: F.code },
      website: { label: 'Website', rule: F.url },
      careNumber: { label: 'Customer care number', rule: F.phone },
      careEmail: { label: 'Customer care email', rule: F.email },
    });
  } catch (err) {
    if (err instanceof AppError) errors.push(...err.fields);
    else throw err;
  }
  const rawDomains = Array.isArray(b.paymentDomains) ? b.paymentDomains : typeof b.paymentDomains === 'string' ? b.paymentDomains.split(/[\s,]+/) : [];
  const domains = rawDomains.filter((d): d is string => typeof d === 'string' && d.trim() !== '');
  const clean = domains.map(bareDomain);
  if (domains.length === 0) errors.push({ field: 'paymentDomains', code: 'GEN-01', params: { 'Field label': 'Payment link domains' } });
  else if (clean.some((d) => d === null)) errors.push({ field: 'paymentDomains', code: 'CAT-10' });
  let logoFileId: string | null = null;
  if (b.logoFileId !== undefined && b.logoFileId !== null && b.logoFileId !== '') {
    const [f] = isUuid(b.logoFileId) ? await db.select().from(files).where(eq(files.id, b.logoFileId)) : [];
    if (!f || f.purpose !== 'INSURER_LOGO' || f.accountId !== null) errors.push({ field: 'logoFileId', code: 'VAL-22' });
    else logoFileId = f.id;
  }
  if (errors.length) throw fieldErrors(errors);
  return {
    name: v.name as string,
    shortCode: v.shortCode as string,
    category: v.category as InsurerData['category'],
    irdaiRegNo: v.irdaiRegNo as string,
    website: (v.website as string | undefined) ?? null,
    paymentDomains: [...new Set(clean as string[])],
    careNumber: (v.careNumber as string | undefined) ?? null,
    careEmail: (v.careEmail as string | undefined) ?? null,
    logoFileId,
  };
}

/** Duplicate name (ignoring case) or code among other insurers, including their pending changes. */
async function checkDuplicates(dbx: DbOrTx, d: InsurerData, exceptId: string | null): Promise<void> {
  const others = await dbx
    .select({ id: insurers.id, name: insurers.name, shortCode: insurers.shortCode, pending: insurers.pendingChange })
    .from(insurers)
    .where(
      and(
        exceptId ? ne(insurers.id, exceptId) : sql`true`,
        or(
          sql`lower(${insurers.name}) = lower(${d.name})`,
          eq(insurers.shortCode, d.shortCode),
          sql`lower(${insurers.pendingChange} -> 'data' ->> 'name') = lower(${d.name})`,
          sql`${insurers.pendingChange} -> 'data' ->> 'shortCode' = ${d.shortCode}`,
        ),
      ),
    );
  const errors: FieldError[] = [];
  const pendingOf = (o: (typeof others)[number]) => (o.pending as Pending | null)?.data;
  if (others.some((o) => o.name.toLowerCase() === d.name.toLowerCase() || pendingOf(o)?.name.toLowerCase() === d.name.toLowerCase())) errors.push({ field: 'name', code: 'CAT-06' });
  if (others.some((o) => o.shortCode === d.shortCode || pendingOf(o)?.shortCode === d.shortCode)) errors.push({ field: 'shortCode', code: 'CAT-07' });
  if (errors.length) throw fieldErrors(errors);
}

const dataOf = (i: Insurer): InsurerData => ({
  name: i.name,
  shortCode: i.shortCode,
  category: i.category as InsurerData['category'],
  irdaiRegNo: i.irdaiRegNo,
  website: i.website,
  paymentDomains: i.paymentDomains,
  careNumber: i.careNumber,
  careEmail: i.careEmail,
  logoFileId: i.logoFileId,
});

export function changedFields(a: InsurerData, b: InsurerData) {
  return FIELDS.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map((k) => ({ field: k, label: INSURER_LABELS[k], old: a[k], new: b[k] }));
}

async function view(i: Insurer) {
  const pending = i.pendingChange as Pending | null;
  return {
    id: i.id,
    ...dataOf(i),
    status: i.status,
    rejectReason: i.rejectReason,
    submittedAt: i.submittedAt,
    approvedAt: i.approvedAt,
    makers: await namesOf(db, i.makers),
    makerIds: i.makers,
    pendingChange: pending ? { ...pending, changes: changedFields(dataOf(i), pending.data) } : null,
    version: i.version,
  };
}

export async function listInsurers(q?: string, status?: string) {
  const rows = await db
    .select()
    .from(insurers)
    .where(
      and(
        q ? or(ilike(insurers.name, `%${q.replace(/[%_\\]/g, '')}%`), ilike(insurers.shortCode, `%${q.replace(/[%_\\]/g, '')}%`)) : sql`true`,
        status ? eq(insurers.status, status) : sql`true`,
      ),
    )
    .orderBy(asc(insurers.name));
  return rows.map((i) => ({
    id: i.id,
    name: i.name,
    shortCode: i.shortCode,
    category: i.category,
    status: i.status,
    pendingChange: (i.pendingChange as Pending | null)?.status ?? null,
    version: i.version,
  }));
}

async function load(dbx: DbOrTx, id: string, lock = false): Promise<Insurer> {
  if (!isUuid(id)) throw notFound();
  const q = dbx.select().from(insurers).where(eq(insurers.id, id));
  const [i] = lock ? await q.for('update') : await q;
  if (!i) throw notFound();
  return i;
}

export async function getInsurer(id: string) {
  return view(await load(db, id));
}

async function tellApprovers(dbx: DbOrTx, item: string, id: string) {
  await notifyRoles(dbx, ['ADM'], { messageId: 'CAT-02', params: { Item: item }, dedupeKey: `approval:insurer:${id}:${clock.now().toISOString()}`, link: { type: 'APPROVAL_INSURER', id } });
}

export async function createInsurer(req: Request, auth: AuthContext, body: unknown) {
  const d = await parseInsurer(body);
  const submit = (body as { submit?: unknown } | null)?.submit === true;
  try {
    return await db.transaction(async (tx) => {
      await checkDuplicates(tx, d, null);
      const now = clock.now();
      const [i] = await tx
        .insert(insurers)
        .values({ ...d, status: submit ? 'PENDING_APPROVAL' : 'DRAFT', makers: [auth.userId], submittedAt: submit ? now : null, createdBy: auth.userId, createdAt: now })
        .returning();
      await audit(tx, req, { action: submit ? 'INSURER_SUBMITTED' : 'INSURER_DRAFTED', entity: 'insurer', entityId: i!.id, newValue: d });
      if (submit) await tellApprovers(tx, d.name, i!.id);
      return { insurer: await view(i!), message: msg(submit ? 'CAT-02' : 'CAT-01', { Item: d.name }) };
    });
  } catch (err) {
    if (isUnique(err, 'insurers_name')) throw fieldError('name', 'CAT-06');
    if (isUnique(err, 'insurers_code')) throw fieldError('shortCode', 'CAT-07');
    throw err;
  }
}

/** Edit: a DRAFT changes in place; an ACTIVE or INACTIVE insurer gets a pending change (CAT-08 if one waits). */
export async function editInsurer(req: Request, auth: AuthContext, id: string, body: unknown) {
  const d = await parseInsurer(body);
  const submit = (body as { submit?: unknown } | null)?.submit === true;
  const version = readVersion(body);
  try {
    return await db.transaction(async (tx) => {
      const i = await load(tx, id, true);
      if (i.version !== version) throw versionConflict('insurer', changedFields(dataOf(i), d).map((c) => c.field));
      await checkDuplicates(tx, d, i.id);
      const now = clock.now();
      if (i.status === 'PENDING_APPROVAL') throw new AppError(409, 'CAT-08');
      if (i.status === 'DRAFT') {
        const [n] = await tx
          .update(insurers)
          .set({ ...d, status: submit ? 'PENDING_APPROVAL' : 'DRAFT', makers: addMaker(i.makers, auth.userId), submittedAt: submit ? now : i.submittedAt, version: i.version + 1 })
          .where(eq(insurers.id, i.id))
          .returning();
        await audit(tx, req, { action: submit ? 'INSURER_SUBMITTED' : 'INSURER_DRAFTED', entity: 'insurer', entityId: i.id, oldValue: dataOf(i), newValue: d });
        if (submit) await tellApprovers(tx, d.name, i.id);
        return { insurer: await view(n!), message: msg(submit ? 'CAT-02' : 'CAT-01', { Item: d.name }) };
      }
      const pending = i.pendingChange as Pending | null;
      if (pending?.status === 'PENDING') throw new AppError(409, 'CAT-08');
      if (changedFields(dataOf(i), d).length === 0) return { insurer: await view(i), message: msg('GEN-08', { 'Record type': 'Insurer' }) };
      const makers = pending ? addMaker(i.makers, auth.userId) : [auth.userId];
      const change: Pending = { data: d, status: 'PENDING', by: auth.userId, at: now.toISOString() };
      const [n] = await tx.update(insurers).set({ pendingChange: change, makers, submittedAt: now, version: i.version + 1 }).where(eq(insurers.id, i.id)).returning();
      await audit(tx, req, { action: 'INSURER_CHANGE_SUBMITTED', entity: 'insurer', entityId: i.id, oldValue: dataOf(i), newValue: d });
      await tellApprovers(tx, i.name, i.id);
      return { insurer: await view(n!), message: msg('CAT-02', { Item: i.name }) };
    });
  } catch (err) {
    if (isUnique(err, 'insurers_name')) throw fieldError('name', 'CAT-06');
    if (isUnique(err, 'insurers_code')) throw fieldError('shortCode', 'CAT-07');
    throw err;
  }
}

export async function submitInsurer(req: Request, auth: AuthContext, id: string, body: unknown) {
  const version = readVersion(body);
  return db.transaction(async (tx) => {
    const i = await load(tx, id, true);
    if (i.version !== version) throw versionConflict('insurer');
    if (i.status !== 'DRAFT') throw stateConflict('insurer', i.status);
    const [n] = await tx
      .update(insurers)
      .set({ status: 'PENDING_APPROVAL', makers: addMaker(i.makers, auth.userId), submittedAt: clock.now(), version: i.version + 1 })
      .where(eq(insurers.id, i.id))
      .returning();
    await audit(tx, req, { action: 'INSURER_SUBMITTED', entity: 'insurer', entityId: i.id });
    await tellApprovers(tx, i.name, i.id);
    return { insurer: await view(n!), message: msg('CAT-02', { Item: i.name }) };
  });
}

export async function approveInsurer(req: Request, auth: AuthContext, id: string, body: unknown) {
  const version = readVersion(body);
  try {
    return await db.transaction(async (tx) => {
      const i = await load(tx, id, true);
      const pending = i.pendingChange as Pending | null;
      const isNew = i.status === 'PENDING_APPROVAL';
      if (!isNew && pending?.status !== 'PENDING') throw stateConflict('insurer', i.status);
      if (i.version !== version) throw stateConflict('insurer', 'changed');
      assertChecker(auth, i.makers);
      const ticketId = await consumeStepUp(tx, auth, req.get('x-step-up-token'), 'APPROVE');
      const now = clock.now();
      const set = isNew
        ? { status: 'ACTIVE' }
        : { ...pending!.data, pendingChange: null };
      if (!isNew) await checkDuplicates(tx, pending!.data, i.id);
      const [n] = await tx
        .update(insurers)
        .set({ ...set, makers: [], rejectReason: null, approvedBy: auth.userId, approvedAt: now, approvalTicketId: ticketId, version: i.version + 1 })
        .where(eq(insurers.id, i.id))
        .returning();
      await audit(tx, req, {
        action: isNew ? 'INSURER_APPROVED' : 'INSURER_CHANGE_APPROVED',
        entity: 'insurer',
        entityId: i.id,
        oldValue: dataOf(i),
        newValue: { ...dataOf(n!), approvalTicketId: ticketId },
      });
      return { insurer: await view(n!), message: msg('CAT-03', { Item: n!.name }) };
    });
  } catch (err) {
    if (isUnique(err, 'insurers_name')) throw fieldError('name', 'CAT-06');
    if (isUnique(err, 'insurers_code')) throw fieldError('shortCode', 'CAT-07');
    throw err;
  }
}

/** Reject: a new insurer goes back to DRAFT; a pending change is kept (REJECTED) so the maker can fix it. */
export async function rejectInsurer(req: Request, auth: AuthContext, id: string, body: unknown) {
  const reason = readReason(body);
  const version = readVersion(body);
  return db.transaction(async (tx) => {
    const i = await load(tx, id, true);
    const pending = i.pendingChange as Pending | null;
    const isNew = i.status === 'PENDING_APPROVAL';
    if (!isNew && pending?.status !== 'PENDING') throw stateConflict('insurer', i.status);
    if (i.version !== version) throw stateConflict('insurer', 'changed');
    assertChecker(auth, i.makers);
    const set = isNew ? { status: 'DRAFT', rejectReason: reason } : { pendingChange: { ...pending!, status: 'REJECTED', reason } };
    const [n] = await tx
      .update(insurers)
      .set({ ...set, version: i.version + 1 })
      .where(eq(insurers.id, i.id))
      .returning();
    await audit(tx, req, { action: isNew ? 'INSURER_REJECTED' : 'INSURER_CHANGE_REJECTED', entity: 'insurer', entityId: i.id, newValue: { reason } });
    return { insurer: await view(n!), message: msg('CAT-04', { Item: i.name, reason }) };
  });
}

/** Discard a rejected pending change (the maker decides not to resubmit). */
export async function discardInsurerChange(req: Request, id: string, body: unknown) {
  const version = readVersion(body);
  return db.transaction(async (tx) => {
    const i = await load(tx, id, true);
    if (i.version !== version) throw versionConflict('insurer');
    if ((i.pendingChange as Pending | null)?.status !== 'REJECTED') throw stateConflict('insurer', i.status);
    const [n] = await tx.update(insurers).set({ pendingChange: null, makers: [], version: i.version + 1 }).where(eq(insurers.id, i.id)).returning();
    await audit(tx, req, { action: 'INSURER_CHANGE_DISCARDED', entity: 'insurer', entityId: i.id });
    return { insurer: await view(n!) };
  });
}

/** CAT-09 impact: products hidden from new quotations, and advisors affected. */
export async function insurerImpact(id: string) {
  const i = await load(db, id);
  const [p] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(products)
    .where(and(eq(products.insurerId, i.id), ne(products.status, 'WITHDRAWN')));
  const [m] = await db
    .select({ m: countDistinct(sql`acc`) })
    .from(
      sql`(select ${insurerMappings.accountId} as acc from ${insurerMappings} where ${insurerMappings.insurerId} = ${i.id} and ${insurerMappings.status} = 'ACTIVE'
           union select ${products.accountId} from ${products} where ${products.insurerId} = ${i.id} and ${products.accountId} is not null) as a`,
    );
  const n = p?.n ?? 0;
  const advisors = Number(m?.m ?? 0);
  return { products: n, advisors, message: msg('CAT-09', { name: i.name, n, m: advisors }) };
}

export async function setInsurerActive(req: Request, auth: AuthContext, id: string, active: boolean, body: unknown) {
  if (auth.role !== 'ADM') throw new AppError(403, 'GEN-03');
  const version = readVersion(body);
  return db.transaction(async (tx) => {
    const i = await load(tx, id, true);
    if (i.version !== version) throw versionConflict('insurer');
    const from = active ? 'INACTIVE' : 'ACTIVE';
    if (i.status !== from) throw stateConflict('insurer', i.status);
    const [n] = await tx
      .update(insurers)
      .set({ status: active ? 'ACTIVE' : 'INACTIVE', version: i.version + 1 })
      .where(eq(insurers.id, i.id))
      .returning();
    await audit(tx, req, { action: active ? 'INSURER_ACTIVATED' : 'INSURER_DEACTIVATED', entity: 'insurer', entityId: i.id, oldValue: { status: i.status }, newValue: { status: n!.status } });
    return { insurer: await view(n!), message: msg('GEN-08', { 'Record type': 'Insurer' }) };
  });
}

/** Pending insurer items for Admin → Approvals. */
export async function pendingInsurers() {
  const rows = await db
    .select()
    .from(insurers)
    .where(or(eq(insurers.status, 'PENDING_APPROVAL'), sql`${insurers.pendingChange} ->> 'status' = 'PENDING'`));
  return Promise.all(
    rows.map(async (i) => ({
      kind: i.status === 'PENDING_APPROVAL' ? 'INSURER' : 'INSURER_CHANGE',
      id: i.id,
      title: i.name,
      makers: await namesOf(db, i.makers),
      makerIds: i.makers,
      submittedAt: i.submittedAt,
    })),
  );
}
