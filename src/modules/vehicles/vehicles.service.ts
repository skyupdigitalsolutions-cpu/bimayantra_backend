// P-54 A client's vehicles. Each has its own RC (document type Vehicle RC, versions kept) and at least
// CFG-154 photos, one per slot (CFG-155). Photos belong to the vehicle, never just to the customer.
// Registration numbers are stored without spaces, in capitals, and are unique in the account.
import type { Request } from 'express';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.js';
import { documentVersions, documents, vehicles } from '../../db/schema.js';
import { clock } from '../../lib/clock.js';
import { AppError, fieldError, fieldErrors, notFound, stateConflict, versionConflict, type FieldError } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import { msg } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { settings } from '../settings/settings.service.js';
import { isUnique, isUuid, readVersion } from '../clients/common.js';
import { assertActive, loadCustomer } from '../customers/customers.service.js';
import { addVersion } from '../documents/documents.service.js';

export const VEHICLE_TYPES = ['PRIVATE_CAR', 'TWO_WHEELER', 'COMMERCIAL'] as const;
export const FUELS = ['PETROL', 'DIESEL', 'CNG', 'ELECTRIC', 'HYBRID'] as const;

function parseVehicle(body: unknown) {
  const year = new Date(clock.now().getTime() + 330 * 60_000).getUTCFullYear();
  return F.parseFields(body, {
    registration: { label: 'Registration number', required: true, rule: F.vehicleRegistration },
    vehicleType: { label: 'Vehicle type', required: true, oneOf: VEHICLE_TYPES },
    make: { label: 'Make', required: true, rule: F.shortText },
    model: { label: 'Model', required: true, rule: F.shortText },
    year: { label: 'Year of manufacture', required: true, rule: F.wholeNumber(settings.get('CFG-181'), year) },
    fuel: { label: 'Fuel', required: true, oneOf: FUELS },
  }) as { registration: string; vehicleType: string; make: string; model: string; year: number; fuel: string };
}

export async function addVehicle(req: Request, auth: AuthContext, customerId: string, body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const errors: FieldError[] = [];
  let v: ReturnType<typeof parseVehicle> | null = null;
  try {
    v = parseVehicle(body);
  } catch (err) {
    if (err instanceof AppError) errors.push(...err.fields);
    else throw err;
  }
  if (!b.rcFileId) errors.push({ field: 'rcFileId', code: 'GEN-01', params: { 'Field label': 'RC (registration certificate)' } });
  const slots = settings.get('CFG-155');
  const photos = (Array.isArray(b.photos) ? b.photos : []) as { slot?: unknown; fileId?: unknown }[];
  const bySlot = new Map<string, unknown>();
  for (const p of photos) {
    if (typeof p.slot !== 'string' || !slots.includes(p.slot)) errors.push({ field: 'photos', code: 'VAL-22' });
    else if (p.fileId) bySlot.set(p.slot, p.fileId);
  }
  // Save stays disabled until at least CFG-154 photos are added (VEH-02)
  if (bySlot.size < settings.get('CFG-154')) errors.push({ field: 'photos', code: 'VEH-02', params: { 'CFG-154': settings.get('CFG-154') } });
  if (errors.length) throw fieldErrors(errors);
  try {
    return await db.transaction(async (tx) => {
      const c = await loadCustomer(tx, auth.accountId!, customerId, true);
      assertActive(c);
      const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(vehicles).where(and(eq(vehicles.customerId, c.id), eq(vehicles.status, 'ACTIVE')));
      if (n >= settings.get('CFG-156')) throw new AppError(409, 'VEH-04', { 'CFG-156': settings.get('CFG-156') });
      const [dup] = await tx.select({ customerId: vehicles.customerId }).from(vehicles).where(and(eq(vehicles.accountId, c.accountId), eq(vehicles.registration, v!.registration)));
      if (dup) {
        const owner = dup.customerId === c.id ? c : await loadCustomer(tx, auth.accountId!, dup.customerId);
        throw fieldError('registration', 'VEH-03', { registration: v!.registration, customer: owner.fullName });
      }
      const [veh] = await tx.insert(vehicles).values({ accountId: c.accountId, customerId: c.id, ...v!, createdBy: auth.userId, createdAt: clock.now() }).returning();
      await addVersion(tx, req, auth, { customer: c, familyMemberId: null, vehicleId: veh!.id, type: 'Vehicle RC', name: v!.registration, fileId: b.rcFileId });
      for (const [slot, fileId] of bySlot) await addVersion(tx, req, auth, { customer: c, familyMemberId: null, vehicleId: veh!.id, type: 'Vehicle photo', name: v!.registration, slot, fileId });
      await audit(tx, req, { action: 'VEHICLE_ADDED', entity: 'customer', entityId: c.id, newValue: { vehicleId: veh!.id, registration: v!.registration } });
      return { vehicle: { id: veh!.id, registration: veh!.registration }, message: msg('VEH-01', { registration: v!.registration, customer: c.fullName }) };
    });
  } catch (err) {
    if (isUnique(err, 'vehicles_registration')) throw fieldError('registration', 'VEH-03', { registration: v!.registration, customer: '' });
    throw err;
  }
}

export async function listVehicles(auth: AuthContext, customerId: string) {
  const c = await loadCustomer(db, auth.accountId!, customerId);
  const rows = await db.select().from(vehicles).where(eq(vehicles.customerId, c.id)).orderBy(asc(vehicles.status), asc(vehicles.registration));
  const ids = rows.map((r) => r.id);
  const docs = ids.length ? await db.select().from(documents).where(inArray(documents.vehicleId, ids)) : [];
  const vers = docs.length ? await db.select().from(documentVersions).where(inArray(documentVersions.documentId, docs.map((d) => d.id))).orderBy(desc(documentVersions.versionNo)) : [];
  return {
    items: rows.map((r) => {
      const mine = docs.filter((d) => d.vehicleId === r.id);
      const latest = (d: (typeof docs)[number]) => vers.find((x) => x.documentId === d.id);
      const rc = mine.find((d) => d.type === 'Vehicle RC');
      return {
        ...r,
        rc: rc ? { documentId: rc.id, fileId: latest(rc)?.fileId ?? null, versions: vers.filter((x) => x.documentId === rc.id).length } : null,
        photos: mine.filter((d) => d.type === 'Vehicle photo').map((d) => ({ slot: d.slot, documentId: d.id, fileId: latest(d)?.fileId ?? null, versions: vers.filter((x) => x.documentId === d.id).length })),
      };
    }),
    slots: settings.get('CFG-155'),
    minPhotos: settings.get('CFG-154'),
    max: settings.get('CFG-156'),
  };
}

async function loadVehicle(tx: DbOrTx, auth: AuthContext, customerId: string, vehicleId: string) {
  if (!isUuid(vehicleId)) throw notFound();
  const [v] = await tx.select().from(vehicles).where(and(eq(vehicles.id, vehicleId), eq(vehicles.customerId, customerId), eq(vehicles.accountId, auth.accountId!))).for('update');
  if (!v) throw notFound();
  return v;
}

/** A newer photo for a slot (or a newer RC) adds a version; older ones stay. */
export async function addVehicleFile(req: Request, auth: AuthContext, customerId: string, vehicleId: string, body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const kind = b.kind === 'RC' ? 'RC' : 'PHOTO';
  const slots = settings.get('CFG-155');
  if (kind === 'PHOTO' && (typeof b.slot !== 'string' || !slots.includes(b.slot))) throw fieldError('slot', 'VAL-22');
  return db.transaction(async (tx) => {
    const c = await loadCustomer(tx, auth.accountId!, customerId, true);
    assertActive(c);
    const v = await loadVehicle(tx, auth, c.id, vehicleId);
    if (v.status !== 'ACTIVE') throw stateConflict('vehicle', v.status);
    const r = await addVersion(tx, req, auth, { customer: c, familyMemberId: null, vehicleId: v.id, type: kind === 'RC' ? 'Vehicle RC' : 'Vehicle photo', name: v.registration, slot: kind === 'RC' ? null : (b.slot as string), fileId: b.fileId });
    await audit(tx, req, { action: 'VEHICLE_PHOTO_ADDED', entity: 'customer', entityId: c.id, newValue: { registration: v.registration, slot: b.slot ?? 'RC', version: r.version.versionNo } });
    return { message: msg('DOC-03', { 'Document type': kind === 'RC' ? 'Vehicle RC' : `Photo (${b.slot as string})`, n: r.version.versionNo }) };
  });
}

/** Mark as sold: INACTIVE; documents and photos stay (AC-P54-4). */
export async function markSold(req: Request, auth: AuthContext, customerId: string, vehicleId: string, body: unknown) {
  const version = readVersion(body);
  return db.transaction(async (tx) => {
    const c = await loadCustomer(tx, auth.accountId!, customerId, true);
    const v = await loadVehicle(tx, auth, c.id, vehicleId);
    if (v.status !== 'ACTIVE') throw stateConflict('vehicle', v.status);
    if (v.version !== version) throw versionConflict('vehicle', ['status']);
    await tx.update(vehicles).set({ status: 'INACTIVE', version: v.version + 1 }).where(eq(vehicles.id, v.id));
    await audit(tx, req, { action: 'VEHICLE_SOLD', entity: 'customer', entityId: c.id, newValue: { registration: v.registration } });
    return { message: msg('GEN-08', { 'Record type': `Vehicle ${v.registration}` }) };
  });
}

/** The customer's ACTIVE vehicles, for a Motor quotation (P-27). */
export async function activeVehicles(accountId: string, customerId: string) {
  return db.select().from(vehicles).where(and(eq(vehicles.accountId, accountId), eq(vehicles.customerId, customerId), eq(vehicles.status, 'ACTIVE')));
}
