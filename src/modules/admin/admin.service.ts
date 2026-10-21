// P-48 SkyUp users and roles, P-49 configuration changes (a second ADM approves), P-50 audit log and export,
// P-51 suspend, reactivate or close an account. Sensitive actions need an extra OTP; everything is audited.
import type { Request } from 'express';
import { and, asc, desc, eq, gte, ilike, inArray, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { SETTINGS, SETTING_IDS, type SettingId } from '../../config/settings.js';
import { db } from '../../db/client.js';
import {
  accounts,
  advisorProfiles,
  auditLog,
  configChanges,
  configValues,
  customers,
  leads,
  outgoingMessages,
  policies,
  quotations,
  referralCodes,
  subscriptions,
  users,
  wallets,
} from '../../db/schema.js';
import { clock, istToday } from '../../lib/clock.js';
import { AppError, fieldErrors, forbidden, notFound, stateConflict, versionConflict } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import { maskMobile } from '../../lib/mask.js';
import { msg } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { consumeStepUp } from '../auth/auth.service.js';
import { endAllSessions } from '../auth/sessions.service.js';
import { isUnique, isUuid, readVersion } from '../clients/common.js';
import { storeGenerated, fileLink } from '../files/files.service.js';
import { cancelWhere } from '../messages/messages.service.js';
import { notifyRoles } from '../notifications/notifications.service.js';
import { settings } from '../settings/settings.service.js';
import { planView } from '../billing/subscription.service.js';

// ======================= P-48 =======================
export async function listStaff() {
  const rows = await db.select().from(users).where(inArray(users.role, ['STF', 'ADM'])).orderBy(asc(users.name));
  return { items: rows.map((u) => ({ id: u.id, name: u.name, mobile: maskMobile(u.mobile), role: u.role, status: u.status, lastLoginAt: u.lastLoginAt?.toISOString() ?? null, version: u.version })) };
}

async function activeAdmins(tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) {
  const [{ n }] = (await tx.select({ n: sql<number>`count(*)::int` }).from(users).where(and(eq(users.role, 'ADM'), ne(users.status, 'DISABLED')))) as [{ n: number }];
  return n;
}

export async function addStaff(req: Request, auth: AuthContext, body: unknown) {
  const v = F.parseFields(body, { name: { label: 'Name', required: true, rule: F.personName }, mobile: { label: 'Mobile', required: true, rule: F.mobile }, role: { label: 'Role', required: true, oneOf: ['STF', 'ADM'] } }) as { name: string; mobile: string; role: 'STF' | 'ADM' };
  try {
    return await db.transaction(async (tx) => {
      const [taken] = await tx.select({ id: users.id }).from(users).where(eq(users.mobile, v.mobile));
      if (taken) throw fieldErrors([{ field: 'mobile', code: 'REF-02' }]);
      const ticket = await consumeStepUp(tx, auth, req.get('x-step-up-token'), 'USER_CHANGE');
      const [u] = await tx.insert(users).values({ role: v.role, name: v.name, mobile: v.mobile, status: 'INVITED', invitedBy: auth.userId, invitedAt: clock.now(), createdAt: clock.now() }).returning();
      await audit(tx, req, { action: 'STAFF_ADDED', entity: 'user', entityId: u!.id, newValue: { name: v.name, role: v.role, mobile: maskMobile(v.mobile), ticket } });
      return { id: u!.id, message: msg('ADM-01', { Name: v.name, role: v.role === 'ADM' ? 'SkyUp Admin' : 'SkyUp Staff' }) };
    });
  } catch (err) {
    if (isUnique(err, 'users_mobile_unique')) throw fieldErrors([{ field: 'mobile', code: 'REF-02' }]);
    throw err;
  }
}

export async function changeStaff(req: Request, auth: AuthContext, id: string, body: unknown) {
  const b = (body ?? {}) as { role?: unknown; status?: unknown };
  if (!isUuid(id)) throw notFound();
  if (id === auth.userId) throw new AppError(403, 'ADM-03');
  return db.transaction(async (tx) => {
    const [u] = await tx.select().from(users).where(and(eq(users.id, id), inArray(users.role, ['STF', 'ADM']))).for('update');
    if (!u) throw notFound();
    if (u.version !== readVersion(body)) throw versionConflict('user');
    const role = b.role === 'STF' || b.role === 'ADM' ? b.role : u.role;
    const status = b.status === 'DISABLED' ? 'DISABLED' : b.status === 'ACTIVE' ? (u.activatedAt ? 'ACTIVE' : 'INVITED') : u.status;
    const losesAdmin = u.role === 'ADM' && u.status !== 'DISABLED' && (role !== 'ADM' || status === 'DISABLED');
    if (losesAdmin && (await activeAdmins(tx)) <= 1) throw new AppError(409, 'ADM-02');
    const ticket = await consumeStepUp(tx, auth, req.get('x-step-up-token'), 'USER_CHANGE');
    await tx.update(users).set({ role, status, version: u.version + 1 }).where(eq(users.id, u.id));
    // A role change or disable ends the user's sessions at once
    if (role !== u.role) await endAllSessions(tx, u.id, 'ROLE_CHANGED');
    if (status === 'DISABLED') await endAllSessions(tx, u.id, 'USER_DISABLED');
    await audit(tx, req, { action: 'STAFF_CHANGED', entity: 'user', entityId: u.id, oldValue: { role: u.role, status: u.status }, newValue: { role, status, ticket } });
    return { message: msg('GEN-08', { 'Record type': 'User' }) };
  });
}

// ======================= P-49 =======================
type Range = { min: number; max: number };
function rangeCheck(def: unknown, val: unknown, path: string): string | null {
  if (typeof def === 'number') {
    if (typeof val !== 'number' || Number.isNaN(val)) return path;
    const lo = def === 0 ? 0 : def / 2;
    const hi = def === 0 ? Math.max(1, def * 2) : def * 2;
    if (Number.isInteger(def) && !Number.isInteger(val)) return path;
    return val < Math.min(lo, hi) || val > Math.max(lo, hi) ? path : null;
  }
  if (typeof def === 'string') {
    if (typeof val !== 'string') return path;
    if (/^\d{2}:\d{2}$/.test(def)) return /^([01]\d|2[0-3]):[0-5]\d$/.test(val) ? null : path;
    if (/^\d+(\.\d+)?$/.test(def)) return /^\d+(\.\d{1,2})?$/.test(val) && Number(val) >= Number(def) / 2 && Number(val) <= Math.max(Number(def) * 2, 1) ? null : path;
    return val.trim() ? null : path;
  }
  if (typeof def === 'boolean') return typeof val === 'boolean' ? null : path;
  if (def === null) return val === null || (typeof val === 'number' && val >= 0) ? null : path;
  if (Array.isArray(def)) {
    if (!Array.isArray(val) || val.length === 0) return path;
    return val.every((x) => typeof x === typeof def[0]) ? null : path;
  }
  if (typeof def === 'object') {
    if (!val || typeof val !== 'object' || Array.isArray(val)) return path;
    const d = def as Record<string, unknown>;
    const v = val as Record<string, unknown>;
    if (Object.keys(d).sort().join() !== Object.keys(v).sort().join()) return path;
    for (const k of Object.keys(d)) {
      const r = rangeCheck(d[k], v[k], `${path}.${k}`);
      if (r) return r;
    }
    return null;
  }
  return path;
}
function describeRange(def: unknown): { min: string; max: string } {
  if (typeof def === 'number') return { min: String(def / 2), max: String(def * 2) };
  const r = def as Range;
  if (r && typeof r === 'object' && 'min' in r) return { min: `${r.min / 2}`, max: `${r.max * 2}` };
  return { min: 'half the default', max: 'twice the default' };
}

export async function listConfig() {
  const rows = await db.select().from(configValues).orderBy(asc(configValues.id));
  const pending = await db.select().from(configChanges).where(eq(configChanges.status, 'PENDING_APPROVAL'));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    items: SETTING_IDS.map((id) => {
      const s = SETTINGS[id];
      const r = byId.get(id);
      const p = pending.find((x) => x.settingId === id);
      return { id, name: s.setting, value: r?.value ?? s.value, defaultValue: s.value, changeBy: s.changeBy, usedIn: s.usedIn, pending: p ? { id: p.id, newValue: p.newValue, reason: p.reason, requestedBy: p.requestedBy, requestedAt: p.requestedAt.toISOString() } : null };
    }).sort((a, b) => Number(a.id.slice(4)) - Number(b.id.slice(4))),
  };
}

export async function requestConfigChange(req: Request, auth: AuthContext, id: string, body: unknown) {
  if (!(SETTING_IDS as string[]).includes(id)) throw notFound();
  const s = SETTINGS[id as SettingId];
  if (s.changeBy !== 'ADM') throw new AppError(403, 'GEN-03');
  const b = (body ?? {}) as { value?: unknown; reason?: unknown };
  const reason = F.parseFields(b, { reason: { label: 'Reason', required: true, rule: F.shortText } }) as { reason: string };
  const bad = rangeCheck(s.value, b.value, id);
  if (bad) throw new AppError(422, 'ADM-05', describeRange(s.value), [{ field: 'value', code: 'ADM-05', params: describeRange(s.value) }]);
  try {
    return await db.transaction(async (tx) => {
      const [cur] = await tx.select().from(configValues).where(eq(configValues.id, id));
      const [c] = await tx.insert(configChanges).values({ settingId: id, oldValue: (cur?.value ?? s.value), newValue: b.value, reason: reason.reason, status: 'PENDING_APPROVAL', requestedBy: auth.userId, requestedAt: clock.now() }).returning();
      await notifyRoles(tx, ['ADM'], { messageId: 'DSH-20', params: { 'Item type': 'Configuration change', name: `${id} ${s.setting}` }, link: { type: 'CONFIG', id: c!.id }, dedupeKey: `cfg:${c!.id}` });
      await audit(tx, req, { action: 'CONFIG_CHANGE_REQUESTED', entity: 'config', entityId: id, oldValue: cur?.value, newValue: { value: b.value, reason: reason.reason } });
      return { message: msg('ADM-04') };
    });
  } catch (err) {
    if (isUnique(err, 'config_one_pending')) throw new AppError(409, 'CAT-08');
    throw err;
  }
}

export async function decideConfigChange(req: Request, auth: AuthContext, changeId: string, approve: boolean, body: unknown) {
  if (!isUuid(changeId)) throw notFound();
  const result = await db.transaction(async (tx) => {
    const [c] = await tx.select().from(configChanges).where(eq(configChanges.id, changeId)).for('update');
    if (!c) throw notFound();
    if (c.status !== 'PENDING_APPROVAL') throw stateConflict('configuration change', c.status);
    if (auth.role !== 'ADM') throw forbidden();
    if (c.requestedBy === auth.userId) throw new AppError(403, 'CAT-05');
    if (!approve) {
      const reason = F.parseFields(body, { reason: { label: 'Reason', required: true, rule: F.notes } }) as { reason: string };
      await tx.update(configChanges).set({ status: 'REJECTED', rejectReason: reason.reason, decidedBy: auth.userId, decidedAt: clock.now() }).where(eq(configChanges.id, c.id));
      await audit(tx, req, { action: 'CONFIG_CHANGE_REJECTED', entity: 'config', entityId: c.settingId, newValue: reason });
      return { message: msg('CAT-04', { Item: c.settingId, reason: reason.reason }) };
    }
    const [cur] = await tx.select().from(configValues).where(eq(configValues.id, c.settingId)).for('update');
    // The value changed since the request: refuse (CAT-29)
    if (JSON.stringify(cur?.value) !== JSON.stringify(c.oldValue)) throw new AppError(409, 'CAT-29');
    const ticket = await consumeStepUp(tx, auth, req.get('x-step-up-token'), 'CONFIG_CHANGE');
    await tx.update(configValues).set({ value: c.newValue, updatedAt: clock.now(), updatedBy: auth.userId }).where(eq(configValues.id, c.settingId));
    await tx.update(configChanges).set({ status: 'APPLIED', decidedBy: auth.userId, decidedAt: clock.now(), approvalTicketId: ticket }).where(eq(configChanges.id, c.id));
    await audit(tx, req, { action: 'CONFIG_CHANGE_APPLIED', entity: 'config', entityId: c.settingId, oldValue: c.oldValue, newValue: { value: c.newValue, ticket } });
    return { message: msg('ADM-06') };
  });
  await settings.refresh();
  return result;
}

export async function configHistory() {
  const rows = await db.select({ c: configChanges, by: users.name }).from(configChanges).leftJoin(users, eq(users.id, configChanges.requestedBy)).orderBy(desc(configChanges.requestedAt)).limit(200);
  const names = new Map((await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.role, ['ADM']))).map((u) => [u.id, u.name]));
  return { items: rows.map(({ c, by }) => ({ id: c.id, settingId: c.settingId, oldValue: c.oldValue, newValue: c.newValue, reason: c.reason, status: c.status, requestedBy: by, requestedAt: c.requestedAt.toISOString(), decidedBy: c.decidedBy ? names.get(c.decidedBy) ?? null : null, decidedAt: c.decidedAt?.toISOString() ?? null, rejectReason: c.rejectReason })) };
}

export async function pendingConfig() {
  const rows = await db.select({ c: configChanges, by: users.name }).from(configChanges).leftJoin(users, eq(users.id, configChanges.requestedBy)).where(eq(configChanges.status, 'PENDING_APPROVAL'));
  return rows.map(({ c, by }) => ({ kind: 'CONFIG', id: c.id, title: `${c.settingId} ${SETTINGS[c.settingId as SettingId]?.setting ?? ''}`, makers: [by ?? ''], makerIds: [c.requestedBy], submittedAt: c.requestedAt.toISOString() }));
}

// ======================= P-50 =======================
const PERSONAL = /mobile|email|pan|aadhaar|address|dateOfBirth|name/i;
function mask(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(mask);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, PERSONAL.test(k) && typeof x === 'string' ? (k.toLowerCase().includes('mobile') ? maskMobile(x) : `${x.slice(0, 1)}•••`) : mask(x)]));
  return v;
}

function auditFilter(auth: AuthContext, f: Record<string, string | undefined>): SQL[] {
  const conds: SQL[] = [];
  if (auth.role === 'ADV') conds.push(eq(auditLog.accountId, auth.accountId!));
  else if (f.accountId && isUuid(f.accountId)) conds.push(eq(auditLog.accountId, f.accountId));
  if (f.userId && isUuid(f.userId)) conds.push(eq(auditLog.actorUserId, f.userId));
  if (f.entity) conds.push(eq(auditLog.entity, f.entity));
  if (f.entityId) conds.push(eq(auditLog.entityId, f.entityId));
  if (f.action) conds.push(ilike(auditLog.action, `%${f.action.replace(/[%_\\]/g, '')}%`));
  if (f.from && /^\d{4}-\d{2}-\d{2}$/.test(f.from)) conds.push(gte(auditLog.at, new Date(`${f.from}T00:00:00+05:30`)));
  if (f.to && /^\d{4}-\d{2}-\d{2}$/.test(f.to)) conds.push(lt(auditLog.at, new Date(new Date(`${f.to}T00:00:00+05:30`).getTime() + 86_400_000)));
  return conds;
}

export async function listAudit(auth: AuthContext, f: Record<string, string | undefined>) {
  const conds = auditFilter(auth, f);
  const page = Math.max(1, Number(f.page) || 1);
  const size = settings.get('CFG-23');
  const rows = await db.select({ a: auditLog, who: users.name }).from(auditLog).leftJoin(users, eq(users.id, auditLog.actorUserId)).where(and(...conds)).orderBy(desc(auditLog.at)).limit(size).offset((page - 1) * size);
  const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(auditLog).where(and(...conds))) as [{ n: number }];
  const personal = auth.role !== 'ADV';
  return {
    items: rows.map(({ a, who }) => ({ id: a.id, at: a.at.toISOString(), who: who ?? a.actorJob ?? 'System', role: a.actorRole, action: a.action, entity: a.entity, entityId: a.entityId, oldValue: personal ? mask(a.oldValue) : a.oldValue, newValue: personal ? mask(a.newValue) : a.newValue, result: a.result, requestId: a.requestId, accountId: a.accountId })),
    total: n,
    page,
    pageSize: size,
  };
}

const csv = (v: unknown) => {
  const s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function exportAudit(req: Request, auth: AuthContext, f: Record<string, string | undefined>) {
  const conds = auditFilter(auth, f);
  const rows = await db.select({ a: auditLog, who: users.name }).from(auditLog).leftJoin(users, eq(users.id, auditLog.actorUserId)).where(and(...conds)).orderBy(desc(auditLog.at)).limit(50_000);
  const lines = ['time,who,role,action,record,record id,old value,new value,result,request id'];
  for (const { a, who } of rows) lines.push([a.at.toISOString(), who ?? a.actorJob ?? 'System', a.actorRole, a.action, a.entity, a.entityId, mask(a.oldValue), mask(a.newValue), a.result, a.requestId].map(csv).join(','));
  return db.transaction(async (tx) => {
    if (auth.role === 'ADM') await consumeStepUp(tx, auth, req.get('x-step-up-token'), 'EXPORT');
    const file = await storeGenerated(auth.accountId, auth.userId, 'AUDIT_EXPORT', `audit-${istToday()}.csv`, Buffer.from(lines.join('\n'), 'utf8'), 'text/csv');
    await audit(tx, req, { action: 'AUDIT_EXPORTED', entity: 'audit', entityId: null, newValue: { filters: f, rows: rows.length } });
    return { ...fileLink(auth.userId, auth.sessionId, file.id), rows: rows.length };
  });
}

// ======================= P-51 =======================
export async function listAccounts(f: { q?: string; status?: string; page?: number }) {
  const conds: SQL[] = [eq(users.role, 'ADV')];
  if (f.status && ['ACTIVE', 'SUSPENDED', 'CLOSED'].includes(f.status)) conds.push(eq(accounts.status, f.status));
  if (f.q) conds.push(or(ilike(users.name, `%${f.q.replace(/[%_\\]/g, '')}%`), ilike(advisorProfiles.businessName, `%${f.q.replace(/[%_\\]/g, '')}%`))!);
  const page = Math.max(1, f.page ?? 1);
  const size = settings.get('CFG-23');
  const rows = await db
    .select({ a: accounts, name: users.name, business: advisorProfiles.businessName, s: subscriptions })
    .from(accounts)
    .innerJoin(users, eq(users.accountId, accounts.id))
    .leftJoin(advisorProfiles, eq(advisorProfiles.accountId, accounts.id))
    .leftJoin(subscriptions, and(eq(subscriptions.accountId, accounts.id), eq(subscriptions.isCurrent, true)))
    .where(and(...conds))
    .orderBy(desc(accounts.createdAt))
    .limit(size)
    .offset((page - 1) * size);
  const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(accounts).innerJoin(users, eq(users.accountId, accounts.id)).leftJoin(advisorProfiles, eq(advisorProfiles.accountId, accounts.id)).where(and(...conds))) as [{ n: number }];
  return { items: rows.map(({ a, name, business, s }) => ({ id: a.id, advisor: name, businessName: business, status: a.status, plan: s?.plan ?? null, subscription: s?.status ?? null, periodEnd: s?.periodEnd ?? null, createdAt: a.createdAt.toISOString() })), total: n, page, pageSize: size };
}

/** Support summary: counts only, never customer names or contact details (AC-P51-3). */
export async function accountSummary(auth: AuthContext, id: string) {
  if (!isUuid(id)) throw notFound();
  const [a] = await db.select().from(accounts).where(eq(accounts.id, id));
  if (!a) throw notFound();
  const [adv] = await db.select().from(users).where(and(eq(users.accountId, id), eq(users.role, 'ADV')));
  const count = async (t: typeof leads | typeof customers | typeof quotations | typeof policies) => ((await db.select({ n: sql<number>`count(*)::int` }).from(t).where(eq(t.accountId, id)))[0]?.n ?? 0);
  const msgs = await db.select({ channel: outgoingMessages.channel, n: sql<number>`count(*)::int` }).from(outgoingMessages).where(eq(outgoingMessages.accountId, id)).groupBy(outgoingMessages.channel);
  const [w] = await db.select().from(wallets).where(eq(wallets.accountId, id));
  return {
    id: a.id,
    status: a.status,
    statusReason: a.statusReason,
    createdAt: a.createdAt.toISOString(),
    advisor: { name: adv?.name ?? '', lastLoginAt: adv?.lastLoginAt?.toISOString() ?? null },
    plan: await planView(auth, id),
    counts: { leads: await count(leads), customers: await count(customers), quotations: await count(quotations), policies: await count(policies) },
    messages: Object.fromEntries(msgs.map((m) => [m.channel, m.n])),
    walletBalance: w?.balance ?? '0.00',
    version: a.version,
  };
}

export const SUSPEND_REASONS = ['Misuse or spam complaints', 'Suspected fraud', 'Requested by the advisor', 'Legal request', 'Other'] as const;

export async function changeAccountStatus(req: Request, auth: AuthContext, id: string, to: 'SUSPENDED' | 'ACTIVE' | 'CLOSED', body: unknown) {
  if (auth.role !== 'ADM') throw forbidden();
  const v = F.parseFields(body, { reason: { label: 'Reason', required: true, rule: F.notes } }) as { reason: string };
  if (!isUuid(id)) throw notFound();
  return db.transaction(async (tx) => {
    const [a] = await tx.select().from(accounts).where(eq(accounts.id, id)).for('update');
    if (!a) throw notFound();
    if (a.version !== readVersion(body)) throw versionConflict('account');
    const allowed = to === 'SUSPENDED' ? a.status === 'ACTIVE' : to === 'ACTIVE' ? a.status === 'SUSPENDED' : a.status !== 'CLOSED';
    if (!allowed) throw stateConflict('account', a.status);
    const ticket = await consumeStepUp(tx, auth, req.get('x-step-up-token'), 'ACCOUNT_STATUS');
    await tx.update(accounts).set({ status: to, statusReason: v.reason, closedAt: to === 'CLOSED' ? clock.now() : a.closedAt, version: a.version + 1 }).where(eq(accounts.id, id));
    if (to !== 'ACTIVE') {
      // Sessions of the advisor, assistants and referrers end; referral links stop; queued messages cancelled
      const people = await tx.select({ id: users.id }).from(users).where(eq(users.accountId, id));
      for (const u of people) await endAllSessions(tx, u.id, to === 'CLOSED' ? 'ACCOUNT_CLOSED' : 'ACCOUNT_SUSPENDED');
      await tx.update(referralCodes).set({ status: 'REVOKED', revokedAt: clock.now() }).where(and(eq(referralCodes.accountId, id), eq(referralCodes.status, 'ACTIVE')));
      await cancelWhere(tx, id, to === 'CLOSED' ? 'Account closed' : 'Account suspended');
    }
    await audit(tx, req, { action: `ACCOUNT_${to}`, entity: 'account', entityId: id, accountId: id, oldValue: { status: a.status }, newValue: { status: to, reason: v.reason, ticket } });
    return { message: to === 'SUSPENDED' ? msg('ADM-07') : to === 'ACTIVE' ? msg('ADM-08') : msg('ADM-09', { date: 'never deleted automatically (CFG-87)' }) };
  });
}


