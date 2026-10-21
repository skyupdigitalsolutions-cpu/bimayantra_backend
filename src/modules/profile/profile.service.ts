// P-05 Complete the advisor profile (progressive). Each section saves on its own; the completion % is
// computed only on the server from saved values and the live weights (CFG-124).
import type { Request } from 'express';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.js';
import { advisorKyc, advisorProfiles, insuranceTypes, insurerMappings, users } from '../../db/schema.js';
import { addDays, clock, formatDate, istToday } from '../../lib/clock.js';
import { AppError, fieldError, notFound, versionConflict } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import { msg } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { ownFile } from '../files/files.service.js';
import { notify } from '../notifications/notifications.service.js';
import { settings } from '../settings/settings.service.js';

export const SECTIONS = ['personal', 'contact', 'professional', 'business'] as const;
export type Section = (typeof SECTIONS)[number];
type Profile = typeof advisorProfiles.$inferSelect;

export const GENDERS = ['MALE', 'FEMALE', 'TRANSGENDER', 'PREFER_NOT_TO_SAY'] as const;
export const ADVISOR_TYPES = ['INDIVIDUAL_AGENT', 'POSP', 'CORPORATE_AGENT_STAFF', 'BROKER_STAFF'] as const;

// Items "required for completion" (P-05 table), with the names shown in PRF-02
type Item = { label: string; done: (p: Profile, x: Extra) => boolean };
type Extra = { kycStatus: string; activeMappings: number };
const filled = (v: unknown) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0);
const ITEMS: Record<'personal' | 'contact' | 'professional' | 'business' | 'kyc' | 'insurers', Item[]> = {
  personal: [
    { label: 'Full name', done: (p) => filled(p.fullName) },
    { label: 'Date of birth', done: (p) => filled(p.dateOfBirth) },
  ],
  contact: [
    { label: 'Email', done: (p) => filled(p.email) },
    { label: 'Address line 1', done: (p) => filled(p.addressLine1) },
    { label: 'City', done: (p) => filled(p.city) },
    { label: 'State', done: (p) => filled(p.state) },
    { label: 'PIN code', done: (p) => filled(p.pinCode) },
  ],
  professional: [
    { label: 'Advisor type', done: (p) => filled(p.advisorType) },
    { label: 'IRDAI licence or POSP certificate number', done: (p) => filled(p.licenceNumber) },
    { label: 'Licence valid until', done: (p) => filled(p.licenceValidUntil) },
    { label: 'Authorised insurance categories', done: (p) => filled(p.authorisedTypeIds) },
  ],
  // The Business section has no required field in P-05; it counts once "Name shown on quotations" is saved
  // (see docs/DOCUMENT-CHANGES.md #18)
  business: [{ label: 'Name shown on quotations', done: (p) => filled(p.businessName) }],
  kyc: [{ label: 'KYC (PAN and documents)', done: (_p, x) => x.kycStatus === 'PENDING_REVIEW' || x.kycStatus === 'VERIFIED' }],
  insurers: [{ label: 'At least one insurer with an agent code', done: (_p, x) => x.activeMappings > 0 }],
};

export type Completion = { percent: number; missing: { section: string; items: string[] }[] };

export function computeCompletion(p: Profile, x: Extra): Completion {
  const weights = settings.get('CFG-124') as Record<keyof typeof ITEMS, number>;
  let total = 0;
  const missing: Completion['missing'] = [];
  for (const [section, items] of Object.entries(ITEMS) as [keyof typeof ITEMS, Item[]][]) {
    const done = items.filter((i) => i.done(p, x)).length;
    total += ((weights[section] ?? 0) * done) / items.length;
    const left = items.filter((i) => !i.done(p, x)).map((i) => i.label);
    if (left.length) missing.push({ section, items: left });
  }
  return { percent: Math.min(100, Math.floor(total + 1e-9)), missing };
}

async function extra(dbx: DbOrTx, accountId: string): Promise<Extra> {
  const [k] = await dbx.select({ status: advisorKyc.status }).from(advisorKyc).where(eq(advisorKyc.accountId, accountId));
  const [{ n } = { n: 0 }] = await dbx
    .select({ n: sql<number>`count(*)::int` })
    .from(insurerMappings)
    .where(and(eq(insurerMappings.accountId, accountId), eq(insurerMappings.status, 'ACTIVE')));
  return { kycStatus: k?.status ?? 'NOT_SUBMITTED', activeMappings: n };
}

/**
 * Recalculate and store the %. A notification is created only when the % reaches a new milestone (CFG-129),
 * never on every save (P-05 step 4).
 */
export async function recalc(dbx: DbOrTx, accountId: string): Promise<Completion> {
  const [p] = await dbx.select().from(advisorProfiles).where(eq(advisorProfiles.accountId, accountId));
  if (!p) throw notFound();
  const c = computeCompletion(p, await extra(dbx, accountId));
  const reached = settings
    .get('CFG-129')
    .filter((m) => c.percent >= m && m > p.lastMilestone)
    .sort((a, b) => b - a)[0];
  await dbx
    .update(advisorProfiles)
    .set({ completionPercent: c.percent, ...(reached ? { lastMilestone: reached } : {}) })
    .where(eq(advisorProfiles.accountId, accountId));
  if (reached) {
    const [adv] = await dbx.select({ id: users.id }).from(users).where(and(eq(users.accountId, accountId), eq(users.role, 'ADV')));
    if (adv) await notify(dbx, { userId: adv.id, accountId, messageId: 'DSH-10', params: { percent: reached }, dedupeKey: `profile-milestone:${reached}`, link: { type: 'PROFILE', id: accountId } });
  }
  return c;
}

const missingText = (c: Completion) => c.missing.flatMap((m) => m.items).join(', ');

export function completionView(c: Completion) {
  return { percent: c.percent, missing: c.missing, message: c.percent < 100 ? msg('PRF-02', { percent: c.percent, 'missing items': missingText(c) }) : null };
}

export async function getProfile(auth: AuthContext) {
  const accountId = auth.accountId!;
  const c = await recalc(db, accountId); // weights may have changed since the last save (P-05 backend rules)
  const [p] = await db.select().from(advisorProfiles).where(eq(advisorProfiles.accountId, accountId));
  const types = await db.select({ id: insuranceTypes.id, name: insuranceTypes.name, status: insuranceTypes.status }).from(insuranceTypes).orderBy(insuranceTypes.position);
  const [k] = await db.select({ status: advisorKyc.status }).from(advisorKyc).where(eq(advisorKyc.accountId, accountId));
  return {
    personal: { fullName: p!.fullName, dateOfBirth: p!.dateOfBirth, gender: p!.gender, photoFileId: p!.photoFileId, version: p!.personalVersion },
    contact: { email: p!.email, altMobile: p!.altMobile, addressLine1: p!.addressLine1, addressLine2: p!.addressLine2, city: p!.city, state: p!.state, pinCode: p!.pinCode, version: p!.contactVersion },
    professional: {
      advisorType: p!.advisorType,
      licenceNumber: p!.licenceNumber,
      licenceValidUntil: p!.licenceValidUntil,
      experienceYears: p!.experienceYears,
      authorisedTypeIds: p!.authorisedTypeIds,
      version: p!.professionalVersion,
    },
    business: { businessName: p!.businessName, logoFileId: p!.logoFileId, gstin: p!.gstin, version: p!.businessVersion, defaultBusinessName: p!.fullName },
    kycStatus: k?.status ?? 'NOT_SUBMITTED',
    licence: licenceState(p!.licenceValidUntil),
    insuranceTypes: types,
    completion: completionView(c),
    options: { genders: GENDERS, advisorTypes: ADVISOR_TYPES, states: F.INDIAN_STATES, maxExperience: settings.get('CFG-151') },
  };
}

/** PRF-16 warning from CFG-152 days before expiry; PRF-17 after expiry (P-05, used by P-27). */
export function licenceState(validUntil: string | null) {
  if (!validUntil) return null;
  const today = istToday();
  if (validUntil < today) return { state: 'EXPIRED' as const, message: msg('PRF-17', { date: formatDate(validUntil) }) };
  if (validUntil <= addDays(today, settings.get('CFG-152'))) return { state: 'EXPIRING' as const, message: msg('PRF-16', { date: formatDate(validUntil) }) };
  return { state: 'VALID' as const, message: null };
}

// ---------- save one section ----------
type Values = Record<string, unknown>;

async function validate(auth: AuthContext, section: Section, body: unknown): Promise<Values> {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  switch (section) {
    case 'personal': {
      const v = F.parseFields(b, {
        fullName: { label: 'Full name', required: true, rule: F.personName },
        dateOfBirth: { label: 'Date of birth', rule: F.dateOfBirth },
        gender: { label: 'Gender', oneOf: GENDERS },
      });
      // CFG-128: the advisor must be at least this old (PRF-14)
      if (typeof v.dateOfBirth === 'string') {
        const [y, m, d] = istToday().split('-').map(Number);
        const youngestDob = `${y! - settings.get('CFG-128')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        if (v.dateOfBirth > youngestDob) throw fieldError('dateOfBirth', 'PRF-14');
      }
      const photo = filled(b.photoFileId) ? (await ownFile(auth, b.photoFileId, ['PROFILE_PHOTO'], 'photoFileId')).id : null;
      return { fullName: v.fullName, dateOfBirth: v.dateOfBirth ?? null, gender: v.gender ?? null, photoFileId: photo };
    }
    case 'contact': {
      const v = F.parseFields(b, {
        email: { label: 'Email', rule: F.email },
        altMobile: { label: 'Alternate mobile', rule: F.mobile },
        addressLine1: { label: 'Address line 1', rule: F.addressLine },
        addressLine2: { label: 'Address line 2', rule: F.addressLine },
        city: { label: 'City', rule: F.city },
        state: { label: 'State', oneOf: F.INDIAN_STATES },
        pinCode: { label: 'PIN code', rule: F.pinCode },
      });
      if (v.altMobile && v.altMobile === auth.mobile) throw fieldError('altMobile', 'AUTH-24');
      return { email: v.email ?? null, altMobile: v.altMobile ?? null, addressLine1: v.addressLine1 ?? null, addressLine2: v.addressLine2 ?? null, city: v.city ?? null, state: v.state ?? null, pinCode: v.pinCode ?? null };
    }
    case 'professional': {
      const v = F.parseFields(b, {
        advisorType: { label: 'Advisor type', oneOf: ADVISOR_TYPES },
        licenceNumber: { label: 'IRDAI licence or POSP certificate number', rule: F.licenceNumber },
        licenceValidUntil: { label: 'Licence valid until', rule: F.futureDate },
        experienceYears: { label: 'Experience in years', rule: F.wholeNumber(0, settings.get('CFG-151')) },
      });
      const ids = Array.isArray(b.authorisedTypeIds) ? b.authorisedTypeIds.filter((x): x is string => typeof x === 'string') : [];
      if (!Array.isArray(b.authorisedTypeIds) && b.authorisedTypeIds !== undefined && b.authorisedTypeIds !== null) throw fieldError('authorisedTypeIds', 'VAL-22');
      if (ids.length) {
        const ok = ids.every((x) => /^[0-9a-f-]{36}$/.test(x))
          ? await db.select({ id: insuranceTypes.id }).from(insuranceTypes).where(and(inArray(insuranceTypes.id, ids), eq(insuranceTypes.status, 'ACTIVE')))
          : [];
        if (ok.length !== new Set(ids).size) throw fieldError('authorisedTypeIds', 'VAL-22'); // FLD-20: must exist and be active
      }
      return { advisorType: v.advisorType ?? null, licenceNumber: v.licenceNumber ?? null, licenceValidUntil: v.licenceValidUntil ?? null, experienceYears: v.experienceYears ?? null, authorisedTypeIds: [...new Set(ids)] };
    }
    case 'business': {
      const v = F.parseFields(b, {
        businessName: { label: 'Name shown on quotations', rule: F.shortText },
        gstin: { label: 'GSTIN', rule: F.gstin },
      });
      const logo = filled(b.logoFileId) ? (await ownFile(auth, b.logoFileId, ['BUSINESS_LOGO'], 'logoFileId')).id : null;
      return { businessName: v.businessName ?? null, gstin: v.gstin ?? null, logoFileId: logo };
    }
  }
}

const versionCol = {
  personal: advisorProfiles.personalVersion,
  contact: advisorProfiles.contactVersion,
  professional: advisorProfiles.professionalVersion,
  business: advisorProfiles.businessVersion,
} as const;
const versionKey = { personal: 'personalVersion', contact: 'contactVersion', professional: 'professionalVersion', business: 'businessVersion' } as const;

export async function saveSection(req: Request, auth: AuthContext, section: Section, body: unknown) {
  const values = await validate(auth, section, body);
  const version = Number((body as { version?: unknown } | null)?.version);
  if (!Number.isInteger(version)) throw fieldError('version', 'GEN-01', { 'Field label': 'Version' });
  const accountId = auth.accountId!;
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(advisorProfiles).where(eq(advisorProfiles.accountId, accountId)).for('update');
    if (!before) throw notFound();
    if (before[versionKey[section]] !== version) {
      // GR-11: refuse, and say which fields someone else changed
      const changed = Object.keys(values).filter((k) => JSON.stringify((before as Record<string, unknown>)[k] ?? null) !== JSON.stringify(values[k] ?? null));
      throw versionConflict('profile', changed);
    }
    await tx
      .update(advisorProfiles)
      .set({ ...values, [versionKey[section]]: sql`${versionCol[section]} + 1`, updatedAt: clock.now() })
      .where(eq(advisorProfiles.accountId, accountId));
    const oldValues = Object.fromEntries(Object.keys(values).map((k) => [k, (before as Record<string, unknown>)[k] ?? null]));
    await audit(tx, req, { action: 'PROFILE_SECTION_SAVED', entity: 'advisor_profile', entityId: accountId, oldValue: { section, ...oldValues }, newValue: { section, ...values } });
    // The name shown on screens follows the profile's full name
    if (section === 'personal') await tx.update(users).set({ name: values.fullName as string }).where(eq(users.id, auth.userId));
    const c = await recalc(tx, accountId);
    return { section, version: version + 1, completion: completionView(c), message: msg('PRF-01', { percent: c.percent }) };
  });
}

/** P-05 "What needs which profile items" for sharing a quotation (P-28): PRF-13 or PRF-03 with the list. */
export async function sharingBlock(accountId: string): Promise<AppError | null> {
  const [p] = await db.select().from(advisorProfiles).where(eq(advisorProfiles.accountId, accountId));
  const [k] = await db.select({ status: advisorKyc.status }).from(advisorKyc).where(eq(advisorKyc.accountId, accountId));
  if (!p) return null;
  if (p.licenceValidUntil && p.licenceValidUntil < istToday()) return new AppError(403, 'PRF-13');
  const missing: string[] = [];
  if (!p.email) missing.push('Email');
  if (!p.licenceNumber) missing.push('IRDAI licence or POSP certificate number');
  if (settings.get('CFG-100') && k?.status !== 'VERIFIED') missing.push('Verified KYC');
  return missing.length ? new AppError(403, 'PRF-03', { 'missing items': missing.join(', ') }) : null;
}
