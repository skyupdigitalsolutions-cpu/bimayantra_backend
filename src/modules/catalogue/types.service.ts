// P-21 Manage insurance types and feature templates. STF or ADM makes; a different ADM approves.
// A new type and its first template are submitted and approved together. For an ACTIVE type, a rename is a
// pending change and a template edit is a new DRAFT version; on approval the new version becomes ACTIVE and
// the earlier one RETIRED. Products keep their old template version until their next edit (CAT-28).
import { randomBytes } from 'node:crypto';
import type { Request } from 'express';
import { and, asc, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.js';
import { insuranceTypes, products, templateVersions } from '../../db/schema.js';
import { clock } from '../../lib/clock.js';
import { AppError, fieldError, fieldErrors, notFound, stateConflict, versionConflict, type FieldError } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import { msg } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { consumeStepUp } from '../auth/auth.service.js';
import { notifyRoles } from '../notifications/notifications.service.js';
import { addMaker, assertChecker, isUnique, isUuid, namesOf, readReason, readVersion, scalar } from './common.js';

export const FEATURE_GROUPS = ['COVERAGE', 'WAITING_PERIODS', 'LIMITS', 'BENEFITS', 'EXCLUSIONS', 'OTHER'] as const;
export const DATA_TYPES = ['YES_NO', 'NUMBER', 'AMOUNT', 'PERCENT', 'DAYS', 'MONTHS', 'YEARS', 'TEXT'] as const;
export const FACTOR_KINDS = ['BAND', 'VALUE'] as const;
export const FILLED_FROM = ['ASKED', 'ELDEST_AGE', 'PROPOSER_AGE', 'ADULTS', 'CHILDREN', 'SUM_INSURED', 'POLICY_TERM'] as const;
export const LABELS = {
  groups: { COVERAGE: 'Coverage', WAITING_PERIODS: 'Waiting periods', LIMITS: 'Limits and sub-limits', BENEFITS: 'Benefits', EXCLUSIONS: 'Exclusions', OTHER: 'Other' },
  dataTypes: { YES_NO: 'Yes/No', NUMBER: 'Number', AMOUNT: 'Amount in ₹', PERCENT: 'Percentage', DAYS: 'Days', MONTHS: 'Months', YEARS: 'Years', TEXT: 'Text' },
  kinds: { BAND: 'Band', VALUE: 'Value' },
  filledFrom: {
    ASKED: 'Asked in the quotation',
    ELDEST_AGE: 'Age of the eldest insured person',
    PROPOSER_AGE: 'Age of the proposer',
    ADULTS: 'Number of adults',
    CHILDREN: 'Number of children',
    SUM_INSURED: 'Sum insured',
    POLICY_TERM: 'Policy term',
  },
} as const;

export type Feature = {
  key: string;
  name: string;
  group: (typeof FEATURE_GROUPS)[number];
  dataType: (typeof DATA_TYPES)[number];
  requiredToPublish: boolean;
  order: number;
  help: string | null;
};
export type Band = { min: number; max: number };
export type Factor = {
  key: string;
  name: string;
  kind: (typeof FACTOR_KINDS)[number];
  filledFrom: (typeof FILLED_FROM)[number];
  bands: Band[];
  values: string[];
};
export type Question = { key: string; label: string; dataType: (typeof DATA_TYPES)[number]; required: boolean };
type Template = typeof templateVersions.$inferSelect;
type TypeRow = typeof insuranceTypes.$inferSelect;
type TypePending = { data: { name: string }; status: 'PENDING' | 'REJECTED'; reason?: string | null; by: string; at: string };

const newKey = (name: string) =>
  `${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 24) || 'f'}_${randomBytes(3).toString('hex')}`;
const keyOk = (k: unknown): k is string => typeof k === 'string' && /^[a-z0-9_]{1,40}$/.test(k);

/** Band labels as used in rate tables: "18-35". */
export const bandLabel = (b: Band) => `${b.min}-${b.max}`;

/** Check the editor's rows (formats only). Submit adds the completeness checks (CAT-12, CAT-30, CAT-16). */
export function parseTemplate(body: unknown): { features: Feature[]; factors: Factor[]; questions: Question[] } {
  const b = (body ?? {}) as Record<string, unknown>;
  const errors: FieldError[] = [];
  const text = (v: unknown, field: string, label: string): string => {
    if (typeof v !== 'string' || v.trim() === '') {
      errors.push({ field, code: 'GEN-01', params: { 'Field label': label } });
      return '';
    }
    const r = F.shortText(v);
    if (!r.ok) errors.push({ field, code: r.code, ...(r.params ? { params: r.params } : {}) });
    return r.ok ? r.value : '';
  };
  const pick = <T extends string>(v: unknown, list: readonly T[], field: string, label: string): T => {
    if (typeof v !== 'string' || v === '') errors.push({ field, code: 'GEN-01', params: { 'Field label': label } });
    else if (!list.includes(v as T)) errors.push({ field, code: 'VAL-22' });
    return v as T;
  };
  const arr = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  const seen = new Set<string>();
  const uniqueKey = (k: unknown, name: string) => {
    let key = keyOk(k) ? k : newKey(name);
    while (seen.has(key)) key = newKey(name);
    seen.add(key);
    return key;
  };
  const features: Feature[] = arr(b.features).map((f, i) => {
    const name = text(f.name, `features.${i}.name`, 'Feature name');
    const help = typeof f.help === 'string' && f.help.trim() ? F.notes(f.help) : null;
    if (help && !help.ok) errors.push({ field: `features.${i}.help`, code: help.code });
    return {
      key: uniqueKey(f.key, name),
      name,
      group: pick(f.group, FEATURE_GROUPS, `features.${i}.group`, 'Group'),
      dataType: pick(f.dataType, DATA_TYPES, `features.${i}.dataType`, 'Data type'),
      requiredToPublish: f.requiredToPublish === true,
      order: i + 1,
      help: help?.ok ? help.value : null,
    };
  });
  const factors: Factor[] = arr(b.factors).map((f, i) => {
    const name = text(f.name, `factors.${i}.name`, 'Factor name');
    const kind = pick(f.kind, FACTOR_KINDS, `factors.${i}.kind`, 'Kind');
    const bands: Band[] = [];
    const values: string[] = [];
    if (kind === 'BAND') {
      arr(f.bands).forEach((band, j) => {
        const min = F.wholeNumber(0, 99_99_99_999)(scalar(band.min));
        const max = F.wholeNumber(0, 99_99_99_999)(scalar(band.max));
        if (!min.ok) errors.push({ field: `factors.${i}.bands.${j}.min`, code: min.code, ...(min.params ? { params: min.params } : {}) });
        if (!max.ok) errors.push({ field: `factors.${i}.bands.${j}.max`, code: max.code, ...(max.params ? { params: max.params } : {}) });
        if (min.ok && max.ok) bands.push({ min: min.value, max: max.value });
      });
    } else if (kind === 'VALUE') {
      const list = Array.isArray(f.values) ? f.values : [];
      list.forEach((v, j) => {
        const t = text(v, `factors.${i}.values.${j}`, 'Value');
        if (t) values.push(t);
      });
    }
    return { key: uniqueKey(f.key, name), name, kind, filledFrom: pick(f.filledFrom, FILLED_FROM, `factors.${i}.filledFrom`, 'Filled from'), bands, values };
  });
  const questions: Question[] = arr(b.questions).map((q, i) => {
    const label = text(q.label, `questions.${i}.label`, 'Question');
    return { key: uniqueKey(q.key, label), label, dataType: pick(q.dataType, DATA_TYPES, `questions.${i}.dataType`, 'Data type'), required: q.required === true };
  });
  if (errors.length) throw fieldErrors(errors);
  return { features, factors, questions };
}

/** Completeness checks on submit: at least one feature and one factor; bands without overlaps or gaps. */
export function checkTemplateComplete(t: { features: Feature[]; factors: Factor[] }): void {
  const errors: FieldError[] = [];
  if (t.features.length === 0) errors.push({ field: 'features', code: 'CAT-12' });
  if (t.factors.length === 0) errors.push({ field: 'factors', code: 'CAT-30' });
  t.factors.forEach((f, i) => {
    if (f.kind === 'BAND') {
      if (f.bands.length === 0) errors.push({ field: `factors.${i}.bands`, code: 'GEN-01', params: { 'Field label': 'Bands' } });
      const sorted = [...f.bands].sort((a, b) => a.min - b.min);
      const bad = sorted.some((b, j) => b.min > b.max || (j > 0 && b.min !== sorted[j - 1]!.max + 1));
      if (bad) errors.push({ field: `factors.${i}.bands`, code: 'CAT-16' });
    } else if (f.values.length === 0) errors.push({ field: `factors.${i}.values`, code: 'GEN-01', params: { 'Field label': 'Values' } });
    else if (new Set(f.values.map((v) => v.toLowerCase())).size !== f.values.length) errors.push({ field: `factors.${i}.values`, code: 'VAL-22' });
  });
  if (errors.length) throw fieldErrors(errors);
}

// ---------- reads ----------
export async function activeTemplate(dbx: DbOrTx, typeId: string): Promise<Template | undefined> {
  const [t] = await dbx.select().from(templateVersions).where(and(eq(templateVersions.typeId, typeId), eq(templateVersions.status, 'ACTIVE')));
  return t;
}
export async function templateById(dbx: DbOrTx, id: string): Promise<Template | undefined> {
  if (!isUuid(id)) return undefined;
  const [t] = await dbx.select().from(templateVersions).where(eq(templateVersions.id, id));
  return t;
}

async function templateView(t: Template) {
  return {
    id: t.id,
    typeId: t.typeId,
    versionNo: t.versionNo,
    status: t.status,
    features: t.features as Feature[],
    factors: t.factors as Factor[],
    questions: t.questions as Question[],
    rejectReason: t.rejectReason,
    submittedAt: t.submittedAt,
    approvedAt: t.approvedAt,
    makers: await namesOf(db, t.makers),
    makerIds: t.makers,
    version: t.version,
  };
}

async function typeView(t: TypeRow) {
  const versions = await db.select().from(templateVersions).where(eq(templateVersions.typeId, t.id)).orderBy(desc(templateVersions.versionNo));
  const pending = t.pendingChange as TypePending | null;
  return {
    id: t.id,
    name: t.name,
    status: t.status,
    rejectReason: t.rejectReason,
    submittedAt: t.submittedAt,
    makers: await namesOf(db, t.makers),
    makerIds: t.makers,
    pendingChange: pending,
    version: t.version,
    activeTemplate: versions.find((v) => v.status === 'ACTIVE') ? await templateView(versions.find((v) => v.status === 'ACTIVE')!) : null,
    openTemplate: versions.find((v) => v.status === 'DRAFT' || v.status === 'PENDING_APPROVAL')
      ? await templateView(versions.find((v) => v.status === 'DRAFT' || v.status === 'PENDING_APPROVAL')!)
      : null,
    history: versions.map((v) => ({ id: v.id, versionNo: v.versionNo, status: v.status, approvedAt: v.approvedAt })),
  };
}

export async function listTypes() {
  const rows = await db.select().from(insuranceTypes).orderBy(asc(insuranceTypes.position), asc(insuranceTypes.name));
  const tv = await db
    .select({ typeId: templateVersions.typeId, status: templateVersions.status, versionNo: templateVersions.versionNo })
    .from(templateVersions)
    .where(inArray(templateVersions.status, ['ACTIVE', 'DRAFT', 'PENDING_APPROVAL']));
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    status: t.status,
    pendingChange: (t.pendingChange as TypePending | null)?.status ?? null,
    activeTemplateVersion: tv.find((v) => v.typeId === t.id && v.status === 'ACTIVE')?.versionNo ?? null,
    openTemplate: tv.find((v) => v.typeId === t.id && v.status !== 'ACTIVE')?.status ?? null,
    version: t.version,
  }));
}

async function loadType(dbx: DbOrTx, id: string, lock = false): Promise<TypeRow> {
  if (!isUuid(id)) throw notFound();
  const q = dbx.select().from(insuranceTypes).where(eq(insuranceTypes.id, id));
  const [t] = lock ? await q.for('update') : await q;
  if (!t) throw notFound();
  return t;
}
async function loadTemplate(dbx: DbOrTx, id: string, lock = false): Promise<Template> {
  if (!isUuid(id)) throw notFound();
  const q = dbx.select().from(templateVersions).where(eq(templateVersions.id, id));
  const [t] = lock ? await q.for('update') : await q;
  if (!t) throw notFound();
  return t;
}

export async function getType(id: string) {
  return typeView(await loadType(db, id));
}
export async function getTemplate(id: string) {
  const t = await loadTemplate(db, id);
  const type = await loadType(db, t.typeId);
  const active = await activeTemplate(db, t.typeId);
  return { ...(await templateView(t)), typeName: type.name, typeStatus: type.status, active: active && active.id !== t.id ? await templateView(active) : null };
}

function parseName(body: unknown): string {
  const raw = (body as { name?: unknown } | null)?.name;
  if (typeof raw !== 'string' || raw.trim() === '') throw fieldError('name', 'GEN-01', { 'Field label': 'Type name' });
  const r = F.shortText(raw);
  if (!r.ok) throw fieldError('name', r.code, r.params);
  return r.value;
}

async function nameTaken(dbx: DbOrTx, name: string, exceptId: string | null) {
  const rows = await dbx
    .select({ id: insuranceTypes.id })
    .from(insuranceTypes)
    .where(
      and(
        exceptId ? ne(insuranceTypes.id, exceptId) : sql`true`,
        or(sql`lower(${insuranceTypes.name}) = lower(${name})`, sql`lower(${insuranceTypes.pendingChange} -> 'data' ->> 'name') = lower(${name})`),
      ),
    );
  // VAL-22 is the closest catalogue message; a type-specific duplicate message is a document change (document change 25)
  if (rows.length) throw fieldError('name', 'VAL-22');
}

const notifyApprovers = (dbx: DbOrTx, item: string, kind: string, id: string) =>
  notifyRoles(dbx, ['ADM'], { messageId: 'CAT-02', params: { Item: item }, dedupeKey: `approval:${kind}:${id}:${clock.now().toISOString()}`, link: { type: `APPROVAL_${kind}`, id } });

/** + Type: the type (DRAFT) and its first template version (DRAFT) are created together. */
export async function createType(req: Request, auth: AuthContext, body: unknown) {
  const name = parseName(body);
  const tpl = parseTemplate(body);
  try {
    return await db.transaction(async (tx) => {
      await nameTaken(tx, name, null);
      const now = clock.now();
      const [maxPos] = await tx.select({ p: sql<number>`coalesce(max(${insuranceTypes.position}), 0)::int` }).from(insuranceTypes);
      const [t] = await tx
        .insert(insuranceTypes)
        .values({ name, status: 'DRAFT', position: (maxPos?.p ?? 0) + 1, makers: [auth.userId], createdAt: now })
        .returning();
      await tx.insert(templateVersions).values({ typeId: t!.id, versionNo: 1, status: 'DRAFT', ...tpl, makers: [auth.userId], createdBy: auth.userId, createdAt: now });
      await audit(tx, req, { action: 'TYPE_DRAFTED', entity: 'insurance_type', entityId: t!.id, newValue: { name, ...tpl } });
      return t!;
    }).then(async (t) => ({ type: await typeView(t), message: msg('CAT-01', { Item: name }) }));
  } catch (err) {
    if (isUnique(err, 'insurance_types_name')) throw fieldError('name', 'VAL-22');
    throw err;
  }
}

/** Rename: in place while DRAFT; a pending change once ACTIVE or INACTIVE. */
export async function renameType(req: Request, auth: AuthContext, id: string, body: unknown) {
  const name = parseName(body);
  const version = readVersion(body);
  try {
    return await db.transaction(async (tx) => {
      const t = await loadType(tx, id, true);
      if (t.version !== version) throw versionConflict('insurance type', ['name']);
      await nameTaken(tx, name, t.id);
      if (t.status === 'PENDING_APPROVAL') throw new AppError(409, 'CAT-08');
      if (t.status === 'DRAFT') {
        const [n] = await tx.update(insuranceTypes).set({ name, makers: addMaker(t.makers, auth.userId), version: t.version + 1 }).where(eq(insuranceTypes.id, t.id)).returning();
        await audit(tx, req, { action: 'TYPE_DRAFTED', entity: 'insurance_type', entityId: t.id, oldValue: { name: t.name }, newValue: { name } });
        return { type: await typeView(n!), message: msg('CAT-01', { Item: name }) };
      }
      const pending = t.pendingChange as TypePending | null;
      if (pending?.status === 'PENDING') throw new AppError(409, 'CAT-08');
      if (name === t.name) return { type: await typeView(t), message: msg('GEN-08', { 'Record type': 'Insurance type' }) };
      const now = clock.now();
      const change: TypePending = { data: { name }, status: 'PENDING', by: auth.userId, at: now.toISOString() };
      const [n] = await tx
        .update(insuranceTypes)
        .set({ pendingChange: change, makers: pending ? addMaker(t.makers, auth.userId) : [auth.userId], submittedAt: now, version: t.version + 1 })
        .where(eq(insuranceTypes.id, t.id))
        .returning();
      await audit(tx, req, { action: 'TYPE_CHANGE_SUBMITTED', entity: 'insurance_type', entityId: t.id, oldValue: { name: t.name }, newValue: { name } });
      await notifyApprovers(tx, t.name, 'TYPE', t.id);
      return { type: await typeView(n!), message: msg('CAT-02', { Item: t.name }) };
    });
  } catch (err) {
    if (isUnique(err, 'insurance_types_name')) throw fieldError('name', 'VAL-22');
    throw err;
  }
}

/** Edit template: returns the open draft, or creates one copied from the ACTIVE version. */
export async function openTemplateDraft(req: Request, auth: AuthContext, typeId: string) {
  return db.transaction(async (tx) => {
    const t = await loadType(tx, typeId, true);
    const versions = await tx.select().from(templateVersions).where(eq(templateVersions.typeId, t.id)).orderBy(desc(templateVersions.versionNo));
    const open = versions.find((v) => v.status === 'DRAFT' || v.status === 'PENDING_APPROVAL');
    if (open) return { template: await templateView(open), created: false };
    const base = versions.find((v) => v.status === 'ACTIVE');
    const [n] = await tx
      .insert(templateVersions)
      .values({
        typeId: t.id,
        versionNo: (versions[0]?.versionNo ?? 0) + 1,
        status: 'DRAFT',
        features: base?.features ?? [],
        factors: base?.factors ?? [],
        questions: base?.questions ?? [],
        makers: [auth.userId],
        createdBy: auth.userId,
        createdAt: clock.now(),
      })
      .returning();
    await audit(tx, req, { action: 'TEMPLATE_DRAFTED', entity: 'template_version', entityId: n!.id, newValue: { typeId: t.id, versionNo: n!.versionNo } });
    return { template: await templateView(n!), created: true };
  });
}

/** Save the table editor (DRAFT only). Two makers editing one draft: the second gets GEN-05. */
export async function saveTemplate(req: Request, auth: AuthContext, id: string, body: unknown) {
  const tpl = parseTemplate(body);
  const version = readVersion(body);
  return db.transaction(async (tx) => {
    const t = await loadTemplate(tx, id, true);
    if (t.version !== version) throw versionConflict('feature template');
    if (t.status !== 'DRAFT') throw stateConflict('feature template', t.status);
    const [n] = await tx
      .update(templateVersions)
      .set({ ...tpl, makers: addMaker(t.makers, auth.userId), version: t.version + 1 })
      .where(eq(templateVersions.id, t.id))
      .returning();
    const type = await loadType(tx, t.typeId);
    if (type.status === 'DRAFT') await tx.update(insuranceTypes).set({ makers: addMaker(type.makers, auth.userId) }).where(eq(insuranceTypes.id, type.id));
    await audit(tx, req, { action: 'TEMPLATE_SAVED', entity: 'template_version', entityId: t.id, newValue: tpl });
    return { template: await templateView(n!), message: msg('CAT-01', { Item: `${type.name} feature template v${t.versionNo}` }) };
  });
}

/** Submit a template draft. For a DRAFT type, the type is submitted with it. */
export async function submitTemplate(req: Request, auth: AuthContext, id: string, body: unknown) {
  const version = readVersion(body);
  return db.transaction(async (tx) => {
    const t = await loadTemplate(tx, id, true);
    if (t.version !== version) throw versionConflict('feature template');
    if (t.status !== 'DRAFT') throw stateConflict('feature template', t.status);
    checkTemplateComplete({ features: t.features as Feature[], factors: t.factors as Factor[] });
    const type = await loadType(tx, t.typeId, true);
    const now = clock.now();
    await tx
      .update(templateVersions)
      .set({ status: 'PENDING_APPROVAL', makers: addMaker(t.makers, auth.userId), submittedAt: now, rejectReason: null, version: t.version + 1 })
      .where(eq(templateVersions.id, t.id));
    let item = `${type.name} feature template v${t.versionNo}`;
    if (type.status === 'DRAFT') {
      await tx
        .update(insuranceTypes)
        .set({ status: 'PENDING_APPROVAL', makers: addMaker(type.makers, auth.userId), submittedAt: now, rejectReason: null, version: type.version + 1 })
        .where(eq(insuranceTypes.id, type.id));
      item = type.name;
    }
    await audit(tx, req, { action: 'TEMPLATE_SUBMITTED', entity: 'template_version', entityId: t.id });
    await notifyApprovers(tx, item, 'TEMPLATE', t.id);
    return { template: await templateView(await loadTemplate(tx, t.id)), message: msg('CAT-02', { Item: item }) };
  });
}

export async function approveTemplate(req: Request, auth: AuthContext, id: string, body: unknown) {
  const version = readVersion(body);
  return db.transaction(async (tx) => {
    const t = await loadTemplate(tx, id, true);
    if (t.status !== 'PENDING_APPROVAL') throw stateConflict('feature template', t.status);
    if (t.version !== version) throw stateConflict('feature template', 'changed');
    const type = await loadType(tx, t.typeId, true);
    assertChecker(auth, [...t.makers, ...(type.status === 'PENDING_APPROVAL' ? type.makers : [])]);
    const ticketId = await consumeStepUp(tx, auth, req.get('x-step-up-token'), 'APPROVE');
    const now = clock.now();
    // One transaction: the earlier ACTIVE version is RETIRED and the new one ACTIVE together
    await tx.update(templateVersions).set({ status: 'RETIRED' }).where(and(eq(templateVersions.typeId, t.typeId), eq(templateVersions.status, 'ACTIVE')));
    await tx
      .update(templateVersions)
      .set({ status: 'ACTIVE', approvedBy: auth.userId, approvedAt: now, approvalTicketId: ticketId, version: t.version + 1 })
      .where(eq(templateVersions.id, t.id));
    let item = `${type.name} feature template v${t.versionNo}`;
    if (type.status === 'PENDING_APPROVAL') {
      await tx
        .update(insuranceTypes)
        .set({ status: 'ACTIVE', makers: [], approvedBy: auth.userId, approvedAt: now, approvalTicketId: ticketId, version: type.version + 1 })
        .where(eq(insuranceTypes.id, type.id));
      item = type.name;
    }
    await audit(tx, req, { action: 'TEMPLATE_APPROVED', entity: 'template_version', entityId: t.id, newValue: { approvalTicketId: ticketId } });
    return { message: msg('CAT-03', { Item: item }) };
  });
}

/** Reject: the template version (and a new type) go back to DRAFT for editing. */
export async function rejectTemplate(req: Request, auth: AuthContext, id: string, body: unknown) {
  const reason = readReason(body);
  const version = readVersion(body);
  return db.transaction(async (tx) => {
    const t = await loadTemplate(tx, id, true);
    if (t.status !== 'PENDING_APPROVAL') throw stateConflict('feature template', t.status);
    if (t.version !== version) throw stateConflict('feature template', 'changed');
    const type = await loadType(tx, t.typeId, true);
    assertChecker(auth, [...t.makers, ...(type.status === 'PENDING_APPROVAL' ? type.makers : [])]);
    await tx.update(templateVersions).set({ status: 'DRAFT', rejectReason: reason, version: t.version + 1 }).where(eq(templateVersions.id, t.id));
    let item = `${type.name} feature template v${t.versionNo}`;
    if (type.status === 'PENDING_APPROVAL') {
      await tx.update(insuranceTypes).set({ status: 'DRAFT', rejectReason: reason, version: type.version + 1 }).where(eq(insuranceTypes.id, type.id));
      item = type.name;
    }
    await audit(tx, req, { action: 'TEMPLATE_REJECTED', entity: 'template_version', entityId: t.id, newValue: { reason } });
    return { message: msg('CAT-04', { Item: item, reason }) };
  });
}

/** Approve or reject a pending rename of an ACTIVE type. */
export async function decideTypeChange(req: Request, auth: AuthContext, id: string, approve: boolean, body: unknown) {
  const reason = approve ? null : readReason(body);
  const version = readVersion(body);
  try {
    return await db.transaction(async (tx) => {
      const t = await loadType(tx, id, true);
      const pending = t.pendingChange as TypePending | null;
      if (pending?.status !== 'PENDING') throw stateConflict('insurance type', t.status);
      if (t.version !== version) throw stateConflict('insurance type', 'changed');
      assertChecker(auth, t.makers);
      if (approve) {
        const ticketId = await consumeStepUp(tx, auth, req.get('x-step-up-token'), 'APPROVE');
        await nameTaken(tx, pending.data.name, t.id);
        await tx
          .update(insuranceTypes)
          .set({ name: pending.data.name, pendingChange: null, makers: [], approvedBy: auth.userId, approvedAt: clock.now(), approvalTicketId: ticketId, version: t.version + 1 })
          .where(eq(insuranceTypes.id, t.id));
        await audit(tx, req, { action: 'TYPE_CHANGE_APPROVED', entity: 'insurance_type', entityId: t.id, oldValue: { name: t.name }, newValue: { name: pending.data.name, approvalTicketId: ticketId } });
        return { message: msg('CAT-03', { Item: pending.data.name }) };
      }
      await tx
        .update(insuranceTypes)
        .set({ pendingChange: { ...pending, status: 'REJECTED', reason }, version: t.version + 1 })
        .where(eq(insuranceTypes.id, t.id));
      await audit(tx, req, { action: 'TYPE_CHANGE_REJECTED', entity: 'insurance_type', entityId: t.id, newValue: { reason } });
      return { message: msg('CAT-04', { Item: t.name, reason: reason! }) };
    });
  } catch (err) {
    if (isUnique(err, 'insurance_types_name')) throw fieldError('name', 'VAL-22');
    throw err;
  }
}

export async function typeImpact(id: string) {
  const t = await loadType(db, id);
  const [r] = await db
    .select({ n: sql<number>`count(*) filter (where ${products.status} <> 'WITHDRAWN')::int`, m: sql<number>`count(distinct ${products.accountId})::int` })
    .from(products)
    .where(eq(products.typeId, t.id));
  // Advisors affected: own-product owners of this type, plus every advisor if verified products are hidden
  const n = r?.n ?? 0;
  const m = r?.m ?? 0;
  return { products: n, advisors: m, message: msg('CAT-09', { name: t.name, n, m }) };
}

export async function setTypeActive(req: Request, auth: AuthContext, id: string, active: boolean, body: unknown) {
  if (auth.role !== 'ADM') throw new AppError(403, 'GEN-03');
  const version = readVersion(body);
  return db.transaction(async (tx) => {
    const t = await loadType(tx, id, true);
    if (t.version !== version) throw versionConflict('insurance type');
    const from = active ? 'INACTIVE' : 'ACTIVE';
    if (t.status !== from) throw stateConflict('insurance type', t.status);
    await tx.update(insuranceTypes).set({ status: active ? 'ACTIVE' : 'INACTIVE', version: t.version + 1 }).where(eq(insuranceTypes.id, t.id));
    await audit(tx, req, { action: active ? 'TYPE_ACTIVATED' : 'TYPE_DEACTIVATED', entity: 'insurance_type', entityId: t.id, oldValue: { status: t.status }, newValue: { status: active ? 'ACTIVE' : 'INACTIVE' } });
    return { type: await typeView(await loadType(tx, t.id)), message: msg('GEN-08', { 'Record type': 'Insurance type' }) };
  });
}

/** Pending type and template items for Admin → Approvals. */
export async function pendingTypeItems() {
  const tpls = await db
    .select({ t: templateVersions, typeName: insuranceTypes.name, typeStatus: insuranceTypes.status, typeMakers: insuranceTypes.makers })
    .from(templateVersions)
    .innerJoin(insuranceTypes, eq(insuranceTypes.id, templateVersions.typeId))
    .where(eq(templateVersions.status, 'PENDING_APPROVAL'));
  const renames = await db.select().from(insuranceTypes).where(sql`${insuranceTypes.pendingChange} ->> 'status' = 'PENDING'`);
  const items = await Promise.all(
    tpls.map(async ({ t, typeName, typeStatus, typeMakers }) => {
      const makerIds = [...new Set([...t.makers, ...(typeStatus === 'PENDING_APPROVAL' ? typeMakers : [])])];
      return {
        kind: typeStatus === 'PENDING_APPROVAL' ? 'TYPE' : 'TEMPLATE',
        id: t.id,
        title: typeStatus === 'PENDING_APPROVAL' ? typeName : `${typeName} feature template v${t.versionNo}`,
        makers: await namesOf(db, makerIds),
        makerIds,
        submittedAt: t.submittedAt,
      };
    }),
  );
  for (const r of renames) {
    items.push({
      kind: 'TYPE_CHANGE',
      id: r.id,
      title: `${r.name} → ${(r.pendingChange as TypePending).data.name}`,
      makers: await namesOf(db, r.makers),
      makerIds: r.makers,
      submittedAt: r.submittedAt,
    });
  }
  return items;
}
