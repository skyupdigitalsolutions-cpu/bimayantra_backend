// P-10 bell notifications. One item per dedupe key (event + record + date). Saved before any email is sent;
// an email failure never removes the bell item. Bell text never shows health details, PAN or full mobiles.
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.js';
import { notifications, users } from '../../db/schema.js';
import { clock } from '../../lib/clock.js';
import { render, type Params } from '../../messages/messages.js';
import { sendEmail } from '../email/email.js';
import { defineJob } from '../jobs/jobs.js';
import { settings } from '../settings/settings.service.js';

export type Notify = {
  userId: string;
  accountId?: string | null;
  messageId: string;
  params?: Params;
  link?: { type: string; id: string } | null;
  dedupeKey: string;
  /** Also email it to this address (KYC result, subscription ending) */
  email?: { to: string | null | undefined; subject: string };
};

export async function notify(dbx: DbOrTx, n: Notify): Promise<boolean> {
  const text = render(n.messageId, n.params);
  const rows = await dbx
    .insert(notifications)
    .values({
      userId: n.userId,
      accountId: n.accountId ?? null,
      messageId: n.messageId,
      text,
      linkType: n.link?.type ?? null,
      linkId: n.link?.id ?? null,
      dedupeKey: n.dedupeKey,
      createdAt: clock.now(),
    })
    .onConflictDoNothing()
    .returning({ id: notifications.id });
  if (rows.length && n.email?.to) await sendEmail({ to: n.email.to, subject: n.email.subject, text, dedupeKey: `${n.userId}:${n.dedupeKey}` });
  return rows.length > 0;
}

/** Notify every active SkyUp user with one of the roles (DSH-20, DSH-21). */
export async function notifyRoles(dbx: DbOrTx, roles: ('STF' | 'ADM')[], n: Omit<Notify, 'userId'>): Promise<void> {
  const list = await dbx.select({ id: users.id }).from(users).where(and(inArray(users.role, roles), eq(users.status, 'ACTIVE')));
  for (const u of list) await notify(dbx, { ...n, userId: u.id });
}

export async function listNotifications(userId: string, limit = 50) {
  const items = await db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
  const [{ unread } = { unread: 0 }] = await db
    .select({ unread: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.status, 'UNREAD')));
  return { items, unread, cap: settings.get('CFG-149') };
}

/** CFG-72: items older than this are removed. */
defineJob(
  'notifications-cleanup',
  async () => {
    const before = new Date(clock.now().getTime() - settings.get('CFG-72') * 86_400_000);
    await db.delete(notifications).where(lt(notifications.createdAt, before));
  },
  '17 3 * * *',
);
