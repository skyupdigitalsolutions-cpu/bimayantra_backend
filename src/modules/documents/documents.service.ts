// P-18 Document vault: add, verify, version and label documents. One document per person and type (and
// name for Other, slot for a vehicle photo); every upload is a new version. Nothing is ever deleted or
// replaced (DOC-07); only the label changes, and every change keeps the original upload name.
// Aadhaar, PAN and Old policy have a verify step: nothing read from them is saved before Confirm.
import type { Request } from 'express';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.js';
import { customers, documentLabelChanges, documentVersions, documents, familyMembers, files, users } from '../../db/schema.js';
import { clock } from '../../lib/clock.js';
import { AppError, fieldError, fieldErrors, forbidden, notFound, versionConflict, type FieldError } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import { maskAadhaar, maskPan } from '../../lib/mask.js';
import { msg } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { settings } from '../settings/settings.service.js';
import { isUnique, isUuid, readVersion } from '../clients/common.js';
import { GENDERS, assertActive, assertPersonalDataAllowed, loadCustomer, setIdentity } from '../customers/customers.service.js';
import { readStored } from '../files/files.service.js';
import { readDocument, type ReadType } from './reader.js';

type Doc = typeof documents.$inferSelect;
type Version = typeof documentVersions.$inferSelect;
export const VERIFY_TYPES = ['Aadhaar', 'PAN', 'Old policy'] as const;
const IDENTITY_TYPES = ['Aadhaar', 'PAN', 'Old policy'];
const VEHICLE_TYPES = ['Vehicle RC', 'Vehicle photo'];

/** Fields on the verify screen for each type (P-18 step 5). */
export const VERIFY_FIELDS: Record<string, { key: string; label: string; kind: 'name' | 'date' | 'gender' | 'aadhaar' | 'pan' | 'text' | 'policy' | 'amount' | 'longtext' }[]> = {
  Aadhaar: [
    { key: 'name', label: 'Name', kind: 'name' },
    { key: 'dateOfBirth', label: 'Date of birth', kind: 'date' },
    { key: 'gender', label: 'Gender', kind: 'gender' },
    { key: 'aadhaar', label: 'Aadhaar number', kind: 'aadhaar' },
  ],
  PAN: [
    { key: 'name', label: 'Name', kind: 'name' },
    { key: 'fatherName', label: "Father's name", kind: 'name' },
    { key: 'dateOfBirth', label: 'Date of birth', kind: 'date' },
    { key: 'pan', label: 'PAN', kind: 'pan' },
  ],
  'Old policy': [
    { key: 'insurer', label: 'Insurer', kind: 'text' },
    { key: 'policyNumber', label: 'Policy number', kind: 'policy' },
    { key: 'productName', label: 'Product name', kind: 'text' },
    { key: 'startDate', label: 'Start date', kind: 'date' },
    { key: 'endDate', label: 'End date', kind: 'date' },
    { key: 'sumInsured', label: 'Sum insured', kind: 'amount' },
    { key: 'premium', label: 'Premium', kind: 'amount' },
    { key: 'insuredPeople', label: 'Insured people', kind: 'longtext' },
    { key: 'nominees', label: 'Nominees', kind: 'longtext' },
  ],
};

async function personName(dbx: DbOrTx, customer: { id: string; fullName: string }, familyMemberId: string | null) {
  if (!familyMemberId) return customer.fullName;
  const [m] = await dbx.select({ fullName: familyMembers.fullName }).from(familyMembers).where(and(eq(familyMembers.id, familyMemberId), eq(familyMembers.customerId, customer.id)));
  if (!m) throw fieldError('familyMemberId', 'VAL-22');
  return m.fullName;
}

/** A label that is unique on this customer: "PAN - Ravi Kumar", then "(2)", "(3)" … */
async function freeLabel(dbx: DbOrTx, customerId: string, base: string) {
  const rows = await dbx.select({ label: documents.label }).from(documents).where(eq(documents.customerId, customerId));
  const taken = new Set(rows.map((r) => r.label.toLowerCase()));
  const max = settings.get('CFG-172').max;
  const b = base.slice(0, max);
  if (!taken.has(b.toLowerCase())) return b;
  for (let i = 2; ; i += 1) {
    const l = `${b.slice(0, max - 5)} (${i})`;
    if (!taken.has(l.toLowerCase())) return l;
  }
}

/**
 * Add a version (shared by the vault and by vehicles). Creates the document on its first upload. Returns
 * the version; types with a verify step start UNCONFIRMED.
 */
export async function addVersion(
  tx: DbOrTx,
  req: Request,
  auth: AuthContext,
  args: { customer: typeof customers.$inferSelect; familyMemberId: string | null; vehicleId?: string | null; type: string; name?: string | null; slot?: string | null; fileId: unknown },
) {
  const [f] = isUuid(args.fileId) ? await tx.select().from(files).where(eq(files.id, args.fileId)) : [];
  const purposes = args.type === 'Vehicle photo' ? ['VEHICLE_PHOTO'] : ['CLIENT_DOCUMENT'];
  if (!f || f.accountId !== auth.accountId || !purposes.includes(f.purpose)) throw fieldError('fileId', 'VAL-22');
  const person = await personName(tx, args.customer, args.familyMemberId);
  const [existing] = await tx
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.customerId, args.customer.id),
        sql`coalesce(${documents.familyMemberId}, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(${args.familyMemberId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
        sql`coalesce(${documents.vehicleId}, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(${args.vehicleId ?? null}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
        eq(documents.type, args.type),
        sql`coalesce(lower(${documents.name}), '') = ${(args.name ?? '').toLowerCase()}`,
        sql`coalesce(${documents.slot}, '') = ${args.slot ?? ''}`,
      ),
    )
    .for('update');
  const now = clock.now();
  let doc: Doc;
  if (existing) {
    const [d] = await tx.update(documents).set({ latestVersion: existing.latestVersion + 1, version: existing.version + 1 }).where(eq(documents.id, existing.id)).returning();
    doc = d!;
  } else {
    const base = `${args.name ?? args.slot ?? args.type} - ${person}`;
    const label = await freeLabel(tx, args.customer.id, args.slot ? `${args.type} ${args.slot} - ${person}` : base);
    const [d] = await tx
      .insert(documents)
      .values({ accountId: args.customer.accountId, customerId: args.customer.id, familyMemberId: args.familyMemberId, vehicleId: args.vehicleId ?? null, type: args.type, name: args.name ?? null, slot: args.slot ?? null, label, createdBy: auth.userId, createdAt: now })
      .returning();
    doc = d!;
  }
  const verify = (VERIFY_TYPES as readonly string[]).includes(args.type);
  const [v] = await tx
    .insert(documentVersions)
    .values({
      documentId: doc.id,
      accountId: doc.accountId,
      versionNo: doc.latestVersion,
      fileId: f.id,
      originalName: f.originalName,
      status: verify ? 'UNCONFIRMED' : 'CONFIRMED',
      // Reading identity documents needs an OCR provider (document change 49); until then the verify
      // screen opens with empty fields (DOC-10) and the user types the details
      readValues: null,
      uploadedBy: auth.userId,
      uploadedAt: now,
    })
    .returning();
  await audit(tx, req, { action: 'DOCUMENT_UPLOADED', entity: 'customer', entityId: args.customer.id, newValue: { documentId: doc.id, label: doc.label, type: args.type, version: v!.versionNo } });
  return { doc, version: v!, verify };
}

export async function uploadDocument(req: Request, auth: AuthContext, body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const errors: FieldError[] = [];
  const types = settings.get('CFG-171');
  if (!isUuid(b.customerId) || !b.type || (b.type === 'Other' && !b.name)) {
    // Upload stays disabled until customer, person and type (and the name for Other) are chosen
    if (b.type === 'Other' && !b.name && isUuid(b.customerId)) throw fieldError('name', 'DOC-02');
    throw new AppError(422, 'DOC-01', {}, [{ field: 'type', code: 'DOC-01' }]);
  }
  const type = typeof b.type === 'string' ? b.type : '';
  if (!types.includes(type) || VEHICLE_TYPES.includes(type)) errors.push({ field: 'type', code: 'VAL-22' });
  let name: string | null = null;
  if (type === 'Other') {
    const r = F.documentLabel(String(b.name));
    if (!r.ok) errors.push({ field: 'name', code: 'DOC-02' });
    else name = r.value;
  }
  if (errors.length) throw fieldErrors(errors);
  const familyMemberId = b.familyMemberId ? (typeof b.familyMemberId === 'string' ? b.familyMemberId : '') : null;
  const result = await db.transaction(async (tx) => {
    const c = await loadCustomer(tx, auth.accountId!, b.customerId as string, true);
    assertActive(c);
    if (IDENTITY_TYPES.includes(type)) await assertPersonalDataAllowed(tx, c);
    else {
      // Withdrawn personal-data consent stops every new document for the customer (CU-30)
      const withdrawn = await tx.execute(sql`select 1 from consents where customer_id = ${c.id} and family_member_id is null and channel = 'PERSONAL_DATA' and status = 'WITHDRAWN'`);
      if (withdrawn.rows.length) throw new AppError(409, 'CU-30', { Customer: c.fullName });
    }
    if (familyMemberId && !isUuid(familyMemberId)) throw fieldError('familyMemberId', 'VAL-22');
    const r = await addVersion(tx, req, auth, { customer: c, familyMemberId, type, name, fileId: b.fileId });
    return {
      document: { id: r.doc.id, label: r.doc.label, type },
      version: { id: r.version.id, versionNo: r.version.versionNo, status: r.version.status },
      verify: r.verify ? ({ fields: VERIFY_FIELDS[type], readValues: {}, prompt: msg('DOC-04'), notRead: msg('DOC-10') } satisfies Record<string, unknown>) : null,
      message: msg('DOC-03', { 'Document type': type, n: r.version.versionNo }),
      fileId: r.version.fileId,
    };
  });
  // Read the document (outside the transaction: it can take a few seconds). The screen opens filled; the
  // person checks and confirms. Aadhaar and PAN numbers are sent to the screen only, never stored as read values.
  const { fileId, ...out } = result;
  if (out.verify) {
    const [f] = await db.select().from(files).where(eq(files.id, fileId));
    const values = f ? await readDocument(type as ReadType, await readStored(f.storageKey).catch(() => Buffer.alloc(0)), f.mime, f.originalName) : null;
    if (values && Object.keys(values).length) {
      const safe = Object.fromEntries(Object.entries(values).filter(([k]) => k !== 'aadhaar' && k !== 'pan'));
      await db.update(documentVersions).set({ readValues: safe }).where(eq(documentVersions.id, out.version.id));
      return { ...out, verify: { ...out.verify, readValues: values, notRead: null } };
    }
  }
  return out;
}

async function loadVersion(dbx: DbOrTx, auth: AuthContext, id: string, lock = false) {
  if (!isUuid(id)) throw notFound();
  const q = dbx
    .select({ v: documentVersions, d: documents })
    .from(documentVersions)
    .innerJoin(documents, eq(documents.id, documentVersions.documentId))
    .where(and(eq(documentVersions.id, id), eq(documentVersions.accountId, auth.accountId!)));
  const [r] = lock ? await q.for('update') : await q;
  if (!r) throw notFound();
  return r;
}

export async function getVersion(auth: AuthContext, id: string) {
  const { v, d } = await loadVersion(db, auth, id);
  return { id: v.id, documentId: d.id, type: d.type, label: d.label, versionNo: v.versionNo, status: v.status, fileId: v.fileId, fields: VERIFY_FIELDS[d.type] ?? [], readValues: v.readValues ?? {}, confirmedValues: v.confirmedValues, prompt: msg('DOC-04'), notRead: v.readValues ? null : msg('DOC-10'), version: v.version };
}

const genderRule: F.Rule<string> = (x) => ((GENDERS as readonly string[]).includes(x) ? { ok: true, value: x } : { ok: false, code: 'VAL-22' });

function parseVerify(type: string, body: unknown) {
  const b = ((body as { values?: unknown } | null)?.values ?? {}) as Record<string, unknown>;
  const errors: FieldError[] = [];
  const out: Record<string, string | null> = {};
  for (const f of VERIFY_FIELDS[type] ?? []) {
    const raw = b[f.key];
    const s = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';
    if (!s) {
      out[f.key] = null;
      continue;
    }
    const rule =
      f.kind === 'name' ? F.personName
        : f.kind === 'date' ? (type === 'Old policy' ? F.date : F.dateOfBirth)
          : f.kind === 'aadhaar' ? F.aadhaar
            : f.kind === 'pan' ? F.pan
              : f.kind === 'policy' ? F.policyNumber
                : f.kind === 'amount' ? F.amount()
                  : f.kind === 'longtext' ? F.notes
                    : f.kind === 'gender' ? genderRule
                      : F.shortText;
    const r = rule(s);
    if (r.ok) out[f.key] = r.value;
    else errors.push({ field: `values.${f.key}`, code: r.code, ...(r.params ? { params: r.params } : {}) });
  }
  if (type === 'Old policy' && out.startDate && out.endDate && out.endDate < out.startDate) errors.push({ field: 'values.endDate', code: 'VAL-08' });
  if (errors.length) throw fieldErrors(errors);
  return out;
}

/**
 * Confirm (P-18 step 6): the version becomes CONFIRMED. Aadhaar or PAN are copied to the customer's
 * encrypted fields when empty, or after the user confirms a change. Identity numbers are kept only masked
 * in the stored values. A double click gives one confirmation.
 */
export async function confirmVersion(req: Request, auth: AuthContext, id: string, body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const version = readVersion(body);
  return db.transaction(async (tx) => {
    const { v, d } = await loadVersion(tx, auth, id, true);
    if (v.status === 'CONFIRMED') return { status: 'CONFIRMED', message: msg('GEN-06'), recordAsPolicy: null };
    if (v.version !== version) throw versionConflict('document', ['values']);
    const values = parseVerify(d.type, body);
    const c = await loadCustomer(tx, auth.accountId!, d.customerId, true);
    let identityUpdated = false;
    if (!d.familyMemberId && (d.type === 'PAN' || d.type === 'Aadhaar')) {
      const field = d.type === 'PAN' ? 'pan' : 'aadhaar';
      const value = values[field];
      const has = field === 'pan' ? c.panEnc : c.aadhaarEnc;
      const masked = field === 'pan' && value ? maskPan(value) : value ? maskAadhaar(value) : null;
      const current = field === 'pan' ? c.panMasked : c.aadhaarMasked;
      if (value && (!has || (current !== masked && b.replaceIdentity === true))) {
        await setIdentity(tx, req, c, { [field]: value }, b.saveAnyway === true);
        identityUpdated = true;
      } else if (value && has && current !== masked && b.replaceIdentity !== true) {
        throw new AppError(409, 'GEN-04', { 'record type': 'customer', 'current status': `already holding ${current}` }, [], { reason: 'confirm_identity_change', current, proposed: masked });
      }
    }
    // Aadhaar / PAN of the customer: fill an empty date of birth and gender on the customer's details
    if (!d.familyMemberId && (d.type === 'PAN' || d.type === 'Aadhaar')) {
      const patch: { dateOfBirth?: string; gender?: string } = {};
      if (!c.dateOfBirth && values.dateOfBirth) patch.dateOfBirth = values.dateOfBirth;
      if (!c.gender && values.gender) patch.gender = values.gender;
      if (Object.keys(patch).length) await tx.update(customers).set({ ...patch, version: c.version + 1 }).where(eq(customers.id, c.id));
    }
    const stored = { ...values, ...(values.pan ? { pan: maskPan(values.pan) } : {}), ...(values.aadhaar ? { aadhaar: maskAadhaar(values.aadhaar) } : {}) };
    await tx.update(documentVersions).set({ status: 'CONFIRMED', confirmedValues: stored, confirmedBy: auth.userId, confirmedAt: clock.now(), version: v.version + 1 }).where(eq(documentVersions.id, v.id));
    await audit(tx, req, { action: 'DOCUMENT_CONFIRMED', entity: 'customer', entityId: d.customerId, newValue: { documentId: d.id, label: d.label, version: v.versionNo, identityUpdated } });
    return {
      status: 'CONFIRMED',
      message: msg('GEN-08', { 'Record type': d.type }),
      // A confirmed old policy offers "Record as existing policy" (P-34) with these values
      recordAsPolicy: d.type === 'Old policy' ? { customerId: d.customerId, familyMemberId: d.familyMemberId, values: stored, documentId: d.id } : null,
    };
  });
}

/** Change label (advisor only, DOC-05); cannot be empty or repeat another label on the customer (DOC-06). */
export async function changeLabel(req: Request, auth: AuthContext, documentId: string, body: unknown) {
  if (auth.role !== 'ADV') throw forbidden();
  const v = F.parseFields(body, { label: { label: 'Label', required: true, rule: F.documentLabel } }) as { label: string };
  const version = readVersion(body);
  try {
    return await db.transaction(async (tx) => {
      if (!isUuid(documentId)) throw notFound();
      const [d] = await tx.select().from(documents).where(and(eq(documents.id, documentId), eq(documents.accountId, auth.accountId!))).for('update');
      if (!d) throw notFound();
      if (d.version !== version) throw versionConflict('document', ['label']);
      if (d.label === v.label) return { message: msg('DOC-05'), version: d.version };
      await tx.update(documents).set({ label: v.label, version: d.version + 1 }).where(eq(documents.id, d.id));
      await tx.insert(documentLabelChanges).values({ documentId: d.id, oldLabel: d.label, newLabel: v.label, byUserId: auth.userId, at: clock.now() });
      await audit(tx, req, { action: 'DOCUMENT_LABEL_CHANGED', entity: 'customer', entityId: d.customerId, oldValue: { label: d.label }, newValue: { label: v.label } });
      return { message: msg('DOC-05'), version: d.version + 1 };
    });
  } catch (err) {
    if (isUnique(err, 'documents_label')) throw fieldError('label', 'DOC-06');
    throw err;
  }
}

/** Browse a customer's documents by type and person, with versions, label history and the Missing box. */
export async function listDocuments(auth: AuthContext, customerId: string) {
  const c = await loadCustomer(db, auth.accountId!, customerId);
  const docs = await db.select().from(documents).where(eq(documents.customerId, c.id)).orderBy(asc(documents.type), asc(documents.label));
  const ids = docs.map((d) => d.id);
  const versions: Version[] = ids.length ? await db.select().from(documentVersions).where(inArray(documentVersions.documentId, ids)).orderBy(desc(documentVersions.versionNo)) : [];
  const labels = ids.length ? await db.select().from(documentLabelChanges).where(inArray(documentLabelChanges.documentId, ids)).orderBy(asc(documentLabelChanges.at)) : [];
  const members = await db.select({ id: familyMembers.id, fullName: familyMembers.fullName }).from(familyMembers).where(eq(familyMembers.customerId, c.id));
  const uids = [...new Set([...versions.map((v) => v.uploadedBy), ...labels.map((l) => l.byUserId)])];
  const names = uids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, uids)) : [];
  const who = (id: string | null) => names.find((n) => n.id === id)?.name ?? null;
  const items = docs.map((d) => {
    const vs = versions.filter((v) => v.documentId === d.id);
    return {
      id: d.id,
      type: d.type,
      name: d.name,
      slot: d.slot,
      vehicleId: d.vehicleId,
      label: d.label,
      person: d.familyMemberId ? (members.find((m) => m.id === d.familyMemberId)?.fullName ?? '—') : c.fullName,
      familyMemberId: d.familyMemberId,
      latest: vs[0] ? { id: vs[0].id, versionNo: vs[0].versionNo, status: vs[0].status, fileId: vs[0].fileId, uploadedAt: vs[0].uploadedAt } : null,
      versions: vs.map((v) => ({ id: v.id, versionNo: v.versionNo, status: v.status, fileId: v.fileId, originalName: v.originalName, uploadedAt: v.uploadedAt, uploadedBy: who(v.uploadedBy), confirmedValues: v.confirmedValues })),
      // The history always starts with the original upload name, then each label change
      labelHistory: [
        { at: d.createdAt, text: `Uploaded as ${vs[vs.length - 1]?.originalName ?? d.label}` },
        ...labels.filter((l) => l.documentId === d.id).map((l) => ({ at: l.at, text: `Label "${l.oldLabel}" → "${l.newLabel}" by ${who(l.byUserId) ?? 'someone'}` })),
      ],
      version: d.version,
    };
  });
  const own = items.filter((i) => !i.familyMemberId && !i.vehicleId);
  const missing: string[] = [];
  for (const t of ['Aadhaar', 'PAN']) {
    const d = own.find((i) => i.type === t);
    if (!d) missing.push(t);
    else if (d.latest?.status === 'UNCONFIRMED') missing.push(`${t} (waiting to be checked)`);
  }
  return {
    items: items.filter((i) => !i.vehicleId),
    missing: missing.length ? msg('DOC-08', { customer: c.fullName, list: missing.join(', ') }) : null,
    canChangeLabel: auth.role === 'ADV',
  };
}

export function documentOptions() {
  return {
    types: (settings.get('CFG-171')).filter((t) => !VEHICLE_TYPES.includes(t)),
    verifyTypes: VERIFY_TYPES,
    verifyFields: VERIFY_FIELDS,
    aadhaarReminder: msg('CU-17'),
    cameraBlocked: msg('DOC-09'),
    needFirst: msg('DOC-01'),
    noDelete: msg('DOC-07'),
  };
}

/** Customers to choose from on "+ Document" (registered customers only; free text is not accepted). */
export async function customerPicker(auth: AuthContext, q: string) {
  const term = q.trim().replace(/[%_\\]/g, '');
  if (term.length < 2) return { items: [] };
  const rows = await db
    .select({ id: customers.id, number: customers.number, fullName: customers.fullName, status: customers.status })
    .from(customers)
    .where(and(eq(customers.accountId, auth.accountId!), sql`(${customers.fullName} ilike ${`%${term}%`} or ${customers.number} ilike ${`%${term}%`} or ${customers.mobile} like ${`%${term.replace(/\D/g, '') || '§'}%`})`))
    .orderBy(asc(customers.fullName))
    .limit(20);
  const members = rows.length ? await db.select({ id: familyMembers.id, customerId: familyMembers.customerId, fullName: familyMembers.fullName, relationship: familyMembers.relationship }).from(familyMembers).where(and(inArray(familyMembers.customerId, rows.map((r) => r.id)), eq(familyMembers.status, 'ACTIVE'))) : [];
  return { items: rows.map((r) => ({ ...r, family: members.filter((m) => m.customerId === r.id) })) };
}
