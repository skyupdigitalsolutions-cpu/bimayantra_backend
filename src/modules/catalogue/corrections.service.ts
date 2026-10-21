// P-58 Suggest a correction to a verified product. The advisor never edits the shared record; STF reviews,
// and Accept opens a DRAFT version with the value filled in, which then follows P-22 and P-25 (a different
// ADM approves). Every accepted value keeps the correction ID in the version history.
import type { Request } from 'express';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { productCorrections, productVersions, products, templateVersions, users } from '../../db/schema.js';
import { clock } from '../../lib/clock.js';
import { AppError, fieldErrors, notFound, stateConflict, type FieldError } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import { msg } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { ownFile } from '../files/files.service.js';
import { notify, notifyRoles } from '../notifications/notifications.service.js';
import { isUnique, isUuid, readReason, readVersion, scalar } from './common.js';
import { displayValue, FIELD_LABELS, parseFeatureValue, type ProductData } from './productData.js';
import { newDraftFrom } from './products.service.js';
import type { Feature } from './types.service.js';

// Core fields an advisor can point at (files are corrected by attaching the insurer's page instead)
const SIMPLE_TEXT = ['name', 'shortDescription', 'uin', 'sourceLink'] as const;
const SIMPLE_NUMBER = ['adultMinAge', 'adultMaxAge', 'childMinAge', 'childMaxAge', 'maxNominees', 'graceDays'] as const;
const OTHER = ['launchDate', 'sumInsured', 'policyTerms', 'riders', 'taxPercent', 'nomineeRequired'] as const;
const CORE = [...SIMPLE_TEXT, ...SIMPLE_NUMBER, ...OTHER] as const;

async function publishedOf(productId: string) {
  if (!isUuid(productId)) throw notFound();
  const [r] = await db
    .select({ p: products, v: productVersions })
    .from(products)
    .innerJoin(productVersions, eq(productVersions.id, products.publishedVersionId))
    .where(and(eq(products.id, productId), eq(products.kind, 'VERIFIED')));
  if (!r) throw notFound();
  const [t] = await db.select().from(templateVersions).where(eq(templateVersions.id, r.v.templateVersionId));
  return { ...r, features: (t?.features ?? []) as Feature[] };
}

/** Fields the advisor can choose from, with today's published value. */
export async function correctionFields(productId: string) {
  const { v, features } = await publishedOf(productId);
  const d = v.data as ProductData;
  return [
    ...CORE.map((k) => ({ field: k, label: FIELD_LABELS[k]!, current: currentText(d, k, features) })),
    ...features.map((f) => ({ field: `features.${f.key}`, label: f.name, current: displayValue(f, d.features[f.key]) })),
  ];
}

function currentText(d: ProductData, field: string, features: Feature[]): string | null {
  if (field.startsWith('features.')) {
    const f = features.find((x) => `features.${x.key}` === field);
    return f ? displayValue(f, d.features[f.key]) : null;
  }
  const v = (d as Record<string, unknown>)[field];
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return typeof v === 'object' ? JSON.stringify(v) : scalar(v);
}

export async function submitCorrection(req: Request, auth: AuthContext, productId: string, body: unknown) {
  const { p, v, features } = await publishedOf(productId);
  const b = (body ?? {}) as Record<string, unknown>;
  const errors: FieldError[] = [];
  const field = typeof b.field === 'string' ? b.field : '';
  const label = (CORE as readonly string[]).includes(field) ? FIELD_LABELS[field]! : features.find((f) => `features.${f.key}` === field)?.name;
  if (!field) errors.push({ field: 'field', code: 'GEN-01', params: { 'Field label': 'Field' } });
  else if (!label) errors.push({ field: 'field', code: 'VAL-22' });
  let proposed = '';
  if (typeof b.proposedValue !== 'string' || !b.proposedValue.trim()) errors.push({ field: 'proposedValue', code: 'GEN-01', params: { 'Field label': 'Proposed value' } });
  else {
    const r = F.notes(b.proposedValue);
    if (r.ok) proposed = r.value;
    else errors.push({ field: 'proposedValue', code: r.code });
  }
  let reason = '';
  try {
    reason = readReason(body);
  } catch (err) {
    if (err instanceof AppError) errors.push(...err.fields);
    else throw err;
  }
  if (errors.length) throw fieldErrors(errors);
  const file = b.fileId ? await ownFile(auth, b.fileId, ['CORRECTION_EVIDENCE'], 'fileId') : null;
  try {
    return await db.transaction(async (tx) => {
      const [c] = await tx
        .insert(productCorrections)
        .values({
          productId: p.id,
          accountId: auth.accountId!,
          userId: auth.userId,
          field,
          fieldLabel: label!,
          currentValue: currentText(v.data as ProductData, field, features),
          proposedValue: proposed,
          reason,
          fileId: file?.id ?? null,
          createdAt: clock.now(),
        })
        .returning();
      await audit(tx, req, { action: 'CORRECTION_SUBMITTED', entity: 'product_correction', entityId: c!.id, accountId: auth.accountId, newValue: { productId: p.id, field, proposed } });
      await notifyRoles(tx, ['STF'], { messageId: 'CAT-35', dedupeKey: `correction:${c!.id}`, link: { type: 'CORRECTION', id: c!.id } });
      return { id: c!.id, message: msg('CAT-35') };
    });
  } catch (err) {
    // A second open correction for the same field from the same account (CAT-08)
    if (isUnique(err, 'corrections_one_open')) throw new AppError(409, 'CAT-08');
    throw err;
  }
}

export async function myCorrections(auth: AuthContext, productId?: string) {
  const rows = await db
    .select({ c: productCorrections, name: productVersions.name })
    .from(productCorrections)
    .innerJoin(products, eq(products.id, productCorrections.productId))
    .leftJoin(productVersions, eq(productVersions.id, products.publishedVersionId))
    .where(and(eq(productCorrections.accountId, auth.accountId!), isUuid(productId) ? eq(productCorrections.productId, productId) : sql`true`))
    .orderBy(desc(productCorrections.createdAt));
  return rows.map(({ c, name }) => ({
    id: c.id,
    productId: c.productId,
    productName: name,
    field: c.field,
    fieldLabel: c.fieldLabel,
    proposedValue: c.proposedValue,
    reason: c.reason,
    status: c.status,
    rejectReason: c.rejectReason,
    createdAt: c.createdAt,
  }));
}

/** Admin → Approvals → Product corrections. The advisor's account is never shown to other advisors. */
export async function correctionQueue() {
  const rows = await db
    .select({ c: productCorrections, name: productVersions.name, by: users.name })
    .from(productCorrections)
    .innerJoin(products, eq(products.id, productCorrections.productId))
    .leftJoin(productVersions, eq(productVersions.id, products.publishedVersionId))
    .innerJoin(users, eq(users.id, productCorrections.userId))
    .where(eq(productCorrections.status, 'SUBMITTED'))
    .orderBy(asc(productCorrections.createdAt));
  return rows.map(({ c, name, by }) => ({
    id: c.id,
    productId: c.productId,
    productName: name,
    field: c.field,
    fieldLabel: c.fieldLabel,
    currentValue: c.currentValue,
    proposedValue: c.proposedValue,
    reason: c.reason,
    fileId: c.fileId,
    by,
    createdAt: c.createdAt,
    version: c.version,
  }));
}

/** Fill the proposed value into a draft where it can be read safely; otherwise the reviewer edits the draft. */
function patchFor(field: string, value: string, features: Feature[]): ((d: ProductData) => ProductData) | null {
  if (field.startsWith('features.')) {
    const f = features.find((x) => `features.${x.key}` === field);
    const r = f ? parseFeatureValue(f, value) : null;
    if (!f || !r?.ok) return null;
    return (d) => ({ ...d, features: { ...d.features, [f.key]: { value: r.value, notStated: false, sourcePage: null } } });
  }
  if ((SIMPLE_TEXT as readonly string[]).includes(field)) {
    const r = field === 'uin' ? F.productUin(value) : field === 'sourceLink' ? F.url(value) : F.shortText(value);
    return r.ok ? (d) => ({ ...d, [field]: r.value }) : null;
  }
  if ((SIMPLE_NUMBER as readonly string[]).includes(field)) {
    const r = F.wholeNumber(0, 999)(value);
    return r.ok ? (d) => ({ ...d, [field]: r.value }) : null;
  }
  return null;
}

export async function decideCorrection(req: Request, auth: AuthContext, id: string, accept: boolean, body: unknown) {
  if (auth.role !== 'STF' && auth.role !== 'ADM') throw new AppError(403, 'GEN-03');
  const reason = accept ? null : readReason(body);
  const version = readVersion(body);
  if (!isUuid(id)) throw notFound();
  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(productCorrections).where(eq(productCorrections.id, id)).for('update');
    if (!c) throw notFound();
    if (c.status !== 'SUBMITTED' || c.version !== version) throw stateConflict('correction', c.status === 'SUBMITTED' ? 'changed' : c.status);
    const [p] = await tx.select().from(products).where(eq(products.id, c.productId)).for('update');
    const [pub] = await tx.select().from(productVersions).where(eq(productVersions.id, p!.publishedVersionId!));
    let resultingVersionId: string | null = null;
    let filled = false;
    if (accept) {
      const [t] = await tx.select().from(templateVersions).where(eq(templateVersions.id, pub!.templateVersionId));
      const patch = patchFor(c.field, c.proposedValue, (t?.features ?? []) as Feature[]);
      filled = patch !== null;
      const [open] = await tx.select().from(productVersions).where(and(eq(productVersions.productId, p!.id), inArray(productVersions.status, ['DRAFT', 'PENDING_APPROVAL']))).for('update');
      if (open?.status === 'PENDING_APPROVAL') throw new AppError(409, 'CAT-08');
      if (open) {
        const data = patch ? patch(structuredClone(open.data as ProductData)) : (open.data as ProductData);
        await tx
          .update(productVersions)
          .set({ data, name: data.name, uin: data.uin, correctionIds: [...open.correctionIds, c.id], makers: open.makers.includes(auth.userId) ? open.makers : [...open.makers, auth.userId], updatedAt: clock.now(), version: open.version + 1 })
          .where(eq(productVersions.id, open.id));
        resultingVersionId = open.id;
      } else {
        const v = await newDraftFrom(tx, p!, auth.userId, patch ?? undefined, c.id);
        resultingVersionId = v.id;
      }
    }
    await tx
      .update(productCorrections)
      .set({ status: accept ? 'ACCEPTED' : 'REJECTED', rejectReason: reason, reviewedBy: auth.userId, reviewedAt: clock.now(), resultingVersionId, version: c.version + 1 })
      .where(eq(productCorrections.id, c.id));
    await audit(tx, req, { action: accept ? 'CORRECTION_ACCEPTED' : 'CORRECTION_REJECTED', entity: 'product_correction', entityId: c.id, newValue: { reason, resultingVersionId, filled } });
    await notify(tx, {
      userId: c.userId,
      accountId: c.accountId,
      messageId: accept ? 'CAT-39' : 'CAT-40',
      params: { product: pub!.name, reason: reason ?? '' },
      dedupeKey: `correction-decision:${c.id}`,
      link: { type: 'PRODUCT', id: c.productId },
    });
    return { status: accept ? 'ACCEPTED' : 'REJECTED', resultingVersionId, filled, message: msg(accept ? 'CAT-39' : 'CAT-40', { product: pub!.name, reason: reason ?? '' }) };
  });
}

