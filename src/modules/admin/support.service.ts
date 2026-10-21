// P-57 Support grants: SkyUp may open an account's clients and documents read-only only while the advisor
// has given an ACTIVE grant (at most CFG-159 hours); every record opened is logged and the advisor sees the
// log live. Without a grant SkyUp gets SUP-03 (logged). Full Aadhaar or PAN is never shown through it.
import type { Request } from 'express';
import { and, desc, eq, gt, inArray, lt } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { supportGrants, supportViews, users } from '../../db/schema.js';
import { clock, formatIstTime } from '../../lib/clock.js';
import { AppError, fieldErrors, forbidden, notFound, stateConflict } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import { msg } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { consumeStepUp } from '../auth/auth.service.js';
import { isUuid } from '../clients/common.js';
import { defineJob } from '../jobs/jobs.js';
import { settings } from '../settings/settings.service.js';
import { getCustomer, listCustomers } from '../customers/customers.service.js';
import { listDocuments } from '../documents/documents.service.js';
import { listFamily } from '../customers/family.service.js';

export async function supportPeople() {
  const rows = await db.select({ id: users.id, name: users.name, role: users.role }).from(users).where(and(inArray(users.role, ['STF', 'ADM']), eq(users.status, 'ACTIVE')));
  return { items: rows, maxHours: settings.get('CFG-159') };
}

export async function listGrants(auth: AuthContext) {
  const rows = await db.select({ g: supportGrants, name: users.name }).from(supportGrants).innerJoin(users, eq(users.id, supportGrants.staffUserId)).where(eq(supportGrants.accountId, auth.accountId!)).orderBy(desc(supportGrants.createdAt)).limit(50);
  const items = [];
  for (const { g, name } of rows) {
    const views = await db.select().from(supportViews).where(eq(supportViews.grantId, g.id)).orderBy(desc(supportViews.at));
    items.push({ id: g.id, staff: name, reason: g.reason, startsAt: g.startsAt.toISOString(), endsAt: g.endsAt.toISOString(), status: g.status === 'ACTIVE' && g.endsAt < clock.now() ? 'EXPIRED' : g.status, views: views.map((v) => ({ label: v.label, recordType: v.recordType, at: v.at.toISOString() })) });
  }
  return { items };
}

export async function giveGrant(req: Request, auth: AuthContext, body: unknown) {
  if (auth.role !== 'ADV') throw forbidden();
  const max = settings.get('CFG-159');
  const v = F.parseFields(body, { staffUserId: { label: 'SkyUp person', required: true }, reason: { label: 'Reason', required: true, rule: F.notes }, hours: { label: 'Duration', required: true, rule: F.wholeNumber(1, max) } }) as { staffUserId: string; reason: string; hours: number };
  const [staff] = isUuid(v.staffUserId) ? await db.select().from(users).where(and(eq(users.id, v.staffUserId), inArray(users.role, ['STF', 'ADM']), eq(users.status, 'ACTIVE'))) : [];
  if (!staff) throw fieldErrors([{ field: 'staffUserId', code: 'VAL-22' }]);
  return db.transaction(async (tx) => {
    const ticket = await consumeStepUp(tx, auth, req.get('x-step-up-token'), 'SUPPORT_GRANT');
    // A grant cannot be extended: an active one for this person is ended and a new one starts
    await tx.update(supportGrants).set({ status: 'ENDED', endedAt: clock.now(), endedBy: auth.userId }).where(and(eq(supportGrants.accountId, auth.accountId!), eq(supportGrants.staffUserId, staff.id), eq(supportGrants.status, 'ACTIVE')));
    const now = clock.now();
    const endsAt = new Date(now.getTime() + v.hours * 3600_000);
    const [g] = await tx.insert(supportGrants).values({ accountId: auth.accountId!, staffUserId: staff.id, reason: v.reason, startsAt: now, endsAt, status: 'ACTIVE', grantedBy: auth.userId, ticketId: ticket, createdAt: now }).returning();
    await audit(tx, req, { action: 'SUPPORT_GRANT_GIVEN', entity: 'support_grant', entityId: g!.id, newValue: { staff: staff.name, hours: v.hours, reason: v.reason } });
    return { message: msg('SUP-01', { name: staff.name, time: formatIstTime(endsAt) }) };
  });
}

export async function endGrant(req: Request, auth: AuthContext, id: string) {
  if (!isUuid(id)) throw notFound();
  const rows = await db.update(supportGrants).set({ status: 'ENDED', endedAt: clock.now(), endedBy: auth.userId }).where(and(eq(supportGrants.id, id), eq(supportGrants.accountId, auth.accountId!), eq(supportGrants.status, 'ACTIVE'))).returning();
  if (!rows.length) throw stateConflict('support grant', 'ENDED');
  await audit(db, req, { action: 'SUPPORT_GRANT_ENDED', entity: 'support_grant', entityId: id });
  return { message: msg('SUP-02') };
}

/** SkyUp side: my active grants. */
export async function myGrants(auth: AuthContext) {
  const rows = await db.select().from(supportGrants).where(and(eq(supportGrants.staffUserId, auth.userId), eq(supportGrants.status, 'ACTIVE'), gt(supportGrants.endsAt, clock.now())));
  const names = rows.length ? await db.select({ accountId: users.accountId, name: users.name }).from(users).where(and(inArray(users.accountId, rows.map((r) => r.accountId)), eq(users.role, 'ADV'))) : [];
  return { items: rows.map((g) => ({ id: g.id, accountId: g.accountId, advisor: names.find((n) => n.accountId === g.accountId)?.name ?? '', endsAt: g.endsAt.toISOString(), reason: g.reason })) };
}

/** Grant check on every request; logs the view, or refuses with SUP-03 (logged). */
async function grantFor(req: Request, auth: AuthContext, accountId: string, record: { type: string; id: string | null; label: string }) {
  if (auth.role !== 'STF' && auth.role !== 'ADM') throw forbidden();
  const [g] = isUuid(accountId) ? await db.select().from(supportGrants).where(and(eq(supportGrants.accountId, accountId), eq(supportGrants.staffUserId, auth.userId), eq(supportGrants.status, 'ACTIVE'), gt(supportGrants.endsAt, clock.now()))) : [];
  if (!g) {
    await audit(db, req, { action: 'SUPPORT_ACCESS_REFUSED', entity: record.type, entityId: record.id, accountId: isUuid(accountId) ? accountId : null, result: 'FAILURE' });
    throw new AppError(403, 'SUP-03');
  }
  await db.insert(supportViews).values({ grantId: g.id, accountId, staffUserId: auth.userId, recordType: record.type, recordId: record.id, label: record.label, at: clock.now() });
  const [adv] = await db.select({ name: users.name }).from(users).where(and(eq(users.accountId, accountId), eq(users.role, 'ADV')));
  // Read-only view as an assistant of that account would see it (masked identity numbers)
  return { asAuth: { ...auth, role: 'AST' as const, accountId, readOnly: true }, banner: `Support view of ${adv?.name ?? 'the advisor'} until ${formatIstTime(g.endsAt)}` };
}

export async function supportCustomers(req: Request, auth: AuthContext, accountId: string, q: string | undefined) {
  const { asAuth, banner } = await grantFor(req, auth, accountId, { type: 'customer', id: null, label: 'Customer list' });
  return { banner, ...(await listCustomers(asAuth, { q, page: 1 })) };
}

export async function supportCustomer(req: Request, auth: AuthContext, accountId: string, customerId: string) {
  const pre = await grantFor(req, auth, accountId, { type: 'customer', id: customerId, label: `Customer ${customerId.slice(0, 8)}` });
  const c = await getCustomer(pre.asAuth, customerId);
  await db.update(supportViews).set({ label: `Customer ${(c as { number?: string; fullName?: string }).number ?? ''} ${(c as { fullName?: string }).fullName ?? ''}`.trim() }).where(and(eq(supportViews.staffUserId, auth.userId), eq(supportViews.recordId, customerId)));
  return { banner: pre.banner, customer: { ...c, canReveal: false }, family: await listFamily(pre.asAuth, customerId), documents: await listDocuments(pre.asAuth, customerId) };
}

/** SYS-14: end grants older than CFG-159. */
export async function expireGrants() {
  const rows = await db.update(supportGrants).set({ status: 'EXPIRED', endedAt: clock.now() }).where(and(eq(supportGrants.status, 'ACTIVE'), lt(supportGrants.endsAt, clock.now()))).returning({ id: supportGrants.id });
  return rows.length;
}
defineJob('support-grant-expiry', async () => void (await expireGrants()), '*/5 * * * *');

