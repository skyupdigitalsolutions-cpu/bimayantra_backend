// P-22 Create or edit a product; P-25 Approve, publish and withdraw.
// Verified products: STF or ADM make a DRAFT version; a different ADM approves with the extra OTP; publishing
// is one transaction (new version PUBLISHED, old SUPERSEDED). Own products: the advisor saves and the
// version is PUBLISHED at once, seen only in that account (GR-20). Every version is kept (GR-23).
import type { Request } from 'express';
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.js';
import { insuranceTypes, insurers, priceVersions, productCommercials, productVersions, products, templateVersions } from '../../db/schema.js';
import { clock, istToday } from '../../lib/clock.js';
import { AppError, fieldError, fieldErrors, notFound, stateConflict, versionConflict } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import { msg } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { consumeStepUp } from '../auth/auth.service.js';
import { notifyRoles } from '../notifications/notifications.service.js';
import { addMaker, assertChecker, isUnique, isUuid, namesOf, readReason, readVersion } from './common.js';
import { cannotSave, diffData, featureView, missingItems, parseProductData, type ProductData } from './productData.js';
import type { Factor, Feature, Question } from './types.service.js';

type Product = typeof products.$inferSelect;
type Version = typeof productVersions.$inferSelect;
type Template = typeof templateVersions.$inferSelect;
export const PRODUCT_STATUSES = ['UPCOMING', 'ACTIVE', 'WITHDRAWN'] as const;

const statusFor = (launchDate: string | null, current?: string) => (current === 'WITHDRAWN' ? 'WITHDRAWN' : launchDate && launchDate > istToday() ? 'UPCOMING' : 'ACTIVE');

/** Status as advisors see it: an UPCOMING product whose launch date has come is ACTIVE even before the nightly job. */
export function effectiveStatus(p: Pick<Product, 'status'>, v: Pick<Version, 'data'> | null): string {
  if (p.status !== 'UPCOMING' || !v) return p.status;
  const launch = (v.data as ProductData).launchDate;
  return launch && launch <= istToday() ? 'ACTIVE' : 'UPCOMING';
}

/**
 * Can this product be used in a quotation? New business needs an ACTIVE product, insurer and type and a
 * PUBLISHED version; a renewal quotation may also use a WITHDRAWN product (P-22 step 4, AC-P22-4).
 */
export async function quotability(productId: string, opts: { accountId: string; renewal?: boolean }) {
  const row = await productRow(db, productId, opts.accountId);
  if (!row || !row.v) return { ok: false as const, reason: 'NOT_PUBLISHED' };
  const status = effectiveStatus(row.p, row.v);
  if (row.insurerStatus !== 'ACTIVE' && !opts.renewal) return { ok: false as const, reason: 'INSURER_INACTIVE' };
  if (row.typeStatus !== 'ACTIVE' && !opts.renewal) return { ok: false as const, reason: 'TYPE_INACTIVE' };
  if (status === 'UPCOMING') return { ok: false as const, reason: 'UPCOMING' };
  if (status === 'WITHDRAWN' && !opts.renewal) return { ok: false as const, reason: 'WITHDRAWN' };
  return { ok: true as const, versionId: row.v.id };
}

async function productRow(dbx: DbOrTx, id: string, accountId: string | null) {
  if (!isUuid(id)) return undefined;
  const [r] = await dbx
    .select({ p: products, insurerName: insurers.name, insurerStatus: insurers.status, typeName: insuranceTypes.name, typeStatus: insuranceTypes.status })
    .from(products)
    .innerJoin(insurers, eq(insurers.id, products.insurerId))
    .innerJoin(insuranceTypes, eq(insuranceTypes.id, products.typeId))
    .where(and(eq(products.id, id), accountId ? or(isNull(products.accountId), eq(products.accountId, accountId)) : isNull(products.accountId)));
  if (!r) return undefined;
  const [v] = r.p.publishedVersionId ? await dbx.select().from(productVersions).where(eq(productVersions.id, r.p.publishedVersionId)) : [];
  return { ...r, v: v ?? null };
}

async function loadTemplateRow(dbx: DbOrTx, id: string): Promise<Template> {
  const [t] = await dbx.select().from(templateVersions).where(eq(templateVersions.id, id));
  if (!t) throw notFound();
  return t;
}

/** Insurer and type must be ACTIVE, and the type must have an ACTIVE template (P-22 preconditions). */
async function identity(dbx: DbOrTx, body: unknown, kind: 'VERIFIED' | 'OWN') {
  const v = F.parseFields(body, {
    insurerId: { label: 'Insurer', required: true },
    typeId: { label: 'Insurance type', required: true },
    code: { label: 'Product code', required: true, rule: F.code },
  }) as { insurerId: string; typeId: string; code: string };
  const errs = [];
  const [ins] = isUuid(v.insurerId) ? await dbx.select().from(insurers).where(eq(insurers.id, v.insurerId)) : [];
  if (!ins || ins.status !== 'ACTIVE') errs.push({ field: 'insurerId', code: 'VAL-22' });
  const [typ] = isUuid(v.typeId) ? await dbx.select().from(insuranceTypes).where(eq(insuranceTypes.id, v.typeId)) : [];
  const [tpl] = typ ? await dbx.select().from(templateVersions).where(and(eq(templateVersions.typeId, typ.id), eq(templateVersions.status, 'ACTIVE'))) : [];
  if (!typ || typ.status !== 'ACTIVE' || !tpl) errs.push({ field: 'typeId', code: 'VAL-22' });
  if (errs.length) throw fieldErrors(errs);
  void kind;
  return { insurer: ins!, type: typ!, template: tpl!, code: v.code };
}

const codeClash = (err: unknown) => isUnique(err, 'products_verified_code') || isUnique(err, 'products_own_code');

// ======================= Verified products (Admin → Catalogue → Products) =======================

export async function createVerified(req: Request, auth: AuthContext, body: unknown) {
  try {
    return await db.transaction(async (tx) => {
      const id = await identity(tx, body, 'VERIFIED');
      const data = await parseProductData(body, { kind: 'VERIFIED', accountId: null, features: id.template.features as Feature[] });
      const now = clock.now();
      const [p] = await tx
        .insert(products)
        .values({ kind: 'VERIFIED', accountId: null, insurerId: id.insurer.id, typeId: id.type.id, code: id.code, status: statusFor(data.launchDate), createdBy: auth.userId, createdAt: now })
        .returning();
      const [v] = await tx
        .insert(productVersions)
        .values({ productId: p!.id, versionNo: 1, status: 'DRAFT', templateVersionId: id.template.id, name: data.name || id.code, uin: data.uin, data, makers: [auth.userId], createdBy: auth.userId, createdAt: now, updatedAt: now })
        .returning();
      await audit(tx, req, { action: 'PRODUCT_DRAFTED', entity: 'product_version', entityId: v!.id, newValue: { productId: p!.id, code: id.code, data } });
      return { productId: p!.id, versionId: v!.id, version: v!.version, message: msg('CAT-01', { Item: v!.name }) };
    });
  } catch (err) {
    if (codeClash(err)) throw fieldError('code', 'CAT-07');
    throw err;
  }
}

export async function listVerified(q?: string, status?: string) {
  const term = q ? `%${q.replace(/[%_\\]/g, '')}%` : null;
  const rows = await db
    .select({ p: products, insurerName: insurers.name, typeName: insuranceTypes.name })
    .from(products)
    .innerJoin(insurers, eq(insurers.id, products.insurerId))
    .innerJoin(insuranceTypes, eq(insuranceTypes.id, products.typeId))
    .where(and(eq(products.kind, 'VERIFIED'), status ? eq(products.status, status) : sql`true`, term ? or(ilike(products.code, term), ilike(insurers.name, term)) : sql`true`))
    .orderBy(asc(insurers.name), asc(products.code));
  const ids = rows.map((r) => r.p.id);
  const versions = ids.length
    ? await db
        .select({ id: productVersions.id, productId: productVersions.productId, status: productVersions.status, name: productVersions.name, versionNo: productVersions.versionNo })
        .from(productVersions)
        .where(and(inArray(productVersions.productId, ids), inArray(productVersions.status, ['PUBLISHED', 'DRAFT', 'PENDING_APPROVAL'])))
    : [];
  return rows.map(({ p, insurerName, typeName }) => {
    const pub = versions.find((v) => v.productId === p.id && v.status === 'PUBLISHED');
    const open = versions.find((v) => v.productId === p.id && v.status !== 'PUBLISHED');
    return {
      id: p.id,
      code: p.code,
      name: pub?.name ?? open?.name ?? p.code,
      insurerName,
      typeName,
      status: p.status,
      published: pub ? { id: pub.id, versionNo: pub.versionNo } : null,
      open: open ? { id: open.id, versionNo: open.versionNo, status: open.status } : null,
    };
  });
}

async function loadVerified(dbx: DbOrTx, id: string, lock = false): Promise<Product> {
  if (!isUuid(id)) throw notFound();
  const q = dbx.select().from(products).where(and(eq(products.id, id), eq(products.kind, 'VERIFIED')));
  const [p] = lock ? await q.for('update') : await q;
  if (!p) throw notFound();
  return p;
}
async function loadVersion(dbx: DbOrTx, id: string, lock = false): Promise<{ v: Version; p: Product }> {
  if (!isUuid(id)) throw notFound();
  const q = dbx.select({ v: productVersions, p: products }).from(productVersions).innerJoin(products, eq(products.id, productVersions.productId)).where(eq(productVersions.id, id));
  const [r] = lock ? await q.for('update') : await q;
  if (!r) throw notFound();
  return r;
}

export async function getVerified(id: string) {
  const p = await loadVerified(db, id);
  const row = await productRow(db, id, null);
  const versions = await db
    .select({ id: productVersions.id, versionNo: productVersions.versionNo, status: productVersions.status, name: productVersions.name, approvedAt: productVersions.approvedAt, createdAt: productVersions.createdAt, rejectReason: productVersions.rejectReason })
    .from(productVersions)
    .where(eq(productVersions.productId, p.id))
    .orderBy(desc(productVersions.versionNo));
  return {
    id: p.id,
    code: p.code,
    insurerId: p.insurerId,
    insurerName: row!.insurerName,
    typeId: p.typeId,
    typeName: row!.typeName,
    status: p.status,
    statusReason: p.statusReason,
    publishedVersionId: p.publishedVersionId,
    versions,
    version: p.version,
  };
}

/** The checks still failing on a draft, for the editor and the approver. */
async function checksFor(dbx: DbOrTx, p: Product, v: Version, tpl: Template) {
  const data = v.data as ProductData;
  const items = missingItems(data, { kind: p.kind as 'VERIFIED' | 'OWN', features: tpl.features as Feature[] });
  const [ins] = await dbx.select({ status: insurers.status }).from(insurers).where(eq(insurers.id, p.insurerId));
  const [typ] = await dbx.select({ status: insuranceTypes.status }).from(insuranceTypes).where(eq(insuranceTypes.id, p.typeId));
  if (ins?.status !== 'ACTIVE') items.unshift({ field: 'insurerId', label: 'an active insurer' });
  if (typ?.status !== 'ACTIVE') items.unshift({ field: 'typeId', label: 'an active insurance type' });
  if (tpl.status !== 'ACTIVE') items.unshift({ field: 'template', label: 'the current feature template' });
  if (p.kind === 'VERIFIED' && data.pricingMode === 'RATE_TABLE') {
    const [price] = await dbx
      .select({ id: priceVersions.id })
      .from(priceVersions)
      .where(and(eq(priceVersions.ownerKey, 'SKYUP'), eq(priceVersions.productId, p.id), sql`${priceVersions.status} <> 'CANCELLED'`))
      .limit(1);
    if (!price) items.push({ field: 'price', label: 'a SkyUp reference price' });
  }
  return items;
}

export async function getVersionForAdmin(id: string) {
  const { v, p } = await loadVersion(db, id);
  if (p.kind !== 'VERIFIED') throw notFound(); // SkyUp never sees an advisor's own products (AC-P22-2)
  const tpl = await loadTemplateRow(db, v.templateVersionId);
  const [current] = await db.select().from(templateVersions).where(and(eq(templateVersions.typeId, p.typeId), eq(templateVersions.status, 'ACTIVE')));
  const [published] = p.publishedVersionId && p.publishedVersionId !== v.id ? await db.select().from(productVersions).where(eq(productVersions.id, p.publishedVersionId)) : [];
  const row = await productRow(db, p.id, null);
  return {
    id: v.id,
    productId: p.id,
    versionNo: v.versionNo,
    status: v.status,
    code: p.code,
    insurerId: p.insurerId,
    insurerName: row!.insurerName,
    typeId: p.typeId,
    typeName: row!.typeName,
    productStatus: p.status,
    neverPublished: !p.publishedVersionId,
    data: v.data as ProductData,
    template: { id: tpl.id, versionNo: tpl.versionNo, status: tpl.status, features: tpl.features as Feature[], factors: tpl.factors as Factor[], questions: tpl.questions as Question[] },
    olderTemplate: tpl.status !== 'ACTIVE' && current ? msg('CAT-28') : null,
    changes: diffData((published?.data as ProductData | undefined) ?? null, v.data as ProductData, tpl.features as Feature[]),
    missing: v.status === 'DRAFT' || v.status === 'PENDING_APPROVAL' ? await checksFor(db, p, v, tpl) : [],
    makers: await namesOf(db, v.makers),
    makerIds: v.makers,
    rejectReason: v.rejectReason,
    submittedAt: v.submittedAt,
    correctionIds: v.correctionIds,
    version: v.version,
  };
}

/** Autosave of a DRAFT version. Identity (insurer, type, code) can change only before the first publish. */
export async function saveVerifiedDraft(req: Request, auth: AuthContext, versionId: string, body: unknown) {
  const version = readVersion(body);
  try {
    return await db.transaction(async (tx) => {
      const { v, p } = await loadVersion(tx, versionId, true);
      if (p.kind !== 'VERIFIED') throw notFound();
      if (v.version !== version) throw versionConflict('product');
      if (v.status !== 'DRAFT') throw stateConflict('product', v.status);
      const tpl = await loadTemplateRow(tx, v.templateVersionId);
      const data = await parseProductData(body, { kind: 'VERIFIED', accountId: null, features: tpl.features as Feature[] }, v.data as ProductData);
      if (!p.publishedVersionId && (body as { code?: unknown }).code !== undefined) {
        const id = await identity(tx, { insurerId: p.insurerId, typeId: p.typeId, ...(body as object) }, 'VERIFIED');
        if (id.type.id !== p.typeId) throw fieldError('typeId', 'VAL-22'); // a new type needs a new product
        await tx.update(products).set({ insurerId: id.insurer.id, code: id.code, version: p.version + 1 }).where(eq(products.id, p.id));
      }
      const [n] = await tx
        .update(productVersions)
        .set({ data, name: data.name || p.code, uin: data.uin, makers: addMaker(v.makers, auth.userId), updatedAt: clock.now(), version: v.version + 1 })
        .where(eq(productVersions.id, v.id))
        .returning();
      await audit(tx, req, { action: 'PRODUCT_DRAFT_SAVED', entity: 'product_version', entityId: v.id, newValue: data });
      return { version: n!.version, message: msg('CAT-01', { Item: n!.name }) };
    });
  } catch (err) {
    if (codeClash(err)) throw fieldError('code', 'CAT-07');
    throw err;
  }
}

/** Edit (CAT-27): open a new DRAFT copied from the published version, or return the open one. */
export async function openVerifiedDraft(req: Request, auth: AuthContext, productId: string) {
  return db.transaction(async (tx) => {
    const p = await loadVerified(tx, productId, true);
    const [open] = await tx.select().from(productVersions).where(and(eq(productVersions.productId, p.id), inArray(productVersions.status, ['DRAFT', 'PENDING_APPROVAL'])));
    if (open) return { versionId: open.id, created: false, message: null };
    const v = await newDraftFrom(tx, p, auth.userId);
    await audit(tx, req, { action: 'PRODUCT_DRAFTED', entity: 'product_version', entityId: v.id, newValue: { productId: p.id, from: p.publishedVersionId } });
    return { versionId: v.id, created: true, message: msg('CAT-27') };
  });
}

/** New DRAFT from the published version (also used when a correction is accepted, P-58). */
export async function newDraftFrom(tx: DbOrTx, p: Product, userId: string, patch?: (d: ProductData) => ProductData, correctionId?: string): Promise<Version> {
  const [pub] = p.publishedVersionId ? await tx.select().from(productVersions).where(eq(productVersions.id, p.publishedVersionId)) : [];
  if (!pub) throw stateConflict('product', 'not published');
  const [last] = await tx.select({ n: sql<number>`max(${productVersions.versionNo})::int` }).from(productVersions).where(eq(productVersions.productId, p.id));
  const data = patch ? patch(structuredClone(pub.data as ProductData)) : (pub.data as ProductData);
  const now = clock.now();
  const [v] = await tx
    .insert(productVersions)
    .values({
      productId: p.id,
      versionNo: (last?.n ?? 0) + 1,
      status: 'DRAFT',
      templateVersionId: pub.templateVersionId,
      name: data.name,
      uin: data.uin,
      data,
      makers: [userId],
      correctionIds: correctionId ? [correctionId] : [],
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return v!;
}

/** Move a draft onto the current ACTIVE template (values of removed features are dropped from the draft only). */
export async function useCurrentTemplate(req: Request, auth: AuthContext, versionId: string, body: unknown) {
  const version = readVersion(body);
  return db.transaction(async (tx) => {
    const { v, p } = await loadVersion(tx, versionId, true);
    if (p.kind === 'VERIFIED' && v.status !== 'DRAFT') throw stateConflict('product', v.status);
    if (p.kind === 'OWN' && p.accountId !== auth.accountId) throw notFound();
    if (v.version !== version) throw versionConflict('product');
    const [current] = await tx.select().from(templateVersions).where(and(eq(templateVersions.typeId, p.typeId), eq(templateVersions.status, 'ACTIVE')));
    if (!current) throw stateConflict('insurance type', 'no active template');
    const keys = new Set((current.features as Feature[]).map((f) => f.key));
    const data = structuredClone(v.data as ProductData);
    data.features = Object.fromEntries(Object.entries(data.features).filter(([k]) => keys.has(k)));
    const [n] = await tx
      .update(productVersions)
      .set({ templateVersionId: current.id, data, makers: addMaker(v.makers, auth.userId), updatedAt: clock.now(), version: v.version + 1 })
      .where(eq(productVersions.id, v.id))
      .returning();
    await audit(tx, req, { action: 'PRODUCT_TEMPLATE_UPDATED', entity: 'product_version', entityId: v.id, oldValue: { templateVersionId: v.templateVersionId }, newValue: { templateVersionId: current.id } });
    return { version: n!.version };
  });
}

export async function submitVerified(req: Request, auth: AuthContext, versionId: string, body: unknown) {
  const version = readVersion(body);
  return db.transaction(async (tx) => {
    const { v, p } = await loadVersion(tx, versionId, true);
    if (p.kind !== 'VERIFIED') throw notFound();
    if (v.version !== version) throw versionConflict('product');
    if (v.status !== 'DRAFT') throw stateConflict('product', v.status);
    if (!(v.data as ProductData).uin) throw fieldError('uin', 'CAT-33');
    const tpl = await loadTemplateRow(tx, v.templateVersionId);
    const items = await checksFor(tx, p, v, tpl);
    if (items.length) throw cannotSave(items);
    const [n] = await tx
      .update(productVersions)
      .set({ status: 'PENDING_APPROVAL', makers: addMaker(v.makers, auth.userId), submittedAt: clock.now(), rejectReason: null, version: v.version + 1 })
      .where(eq(productVersions.id, v.id))
      .returning();
    await audit(tx, req, { action: 'PRODUCT_SUBMITTED', entity: 'product_version', entityId: v.id });
    const item = `${v.name} v${v.versionNo}`;
    await notifyRoles(tx, ['ADM'], { messageId: 'CAT-02', params: { Item: item }, dedupeKey: `approval:product:${v.id}:${n!.submittedAt!.toISOString()}`, link: { type: 'APPROVAL_PRODUCT', id: v.id } });
    return { version: n!.version, message: msg('CAT-02', { Item: item }) };
  });
}

/**
 * Approve (P-25): a different ADM, the extra OTP, and the version the approver reviewed (CAT-29 if it
 * changed). One transaction: new version PUBLISHED, old SUPERSEDED, product status by launch date.
 */
export async function approveVerified(req: Request, auth: AuthContext, versionId: string, body: unknown) {
  const version = readVersion(body);
  return db.transaction(async (tx) => {
    const { v, p } = await loadVersion(tx, versionId, true);
    if (p.kind !== 'VERIFIED') throw notFound();
    if (v.status !== 'PENDING_APPROVAL') throw stateConflict('product', v.status);
    if (v.version !== version) throw new AppError(409, 'CAT-29', {}, [], { reason: 'version' });
    assertChecker(auth, v.makers);
    const ticketId = await consumeStepUp(tx, auth, req.get('x-step-up-token'), 'APPROVE');
    await tx.select().from(products).where(eq(products.id, p.id)).for('update');
    const now = clock.now();
    await tx.update(productVersions).set({ status: 'SUPERSEDED' }).where(and(eq(productVersions.productId, p.id), eq(productVersions.status, 'PUBLISHED')));
    await tx
      .update(productVersions)
      .set({ status: 'PUBLISHED', approvedBy: auth.userId, approvedAt: now, approvalTicketId: ticketId, version: v.version + 1 })
      .where(eq(productVersions.id, v.id));
    const status = statusFor((v.data as ProductData).launchDate, p.status);
    await tx.update(products).set({ publishedVersionId: v.id, status, version: p.version + 1 }).where(eq(products.id, p.id));
    await audit(tx, req, { action: 'PRODUCT_APPROVED', entity: 'product_version', entityId: v.id, oldValue: { publishedVersionId: p.publishedVersionId }, newValue: { status: 'PUBLISHED', approvalTicketId: ticketId, approvedBy: auth.userId } });
    return { message: msg('CAT-03', { Item: `${v.name} v${v.versionNo}` }) };
  });
}

export async function rejectVerified(req: Request, auth: AuthContext, versionId: string, body: unknown) {
  const reason = readReason(body);
  const version = readVersion(body);
  return db.transaction(async (tx) => {
    const { v, p } = await loadVersion(tx, versionId, true);
    if (p.kind !== 'VERIFIED') throw notFound();
    if (v.status !== 'PENDING_APPROVAL') throw stateConflict('product', v.status);
    if (v.version !== version) throw new AppError(409, 'CAT-29', {}, [], { reason: 'version' });
    assertChecker(auth, v.makers);
    await tx.update(productVersions).set({ status: 'DRAFT', rejectReason: reason, version: v.version + 1 }).where(eq(productVersions.id, v.id));
    await audit(tx, req, { action: 'PRODUCT_REJECTED', entity: 'product_version', entityId: v.id, newValue: { reason } });
    return { message: msg('CAT-04', { Item: `${v.name} v${v.versionNo}`, reason }) };
  });
}

/** Withdraw (ADM, reason required): hidden from new quotations and comparisons; renewals still allowed. */
export async function setVerifiedAvailability(req: Request, auth: AuthContext, productId: string, withdraw: boolean, body: unknown) {
  if (auth.role !== 'ADM') throw new AppError(403, 'GEN-03');
  const reason = withdraw ? readReason(body) : null;
  const version = readVersion(body);
  return db.transaction(async (tx) => {
    const p = await loadVerified(tx, productId, true);
    if (p.version !== version) throw versionConflict('product');
    if (withdraw === (p.status === 'WITHDRAWN')) throw stateConflict('product', p.status);
    const [pub] = p.publishedVersionId ? await tx.select().from(productVersions).where(eq(productVersions.id, p.publishedVersionId)) : [];
    if (!pub) throw stateConflict('product', 'not published');
    const status = withdraw ? 'WITHDRAWN' : statusFor((pub.data as ProductData).launchDate);
    await tx.update(products).set({ status, statusReason: reason, version: p.version + 1 }).where(eq(products.id, p.id));
    await audit(tx, req, { action: withdraw ? 'PRODUCT_WITHDRAWN' : 'PRODUCT_MADE_AVAILABLE', entity: 'product', entityId: p.id, oldValue: { status: p.status }, newValue: { status, reason } });
    return { status, message: withdraw ? msg('CAT-26', { Product: pub.name }) : msg('GEN-08', { 'Record type': 'Product' }) };
  });
}

export async function pendingProductVersions() {
  const rows = await db
    .select({ v: productVersions })
    .from(productVersions)
    .innerJoin(products, eq(products.id, productVersions.productId))
    .where(and(eq(productVersions.status, 'PENDING_APPROVAL'), eq(products.kind, 'VERIFIED')));
  return Promise.all(
    rows.map(async ({ v }) => ({ kind: 'PRODUCT_VERSION', id: v.id, title: `${v.name} v${v.versionNo}`, makers: await namesOf(db, v.makers), makerIds: v.makers, submittedAt: v.submittedAt })),
  );
}

// ======================= Own products (advisor) =======================

async function loadOwn(dbx: DbOrTx, auth: AuthContext, id: string, lock = false): Promise<Product> {
  if (!isUuid(id)) throw notFound();
  const q = dbx.select().from(products).where(and(eq(products.id, id), eq(products.kind, 'OWN'), eq(products.accountId, auth.accountId!)));
  const [p] = lock ? await q.for('update') : await q;
  if (!p) throw notFound();
  return p;
}

/** + My product: saved and PUBLISHED at once in this account; ACTIVE, or UPCOMING if it launches later. */
export async function createOwn(req: Request, auth: AuthContext, body: unknown) {
  try {
    return await db.transaction(async (tx) => {
      const id = await identity(tx, body, 'OWN');
      const features = id.template.features as Feature[];
      const data = await parseProductData(body, { kind: 'OWN', accountId: auth.accountId, features });
      const items = missingItems(data, { kind: 'OWN', features });
      if (items.length) throw cannotSave(items);
      const now = clock.now();
      const [p] = await tx
        .insert(products)
        .values({ kind: 'OWN', accountId: auth.accountId, insurerId: id.insurer.id, typeId: id.type.id, code: id.code, status: statusFor(data.launchDate), createdBy: auth.userId, createdAt: now })
        .returning();
      const [v] = await tx
        .insert(productVersions)
        .values({ productId: p!.id, versionNo: 1, status: 'PUBLISHED', templateVersionId: id.template.id, name: data.name, uin: data.uin, data, makers: [auth.userId], createdBy: auth.userId, createdAt: now, updatedAt: now, approvedAt: now })
        .returning();
      await tx.update(products).set({ publishedVersionId: v!.id }).where(eq(products.id, p!.id));
      await audit(tx, req, { action: 'OWN_PRODUCT_CREATED', entity: 'product', entityId: p!.id, accountId: auth.accountId, newValue: { code: id.code, data } });
      return { productId: p!.id, message: msg('GEN-08', { 'Record type': data.name }) };
    });
  } catch (err) {
    if (codeClash(err)) throw fieldError('code', 'CAT-07');
    throw err;
  }
}

/** Edit my product: a new PUBLISHED version; the old one SUPERSEDED (quotations keep the one they used). */
export async function editOwn(req: Request, auth: AuthContext, productId: string, body: unknown) {
  const version = readVersion(body);
  try {
    return await db.transaction(async (tx) => {
      const p = await loadOwn(tx, auth, productId, true);
      if (p.version !== version) throw versionConflict('product');
      const [pub] = await tx.select().from(productVersions).where(eq(productVersions.id, p.publishedVersionId!));
      // The next edit moves the product onto the current template (P-21 step 4)
      const [current] = await tx.select().from(templateVersions).where(and(eq(templateVersions.typeId, p.typeId), eq(templateVersions.status, 'ACTIVE')));
      if (!current) throw stateConflict('insurance type', 'no active template');
      const features = current.features as Feature[];
      const data = await parseProductData(body, { kind: 'OWN', accountId: auth.accountId, features }, pub!.data as ProductData);
      const items = missingItems(data, { kind: 'OWN', features });
      const [ins] = await tx.select({ status: insurers.status }).from(insurers).where(eq(insurers.id, p.insurerId));
      if (ins?.status !== 'ACTIVE') items.unshift({ field: 'insurerId', label: 'an active insurer' });
      if (items.length) throw cannotSave(items);
      let code = p.code;
      if (typeof (body as { code?: unknown }).code === 'string' && (body as { code: string }).code.trim() !== p.code) {
        const r = F.code((body as { code: string }).code);
        if (!r.ok) throw fieldError('code', r.code, r.params);
        code = r.value;
      }
      const now = clock.now();
      const [last] = await tx.select({ n: sql<number>`max(${productVersions.versionNo})::int` }).from(productVersions).where(eq(productVersions.productId, p.id));
      await tx.update(productVersions).set({ status: 'SUPERSEDED' }).where(eq(productVersions.id, pub!.id));
      const [v] = await tx
        .insert(productVersions)
        .values({ productId: p.id, versionNo: (last?.n ?? 0) + 1, status: 'PUBLISHED', templateVersionId: current.id, name: data.name, uin: data.uin, data, makers: [auth.userId], createdBy: auth.userId, createdAt: now, updatedAt: now, approvedAt: now })
        .returning();
      await tx.update(products).set({ publishedVersionId: v!.id, code, status: statusFor(data.launchDate, p.status), version: p.version + 1 }).where(eq(products.id, p.id));
      await audit(tx, req, { action: 'OWN_PRODUCT_EDITED', entity: 'product', entityId: p.id, accountId: auth.accountId, oldValue: pub!.data, newValue: data });
      return { message: msg('GEN-08', { 'Record type': data.name }), version: p.version + 1 };
    });
  } catch (err) {
    if (codeClash(err)) throw fieldError('code', 'CAT-07');
    throw err;
  }
}

/** The owner changes status: UPCOMING, ACTIVE or WITHDRAWN (Section 4.3 transitions only). */
export async function setOwnStatus(req: Request, auth: AuthContext, productId: string, body: unknown) {
  const v = F.parseFields(body, { status: { label: 'Status', required: true, oneOf: PRODUCT_STATUSES } }) as { status: (typeof PRODUCT_STATUSES)[number] };
  const version = readVersion(body);
  return db.transaction(async (tx) => {
    const p = await loadOwn(tx, auth, productId, true);
    if (p.version !== version) throw versionConflict('product');
    const allowed: Record<string, string[]> = { UPCOMING: ['ACTIVE', 'WITHDRAWN'], ACTIVE: ['WITHDRAWN'], WITHDRAWN: ['ACTIVE'] };
    if (v.status !== p.status && !allowed[p.status]!.includes(v.status)) throw stateConflict('product', p.status);
    await tx.update(products).set({ status: v.status, version: p.version + 1 }).where(eq(products.id, p.id));
    await audit(tx, req, { action: 'OWN_PRODUCT_STATUS', entity: 'product', entityId: p.id, accountId: auth.accountId, oldValue: { status: p.status }, newValue: { status: v.status } });
    const [pub] = await tx.select({ name: productVersions.name }).from(productVersions).where(eq(productVersions.id, p.publishedVersionId!));
    return { status: v.status, version: p.version + 1, message: v.status === 'WITHDRAWN' ? msg('CAT-26', { Product: pub?.name ?? p.code }) : msg('GEN-08', { 'Record type': pub?.name ?? 'Product' }) };
  });
}

// ======================= Catalogue for advisors and assistants =======================

export async function listForAccount(auth: AuthContext, f: { q?: string; typeId?: string; insurerId?: string; kind?: string }) {
  const term = f.q ? `%${f.q.replace(/[%_\\]/g, '')}%` : null;
  const rows = await db
    .select({ p: products, v: productVersions, insurerName: insurers.name, insurerStatus: insurers.status, typeName: insuranceTypes.name, typeStatus: insuranceTypes.status })
    .from(products)
    .innerJoin(productVersions, eq(productVersions.id, products.publishedVersionId))
    .innerJoin(insurers, eq(insurers.id, products.insurerId))
    .innerJoin(insuranceTypes, eq(insuranceTypes.id, products.typeId))
    .where(
      and(
        or(isNull(products.accountId), eq(products.accountId, auth.accountId!)),
        f.kind === 'VERIFIED' || f.kind === 'OWN' ? eq(products.kind, f.kind) : sql`true`,
        isUuid(f.typeId) ? eq(products.typeId, f.typeId) : sql`true`,
        isUuid(f.insurerId) ? eq(products.insurerId, f.insurerId) : sql`true`,
        term ? or(ilike(productVersions.name, term), ilike(insurers.name, term), ilike(products.code, term)) : sql`true`,
      ),
    )
    .orderBy(asc(productVersions.name));
  return rows.map(({ p, v, insurerName, insurerStatus, typeName, typeStatus }) => {
    const status = effectiveStatus(p, v);
    return {
      id: p.id,
      kind: p.kind,
      name: v.name,
      code: p.code,
      uin: v.uin,
      insurerName,
      typeName,
      status,
      quotable: status === 'ACTIVE' && insurerStatus === 'ACTIVE' && typeStatus === 'ACTIVE',
      pricingMode: (v.data as ProductData).pricingMode,
    };
  });
}

/** Product detail for an advisor or assistant. Commercials only for the advisor (AC-P22-6). */
export async function detailForAccount(auth: AuthContext, productId: string) {
  const row = await productRow(db, productId, auth.accountId);
  if (!row || !row.v) throw notFound();
  const tpl = await loadTemplateRow(db, row.v.templateVersionId);
  const data = row.v.data as ProductData;
  const features = tpl.features as Feature[];
  let commercials = null;
  if (auth.role === 'ADV') {
    const [c] = await db.select().from(productCommercials).where(and(eq(productCommercials.accountId, auth.accountId!), eq(productCommercials.productId, row.p.id)));
    commercials = c ? { commissionPercent: c.commissionPercent, notes: c.notes, version: c.version } : { commissionPercent: null, notes: null, version: 0 };
  }
  const [current] = await db.select({ id: templateVersions.id }).from(templateVersions).where(and(eq(templateVersions.typeId, row.p.typeId), eq(templateVersions.status, 'ACTIVE')));
  const status = effectiveStatus(row.p, row.v);
  return {
    id: row.p.id,
    kind: row.p.kind,
    code: row.p.code,
    insurerId: row.p.insurerId,
    insurerName: row.insurerName,
    typeId: row.p.typeId,
    typeName: row.typeName,
    status,
    statusReason: row.p.kind === 'VERIFIED' ? null : row.p.statusReason,
    quotable: status === 'ACTIVE' && row.insurerStatus === 'ACTIVE' && row.typeStatus === 'ACTIVE',
    versionId: row.v.id,
    versionNo: row.v.versionNo,
    data,
    features: featureView(data, features),
    template: { id: tpl.id, features, factors: tpl.factors as Factor[], questions: tpl.questions as Question[] },
    olderTemplate: row.p.kind === 'OWN' && current && current.id !== tpl.id ? msg('CAT-28') : null,
    commercials,
    canEdit: auth.role === 'ADV' && row.p.kind === 'OWN',
    canSuggest: auth.role === 'ADV' && row.p.kind === 'VERIFIED',
    version: row.p.version,
  };
}

/** My commercials: commission % and notes, private to the advisor (CAT-36). */
export async function saveCommercials(req: Request, auth: AuthContext, productId: string, body: unknown) {
  const row = await productRow(db, productId, auth.accountId);
  if (!row || !row.v) throw notFound();
  const v = F.parseFields(body, {
    commissionPercent: { label: 'Commission %', required: true, rule: F.percentage },
    notes: { label: 'Notes', rule: F.notes },
  }) as { commissionPercent: string; notes?: string };
  const version = readVersion(body);
  return db.transaction(async (tx) => {
    const [c] = await tx
      .select()
      .from(productCommercials)
      .where(and(eq(productCommercials.accountId, auth.accountId!), eq(productCommercials.productId, row.p.id)))
      .for('update');
    if ((c?.version ?? 0) !== version) throw versionConflict('commercials', ['commissionPercent', 'notes']);
    const now = clock.now();
    if (c) {
      await tx
        .update(productCommercials)
        .set({ commissionPercent: v.commissionPercent, notes: v.notes ?? null, updatedAt: now, version: c.version + 1 })
        .where(and(eq(productCommercials.accountId, auth.accountId!), eq(productCommercials.productId, row.p.id)));
    } else {
      await tx.insert(productCommercials).values({ accountId: auth.accountId!, productId: row.p.id, commissionPercent: v.commissionPercent, notes: v.notes ?? null, updatedAt: now });
    }
    await audit(tx, req, { action: 'COMMERCIALS_SAVED', entity: 'product_commercials', entityId: row.p.id, accountId: auth.accountId, newValue: { commissionPercent: v.commissionPercent } });
    return { commissionPercent: v.commissionPercent, notes: v.notes ?? null, version: (c?.version ?? 0) + 1, message: msg('CAT-36', { product: row.v!.name }) };
  });
}

/** Expected commission copied to each policy (P-33). */
export async function commissionFor(accountId: string, productId: string): Promise<string | null> {
  const [c] = await db
    .select({ p: productCommercials.commissionPercent })
    .from(productCommercials)
    .where(and(eq(productCommercials.accountId, accountId), eq(productCommercials.productId, productId)));
  return c?.p ?? null;
}

/** Choice lists for "+ My product" and the admin product form. */
export async function productFormOptions() {
  const ins = await db.select({ id: insurers.id, name: insurers.name }).from(insurers).where(eq(insurers.status, 'ACTIVE')).orderBy(asc(insurers.name));
  const types = await db
    .select({ id: insuranceTypes.id, name: insuranceTypes.name, templateId: templateVersions.id, features: templateVersions.features, factors: templateVersions.factors })
    .from(insuranceTypes)
    .innerJoin(templateVersions, and(eq(templateVersions.typeId, insuranceTypes.id), eq(templateVersions.status, 'ACTIVE')))
    .where(eq(insuranceTypes.status, 'ACTIVE'))
    .orderBy(asc(insuranceTypes.position));
  return { insurers: ins, types };
}

// ======================= Nightly: launch dates (with SYS-02) =======================

/** UPCOMING products whose launch date has come become ACTIVE. Repeat-safe. */
export async function startLaunchedProducts(): Promise<number> {
  const today = istToday();
  const rows = await db
    .select({ id: products.id })
    .from(products)
    .innerJoin(productVersions, eq(productVersions.id, products.publishedVersionId))
    .where(and(eq(products.status, 'UPCOMING'), sql`(${productVersions.data} ->> 'launchDate') <= ${today}`));
  if (rows.length) await db.update(products).set({ status: 'ACTIVE' }).where(inArray(products.id, rows.map((r) => r.id)));
  return rows.length;
}
