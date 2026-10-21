// P-12 Create a lead, P-13 Work a lead, P-14 Convert a lead to a customer.
// Duplicate rule (Section 7): same mobile + same name in an open lead = exact duplicate (blocked, a database
// rule too); same mobile, different name = possible duplicate (warned, allowed). Every status change is the
// pipeline's stage move and is written to the stage history with who, when, from, to and reason.
import type { Request } from 'express';
import { and, asc, desc, eq, ilike, inArray, ne, notInArray, or, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.js';
import { customers, insuranceTypes, leadEvents, leads, pipelines, tasks, users } from '../../db/schema.js';
import { addDays, clock, istToday } from '../../lib/clock.js';
import { AppError, fieldError, fieldErrors, forbidden, notFound, stateConflict, versionConflict, type FieldError } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import { maskMobile } from '../../lib/mask.js';
import { msg } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { settings } from '../settings/settings.service.js';
import { istInstant } from '../tasks/tasks.service.js';
import { isUnique, isUuid, nextNumber, normName, overrides, readVersion } from '../clients/common.js';
import { customerDuplicates, customerView, insertCustomer, loadCustomer, parseCustomer } from '../customers/customers.service.js';

type Lead = typeof leads.$inferSelect;
export const OPEN = ['NEW', 'CONTACTED', 'QUALIFIED', 'FOLLOW_UP'] as const;
export const PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export const OUTCOMES = ['SPOKE', 'NOT_REACHABLE', 'CALL_BACK'] as const;
const OUTCOME_TEXT: Record<string, string> = { SPOKE: 'Spoke to customer', NOT_REACHABLE: 'Not reachable', CALL_BACK: 'Asked to call back' };
export const STATUS_TEXT: Record<string, string> = { NEW: 'New', CONTACTED: 'Contacted', QUALIFIED: 'Qualified', FOLLOW_UP: 'Follow-up', CONVERTED: 'Converted', LOST: 'Lost' };
const SRC_REFERRER = 'Referred by a referrer';
const SRC_CLIENT = 'Referred by a client';
const SRC_CAMPAIGN = 'Campaign';

/** Section 4.3 lead transitions (CONVERTED only through P-14; LOST → CONTACTED is Reopen). */
export const NEXT: Record<string, string[]> = {
  NEW: ['CONTACTED', 'FOLLOW_UP', 'LOST'],
  CONTACTED: ['QUALIFIED', 'FOLLOW_UP', 'LOST'],
  QUALIFIED: ['FOLLOW_UP', 'LOST'],
  FOLLOW_UP: ['CONTACTED', 'QUALIFIED', 'LOST'],
  LOST: ['CONTACTED'],
  CONVERTED: [],
};
/** Statuses this role may choose (assistants cannot mark lost or reopen, Section 3.2). */
export const allowedNext = (status: string, role: string) => (NEXT[status] ?? []).filter((s) => role === 'ADV' || (s !== 'LOST' && status !== 'LOST'));

type LeadInput = {
  name: string;
  mobile: string;
  altMobile: string | null;
  email: string | null;
  source: string;
  referrerUserId: string | null;
  referredByCustomerId: string | null;
  campaign: string | null;
  interestTypeIds: string[];
  priority: string;
  pipelineId: string;
  followUpAt: Date | null;
  notes: string | null;
};

async function parseLead(dbx: DbOrTx, accountId: string, body: unknown, opts: { requireFollowUpFuture: boolean }): Promise<LeadInput> {
  const b = (body ?? {}) as Record<string, unknown>;
  const errors: FieldError[] = [];
  let v: Record<string, unknown> = {};
  try {
    v = F.parseFields(body, {
      name: { label: 'Lead name', required: true, rule: F.personName },
      mobile: { label: 'Primary mobile', required: true, rule: F.mobile },
      altMobile: { label: 'Alternate mobile', rule: F.mobile },
      email: { label: 'Email', rule: F.email },
      source: { label: 'Source', required: true, oneOf: settings.get('CFG-133') },
      pipelineId: { label: 'Pipeline', required: true },
      campaign: { label: 'Campaign name', rule: F.shortText },
      priority: { label: 'Priority', oneOf: PRIORITIES },
      followUpDate: { label: 'Next follow-up date', rule: F.futureDate },
      followUpTime: { label: 'Next follow-up time', rule: F.timeOfDay },
      notes: { label: 'Notes', rule: F.notes },
    });
  } catch (err) {
    if (err instanceof AppError) errors.push(...err.fields);
    else throw err;
  }
  if (v.mobile && v.altMobile && v.mobile === v.altMobile) errors.push({ field: 'altMobile', code: 'LD-09' });
  // Pipeline: one of the account's (CFG-169)
  if (v.pipelineId) {
    const [p] = isUuid(v.pipelineId) ? await dbx.select().from(pipelines).where(and(eq(pipelines.id, v.pipelineId), eq(pipelines.accountId, accountId))) : [];
    if (!p) errors.push({ field: 'pipelineId', code: 'VAL-22' });
  }
  let referrerUserId: string | null = null;
  let referredByCustomerId: string | null = null;
  if (v.source === SRC_REFERRER) {
    if (!b.referrerUserId) errors.push({ field: 'referrerUserId', code: 'GEN-01', params: { 'Field label': 'Referrer' } });
    else {
      const [r] = isUuid(b.referrerUserId) ? await dbx.select().from(users).where(and(eq(users.id, b.referrerUserId), eq(users.accountId, accountId), eq(users.role, 'REF'))) : [];
      if (!r) errors.push({ field: 'referrerUserId', code: 'VAL-22' });
      else referrerUserId = r.id;
    }
  }
  if (v.source === SRC_CLIENT) {
    // Chosen from the advisor's registered customers only; free text is not allowed (DEC-25)
    if (!b.referredByCustomerId) errors.push({ field: 'referredByCustomerId', code: 'GEN-01', params: { 'Field label': 'Referred by client' } });
    else {
      const [c] = isUuid(b.referredByCustomerId) ? await dbx.select({ id: customers.id }).from(customers).where(and(eq(customers.id, b.referredByCustomerId), eq(customers.accountId, accountId))) : [];
      if (!c) errors.push({ field: 'referredByCustomerId', code: 'VAL-22' });
      else referredByCustomerId = c.id;
    }
  }
  if (v.source === SRC_CAMPAIGN && !v.campaign) errors.push({ field: 'campaign', code: 'GEN-01', params: { 'Field label': 'Campaign name' } });
  const interests = Array.isArray(b.interestTypeIds) ? b.interestTypeIds.filter((x): x is string => typeof x === 'string') : [];
  if (interests.length) {
    const ok = await dbx.select({ id: insuranceTypes.id }).from(insuranceTypes).where(and(inArray(insuranceTypes.id, interests.filter(isUuid)), eq(insuranceTypes.status, 'ACTIVE')));
    if (ok.length !== new Set(interests).size) errors.push({ field: 'interestTypeIds', code: 'VAL-22' });
  }
  let followUpAt: Date | null = null;
  if (v.followUpDate || v.followUpTime) {
    if (!v.followUpDate) errors.push({ field: 'followUpDate', code: 'GEN-01', params: { 'Field label': 'Next follow-up date' } });
    else if (!v.followUpTime) errors.push({ field: 'followUpTime', code: 'GEN-01', params: { 'Field label': 'Next follow-up time' } });
    else {
      followUpAt = istInstant(v.followUpDate as string, v.followUpTime as string);
      if (opts.requireFollowUpFuture && followUpAt <= clock.now()) errors.push({ field: 'followUpTime', code: 'DSH-24' });
    }
  }
  if (errors.length) throw fieldErrors(errors);
  return {
    name: v.name as string,
    mobile: v.mobile as string,
    altMobile: (v.altMobile as string | undefined) ?? null,
    email: (v.email as string | undefined) ?? null,
    source: v.source as string,
    referrerUserId,
    referredByCustomerId,
    campaign: v.source === SRC_CAMPAIGN ? ((v.campaign as string | undefined) ?? null) : null,
    interestTypeIds: [...new Set(interests)],
    priority: (v.priority as string | undefined) ?? 'MEDIUM',
    pipelineId: v.pipelineId as string,
    followUpAt,
    notes: (v.notes as string | undefined) ?? null,
  };
}

/** Duplicate check (the screen calls it when the mobile field loses focus; the server repeats it on save). */
export async function leadDuplicates(dbx: DbOrTx, accountId: string, mobile: string, name: string, exceptId?: string | null) {
  const open = await dbx
    .select({ id: leads.id, number: leads.number, name: leads.name, nameNorm: leads.nameNorm })
    .from(leads)
    .where(and(eq(leads.accountId, accountId), eq(leads.mobile, mobile), inArray(leads.status, [...OPEN]), exceptId ? ne(leads.id, exceptId) : sql`true`));
  const n = normName(name);
  const exact = name ? (open.find((l) => l.nameNorm === n) ?? null) : null;
  const possible = open.filter((l) => !name || l.nameNorm !== n);
  const [customer] = await dbx
    .select({ id: customers.id, number: customers.number, fullName: customers.fullName })
    .from(customers)
    .where(and(eq(customers.accountId, accountId), eq(customers.mobile, mobile), eq(customers.status, 'ACTIVE')))
    .limit(1);
  return { exact, possible, customer: customer ?? null };
}

export async function checkLeadDuplicate(auth: AuthContext, q: { mobile?: string; name?: string; exceptId?: string }) {
  const m = F.mobile(q.mobile ?? '');
  if (!m.ok) return { exact: null, possible: [], customer: null, messages: [] };
  const d = await leadDuplicates(db, auth.accountId!, m.value, q.name ?? '', isUuid(q.exceptId) ? q.exceptId : null);
  return {
    ...d,
    messages: [
      ...(d.exact ? [msg('LD-02', { 'lead number': d.exact.number })] : []),
      ...d.possible.map((p) => msg('LD-03', { name: p.name, 'lead number': p.number })),
      ...(d.customer ? [msg('LD-04', { Name: d.customer.fullName, 'customer number': d.customer.number })] : []),
    ],
  };
}

async function upsertFollowUpTask(tx: DbOrTx, auth: AuthContext, lead: { id: string; name: string; followUpTaskId: string | null }, at: Date) {
  if (lead.followUpTaskId) {
    const [t] = await tx.select().from(tasks).where(eq(tasks.id, lead.followUpTaskId));
    if (t && t.status === 'OPEN') {
      await tx.update(tasks).set({ dueAt: at, remindedForDueAt: null, version: t.version + 1 }).where(eq(tasks.id, t.id));
      return t.id;
    }
  }
  const [t] = await tx
    .insert(tasks)
    .values({ accountId: auth.accountId!, title: `Follow up with ${lead.name}`, dueAt: at, linkedType: 'LEAD', linkedId: lead.id, createdBy: auth.userId, createdAt: clock.now() })
    .returning();
  return t!.id;
}

async function cancelFollowUpTask(tx: DbOrTx, taskId: string | null) {
  if (!taskId) return;
  await tx.update(tasks).set({ status: 'CANCELLED', version: sql`${tasks.version} + 1` }).where(and(eq(tasks.id, taskId), eq(tasks.status, 'OPEN')));
}

const event = (tx: DbOrTx, l: Pick<Lead, 'id' | 'accountId'>, auth: AuthContext, e: Partial<typeof leadEvents.$inferInsert> & { kind: string }) =>
  tx.insert(leadEvents).values({ leadId: l.id, accountId: l.accountId, userId: auth.userId, at: clock.now(), ...e });

export async function createLead(req: Request, auth: AuthContext, body: unknown) {
  const d = await parseLead(db, auth.accountId!, body, { requireFollowUpFuture: true });
  try {
    return await db.transaction(async (tx) => {
      const dup = await leadDuplicates(tx, auth.accountId!, d.mobile, d.name);
      if (dup.exact) throw fieldError('mobile', 'LD-02', { 'lead number': dup.exact.number });
      if (!overrides(body)) {
        if (dup.possible.length) {
          const p = dup.possible[0]!;
          throw new AppError(409, 'LD-03', { name: p.name, 'lead number': p.number }, [], { reason: 'possible_duplicate', possible: dup.possible });
        }
        if (dup.customer) throw new AppError(409, 'LD-04', { Name: dup.customer.fullName, 'customer number': dup.customer.number }, [], { reason: 'possible_duplicate', customer: dup.customer });
      }
      const number = await nextNumber(tx, auth.accountId!, 'LD');
      const now = clock.now();
      const { followUpAt, ...rest } = d;
      const [l] = await tx
        .insert(leads)
        .values({ accountId: auth.accountId!, number, ...rest, nameNorm: normName(d.name), status: 'NEW', nextFollowUpAt: followUpAt, createdBy: auth.userId, createdAt: now, updatedAt: now })
        .returning();
      if (followUpAt) {
        const taskId = await upsertFollowUpTask(tx, auth, { id: l!.id, name: d.name, followUpTaskId: null }, followUpAt);
        await tx.update(leads).set({ followUpTaskId: taskId }).where(eq(leads.id, l!.id));
      }
      await event(tx, l!, auth, { kind: 'CREATED', toStatus: 'NEW', note: d.notes });
      await audit(tx, req, { action: 'LEAD_CREATED', entity: 'lead', entityId: l!.id, newValue: { number, name: d.name, mobile: maskMobile(d.mobile), source: d.source } });
      return { lead: { id: l!.id, number }, message: msg('LD-01', { 'lead number': number }) };
    });
  } catch (err) {
    // Two forms saving the same name and mobile at the same moment: the database keeps the first
    if (isUnique(err, 'leads_open_exact')) {
      const dup = await leadDuplicates(db, auth.accountId!, d.mobile, d.name);
      throw fieldError('mobile', 'LD-02', { 'lead number': dup.exact?.number ?? '' });
    }
    throw err;
  }
}

async function loadLead(dbx: DbOrTx, accountId: string, id: string, lock = false): Promise<Lead> {
  if (!isUuid(id)) throw notFound();
  const q = dbx.select().from(leads).where(and(eq(leads.id, id), eq(leads.accountId, accountId)));
  const [l] = lock ? await q.for('update') : await q;
  if (!l) throw notFound();
  return l;
}

const converted = async (l: Lead) => {
  const [c] = l.customerId ? await db.select({ number: customers.number }).from(customers).where(eq(customers.id, l.customerId)) : [];
  return new AppError(409, 'LD-08', { 'customer number': c?.number ?? '' }, [], { customerId: l.customerId });
};

export async function getLead(auth: AuthContext, id: string) {
  const l = await loadLead(db, auth.accountId!, id);
  const [p] = await db.select({ name: pipelines.name }).from(pipelines).where(eq(pipelines.id, l.pipelineId));
  const [ref] = l.referrerUserId ? await db.select({ name: users.name }).from(users).where(eq(users.id, l.referrerUserId)) : [];
  const [byCust] = l.referredByCustomerId ? await db.select({ id: customers.id, number: customers.number, fullName: customers.fullName }).from(customers).where(eq(customers.id, l.referredByCustomerId)) : [];
  const [cust] = l.customerId ? await db.select({ id: customers.id, number: customers.number, fullName: customers.fullName }).from(customers).where(eq(customers.id, l.customerId)) : [];
  const types = l.interestTypeIds.length ? await db.select({ id: insuranceTypes.id, name: insuranceTypes.name }).from(insuranceTypes).where(inArray(insuranceTypes.id, l.interestTypeIds)) : [];
  const evs = await db.select().from(leadEvents).where(eq(leadEvents.leadId, l.id)).orderBy(asc(leadEvents.at), asc(leadEvents.id));
  const uids = [...new Set(evs.map((e) => e.userId).filter((x): x is string => !!x))];
  const names = uids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, uids)) : [];
  return {
    id: l.id,
    number: l.number,
    pipelineId: l.pipelineId,
    pipelineName: p?.name ?? null,
    name: l.name,
    mobile: l.mobile,
    altMobile: l.altMobile,
    email: l.email,
    source: l.source,
    referrerUserId: l.referrerUserId,
    referrerName: ref?.name ?? null,
    referredByCustomer: byCust ?? null,
    campaign: l.campaign,
    interests: types,
    interestTypeIds: l.interestTypeIds,
    priority: l.priority,
    status: l.status,
    nextFollowUpAt: l.nextFollowUpAt,
    lostReason: l.lostReason,
    lostNote: l.lostNote,
    notes: l.notes,
    customer: cust ?? null,
    allowedNext: allowedNext(l.status, auth.role),
    canConvert: (OPEN as readonly string[]).includes(l.status),
    timeline: evs.map((e) => ({
      at: e.at,
      kind: e.kind,
      text:
        e.kind === 'CONTACT' ? `Contact: ${OUTCOME_TEXT[e.outcome ?? ''] ?? e.outcome}`
          : e.kind === 'STATUS' ? `${STATUS_TEXT[e.fromStatus ?? ''] ?? e.fromStatus} → ${STATUS_TEXT[e.toStatus ?? ''] ?? e.toStatus}`
            : e.kind === 'CREATED' ? 'Lead created'
              : e.kind === 'CONVERTED' ? 'Converted to customer'
                : e.kind === 'SOURCE_CORRECTED' ? 'Source corrected'
                  : 'Details edited',
      reason: e.reason,
      note: e.note,
      by: names.find((n) => n.id === e.userId)?.name ?? null,
    })),
    createdAt: l.createdAt,
    version: l.version,
  };
}

/**
 * Edit details (same rules as P-12). Source and referrer are locked after save; only the advisor can
 * correct them, and each correction is audited.
 */
export async function editLead(req: Request, auth: AuthContext, id: string, body: unknown) {
  const d = await parseLead(db, auth.accountId!, body, { requireFollowUpFuture: false });
  const version = readVersion(body);
  try {
    return await db.transaction(async (tx) => {
      const l = await loadLead(tx, auth.accountId!, id, true);
      if (l.status === 'CONVERTED') throw await converted(l);
      if (l.version !== version) throw versionConflict('lead', ['name', 'mobile', 'email', 'notes']);
      const sourceChanged = d.source !== l.source || d.referrerUserId !== l.referrerUserId || d.referredByCustomerId !== l.referredByCustomerId || d.campaign !== l.campaign;
      if (sourceChanged && auth.role !== 'ADV') throw forbidden();
      if (d.mobile !== l.mobile || normName(d.name) !== l.nameNorm) {
        const dup = await leadDuplicates(tx, auth.accountId!, d.mobile, d.name, l.id);
        if (dup.exact && l.status !== 'LOST') throw fieldError('mobile', 'LD-02', { 'lead number': dup.exact.number });
        if (dup.possible.length && !overrides(body)) {
          const p = dup.possible[0]!;
          throw new AppError(409, 'LD-03', { name: p.name, 'lead number': p.number }, [], { reason: 'possible_duplicate', possible: dup.possible });
        }
      }
      const { followUpAt: _ignored, ...rest } = d;
      void _ignored;
      const [n] = await tx.update(leads).set({ ...rest, nameNorm: normName(d.name), updatedAt: clock.now(), version: l.version + 1 }).where(eq(leads.id, l.id)).returning();
      await event(tx, l, auth, { kind: sourceChanged ? 'SOURCE_CORRECTED' : 'EDITED' });
      await audit(tx, req, {
        action: sourceChanged ? 'LEAD_SOURCE_CORRECTED' : 'LEAD_EDITED',
        entity: 'lead',
        entityId: l.id,
        oldValue: { name: l.name, mobile: maskMobile(l.mobile), source: l.source, referrerUserId: l.referrerUserId, referredByCustomerId: l.referredByCustomerId },
        newValue: { name: d.name, mobile: maskMobile(d.mobile), source: d.source, referrerUserId: d.referrerUserId, referredByCustomerId: d.referredByCustomerId },
      });
      return { version: n!.version, message: msg('GEN-08', { 'Record type': 'Lead' }) };
    });
  } catch (err) {
    if (isUnique(err, 'leads_open_exact')) throw fieldError('mobile', 'LD-02', { 'lead number': '' });
    throw err;
  }
}

/** Log contact: outcome and note, added to the timeline. */
export async function logContact(req: Request, auth: AuthContext, id: string, body: unknown) {
  const v = F.parseFields(body, { outcome: { label: 'Outcome', required: true, oneOf: OUTCOMES }, note: { label: 'Note', rule: F.notes } }) as { outcome: string; note?: string };
  return db.transaction(async (tx) => {
    const l = await loadLead(tx, auth.accountId!, id, true);
    if (l.status === 'CONVERTED') throw await converted(l);
    await event(tx, l, auth, { kind: 'CONTACT', outcome: v.outcome, note: v.note ?? null });
    await tx.update(leads).set({ updatedAt: clock.now() }).where(eq(leads.id, l.id));
    await audit(tx, req, { action: 'LEAD_CONTACT_LOGGED', entity: 'lead', entityId: l.id, newValue: { outcome: v.outcome } });
    return { message: msg('GEN-08', { 'Record type': 'Contact' }) };
  });
}

/**
 * Change status (P-13 step 3) — also what dragging a card on the board does. Only allowed next statuses;
 * FOLLOW_UP needs a later date and time and creates or moves the follow-up task; LOST needs a reason
 * (LD-06) and a note for Other, and cancels the open follow-up task; Reopen (LOST → CONTACTED) needs a note.
 */
export async function changeStatus(req: Request, auth: AuthContext, id: string, body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const to = typeof b.status === 'string' ? b.status : '';
  const version = readVersion(body);
  return db.transaction(async (tx) => {
    const l = await loadLead(tx, auth.accountId!, id, true);
    if (l.status === 'CONVERTED') throw await converted(l);
    if (!(NEXT[l.status] ?? []).includes(to)) throw stateConflict('lead', l.status);
    if ((to === 'LOST' || l.status === 'LOST') && auth.role !== 'ADV') throw forbidden();
    if (l.version !== version) throw versionConflict('lead', ['status']);
    const set: Partial<Lead> = { status: to, updatedAt: clock.now(), version: l.version + 1 };
    let reason: string | null = null;
    let note: string | null = null;
    if (to === 'FOLLOW_UP') {
      const v = F.parseFields(body, {
        followUpDate: { label: 'Next follow-up', required: true, rule: F.futureDate },
        followUpTime: { label: 'Next follow-up time', required: true, rule: F.timeOfDay },
      }) as { followUpDate: string; followUpTime: string };
      const at = istInstant(v.followUpDate, v.followUpTime);
      if (at <= clock.now()) throw fieldError('followUpTime', 'DSH-24');
      set.nextFollowUpAt = at;
      set.followUpTaskId = await upsertFollowUpTask(tx, auth, l, at);
    } else if (to === 'LOST') {
      const r = b.reason;
      if (typeof r !== 'string' || !r) throw fieldError('reason', 'LD-06');
      if (!settings.get('CFG-33').includes(r)) throw fieldError('reason', 'VAL-22');
      const n = typeof b.note === 'string' && b.note.trim() ? F.notes(b.note) : null;
      if (n && !n.ok) throw fieldError('note', n.code);
      if (r === 'Other' && !n) throw fieldError('note', 'GEN-01', { 'Field label': 'Note' });
      reason = r;
      note = n?.ok ? n.value : null;
      Object.assign(set, { lostReason: reason, lostNote: note, nextFollowUpAt: null });
      await cancelFollowUpTask(tx, l.followUpTaskId);
    } else if (l.status === 'LOST') {
      const v = F.parseFields(body, { note: { label: 'Note', required: true, rule: F.notes } }) as { note: string };
      note = v.note;
      Object.assign(set, { lostReason: null, lostNote: null });
    } else {
      const n = typeof b.note === 'string' && b.note.trim() ? F.notes(b.note) : null;
      note = n?.ok ? n.value : null;
    }
    await tx.update(leads).set(set).where(eq(leads.id, l.id));
    await event(tx, l, auth, { kind: 'STATUS', fromStatus: l.status, toStatus: to, reason, note });
    await audit(tx, req, { action: 'LEAD_STATUS_CHANGED', entity: 'lead', entityId: l.id, oldValue: { status: l.status }, newValue: { status: to, reason } });
    return {
      status: to,
      version: l.version + 1,
      message: l.status === 'LOST' ? msg('LD-07') : msg('LD-05', { status: STATUS_TEXT[to]!.toLowerCase() }),
    };
  });
}

/**
 * P-14 Convert: creates (or links) the customer, copies source, referrer and campaign, sets CONVERTED with
 * the customer link and cancels the open follow-up task — in one transaction. An exact duplicate of an
 * ACTIVE customer can only be linked. A retry never creates a second customer (idempotency key).
 */
export async function convertLead(req: Request, auth: AuthContext, id: string, body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const mode = b.mode === 'LINK' ? 'LINK' : 'CREATE';
  const data = mode === 'CREATE' ? parseCustomer(body) : null;
  return db.transaction(async (tx) => {
    const l = await loadLead(tx, auth.accountId!, id, true);
    if (l.status === 'CONVERTED') throw await converted(l);
    if (!(OPEN as readonly string[]).includes(l.status)) throw stateConflict('lead', l.status);
    let customer;
    let created = false;
    if (mode === 'LINK') {
      if (!isUuid(b.customerId)) throw fieldError('customerId', 'GEN-01', { 'Field label': 'Customer' });
      customer = await loadCustomer(tx, auth.accountId!, b.customerId);
      if (customer.status !== 'ACTIVE') throw new AppError(409, 'CU-20', { Customer: customer.fullName });
    } else {
      const dup = await customerDuplicates(tx, auth.accountId!, data!.mobile, data!.fullName);
      if (dup.exact) throw new AppError(409, 'CU-02', { 'customer number': dup.exact.number }, [], { reason: 'link_only', customer: dup.exact });
      customer = await insertCustomer(tx, req, auth, data!, { source: l.source, leadId: l.id, referrerUserId: l.referrerUserId, referredByCustomerId: l.referredByCustomerId, campaign: l.campaign }, overrides(body));
      created = true;
    }
    const now = clock.now();
    await tx.update(leads).set({ status: 'CONVERTED', customerId: customer.id, convertedAt: now, nextFollowUpAt: null, updatedAt: now, version: l.version + 1 }).where(eq(leads.id, l.id));
    await cancelFollowUpTask(tx, l.followUpTaskId);
    await event(tx, l, auth, { kind: 'CONVERTED', fromStatus: l.status, toStatus: 'CONVERTED' });
    await audit(tx, req, { action: 'LEAD_CONVERTED', entity: 'customer', entityId: customer.id, newValue: { number: l.number, lead: l.number, linked: !created } });
    await audit(tx, req, { action: 'LEAD_STATUS_CHANGED', entity: 'lead', entityId: l.id, oldValue: { status: l.status }, newValue: { status: 'CONVERTED', customerId: customer.id } });
    return {
      customer: { id: customer.id, number: customer.number },
      message: created ? msg('LD-10', { 'customer number': customer.number, 'lead number': l.number }) : msg('LD-11', { 'lead number': l.number, 'customer number': customer.number }),
    };
  });
}

/** Lead list (filters as the dashboard widgets use them) and the board per pipeline. */
export async function listLeads(auth: AuthContext, f: { status?: string; pipelineId?: string; q?: string; page?: number; from?: string; to?: string }) {
  const size = settings.get('CFG-23');
  const page = Math.max(1, f.page ?? 1);
  const statuses = f.status === 'OPEN' ? [...OPEN] : f.status ? f.status.split(',').filter((s) => s in NEXT) : [];
  const term = f.q?.trim().replace(/[%_\\]/g, '');
  const digits = term?.replace(/\D/g, '') ?? '';
  const where = and(
    eq(leads.accountId, auth.accountId!),
    statuses.length ? inArray(leads.status, statuses) : sql`true`,
    isUuid(f.pipelineId) ? eq(leads.pipelineId, f.pipelineId) : sql`true`,
    f.from ? sql`${leads.createdAt} >= ${istInstant(f.from, '00:00')}` : sql`true`,
    f.to ? sql`${leads.createdAt} < ${istInstant(addDays(f.to, 1), '00:00')}` : sql`true`,
    term ? or(ilike(leads.name, `%${term}%`), ilike(leads.number, `%${term}%`), ilike(leads.email, `%${term}%`), digits.length >= settings.get('CFG-132') ? ilike(leads.mobile, `%${digits}%`) : sql`false`) : sql`true`,
  );
  const rows = await db.select().from(leads).where(where).orderBy(desc(leads.createdAt)).limit(size).offset((page - 1) * size);
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(leads).where(where);
  return { items: rows.map(rowView), total: n, page, pageSize: size };
}

const rowView = (l: Lead) => ({ id: l.id, number: l.number, name: l.name, mobile: l.mobile, source: l.source, priority: l.priority, status: l.status, pipelineId: l.pipelineId, nextFollowUpAt: l.nextFollowUpAt, createdAt: l.createdAt, version: l.version });

export async function board(auth: AuthContext, pipelineId: string) {
  const [p] = isUuid(pipelineId) ? await db.select().from(pipelines).where(and(eq(pipelines.id, pipelineId), eq(pipelines.accountId, auth.accountId!))) : [];
  if (!p) throw notFound();
  // Converted and lost cards from the last 30 days, so the board stays short
  const since = istInstant(addDays(istToday(), -30), '00:00');
  const rows = await db
    .select()
    .from(leads)
    .where(and(eq(leads.accountId, auth.accountId!), eq(leads.pipelineId, p.id), or(inArray(leads.status, [...OPEN]), sql`${leads.updatedAt} >= ${since}`)))
    .orderBy(desc(leads.updatedAt))
    .limit(500);
  const stages = settings.get('CFG-170');
  return { pipeline: { id: p.id, name: p.name }, columns: stages.map((s) => ({ status: s, label: STATUS_TEXT[s] ?? s, items: rows.filter((r) => r.status === s).map(rowView) })) };
}

export async function leadOptions(auth: AuthContext) {
  const ps = await db.select({ id: pipelines.id, name: pipelines.name }).from(pipelines).where(eq(pipelines.accountId, auth.accountId!)).orderBy(asc(pipelines.position));
  const refs = await db.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.accountId, auth.accountId!), eq(users.role, 'REF'), notInArray(users.status, ['DISABLED']))).orderBy(asc(users.name));
  const types = await db.select({ id: insuranceTypes.id, name: insuranceTypes.name }).from(insuranceTypes).where(eq(insuranceTypes.status, 'ACTIVE')).orderBy(asc(insuranceTypes.position));
  return {
    pipelines: ps,
    sources: settings.get('CFG-133'),
    lostReasons: settings.get('CFG-33'),
    stages: settings.get('CFG-170').map((s: string) => ({ value: s, label: STATUS_TEXT[s] ?? s })),
    priorities: PRIORITIES,
    outcomes: OUTCOMES.map((o) => ({ value: o, label: OUTCOME_TEXT[o] })),
    referrers: refs,
    insuranceTypes: types,
    sourceRules: { referrer: SRC_REFERRER, client: SRC_CLIENT, campaign: SRC_CAMPAIGN },
  };
}

export { customerView };
