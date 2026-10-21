// P-11 Tasks and follow-ups. Times are IST (GR-25). A reminder (DSH-11) goes once per task and due time,
// CFG-34 before it; changing the due time allows one new reminder.
import type { Request } from 'express';
import { and, asc, desc, eq, gte, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { tasks, users } from '../../db/schema.js';
import { addDays, clock, formatIstTime, istToday } from '../../lib/clock.js';
import { fieldError, notFound, stateConflict, versionConflict } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import { msg } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { defineJob } from '../jobs/jobs.js';
import { notify } from '../notifications/notifications.service.js';
import { settings } from '../settings/settings.service.js';

type Task = typeof tasks.$inferSelect;
const IST_MS = 330 * 60_000;

/** IST date (YYYY-MM-DD) + time (HH:MM) → instant */
export const istInstant = (date: string, time: string) => new Date(new Date(`${date}T${time}:00Z`).getTime() - IST_MS);
const istParts = (at: Date) => {
  const s = new Date(at.getTime() + IST_MS).toISOString();
  return { date: s.slice(0, 10), time: s.slice(11, 16) };
};
const startOfIstDay = (date: string) => istInstant(date, '00:00');

function view(t: Task) {
  const p = istParts(t.dueAt);
  return {
    id: t.id,
    title: t.title,
    dueDate: p.date,
    dueTime: p.time,
    dueAt: t.dueAt.toISOString(),
    linked: t.linkedType ? { type: t.linkedType, id: t.linkedId } : null,
    notes: t.notes,
    status: t.status,
    overdue: t.status === 'OPEN' && t.dueAt < clock.now(),
    version: t.version,
  };
}

function validate(body: unknown) {
  const v = F.parseFields(body, {
    title: { label: 'Title', required: true, rule: F.shortText },
    dueDate: { label: 'Due date', required: true, rule: F.futureDate },
    dueTime: { label: 'Due time', required: true, rule: F.timeOfDay },
    notes: { label: 'Notes', rule: F.notes },
  }) as { title: string; dueDate: string; dueTime: string; notes?: string };
  const dueAt = istInstant(v.dueDate, v.dueTime);
  if (dueAt <= clock.now()) throw fieldError('dueTime', 'DSH-24'); // today, but not later than now
  // A task may link to a customer, quotation or renewal (P-11, P-38 Add follow-up); checked against the account
  const b = body as { linkedType?: unknown; linkedId?: unknown };
  if (b.linkedType && (typeof b.linkedType !== 'string' || !['CUSTOMER', 'QUOTATION', 'RENEWAL'].includes(b.linkedType))) throw fieldError('linkedType', 'VAL-22');
  if (b.linkedType && (typeof b.linkedId !== 'string' || !/^[0-9a-f-]{36}$/.test(b.linkedId))) throw fieldError('linkedId', 'VAL-22');
  return { title: v.title, dueAt, notes: v.notes ?? null, linkedType: typeof b.linkedType === 'string' ? b.linkedType : null, linkedId: typeof b.linkedType === 'string' ? (b.linkedId as string) : null };
}

export type Tab = 'overdue' | 'today' | 'upcoming' | 'done';

export async function listTasks(accountId: string, tab: Tab, page = 1) {
  const now = clock.now();
  const today = istToday();
  const tomorrow = startOfIstDay(addDays(today, 1));
  const size = settings.get('CFG-23');
  const own = eq(tasks.accountId, accountId); // GR-20
  const where = {
    overdue: and(own, eq(tasks.status, 'OPEN'), lt(tasks.dueAt, now)),
    today: and(own, eq(tasks.status, 'OPEN'), gte(tasks.dueAt, now), lt(tasks.dueAt, tomorrow)),
    upcoming: and(own, eq(tasks.status, 'OPEN'), gte(tasks.dueAt, tomorrow)),
    done: and(own, eq(tasks.status, 'DONE')),
  }[tab];
  const order = tab === 'done' ? desc(tasks.completedAt) : asc(tasks.dueAt);
  const rows = await db.select().from(tasks).where(where).orderBy(order).limit(size).offset((page - 1) * size);
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(tasks).where(where);
  return { items: rows.map(view), total: n, page, pageSize: size };
}

/** Dashboard "Today's tasks": OPEN and due today or overdue, oldest due first, up to CFG-130. */
export async function todaysTasks(accountId: string) {
  const tomorrow = startOfIstDay(addDays(istToday(), 1));
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.accountId, accountId), eq(tasks.status, 'OPEN'), lt(tasks.dueAt, tomorrow)))
    .orderBy(asc(tasks.dueAt))
    .limit(settings.get('CFG-130'));
  return rows.map(view);
}

async function own(accountId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound();
  const [t] = await db.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.accountId, accountId)));
  if (!t) throw notFound();
  return t;
}

export async function createTask(req: Request, auth: AuthContext, body: unknown) {
  const v = validate(body);
  if (v.linkedType) {
    const table = v.linkedType === 'CUSTOMER' ? 'customers' : v.linkedType === 'QUOTATION' ? 'quotations' : 'renewal_cycles';
    const found = await db.execute(sql`select 1 from ${sql.raw(table)} where id = ${v.linkedId} and account_id = ${auth.accountId}`);
    if (!found.rows.length) throw fieldError('linkedId', 'VAL-22');
  }
  const [t] = await db.insert(tasks).values({ accountId: auth.accountId!, ...v, createdBy: auth.userId, createdAt: clock.now() }).returning();
  await audit(db, req, { action: 'TASK_CREATED', entity: 'task', entityId: t!.id, newValue: { title: v.title, dueAt: v.dueAt } });
  return { task: view(t!), message: msg('GEN-08', { 'Record type': 'Task' }) };
}

export async function editTask(req: Request, auth: AuthContext, id: string, body: unknown) {
  const t = await own(auth.accountId!, id);
  if (t.status !== 'OPEN') throw stateConflict('task', t.status);
  const { title, dueAt, notes } = validate(body);
  const v = { title, dueAt, notes };
  const moved = v.dueAt.getTime() !== t.dueAt.getTime();
  const [row] = await db
    .update(tasks)
    .set({ ...v, ...(moved ? { remindedForDueAt: null } : {}), version: sql`${tasks.version} + 1` })
    .where(and(eq(tasks.id, t.id), eq(tasks.version, Number((body as { version?: unknown }).version)), eq(tasks.status, 'OPEN')))
    .returning();
  if (!row) throw versionConflict('task', ['title', 'dueDate', 'dueTime', 'notes']);
  await audit(db, req, { action: 'TASK_EDITED', entity: 'task', entityId: t.id, oldValue: { title: t.title, dueAt: t.dueAt, notes: t.notes }, newValue: v });
  return { task: view(row), message: msg('GEN-08', { 'Record type': 'Task' }) };
}

const ALLOWED: Record<string, string[]> = { OPEN: ['DONE', 'CANCELLED'], DONE: ['OPEN'], CANCELLED: [] };

/** Mark done (DSH-23), reopen, cancel — only the transitions in Section 4 (GR-21). */
export async function setTaskStatus(req: Request, auth: AuthContext, id: string, to: 'OPEN' | 'DONE' | 'CANCELLED', version: number) {
  const t = await own(auth.accountId!, id);
  if (!ALLOWED[t.status]!.includes(to)) throw stateConflict('task', t.status);
  const [row] = await db
    .update(tasks)
    .set({ status: to, completedAt: to === 'DONE' ? clock.now() : null, version: sql`${tasks.version} + 1` })
    .where(and(eq(tasks.id, t.id), eq(tasks.version, version), eq(tasks.status, t.status)))
    .returning();
  if (!row) throw versionConflict('task', ['status']);
  await audit(db, req, { action: `TASK_${to === 'OPEN' ? 'REOPENED' : to}`, entity: 'task', entityId: t.id, oldValue: { status: t.status }, newValue: { status: to } });
  return { task: view(row), message: to === 'DONE' ? msg('DSH-23') : null };
}

/** Every minute: DSH-11 reminders for tasks due within CFG-34 that have not had one for this due time. */
export async function sendTaskReminders(): Promise<number> {
  const now = clock.now();
  const until = new Date(now.getTime() + settings.get('CFG-34') * 60_000);
  const due = await db
    .select({ t: tasks, advisorId: users.id })
    .from(tasks)
    .innerJoin(users, and(eq(users.accountId, tasks.accountId), eq(users.role, 'ADV')))
    .where(and(eq(tasks.status, 'OPEN'), gte(tasks.dueAt, now), lte(tasks.dueAt, until), or(isNull(tasks.remindedForDueAt), ne(tasks.remindedForDueAt, tasks.dueAt))));
  for (const { t, advisorId } of due) {
    await db.transaction(async (tx) => {
      const claimed = await tx
        .update(tasks)
        .set({ remindedForDueAt: t.dueAt })
        .where(and(eq(tasks.id, t.id), or(isNull(tasks.remindedForDueAt), ne(tasks.remindedForDueAt, tasks.dueAt))))
        .returning({ id: tasks.id });
      if (!claimed.length) return; // another run already sent it (GR-28)
      await notify(tx, {
        userId: advisorId,
        accountId: t.accountId,
        messageId: 'DSH-11',
        params: { name: t.title, time: formatIstTime(t.dueAt) },
        dedupeKey: `task-reminder:${t.id}:${t.dueAt.toISOString()}`,
        link: { type: 'TASK', id: t.id },
      });
    });
  }
  return due.length;
}

defineJob('task-reminders', async () => void (await sendTaskReminders()), '* * * * *');
