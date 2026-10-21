import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { notifications, sessions, subscriptions, users } from '../src/db/schema.js';
import { addDays, formatDate, istToday } from '../src/lib/clock.js';
import { runJob } from '../src/modules/jobs/jobs.js';
import { notify } from '../src/modules/notifications/notifications.service.js';
import { settings } from '../src/modules/settings/settings.service.js';
import { Device, advance, advisor, ensureTypes, key, lastCode, login, newMobile, resetClock, resetSettings, setSetting, userByMobile } from './helpers.js';

beforeAll(async () => {
  await settings.init();
  await ensureTypes();
});
afterEach(async () => {
  resetClock();
  await resetSettings();
});

const IST_MS = 330 * 60_000;
/** IST date and time n minutes from now */
const inMinutes = (n: number) => {
  const s = new Date(Date.now() + n * 60_000 + IST_MS).toISOString();
  return { dueDate: s.slice(0, 10), dueTime: s.slice(11, 16) };
};

describe('P-11 Tasks and follow-ups', () => {
  it('AC-P11-1: a task due in the past cannot be saved (DSH-24); required fields give GEN-01', async () => {
    const { d } = await advisor();
    const past = await d.post('/tasks', { title: 'Call back', ...inMinutes(-10) }, { 'idempotency-key': key() });
    expect(past.status).toBe(422);
    expect(past.body.error.code).toMatch(/DSH-24|VAL-07/);
    const empty = await d.post('/tasks', {}, { 'idempotency-key': key() });
    expect(empty.body.error.fields.map((f: { message: string }) => f.message)).toEqual(['Title is required.', 'Due date is required.', 'Due time is required.']);
  });

  it('tabs Overdue / Today / Upcoming / Done; mark done (DSH-23), reopen, cancel; GEN-04 for a cancelled task', async () => {
    const { d } = await advisor();
    const t1 = (await d.post('/tasks', { title: 'Soon', ...inMinutes(5) }, { 'idempotency-key': key() })).body.task;
    const tomorrow = formatDate(addDays(istToday(), 2));
    await d.post('/tasks', { title: 'Later', dueDate: tomorrow, dueTime: '10:30 AM' }, { 'idempotency-key': key() });
    advance(10 * 60_000);
    await d.post('/auth/keep-alive');
    expect((await d.get('/tasks?tab=overdue')).body.items.map((t: { title: string }) => t.title)).toEqual(['Soon']);
    expect((await d.get('/tasks?tab=upcoming')).body.items.map((t: { title: string }) => t.title)).toEqual(['Later']);
    const done = await d.post(`/tasks/${t1.id}/done`, { version: t1.version }, { 'idempotency-key': key() });
    expect(done.body.message.text).toBe('Task marked as done.');
    expect((await d.get('/tasks?tab=done')).body.items).toHaveLength(1);
    const re = await d.post(`/tasks/${t1.id}/reopen`, { version: done.body.task.version }, { 'idempotency-key': key() });
    const cancel = await d.post(`/tasks/${t1.id}/cancel`, { version: re.body.task.version }, { 'idempotency-key': key() });
    expect(cancel.body.task.status).toBe('CANCELLED');
    const again = await d.post(`/tasks/${t1.id}/done`, { version: cancel.body.task.version }, { 'idempotency-key': key() });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('GEN-04');
  });

  it('editing a task another tab changed gets GEN-05', async () => {
    const { d } = await advisor();
    const t = (await d.post('/tasks', { title: 'Edit me', ...inMinutes(120) }, { 'idempotency-key': key() })).body.task;
    expect((await d.post(`/tasks/${t.id}`, { title: 'First', ...inMinutes(120), version: t.version })).status).toBe(200);
    const second = await d.post(`/tasks/${t.id}`, { title: 'Second', ...inMinutes(120), version: t.version });
    expect(second.body.error.code).toBe('GEN-05');
  });

  it('AC-P11-2: the reminder (DSH-11) arrives once, CFG-34 before the due time; a new due time allows one new reminder', async () => {
    const { d, user } = await advisor();
    const t = (await d.post('/tasks', { title: 'Call Ravi', ...inMinutes(45) }, { 'idempotency-key': key() })).body.task;
    await runJob('task-reminders');
    const count = async () => (await db.select().from(notifications).where(and(eq(notifications.userId, user.id), eq(notifications.messageId, 'DSH-11')))).length;
    expect(await count()).toBe(0); // 45 minutes away, reminder window is 30
    advance(16 * 60_000);
    await runJob('task-reminders');
    await runJob('task-reminders');
    expect(await count()).toBe(1);
    const [n] = await db.select().from(notifications).where(and(eq(notifications.userId, user.id), eq(notifications.messageId, 'DSH-11')));
    expect(n!.text).toMatch(/^Follow-up with Call Ravi is due at \d{2}:\d{2} (AM|PM)\.$/);
    await d.post('/auth/keep-alive');
    const later = new Date(Date.now() + advanceMs() + 50 * 60_000 + IST_MS).toISOString();
    await d.post(`/tasks/${t.id}`, { title: 'Call Ravi', dueDate: later.slice(0, 10), dueTime: later.slice(11, 16), version: t.version });
    advance(30 * 60_000);
    await d.post('/auth/keep-alive');
    await runJob('task-reminders');
    expect(await count()).toBe(2);
  });

  it('AC-P11-4 and P-08: overdue tasks appear on the dashboard; no other account sees them', async () => {
    const { d } = await advisor();
    await d.post('/tasks', { title: 'Overdue soon', ...inMinutes(2) }, { 'idempotency-key': key() });
    advance(5 * 60_000);
    await d.post('/auth/keep-alive');
    const w = (await d.get('/dashboard/tasks')).body;
    expect(w.items[0].title).toBe('Overdue soon');
    expect(w.items[0].overdue).toBe(true);
    const other = await advisor();
    expect((await other.d.get('/dashboard/tasks')).body.items).toHaveLength(0);
    expect((await other.d.get('/dashboard/tasks')).body.empty.code).toBe('DSH-04');
  });
});

// The test clock offset in milliseconds (so dates computed with Date.now() follow it)
import { clock } from '../src/lib/clock.js';
const advanceMs = () => clock.offset();

describe('P-08 Advisor dashboard', () => {
  it('trial banner SUB-04; grace SUB-05; read-only SUB-03', async () => {
    const { d, accountId } = await advisor();
    expect((await d.get('/dashboard/banners')).body.items[0]).toMatchObject({ code: 'SUB-04', text: 'Your free trial ends in 7 days.' });
    await db.update(subscriptions).set({ status: 'GRACE', plan: 'NORMAL', periodEnd: addDays(istToday(), -2) }).where(eq(subscriptions.accountId, accountId));
    expect((await d.get('/dashboard/banners')).body.items[0].text).toBe(`Your plan ended on ${formatDate(addDays(istToday(), -2))}. Renew within 5 days to keep full access.`);
    await db.update(subscriptions).set({ status: 'EXPIRED' }).where(eq(subscriptions.accountId, accountId));
    expect((await d.get('/dashboard/banners')).body.items[0].code).toBe('SUB-03');
    // GR-33: read-only blocks creating
    const r = await d.post('/tasks', { title: 'Blocked', ...inMinutes(60) }, { 'idempotency-key': key() });
    expect(r.body.error.code).toBe('SUB-03');
  });

  it('recent activity lists record events of this account only', async () => {
    const { d } = await advisor();
    await d.post('/tasks', { title: 'Visible task', ...inMinutes(90) }, { 'idempotency-key': key() });
    const a = (await d.get('/dashboard/activity')).body.items;
    expect(a[0].text).toBe('Task created: Visible task');
    const other = await advisor();
    expect((await other.d.get('/dashboard/activity')).body.items.some((x: { text: string }) => x.text.includes('Visible task'))).toBe(false);
  });
});

describe('P-10 Bell notifications', () => {
  it('AC-P10-1/2/3: one item per event, count = unread, reading marks READ; only own items', async () => {
    const { d, user, accountId } = await advisor();
    for (let i = 0; i < 2; i++) await notify(db, { userId: user.id, accountId, messageId: 'DSH-23', dedupeKey: 'test:same-event' });
    await notify(db, { userId: user.id, accountId, messageId: 'DSH-15', params: { 'Quotation number': 'QT-202610-00001', customer: 'Ravi' }, dedupeKey: 'test:other', link: { type: 'QUOTATION', id: 'x' } });
    const list = (await d.get('/notifications')).body;
    expect(list.unread).toBe(2);
    expect(list.items).toHaveLength(2);
    expect(list.items[0].text).toBe('QT-202610-00001 for Ravi has expired.');
    const r = await d.post(`/notifications/${list.items[0].id}/read`);
    expect(r.body.link).toEqual({ type: 'QUOTATION', id: 'x' });
    expect((await d.get('/notifications')).body.unread).toBe(1);
    const other = await advisor();
    expect((await other.d.post(`/notifications/${list.items[1].id}/read`)).status).toBe(404);
    await d.post('/notifications/read-all');
    expect((await d.get('/notifications')).body.unread).toBe(0);
  });

  it('the badge shows "{CFG-149}+" above the cap', async () => {
    const { d, user } = await advisor();
    await setSetting('CFG-149', 2);
    for (let i = 0; i < 3; i++) await notify(db, { userId: user.id, messageId: 'DSH-23', dedupeKey: `cap:${i}` });
    expect((await d.get('/notifications')).body.badge).toBe('2+');
  });
});

async function addAssistant(d: Device, advisorMobile: string, body: object) {
  const s = await d.post('/auth/step-up/send-otp', { action: 'ADD_ASSISTANT' });
  const v = await d.post('/auth/step-up/verify', { challengeId: s.body.challengeId, code: lastCode(advisorMobile) });
  return d.post('/assistants', body, { 'idempotency-key': key(), 'x-step-up-token': v.body.stepUpToken });
}

describe('P-53 Manage assistant users', () => {
  it('adding needs the extra OTP; the assistant logs in to the advisor\'s dashboard; AST-01', async () => {
    const { d, mobile } = await advisor('Asha Rao');
    const m = newMobile();
    const noOtp = await d.post('/assistants', { name: 'Helper One', mobile: m }, { 'idempotency-key': key() });
    expect(noOtp.status).toBe(403);
    expect(noOtp.body.error.code).toBe('AUTH-26');
    const r = await addAssistant(d, mobile, { name: 'Helper One', mobile: m });
    expect(r.body.message.text).toBe('Assistant Helper One added. They can log in with their mobile number.');
    const ast = new Device();
    const { verify } = await login(ast, m);
    expect(verify.body.redirectTo).toBe('/dashboard');
    expect(verify.body.message.code).toBe('AUTH-12');
    const me = (await ast.get('/auth/me')).body;
    expect(me.user.role).toBe('AST');
    expect(me.accountName).toBe('Asha Rao');
    // Assistants cannot manage assistants or change the profile (Section 3.2)
    expect((await ast.get('/assistants')).status).toBe(403);
    expect((await ast.post('/tasks', { title: 'Data entry', ...inMinutes(60) }, { 'idempotency-key': key() })).status).toBe(200);
  });

  it('REF-02 for a number that already has access; AST-02 at the limit (CFG-158); AST-04 on the Normal plan', async () => {
    const { d, mobile, accountId } = await advisor();
    expect((await addAssistant(d, mobile, { name: 'Dup Number', mobile })).body.error.code).toBe('REF-02');
    await addAssistant(d, mobile, { name: 'Helper A', mobile: newMobile() });
    await addAssistant(d, mobile, { name: 'Helper B', mobile: newMobile() });
    const third = await addAssistant(d, mobile, { name: 'Helper C', mobile: newMobile() });
    expect(third.body.error.message).toBe('Your plan allows up to 2 assistants.');
    await db.update(subscriptions).set({ status: 'ACTIVE', plan: 'NORMAL' }).where(eq(subscriptions.accountId, accountId));
    const normal = await d.post('/assistants', { name: 'Helper D', mobile: newMobile() }, { 'idempotency-key': key() });
    expect(normal.body.error.code).toBe('AST-04');
  });

  it('disabling ends the assistant\'s sessions at once (AST-03); enable reverses it', async () => {
    const { d, mobile } = await advisor();
    const m = newMobile();
    await addAssistant(d, mobile, { name: 'Helper Two', mobile: m });
    const ast = new Device();
    await login(ast, m);
    const a = (await userByMobile(m))!;
    const r = await d.post(`/assistants/${a.id}/disable`);
    expect(r.body.message.text).toBe('Assistant Helper Two can no longer log in.');
    expect((await ast.get('/auth/me')).status).toBe(401);
    const open = await db.select().from(sessions).where(eq(sessions.userId, a.id));
    expect(open.every((s) => s.endedAt)).toBe(true);
    const list = (await d.get('/assistants')).body.items;
    expect(list[0].status).toBe('DISABLED');
    expect(list[0].mobile).toMatch(/^\d{2}XXXXXX\d{2}$/);
    await d.post(`/assistants/${a.id}/enable`);
    expect((await db.select({ s: users.status }).from(users).where(eq(users.id, a.id)))[0]!.s).toBe('ACTIVE');
  });
});
