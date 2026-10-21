// P-07 Add insurers and agent codes. One entry per account and insurer (database unique rule).
import type { Request } from 'express';
import { and, asc, eq, ilike, ne, notInArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { insurerMappings, insurers } from '../../db/schema.js';
import { clock, formatDate, istToday } from '../../lib/clock.js';
import { fieldError, notFound, stateConflict, versionConflict } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import { msg } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { ownFile } from '../files/files.service.js';
import { recalc } from '../profile/profile.service.js';
import { verifyMapping } from './verify.service.js';

const isUnique = (err: unknown) => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
};

/** ACTIVE insurers the advisor has not added yet (search list for "Add insurer"). */
export async function availableInsurers(accountId: string, q?: string) {
  const added = db.select({ id: insurerMappings.insurerId }).from(insurerMappings).where(eq(insurerMappings.accountId, accountId));
  return db
    .select({ id: insurers.id, name: insurers.name, shortCode: insurers.shortCode, category: insurers.category })
    .from(insurers)
    .where(and(eq(insurers.status, 'ACTIVE'), notInArray(insurers.id, added), q ? ilike(insurers.name, `%${q.replace(/[%_\\]/g, '')}%`) : sql`true`))
    .orderBy(asc(insurers.name));
}

export async function listMappings(accountId: string) {
  const rows = await db
    .select({ m: insurerMappings, i: { name: insurers.name, status: insurers.status, shortCode: insurers.shortCode } })
    .from(insurerMappings)
    .innerJoin(insurers, eq(insurers.id, insurerMappings.insurerId))
    .where(eq(insurerMappings.accountId, accountId))
    .orderBy(asc(insurers.name));
  const today = istToday();
  return rows.map(({ m, i }) => ({
    id: m.id,
    insurerId: m.insurerId,
    insurerName: i.name,
    agentCode: m.agentCode,
    codeValidUntil: m.codeValidUntil,
    appointmentFileId: m.appointmentFileId,
    status: m.status,
    version: m.version,
    // Agent code check from the appointment letter (verify.service.ts)
    verification: m.verification,
    verificationNote: m.verificationNote,
    // Shown on the entry: the insurer left the catalogue (PRF-10) or the code date passed (PRF-11)
    warning:
      i.status === 'INACTIVE'
        ? msg('PRF-10', { insurer: i.name })
        : m.codeValidUntil && m.codeValidUntil < today
          ? msg('PRF-11', { insurer: i.name, date: formatDate(m.codeValidUntil) })
          : null,
  }));
}

/** Same insurer + agent code in another account: flag both for SkyUp review, never tell either advisor (DEC-09). */
async function flagDuplicates(insurerId: string, agentCode: string, accountId: string) {
  const others = await db
    .select({ id: insurerMappings.id })
    .from(insurerMappings)
    .where(and(eq(insurerMappings.insurerId, insurerId), eq(insurerMappings.agentCode, agentCode), ne(insurerMappings.accountId, accountId)));
  if (others.length) {
    await db
      .update(insurerMappings)
      .set({ flaggedForReview: true })
      .where(and(eq(insurerMappings.insurerId, insurerId), eq(insurerMappings.agentCode, agentCode)));
  }
}

function fieldsFor(body: unknown, withInsurer: boolean) {
  return F.parseFields(body, {
    ...(withInsurer ? { insurerId: { label: 'Insurer', required: true } } : {}),
    agentCode: { label: 'Agent code', required: true, rule: F.agentCode },
    codeValidUntil: { label: 'Code valid until', rule: F.futureDate },
    ...(withInsurer ? { declaration: { label: 'Declaration', checkbox: true } } : {}),
  }) as { insurerId?: string; agentCode: string; codeValidUntil?: string };
}

export async function addMapping(req: Request, auth: AuthContext, body: unknown) {
  const v = fieldsFor(body, true);
  const accountId = auth.accountId!;
  const [ins] = /^[0-9a-f-]{36}$/.test(v.insurerId!) ? await db.select().from(insurers).where(eq(insurers.id, v.insurerId!)) : [];
  if (!ins || ins.status !== 'ACTIVE') throw fieldError('insurerId', 'VAL-22'); // FLD-20: must exist and be ACTIVE
  const b = body as { appointmentFileId?: unknown };
  const file = b.appointmentFileId ? await ownFile(auth, b.appointmentFileId, ['APPOINTMENT_LETTER'], 'appointmentFileId') : null;
  const [existing] = await db.select({ id: insurerMappings.id }).from(insurerMappings).where(and(eq(insurerMappings.accountId, accountId), eq(insurerMappings.insurerId, ins.id)));
  if (existing) throw fieldError('insurerId', 'PRF-09', { insurer: ins.name });
  try {
    const row = await db.transaction(async (tx) => {
      const [m] = await tx
        .insert(insurerMappings)
        .values({ accountId, insurerId: ins.id, agentCode: v.agentCode, codeValidUntil: v.codeValidUntil ?? null, appointmentFileId: file?.id ?? null, declaredAt: clock.now(), createdAt: clock.now() })
        .returning();
      await audit(tx, req, { action: 'INSURER_MAPPING_ADDED', entity: 'insurer_mapping', entityId: m!.id, newValue: { insurer: ins.name, agentCode: v.agentCode, codeValidUntil: v.codeValidUntil ?? null } });
      await recalc(tx, accountId);
      return m!;
    });
    await flagDuplicates(ins.id, v.agentCode, accountId);
    const check = await verifyMapping(row.id);
    return { id: row.id, message: msg('PRF-08', { insurer: ins.name, code: v.agentCode }), verification: check.verification, verificationNote: check.note };
  } catch (err) {
    if (isUnique(err)) throw fieldError('insurerId', 'PRF-09', { insurer: ins.name }); // two tabs at once (GR-12)
    throw err;
  }
}

async function ownMapping(accountId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound();
  const [row] = await db
    .select({ m: insurerMappings, name: insurers.name, insurerStatus: insurers.status })
    .from(insurerMappings)
    .innerJoin(insurers, eq(insurers.id, insurerMappings.insurerId))
    .where(and(eq(insurerMappings.id, id), eq(insurerMappings.accountId, accountId)));
  if (!row) throw notFound(); // GR-20: another account's entry does not exist for this user
  return row;
}

export async function editMapping(req: Request, auth: AuthContext, id: string, body: unknown) {
  const v = fieldsFor(body, false);
  const { m, name } = await ownMapping(auth.accountId!, id);
  const b = body as { appointmentFileId?: unknown; version?: unknown };
  // No file sent → keep the letter already uploaded (null removes it)
  const file = b.appointmentFileId ? await ownFile(auth, b.appointmentFileId, ['APPOINTMENT_LETTER'], 'appointmentFileId') : null;
  const fileId = file ? file.id : b.appointmentFileId === null ? null : m.appointmentFileId;
  const rows = await db
    .update(insurerMappings)
    .set({ agentCode: v.agentCode, codeValidUntil: v.codeValidUntil ?? null, appointmentFileId: fileId, version: sql`${insurerMappings.version} + 1` })
    .where(and(eq(insurerMappings.id, m.id), eq(insurerMappings.version, Number(b.version))))
    .returning({ id: insurerMappings.id });
  if (!rows.length) throw versionConflict('insurer entry', ['agentCode', 'codeValidUntil']);
  await audit(db, req, { action: 'INSURER_MAPPING_EDITED', entity: 'insurer_mapping', entityId: m.id, oldValue: { agentCode: m.agentCode, codeValidUntil: m.codeValidUntil }, newValue: { agentCode: v.agentCode, codeValidUntil: v.codeValidUntil ?? null } });
  await flagDuplicates(m.insurerId, v.agentCode, auth.accountId!);
  // Check again when the code, the date or the letter changed (an approved entry stays approved otherwise)
  const changed = v.agentCode !== m.agentCode || (v.codeValidUntil ?? null) !== m.codeValidUntil || fileId !== m.appointmentFileId;
  const check = changed || m.verification === 'UNVERIFIED' ? await verifyMapping(m.id) : { verification: m.verification, note: m.verificationNote };
  return { message: msg('GEN-08', { 'Record type': name }), verification: check.verification, verificationNote: check.note };
}

/** ACTIVE ↔ INACTIVE by the advisor (Section 4.3). The browser asks PRF-12 before deactivating. */
export async function setMappingStatus(req: Request, auth: AuthContext, id: string, to: 'ACTIVE' | 'INACTIVE', version: number) {
  const { m, name, insurerStatus } = await ownMapping(auth.accountId!, id);
  if (m.status === to) throw stateConflict('insurer entry', m.status);
  if (to === 'ACTIVE' && insurerStatus !== 'ACTIVE') throw fieldError('insurerId', 'PRF-10', { insurer: name });
  await db.transaction(async (tx) => {
    const rows = await tx
      .update(insurerMappings)
      .set({ status: to, version: sql`${insurerMappings.version} + 1` })
      .where(and(eq(insurerMappings.id, m.id), eq(insurerMappings.version, version), eq(insurerMappings.status, m.status)))
      .returning({ id: insurerMappings.id });
    if (!rows.length) throw versionConflict('insurer entry', ['status']);
    await audit(tx, req, { action: to === 'ACTIVE' ? 'INSURER_MAPPING_ACTIVATED' : 'INSURER_MAPPING_DEACTIVATED', entity: 'insurer_mapping', entityId: m.id, oldValue: { status: m.status }, newValue: { status: to } });
    await recalc(tx, auth.accountId!);
  });
  return { status: to };
}
