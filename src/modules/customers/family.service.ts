// P-16 Household roster. Each member belongs to exactly one customer and never becomes a nominee or an
// insured person automatically; a member's mobile does not imply consent (P-17).
import type { Request } from 'express';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.js';
import { familyMembers, files } from '../../db/schema.js';
import { clock, istToday } from '../../lib/clock.js';
import { AppError, fieldError, fieldErrors, notFound, stateConflict, versionConflict, type FieldError } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import { maskMobile } from '../../lib/mask.js';
import { msg } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { settings } from '../settings/settings.service.js';
import { isUnique, isUuid, normName, readVersion } from '../clients/common.js';
import { cancelQueuedMessages } from '../clients/hooks.js';
import { GENDERS, assertActive, loadCustomer } from './customers.service.js';

type Member = typeof familyMembers.$inferSelect;

async function parseMember(body: unknown, accountId: string) {
  const errors: FieldError[] = [];
  let v: Record<string, unknown> = {};
  try {
    v = F.parseFields(body, {
      fullName: { label: 'Full name', required: true, rule: F.personName },
      relationship: { label: 'Relationship', required: true, oneOf: settings.get('CFG-36') },
      dateOfBirth: { label: 'Date of birth', rule: F.dateOfBirth },
      gender: { label: 'Gender', oneOf: GENDERS },
      anniversary: { label: 'Wedding anniversary', rule: F.pastOrToday },
      mobile: { label: 'Mobile', rule: F.mobile },
      email: { label: 'Email', rule: F.email },
    });
  } catch (err) {
    if (err instanceof AppError) errors.push(...err.fields);
    else throw err;
  }
  const photo = (body as { photoFileId?: unknown } | null)?.photoFileId;
  let photoFileId: string | null = null;
  if (photo) {
    const [f] = isUuid(photo) ? await db.select().from(files).where(eq(files.id, photo)) : [];
    if (!f || f.accountId !== accountId || f.purpose !== 'FAMILY_PHOTO') errors.push({ field: 'photoFileId', code: 'VAL-22' });
    else photoFileId = f.id;
  }
  if (errors.length) throw fieldErrors(errors);
  const s = (k: string) => (v[k] as string | undefined) ?? null;
  return { fullName: v.fullName as string, relationship: v.relationship as string, dateOfBirth: s('dateOfBirth'), gender: s('gender'), anniversary: s('anniversary'), mobile: s('mobile'), email: s('email'), photoFileId };
}

const age = (dob: string | null) => {
  if (!dob) return null;
  const t = istToday();
  let a = Number(t.slice(0, 4)) - Number(dob.slice(0, 4));
  if (t.slice(5) < dob.slice(5)) a -= 1;
  return a;
};
const view = (m: Member) => ({ id: m.id, fullName: m.fullName, relationship: m.relationship, dateOfBirth: m.dateOfBirth, age: age(m.dateOfBirth), gender: m.gender, anniversary: m.anniversary, mobile: m.mobile, email: m.email, photoFileId: m.photoFileId, status: m.status, version: m.version });

export async function listFamily(auth: AuthContext, customerId: string) {
  const c = await loadCustomer(db, auth.accountId!, customerId);
  const rows = await db.select().from(familyMembers).where(eq(familyMembers.customerId, c.id)).orderBy(asc(familyMembers.status), asc(familyMembers.fullName));
  return { items: rows.map(view), max: settings.get('CFG-35') };
}

export async function addMember(req: Request, auth: AuthContext, customerId: string, body: unknown) {
  const d = await parseMember(body, auth.accountId!);
  try {
    return await db.transaction(async (tx) => {
      const c = await loadCustomer(tx, auth.accountId!, customerId, true);
      assertActive(c);
      const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(familyMembers).where(and(eq(familyMembers.customerId, c.id), eq(familyMembers.status, 'ACTIVE')));
      if (n >= settings.get('CFG-35')) throw new AppError(409, 'CU-06', { 'CFG-35': settings.get('CFG-35') });
      const [m] = await tx.insert(familyMembers).values({ accountId: c.accountId, customerId: c.id, ...d, nameNorm: normName(d.fullName), createdBy: auth.userId, createdAt: clock.now() }).returning();
      await audit(tx, req, { action: 'FAMILY_ADDED', entity: 'customer', entityId: c.id, newValue: { memberId: m!.id, name: d.fullName, relationship: d.relationship, mobile: d.mobile ? maskMobile(d.mobile) : null } });
      return { member: view(m!), message: msg('CU-05', { Name: d.fullName, customer: c.fullName }) };
    });
  } catch (err) {
    if (isUnique(err, 'family_active_name_rel')) throw await duplicateMember(customerId, d);
    throw err;
  }
}

/** CU-07 with the member's name as it is on file. */
async function duplicateMember(customerId: string, d: { fullName: string; relationship: string }) {
  const [m] = await db
    .select({ fullName: familyMembers.fullName })
    .from(familyMembers)
    .where(and(eq(familyMembers.customerId, customerId), eq(familyMembers.nameNorm, normName(d.fullName)), eq(familyMembers.relationship, d.relationship), eq(familyMembers.status, 'ACTIVE')));
  return fieldError('fullName', 'CU-07', { Name: m?.fullName ?? d.fullName, relationship: d.relationship.toLowerCase() });
}

async function loadMember(tx: DbOrTx, auth: AuthContext, customerId: string, memberId: string) {
  if (!isUuid(memberId)) throw notFound();
  const [m] = await tx.select().from(familyMembers).where(and(eq(familyMembers.id, memberId), eq(familyMembers.customerId, customerId), eq(familyMembers.accountId, auth.accountId!))).for('update');
  if (!m) throw notFound();
  return m;
}

export async function editMember(req: Request, auth: AuthContext, customerId: string, memberId: string, body: unknown) {
  const d = await parseMember(body, auth.accountId!);
  const version = readVersion(body);
  try {
    return await db.transaction(async (tx) => {
      const c = await loadCustomer(tx, auth.accountId!, customerId, true);
      assertActive(c);
      const m = await loadMember(tx, auth, c.id, memberId);
      if (m.version !== version) throw versionConflict('family member', Object.keys(d).filter((k) => (m as Record<string, unknown>)[k] !== (d as Record<string, unknown>)[k]));
      const [n] = await tx.update(familyMembers).set({ ...d, nameNorm: normName(d.fullName), version: m.version + 1 }).where(eq(familyMembers.id, m.id)).returning();
      await audit(tx, req, { action: 'FAMILY_EDITED', entity: 'customer', entityId: c.id, newValue: { memberId: m.id, name: d.fullName } });
      return { member: view(n!), message: msg('GEN-08', { 'Record type': 'Family member' }) };
    });
  } catch (err) {
    if (isUnique(err, 'family_active_name_rel')) throw await duplicateMember(customerId, d);
    throw err;
  }
}

/** Deactivate (CU-19): QUEUED messages to or about the member are cancelled. Activate reverses it. */
export async function setMemberActive(req: Request, auth: AuthContext, customerId: string, memberId: string, active: boolean, body: unknown) {
  const version = readVersion(body);
  try {
    return await db.transaction(async (tx) => {
      const c = await loadCustomer(tx, auth.accountId!, customerId, true);
      assertActive(c);
      const m = await loadMember(tx, auth, c.id, memberId);
      if (m.status !== (active ? 'INACTIVE' : 'ACTIVE')) throw stateConflict('family member', m.status);
      if (m.version !== version) throw versionConflict('family member', ['status']);
      if (active) {
        const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(familyMembers).where(and(eq(familyMembers.customerId, c.id), eq(familyMembers.status, 'ACTIVE')));
        if (n >= settings.get('CFG-35')) throw new AppError(409, 'CU-06', { 'CFG-35': settings.get('CFG-35') });
      }
      const [n] = await tx.update(familyMembers).set({ status: active ? 'ACTIVE' : 'INACTIVE', version: m.version + 1 }).where(eq(familyMembers.id, m.id)).returning();
      if (!active) await cancelQueuedMessages(tx, { accountId: c.accountId, customerId: c.id, familyMemberId: m.id });
      await audit(tx, req, { action: active ? 'FAMILY_ACTIVATED' : 'FAMILY_DEACTIVATED', entity: 'customer', entityId: c.id, newValue: { memberId: m.id, name: m.fullName } });
      return { member: view(n!), message: active ? msg('GEN-08', { 'Record type': 'Family member' }) : msg('CU-19', { Name: m.fullName }) };
    });
  } catch (err) {
    if (isUnique(err, 'family_active_name_rel')) throw new AppError(409, 'CU-07', {});
    throw err;
  }
}
