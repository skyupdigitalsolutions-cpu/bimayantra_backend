// P-53 Manage assistant users (Premium or Trial). Adding one needs the extra OTP (AUTH-26).
// Disabling ends the assistant's sessions at once (AST-03). Every assistant action is audited under their own ID.
import type { Request } from 'express';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { auditLog, users } from '../../db/schema.js';
import { clock } from '../../lib/clock.js';
import { AppError, fieldError, forbidden, notFound, stateConflict } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import { maskMobile } from '../../lib/mask.js';
import { msg } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { allowsAssistants, currentSubscription } from '../accounts/accounts.service.js';
import { audit } from '../audit/audit.js';
import { consumeStepUp } from '../auth/auth.service.js';
import { endAllSessions } from '../auth/sessions.service.js';
import { settings } from '../settings/settings.service.js';

async function planCheck(accountId: string) {
  if (!allowsAssistants(await currentSubscription(db, accountId))) throw forbidden('AST-04');
}

async function activeCount(accountId: string, exceptId?: string) {
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.accountId, accountId), eq(users.role, 'AST'), inArray(users.status, ['INVITED', 'ACTIVE']), exceptId ? ne(users.id, exceptId) : sql`true`));
  return n;
}

export async function listAssistants(accountId: string) {
  const list = await db
    .select({ id: users.id, name: users.name, mobile: users.mobile, status: users.status, lastLoginAt: users.lastLoginAt, invitedAt: users.invitedAt, version: users.version })
    .from(users)
    .where(and(eq(users.accountId, accountId), eq(users.role, 'AST')))
    .orderBy(users.createdAt);
  const n = settings.get('CFG-130');
  const items = [];
  for (const a of list) {
    const actions = await db
      .select({ at: auditLog.at, action: auditLog.action, entity: auditLog.entity })
      .from(auditLog)
      .where(and(eq(auditLog.actorUserId, a.id), eq(auditLog.accountId, accountId)))
      .orderBy(desc(auditLog.at))
      .limit(n);
    items.push({ ...a, mobile: maskMobile(a.mobile), recentActions: actions });
  }
  const s = await currentSubscription(db, accountId);
  return { items, limit: settings.get('CFG-158'), allowed: allowsAssistants(s) };
}

export async function addAssistant(req: Request, auth: AuthContext, body: unknown) {
  const accountId = auth.accountId!;
  await planCheck(accountId);
  const v = F.parseFields(body, {
    name: { label: 'Name', required: true, rule: F.personName },
    mobile: { label: 'Mobile number', required: true, rule: F.mobile },
  }) as { name: string; mobile: string };
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.mobile, v.mobile));
  if (existing) throw fieldError('mobile', 'REF-02');
  return db.transaction(async (tx) => {
    await consumeStepUp(tx, auth, req.get('x-step-up-token'), 'ADD_ASSISTANT');
    // Lock the advisor row so two simultaneous adds cannot both pass the limit
    await tx.select({ id: users.id }).from(users).where(eq(users.id, auth.userId)).for('update');
    if ((await activeCount(accountId)) >= settings.get('CFG-158')) throw new AppError(409, 'AST-02');
    try {
      const [u] = await tx
        .insert(users)
        .values({ accountId, role: 'AST', name: v.name, mobile: v.mobile, status: 'INVITED', invitedBy: auth.userId, invitedAt: clock.now(), createdAt: clock.now() })
        .returning({ id: users.id });
      await audit(tx, req, { action: 'ASSISTANT_ADDED', entity: 'user', entityId: u!.id, newValue: { name: v.name, mobile: maskMobile(v.mobile), role: 'AST' } });
      return { id: u!.id, message: msg('AST-01', { name: v.name }) };
    } catch (err) {
      const e = err as { code?: string; cause?: { code?: string } };
      if (e.code === '23505' || e.cause?.code === '23505') throw fieldError('mobile', 'REF-02');
      throw err;
    }
  });
}

async function ownAssistant(accountId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound();
  const [a] = await db.select().from(users).where(and(eq(users.id, id), eq(users.accountId, accountId), eq(users.role, 'AST')));
  if (!a) throw notFound();
  return a;
}

export async function disableAssistant(req: Request, auth: AuthContext, id: string) {
  const a = await ownAssistant(auth.accountId!, id);
  if (a.status === 'DISABLED') throw stateConflict('assistant', a.status);
  await db.transaction(async (tx) => {
    await tx.update(users).set({ status: 'DISABLED', version: sql`${users.version} + 1` }).where(eq(users.id, a.id));
    await endAllSessions(tx, a.id, 'USER_DISABLED');
    await audit(tx, req, { action: 'ASSISTANT_DISABLED', entity: 'user', entityId: a.id, oldValue: { status: a.status }, newValue: { status: 'DISABLED' } });
  });
  return { message: msg('AST-03', { name: a.name }) };
}

export async function enableAssistant(req: Request, auth: AuthContext, id: string) {
  const a = await ownAssistant(auth.accountId!, id);
  if (a.status !== 'DISABLED') throw stateConflict('assistant', a.status);
  await planCheck(auth.accountId!);
  if ((await activeCount(auth.accountId!, a.id)) >= settings.get('CFG-158')) throw new AppError(409, 'AST-02');
  const to = a.activatedAt ? 'ACTIVE' : 'INVITED'; // "Enable reverses it"
  await db.update(users).set({ status: to, version: sql`${users.version} + 1` }).where(eq(users.id, a.id));
  await audit(db, req, { action: 'ASSISTANT_ENABLED', entity: 'user', entityId: a.id, oldValue: { status: 'DISABLED' }, newValue: { status: to } });
  return { status: to };
}
