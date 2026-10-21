// P-15 Create or edit a customer; P-19 Deactivate or reactivate; personal data (PAN, Aadhaar), default
// nominee and family links. Every list is filtered by the account (GR-20); edits never change quotation
// or policy snapshots (GR-23).
import type { Request } from 'express';
import { and, asc, desc, eq, ilike, inArray, ne, or, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.js';
import { auditLog, consentHistory, consents, customerLinks, customers, familyMembers, insuranceTypes, leads, users } from '../../db/schema.js';
import { clock, istToday } from '../../lib/clock.js';
import { blindIndex, encryptField, tryDecryptField } from '../../lib/crypto.js';
import { AppError, fieldError, fieldErrors, forbidden, notFound, stateConflict, versionConflict, type FieldError } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import { maskAadhaar, maskMobile, maskPan } from '../../lib/mask.js';
import { msg } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { settings } from '../settings/settings.service.js';
import { isUnique, isUuid, nextNumber, normName, overrides, readVersion } from '../clients/common.js';
import { cancelQueuedMessages, openItemsFor } from '../clients/hooks.js';

type Customer = typeof customers.$inferSelect;
export const GENDERS = ['MALE', 'FEMALE', 'TRANSGENDER', 'PREFER_NOT_TO_SAY'] as const;
export const PREFERRED = ['WHATSAPP', 'PHONE', 'EMAIL'] as const;
export const LINK_RELATIONS = ['Spouse', 'Parent', 'Child', 'Sibling', 'Other'] as const;
export const DEACTIVATE_REASONS = ['Moved to another advisor', 'Not reachable', 'Deceased', 'Duplicate record', 'Other'] as const;

export type CustomerData = {
  fullName: string;
  dateOfBirth: string | null;
  gender: string | null;
  mobile: string;
  altMobile: string | null;
  email: string | null;
  preferredContact: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  pinCode: string | null;
  anniversary: string | null;
  occupation: string | null;
  notes: string | null;
};
export type CustomerOrigin = { source: string; leadId?: string | null; referrerUserId?: string | null; referredByCustomerId?: string | null; campaign?: string | null };

/** Parse the customer form (FLD rules). Alternate mobile must differ from the primary (LD-09). */
export function parseCustomer(body: unknown): CustomerData {
  const errors: FieldError[] = [];
  let v: Record<string, unknown> = {};
  try {
    v = F.parseFields(body, {
      fullName: { label: 'Full name', required: true, rule: F.personName },
      dateOfBirth: { label: 'Date of birth', rule: F.dateOfBirth },
      gender: { label: 'Gender', oneOf: GENDERS },
      mobile: { label: 'Primary mobile', required: true, rule: F.mobile },
      altMobile: { label: 'Alternate mobile', rule: F.mobile },
      email: { label: 'Email', rule: F.email },
      preferredContact: { label: 'Preferred contact', oneOf: PREFERRED },
      addressLine1: { label: 'Address line 1', rule: F.addressLine },
      addressLine2: { label: 'Address line 2', rule: F.addressLine },
      city: { label: 'City', rule: F.city },
      state: { label: 'State', rule: F.indianState },
      pinCode: { label: 'PIN code', rule: F.pinCode },
      anniversary: { label: 'Wedding anniversary', rule: F.pastOrToday },
      occupation: { label: 'Occupation', rule: F.shortText },
      notes: { label: 'Notes', rule: F.notes },
    });
  } catch (err) {
    if (err instanceof AppError) errors.push(...err.fields);
    else throw err;
  }
  if (v.mobile && v.altMobile && v.mobile === v.altMobile) errors.push({ field: 'altMobile', code: 'LD-09' });
  if (errors.length) throw fieldErrors(errors);
  const s = (k: string) => (v[k] as string | undefined) ?? null;
  return {
    fullName: v.fullName as string,
    dateOfBirth: s('dateOfBirth'),
    gender: s('gender'),
    mobile: v.mobile as string,
    altMobile: s('altMobile'),
    email: s('email'),
    preferredContact: s('preferredContact'),
    addressLine1: s('addressLine1'),
    addressLine2: s('addressLine2'),
    city: s('city'),
    state: s('state'),
    pinCode: s('pinCode'),
    anniversary: s('anniversary'),
    occupation: s('occupation'),
    notes: s('notes'),
  };
}

/** Duplicate rule (Section 7): exact = same mobile and name among ACTIVE customers; possible = same mobile. */
export async function customerDuplicates(dbx: DbOrTx, accountId: string, mobile: string, name: string, exceptId?: string | null) {
  const rows = await dbx
    .select({ id: customers.id, number: customers.number, fullName: customers.fullName, nameNorm: customers.nameNorm })
    .from(customers)
    .where(and(eq(customers.accountId, accountId), eq(customers.mobile, mobile), eq(customers.status, 'ACTIVE'), exceptId ? ne(customers.id, exceptId) : sql`true`));
  const n = normName(name);
  const exact = rows.find((r) => r.nameNorm === n) ?? null;
  const possible = rows.filter((r) => r.nameNorm !== n);
  return { exact, possible };
}

export async function checkCustomerDuplicate(auth: AuthContext, q: { mobile?: string; name?: string; exceptId?: string }) {
  const m = F.mobile(q.mobile ?? '');
  if (!m.ok) return { exact: null, possible: [], messages: [] };
  const d = await customerDuplicates(db, auth.accountId!, m.value, q.name ?? '', isUuid(q.exceptId) ? q.exceptId : null);
  const messages = [
    ...(d.exact && q.name ? [msg('CU-02', { 'customer number': d.exact.number })] : []),
    ...d.possible.map((p) => msg('CU-03', { name: p.fullName, 'customer number': p.number })),
  ];
  return { exact: d.exact, possible: d.possible, messages };
}

const age = (dob: string | null) => {
  if (!dob) return null;
  const t = istToday();
  let a = Number(t.slice(0, 4)) - Number(dob.slice(0, 4));
  if (t.slice(5) < dob.slice(5)) a -= 1;
  return a;
};

export async function customerView(c: Customer, auth: AuthContext) {
  const [lead] = c.leadId ? await db.select({ id: leads.id, number: leads.number }).from(leads).where(eq(leads.id, c.leadId)) : [];
  const [ref] = c.referrerUserId ? await db.select({ name: users.name }).from(users).where(eq(users.id, c.referrerUserId)) : [];
  const [byCust] = c.referredByCustomerId ? await db.select({ id: customers.id, number: customers.number, fullName: customers.fullName }).from(customers).where(eq(customers.id, c.referredByCustomerId)) : [];
  const [pd] = await db
    .select({ status: consents.status })
    .from(consents)
    .where(and(eq(consents.customerId, c.id), sql`${consents.familyMemberId} is null`, eq(consents.channel, 'PERSONAL_DATA')));
  return {
    id: c.id,
    number: c.number,
    fullName: c.fullName,
    dateOfBirth: c.dateOfBirth,
    age: age(c.dateOfBirth),
    gender: c.gender,
    mobile: c.mobile,
    altMobile: c.altMobile,
    email: c.email,
    preferredContact: c.preferredContact,
    addressLine1: c.addressLine1,
    addressLine2: c.addressLine2,
    city: c.city,
    state: c.state,
    pinCode: c.pinCode,
    anniversary: c.anniversary,
    occupation: c.occupation,
    notes: c.notes,
    source: c.source,
    lead: lead ?? null,
    referrerName: ref?.name ?? null,
    referredByCustomer: byCust ?? null,
    campaign: c.campaign,
    // Masked everywhere; the full number only through Show full number (advisor, logged)
    panMasked: c.panMasked,
    aadhaarMasked: c.aadhaarMasked,
    personalDataConsent: pd?.status ?? 'NOT_RECORDED',
    canReveal: auth.role === 'ADV',
    defaultNominee: c.defaultNominee,
    status: c.status,
    inactiveReason: c.inactiveReason,
    createdAt: c.createdAt,
    version: c.version,
  };
}

export async function loadCustomer(dbx: DbOrTx, accountId: string, id: string, lock = false): Promise<Customer> {
  if (!isUuid(id)) throw notFound();
  const q = dbx.select().from(customers).where(and(eq(customers.id, id), eq(customers.accountId, accountId)));
  const [c] = lock ? await q.for('update') : await q;
  if (!c) throw notFound(); // another account's customer never exists for this caller (GR-18)
  return c;
}

export function assertActive(c: Customer) {
  if (c.status !== 'ACTIVE') throw new AppError(409, 'CU-20', { Customer: c.fullName });
}

/** Create a customer inside a transaction (also used by lead conversion, P-14). */
export async function insertCustomer(tx: DbOrTx, req: Request, auth: AuthContext, d: CustomerData, origin: CustomerOrigin, saveAnyway: boolean) {
  const dup = await customerDuplicates(tx, auth.accountId!, d.mobile, d.fullName);
  if (dup.exact) throw fieldError('mobile', 'CU-02', { 'customer number': dup.exact.number });
  if (dup.possible.length && !saveAnyway) {
    const p = dup.possible[0]!;
    throw new AppError(409, 'CU-03', { name: p.fullName, 'customer number': p.number }, [], { reason: 'possible_duplicate', possible: dup.possible });
  }
  const number = await nextNumber(tx, auth.accountId!, 'CU');
  const now = clock.now();
  const [c] = await tx
    .insert(customers)
    .values({
      accountId: auth.accountId!,
      number,
      ...d,
      nameNorm: normName(d.fullName),
      source: origin.source,
      leadId: origin.leadId ?? null,
      referrerUserId: origin.referrerUserId ?? null,
      referredByCustomerId: origin.referredByCustomerId ?? null,
      campaign: origin.campaign ?? null,
      createdBy: auth.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  await audit(tx, req, { action: 'CUSTOMER_CREATED', entity: 'customer', entityId: c!.id, newValue: { number, name: d.fullName, mobile: maskMobile(d.mobile), source: origin.source } });
  return c!;
}

export async function createCustomer(req: Request, auth: AuthContext, body: unknown) {
  const d = parseCustomer(body);
  try {
    const c = await db.transaction((tx) => insertCustomer(tx, req, auth, d, { source: 'Direct' }, overrides(body)));
    return { customer: await customerView(c, auth), message: msg('CU-01', { 'customer number': c.number }) };
  } catch (err) {
    if (isUnique(err, 'customers_active_exact')) {
      const dup = await customerDuplicates(db, auth.accountId!, d.mobile, d.fullName);
      throw fieldError('mobile', 'CU-02', { 'customer number': dup.exact?.number ?? '' });
    }
    throw err;
  }
}

/**
 * Edit (same rules). Changing the primary mobile asks CU-21 first (WhatsApp and SMS consent belong to the
 * number); changing the email asks CU-22. Confirmed: those consents become NOT_RECORDED and QUEUED
 * messages to the old number or address are cancelled.
 */
export async function editCustomer(req: Request, auth: AuthContext, id: string, body: unknown) {
  const d = parseCustomer(body);
  const version = readVersion(body);
  const b = (body ?? {}) as Record<string, unknown>;
  try {
    return await db.transaction(async (tx) => {
      const c = await loadCustomer(tx, auth.accountId!, id, true);
      assertActive(c);
      if (c.version !== version) throw versionConflict('customer', Object.keys(d).filter((k) => (c as Record<string, unknown>)[k] !== (d as Record<string, unknown>)[k]));
      const mobileChanged = c.mobile !== d.mobile;
      const emailChanged = (c.email ?? null) !== d.email;
      const given = await tx.select().from(consents).where(and(eq(consents.customerId, c.id), sql`${consents.familyMemberId} is null`, eq(consents.status, 'GIVEN')));
      const phoneConsent = given.filter((g) => g.channel === 'WHATSAPP' || g.channel === 'SMS');
      const emailConsent = given.filter((g) => g.channel === 'EMAIL');
      if (mobileChanged && phoneConsent.length && b.confirmMobileChange !== true) throw new AppError(409, 'CU-21', {}, [], { reason: 'confirm', confirmField: 'confirmMobileChange' });
      if (emailChanged && emailConsent.length && b.confirmEmailChange !== true) throw new AppError(409, 'CU-22', {}, [], { reason: 'confirm', confirmField: 'confirmEmailChange' });
      if (mobileChanged || normName(d.fullName) !== c.nameNorm) {
        const dup = await customerDuplicates(tx, auth.accountId!, d.mobile, d.fullName, c.id);
        if (dup.exact) throw fieldError('mobile', 'CU-02', { 'customer number': dup.exact.number });
        if (dup.possible.length && !overrides(body)) {
          const p = dup.possible[0]!;
          throw new AppError(409, 'CU-03', { name: p.fullName, 'customer number': p.number }, [], { reason: 'possible_duplicate', possible: dup.possible });
        }
      }
      const now = clock.now();
      const reset = [...(mobileChanged ? phoneConsent : []), ...(emailChanged ? emailConsent : [])];
      for (const r of reset) {
        await tx.update(consents).set({ status: 'NOT_RECORDED', changedBy: auth.userId, changedAt: now, version: r.version + 1 }).where(eq(consents.id, r.id));
        await tx.insert(consentHistory).values({ consentId: r.id, accountId: c.accountId, fromStatus: r.status, toStatus: 'NOT_RECORDED', address: r.address, how: 'Contact detail changed', byUserId: auth.userId, source: 'ADVISOR', at: now });
        await cancelQueuedMessages(tx, { accountId: c.accountId, customerId: c.id, channel: r.channel, address: r.address ?? undefined });
      }
      const [n] = await tx
        .update(customers)
        .set({ ...d, nameNorm: normName(d.fullName), updatedAt: now, version: c.version + 1 })
        .where(eq(customers.id, c.id))
        .returning();
      await audit(tx, req, {
        action: 'CUSTOMER_EDITED',
        entity: 'customer',
        entityId: c.id,
        oldValue: { name: c.fullName, mobile: maskMobile(c.mobile) },
        newValue: { name: d.fullName, mobile: maskMobile(d.mobile), consentReset: reset.map((r) => r.channel) },
      });
      return { customer: await customerView(n!, auth), message: msg('GEN-08', { 'Record type': 'Customer' }) };
    });
  } catch (err) {
    if (isUnique(err, 'customers_active_exact')) throw fieldError('mobile', 'CU-02', { 'customer number': '' });
    throw err;
  }
}

export async function listCustomers(auth: AuthContext, f: { q?: string; status?: string; page?: number }) {
  const size = settings.get('CFG-23');
  const page = Math.max(1, f.page ?? 1);
  const term = f.q?.trim();
  const digits = term?.replace(/\D/g, '') ?? '';
  const where = and(
    eq(customers.accountId, auth.accountId!),
    f.status === 'ACTIVE' || f.status === 'INACTIVE' ? eq(customers.status, f.status) : sql`true`,
    term
      ? or(
          ilike(customers.fullName, `%${term.replace(/[%_\\]/g, '')}%`),
          ilike(customers.number, `%${term.replace(/[%_\\]/g, '')}%`),
          ilike(customers.email, `%${term.replace(/[%_\\]/g, '')}%`),
          digits.length >= settings.get('CFG-132') ? ilike(customers.mobile, `%${digits}%`) : sql`false`,
        )
      : sql`true`,
  );
  const rows = await db.select().from(customers).where(where).orderBy(asc(customers.fullName)).limit(size).offset((page - 1) * size);
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(customers).where(where);
  return {
    items: rows.map((c) => ({ id: c.id, number: c.number, fullName: c.fullName, mobile: c.mobile, city: c.city, age: age(c.dateOfBirth), status: c.status, source: c.source })),
    total: n,
    page,
    pageSize: size,
  };
}

export async function getCustomer(auth: AuthContext, id: string) {
  return customerView(await loadCustomer(db, auth.accountId!, id), auth);
}

/** Activities tab: every recorded change about this customer, newest first. */
export async function customerActivity(auth: AuthContext, id: string) {
  const c = await loadCustomer(db, auth.accountId!, id);
  const rows = await db
    .select({ at: auditLog.at, action: auditLog.action, newValue: auditLog.newValue, actorUserId: auditLog.actorUserId })
    .from(auditLog)
    .where(and(eq(auditLog.accountId, auth.accountId!), eq(auditLog.entity, 'customer'), eq(auditLog.entityId, c.id), eq(auditLog.result, 'SUCCESS')))
    .orderBy(desc(auditLog.at))
    .limit(200);
  const ids = [...new Set(rows.map((r) => r.actorUserId).filter((x): x is string => !!x))];
  const names = ids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : [];
  return {
    items: rows.map((r) => ({ at: r.at, action: r.action, text: ACTIVITY_TEXT[r.action] ?? r.action, detail: detailOf(r.newValue), by: names.find((n) => n.id === r.actorUserId)?.name ?? (r.actorUserId ? null : 'System') })),
  };
}
const ACTIVITY_TEXT: Record<string, string> = {
  CUSTOMER_CREATED: 'Customer created',
  CUSTOMER_EDITED: 'Details edited',
  CUSTOMER_DEACTIVATED: 'Deactivated',
  CUSTOMER_REACTIVATED: 'Reactivated',
  IDENTITY_SAVED: 'PAN or Aadhaar saved',
  PERSONAL_DATA_VIEWED: 'Full PAN or Aadhaar viewed',
  DEFAULT_NOMINEE_SAVED: 'Default nominee saved',
  CUSTOMER_LINKED: 'Family link added',
  FAMILY_ADDED: 'Family member added',
  FAMILY_EDITED: 'Family member edited',
  FAMILY_DEACTIVATED: 'Family member deactivated',
  FAMILY_ACTIVATED: 'Family member activated',
  CONSENT_GIVEN: 'Consent recorded',
  CONSENT_WITHDRAWN: 'Consent withdrawn',
  DOCUMENT_UPLOADED: 'Document uploaded',
  DOCUMENT_CONFIRMED: 'Document checked',
  DOCUMENT_LABEL_CHANGED: 'Document label changed',
  VEHICLE_ADDED: 'Vehicle added',
  VEHICLE_SOLD: 'Vehicle marked as sold',
  VEHICLE_PHOTO_ADDED: 'Vehicle photo added',
  LEAD_CONVERTED: 'Converted from a lead',
};
function detailOf(v: unknown): string | null {
  const o = (v ?? {}) as Record<string, unknown>;
  for (const k of ['name', 'label', 'channel', 'registration', 'number', 'reason']) if (typeof o[k] === 'string') return o[k];
  return null;
}

// ---------- PAN and Aadhaar (P-15 personal data) ----------

async function personalDataConsent(dbx: DbOrTx, customerId: string) {
  const [pd] = await dbx
    .select({ status: consents.status })
    .from(consents)
    .where(and(eq(consents.customerId, customerId), sql`${consents.familyMemberId} is null`, eq(consents.channel, 'PERSONAL_DATA')));
  return pd?.status ?? 'NOT_RECORDED';
}

/** PAN and Aadhaar need personal-data consent first (CU-23, CU-30); stored encrypted, shown masked. */
export async function assertPersonalDataAllowed(dbx: DbOrTx, c: Customer) {
  const s = await personalDataConsent(dbx, c.id);
  if (s === 'WITHDRAWN') throw new AppError(409, 'CU-30', { Customer: c.fullName });
  if (s !== 'GIVEN') throw new AppError(409, 'CU-23', { customer: c.fullName });
}

export async function setIdentity(dbx: DbOrTx, req: Request, c: Customer, input: { pan?: string | null; aadhaar?: string | null }, saveAnyway: boolean) {
  await assertPersonalDataAllowed(dbx, c);
  const set: Partial<Customer> = {};
  if (input.pan) {
    const idx = blindIndex('pan', input.pan);
    const [other] = await dbx
      .select({ number: customers.number })
      .from(customers)
      .where(and(eq(customers.accountId, c.accountId), eq(customers.panIndex, idx), eq(customers.status, 'ACTIVE'), ne(customers.id, c.id)));
    if (other && !saveAnyway) throw new AppError(409, 'CU-29', { 'customer number': other.number }, [], { reason: 'possible_duplicate' });
    Object.assign(set, { panEnc: encryptField(input.pan), panIndex: idx, panMasked: maskPan(input.pan) });
  }
  if (input.aadhaar) Object.assign(set, { aadhaarEnc: encryptField(input.aadhaar), aadhaarMasked: maskAadhaar(input.aadhaar) });
  if (!Object.keys(set).length) return c;
  const [n] = await dbx.update(customers).set({ ...set, updatedAt: clock.now(), version: c.version + 1 }).where(eq(customers.id, c.id)).returning();
  await audit(dbx, req, { action: 'IDENTITY_SAVED', entity: 'customer', entityId: c.id, newValue: { pan: set.panMasked ?? undefined, aadhaar: set.aadhaarMasked ?? undefined } });
  return n!;
}

export async function saveIdentity(req: Request, auth: AuthContext, id: string, body: unknown) {
  const v = F.parseFields(body, { pan: { label: 'PAN', rule: F.pan }, aadhaar: { label: 'Aadhaar number', rule: F.aadhaar } }) as { pan?: string; aadhaar?: string };
  const version = readVersion(body);
  return db.transaction(async (tx) => {
    const c = await loadCustomer(tx, auth.accountId!, id, true);
    assertActive(c);
    if (c.version !== version) throw versionConflict('customer', ['pan', 'aadhaar']);
    const n = await setIdentity(tx, req, c, v, overrides(body));
    return { customer: await customerView(n, auth), message: msg('GEN-08', { 'Record type': 'Customer' }) };
  });
}

/** Show full number: advisor only, for CFG-176 seconds; every reveal is logged (CU-25). */
export async function revealIdentity(req: Request, auth: AuthContext, id: string, field: unknown) {
  if (auth.role !== 'ADV') throw forbidden(); // assistants never see the full value (AC-P15-8)
  if (field !== 'pan' && field !== 'aadhaar') throw fieldError('field', 'VAL-22');
  const c = await loadCustomer(db, auth.accountId!, id);
  const enc = field === 'pan' ? c.panEnc : c.aadhaarEnc;
  if (!enc) throw notFound();
  const seconds = settings.get('CFG-176');
  await audit(db, req, { action: 'PERSONAL_DATA_VIEWED', entity: 'customer', entityId: c.id, newValue: { field } });
  // Saved with a key this server no longer has (old .env lost): ask for the number again instead of failing
  const value = tryDecryptField(enc);
  if (value === null) throw new AppError(409, 'GEN-99');
  return { value, seconds, message: msg('CU-25', { 'CFG-176': seconds }) };
}

// ---------- default nominee and family links ----------

/** Default nominee: only pre-fills new proposals (P-55); never changes a policy (CU-28). */
export async function saveDefaultNominee(req: Request, auth: AuthContext, id: string, body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const version = readVersion(body);
  return db.transaction(async (tx) => {
    const c = await loadCustomer(tx, auth.accountId!, id, true);
    assertActive(c);
    if (c.version !== version) throw versionConflict('customer', ['defaultNominee']);
    let name: string;
    let relationship: string;
    let familyMemberId: string | null = null;
    if (isUuid(b.familyMemberId)) {
      const [m] = await tx.select().from(familyMembers).where(and(eq(familyMembers.id, b.familyMemberId), eq(familyMembers.customerId, c.id), eq(familyMembers.status, 'ACTIVE')));
      if (!m) throw fieldError('familyMemberId', 'VAL-22');
      name = m.fullName;
      relationship = m.relationship;
      familyMemberId = m.id;
    } else {
      const v = F.parseFields(body, {
        name: { label: 'Nominee name', required: true, rule: F.personName },
        relationship: { label: 'Relationship', required: true, oneOf: settings.get('CFG-36') },
      }) as { name: string; relationship: string };
      name = v.name;
      relationship = v.relationship;
    }
    const share = F.parseFields(body, { sharePercent: { label: 'Share %', required: true, rule: F.percentage } }) as { sharePercent: string };
    if (Number(share.sharePercent) <= 0) throw fieldError('sharePercent', 'VAL-10', { min: '0.01', max: '100' });
    const nominee = { familyMemberId, name, relationship, sharePercent: share.sharePercent };
    const [n] = await tx.update(customers).set({ defaultNominee: nominee, updatedAt: clock.now(), version: c.version + 1 }).where(eq(customers.id, c.id)).returning();
    await audit(tx, req, { action: 'DEFAULT_NOMINEE_SAVED', entity: 'customer', entityId: c.id, newValue: { name, relationship } });
    return { customer: await customerView(n!, auth), message: msg('CU-28') };
  });
}

export async function addLink(req: Request, auth: AuthContext, id: string, body: unknown) {
  const v = F.parseFields(body, {
    linkedCustomerId: { label: 'Customer', required: true },
    relation: { label: 'Relation', required: true, oneOf: LINK_RELATIONS },
  }) as { linkedCustomerId: string; relation: string };
  return db.transaction(async (tx) => {
    const c = await loadCustomer(tx, auth.accountId!, id, true);
    assertActive(c);
    if (!isUuid(v.linkedCustomerId) || v.linkedCustomerId === c.id) throw fieldError('linkedCustomerId', 'VAL-22');
    const other = await loadCustomer(tx, auth.accountId!, v.linkedCustomerId).catch(() => null);
    if (!other) throw fieldError('linkedCustomerId', 'VAL-22');
    const [exists] = await tx
      .select()
      .from(customerLinks)
      .where(or(and(eq(customerLinks.customerId, c.id), eq(customerLinks.linkedCustomerId, other.id)), and(eq(customerLinks.customerId, other.id), eq(customerLinks.linkedCustomerId, c.id))));
    if (exists) throw new AppError(409, 'CU-26', { Name: other.fullName, relation: exists.relation.toLowerCase() });
    await tx.insert(customerLinks).values({ accountId: c.accountId, customerId: c.id, linkedCustomerId: other.id, relation: v.relation, createdBy: auth.userId, createdAt: clock.now() });
    await audit(tx, req, { action: 'CUSTOMER_LINKED', entity: 'customer', entityId: c.id, newValue: { name: other.fullName, relation: v.relation } });
    return { message: msg('CU-27', { Name: other.fullName, relation: v.relation.toLowerCase() }) };
  });
}

const INVERSE: Record<string, string> = { Parent: 'Child', Child: 'Parent', Spouse: 'Spouse', Sibling: 'Sibling', Other: 'Other' };

export async function listLinks(auth: AuthContext, id: string) {
  const c = await loadCustomer(db, auth.accountId!, id);
  const rows = await db.select().from(customerLinks).where(or(eq(customerLinks.customerId, c.id), eq(customerLinks.linkedCustomerId, c.id)));
  const ids = rows.map((r) => (r.customerId === c.id ? r.linkedCustomerId : r.customerId));
  const people = ids.length ? await db.select({ id: customers.id, number: customers.number, fullName: customers.fullName, status: customers.status }).from(customers).where(inArray(customers.id, ids)) : [];
  return {
    items: rows.map((r) => {
      const otherId = r.customerId === c.id ? r.linkedCustomerId : r.customerId;
      const p = people.find((x) => x.id === otherId)!;
      return { id: r.id, customer: p, relation: r.customerId === c.id ? r.relation : (INVERSE[r.relation] ?? r.relation) };
    }),
  };
}

/**
 * Cover map (read only): for the customer, household members and linked customers, which insurance types
 * each holds through ISSUED policies and which are missing. Policies arrive in Phase 5; until then every
 * active type shows as missing.
 */
export async function coverMap(auth: AuthContext, id: string) {
  const c = await loadCustomer(db, auth.accountId!, id);
  const types = await db.select({ id: insuranceTypes.id, name: insuranceTypes.name }).from(insuranceTypes).where(eq(insuranceTypes.status, 'ACTIVE')).orderBy(asc(insuranceTypes.position));
  const members = await db.select({ id: familyMembers.id, fullName: familyMembers.fullName, relationship: familyMembers.relationship }).from(familyMembers).where(and(eq(familyMembers.customerId, c.id), eq(familyMembers.status, 'ACTIVE')));
  const links = (await listLinks(auth, id)).items;
  const held = await heldTypes(auth.accountId!, [c.id, ...links.map((l) => l.customer.id)], members.map((m) => m.id));
  const person = (key: string, name: string, relation: string, kind: 'CUSTOMER' | 'FAMILY' | 'LINKED') => {
    const h = held.get(key) ?? new Set<string>();
    return { key, name, relation, kind, held: types.filter((t) => h.has(t.id)), missing: types.filter((t) => !h.has(t.id)) };
  };
  return {
    people: [
      person(c.id, c.fullName, 'Customer', 'CUSTOMER'),
      ...members.map((m) => person(m.id, m.fullName, m.relationship, 'FAMILY')),
      ...links.map((l) => person(l.customer.id, l.customer.fullName, l.relation, 'LINKED')),
    ],
  };
}

type HeldFn = (accountId: string, customerIds: string[], memberIds: string[]) => Promise<Map<string, Set<string>>>;
let heldTypes: HeldFn = () => Promise.resolve(new Map<string, Set<string>>());
/** The policy module (Phase 5) tells the cover map which types each person holds. */
export const registerHeldTypes = (fn: HeldFn) => {
  heldTypes = fn;
};

// ---------- P-19 deactivate / reactivate ----------

export async function deactivateCustomer(req: Request, auth: AuthContext, id: string, body: unknown) {
  if (auth.role !== 'ADV') throw forbidden();
  const v = F.parseFields(body, { reason: { label: 'Reason', required: true, oneOf: DEACTIVATE_REASONS }, note: { label: 'Note', rule: F.notes } }) as { reason: string; note?: string };
  if (v.reason === 'Other' && !v.note) throw fieldError('note', 'GEN-01', { 'Field label': 'Note' });
  const version = readVersion(body);
  return db.transaction(async (tx) => {
    const c = await loadCustomer(tx, auth.accountId!, id, true);
    if (c.status !== 'ACTIVE') throw stateConflict('customer', c.status);
    if (c.version !== version) throw versionConflict('customer', ['status']);
    // Open items created in another tab are caught here too (CU-08)
    const open = await openItemsFor(tx, c.accountId, c.id);
    if (open.length) throw new AppError(409, 'CU-08', { list: open.map((o) => `${o.type} ${o.number}`).join(', ') }, [], { items: open });
    const [n] = await tx.update(customers).set({ status: 'INACTIVE', inactiveReason: v.reason, inactiveNote: v.note ?? null, updatedAt: clock.now(), version: c.version + 1 }).where(eq(customers.id, c.id)).returning();
    // One transaction: queued messages to the customer and family are cancelled, greetings stop
    await cancelQueuedMessages(tx, { accountId: c.accountId, customerId: c.id });
    await audit(tx, req, { action: 'CUSTOMER_DEACTIVATED', entity: 'customer', entityId: c.id, newValue: { reason: v.reason, note: v.note ?? null } });
    return { customer: await customerView(n!, auth), message: msg('CU-09', { Customer: c.fullName }) };
  });
}

export async function reactivateCustomer(req: Request, auth: AuthContext, id: string, body: unknown) {
  if (auth.role !== 'ADV') throw forbidden();
  const version = readVersion(body);
  try {
    return await db.transaction(async (tx) => {
      const c = await loadCustomer(tx, auth.accountId!, id, true);
      if (c.status !== 'INACTIVE') throw stateConflict('customer', c.status);
      if (c.version !== version) throw versionConflict('customer', ['status']);
      const [n] = await tx.update(customers).set({ status: 'ACTIVE', inactiveReason: null, inactiveNote: null, updatedAt: clock.now(), version: c.version + 1 }).where(eq(customers.id, c.id)).returning();
      await audit(tx, req, { action: 'CUSTOMER_REACTIVATED', entity: 'customer', entityId: c.id });
      return { customer: await customerView(n!, auth), message: msg('CU-10', { Customer: c.fullName }) };
    });
  } catch (err) {
    // An ACTIVE customer with the same name and mobile was added meanwhile
    if (isUnique(err, 'customers_active_exact')) throw new AppError(409, 'CU-02', { 'customer number': '' });
    throw err;
  }
}

export function customerOptions() {
  return {
    genders: GENDERS,
    preferredContact: PREFERRED,
    states: F.INDIAN_STATES,
    relationships: settings.get('CFG-36'),
    linkRelations: LINK_RELATIONS,
    deactivateReasons: DEACTIVATE_REASONS,
    maxFamily: settings.get('CFG-35'),
    revealSeconds: settings.get('CFG-176'),
  };
}
