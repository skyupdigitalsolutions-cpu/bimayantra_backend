// Outgoing messages (Section 4.3, P-37, P-41 to P-43, GR-26 to GR-28).
// - A message is saved (QUEUED, or SKIPPED with its reason) before anything is sent; the occurrence key is a
//   database unique rule, so a job that runs twice never queues the same message twice.
// - Just before sending, every rule is checked again; a failed check CANCELS or SKIPS it with the reason.
// - WhatsApp goes out only inside CFG-64 and only with an ACTIVE template; each message that reaches SENT
//   debits the wallet once (P-56). Temporary failures are retried CFG-67 times after CFG-68 minutes.
import { createHmac } from 'node:crypto';
import { and, desc, eq, gte, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db, type DbOrTx } from '../../db/client.js';
import { accounts, consents, customers, emailSuppressions, familyMembers, outgoingMessages, renewalCycles, quotationRevisions, whatsappNumbers } from '../../db/schema.js';
import { clock, istToday } from '../../lib/clock.js';
import { notFound, stateConflict, AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { maskMobile } from '../../lib/mask.js';
import { msg } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { currentSubscription, isPremium } from '../accounts/accounts.service.js';
import { registerMessageCanceller } from '../clients/hooks.js';
import { deliver } from '../email/email.js';
import { defineJob, enqueue } from '../jobs/jobs.js';
import { settings } from '../settings/settings.service.js';
import { activeTemplate, PURPOSE_NAMES, type Purpose } from './templates.js';
import { sendWhatsapp } from './whatsapp.js';
import type { Request } from 'express';

export type Message = typeof outgoingMessages.$inferSelect;
export type NewMessage = {
  accountId: string;
  customerId?: string | null;
  familyMemberId?: string | null;
  personName?: string | null;
  channel: 'EMAIL' | 'WHATSAPP';
  purpose: string;
  recipient: string;
  templateId?: string | null;
  templateVersion?: number | null;
  variables?: Record<string, string>;
  subject?: string | null;
  body: string;
  attachmentFileId?: string | null;
  occurrenceKey: string;
  relatedType?: string | null;
  relatedId?: string | null;
  resendOf?: string | null;
  createdBy?: string | null;
  status?: 'QUEUED' | 'SKIPPED' | 'SHARED_MANUALLY';
  reason?: string | null;
};

const NOT_SENT = ['FAILED', 'SKIPPED', 'CANCELLED', 'STATUS_UNKNOWN'];
const SENT_GROUP = ['SENT', 'DELIVERED', 'READ', 'SHARED_MANUALLY'];

/** Save a message. Returns null when its occurrence key already exists (repeat-safe). Call dispatch() after commit. */
export async function queueMessage(tx: DbOrTx, m: NewMessage): Promise<Message | null> {
  const now = clock.now();
  const [row] = await tx
    .insert(outgoingMessages)
    .values({
      accountId: m.accountId,
      customerId: m.customerId ?? null,
      familyMemberId: m.familyMemberId ?? null,
      personName: m.personName ?? null,
      channel: m.channel,
      purpose: m.purpose,
      recipient: m.recipient,
      templateId: m.templateId ?? null,
      templateVersion: m.templateVersion ?? null,
      variables: m.variables ?? {},
      subject: m.subject ?? null,
      body: m.body,
      attachmentFileId: m.attachmentFileId ?? null,
      occurrenceKey: m.occurrenceKey,
      status: m.status ?? 'QUEUED',
      reason: m.reason ?? null,
      relatedType: m.relatedType ?? null,
      relatedId: m.relatedId ?? null,
      resendOf: m.resendOf ?? null,
      createdBy: m.createdBy ?? null,
      statusAt: now,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

export async function dispatch(id: string, startAfterSeconds?: number): Promise<void> {
  await enqueue('send-message', { id }, { singletonKey: `msg:${id}`, ...(startAfterSeconds ? { startAfterSeconds } : {}) });
}

/** Messages of this account and channel created today (IST), for the daily limits CFG-69 and CFG-70. */
export async function sentToday(dbx: DbOrTx, accountId: string, channel: 'EMAIL' | 'WHATSAPP'): Promise<number> {
  const start = new Date(`${istToday()}T00:00:00+05:30`);
  const [r] = await dbx
    .select({ n: sql<number>`count(*)::int` })
    .from(outgoingMessages)
    .where(and(eq(outgoingMessages.accountId, accountId), eq(outgoingMessages.channel, channel), gte(outgoingMessages.createdAt, start), inArray(outgoingMessages.status, ['QUEUED', 'SENT', 'DELIVERED', 'READ'])));
  return r?.n ?? 0;
}
export const dailyLimit = (channel: 'EMAIL' | 'WHATSAPP') => (channel === 'EMAIL' ? settings.get('CFG-70') : settings.get('CFG-69'));

/** Consent for one person, channel and address: GIVEN, WITHDRAWN or NOT_RECORDED. */
export async function consentState(dbx: DbOrTx, customerId: string, familyMemberId: string | null, channel: 'EMAIL' | 'WHATSAPP', address: string): Promise<'GIVEN' | 'WITHDRAWN' | 'NOT_RECORDED'> {
  const rows = await dbx.select().from(consents).where(and(eq(consents.customerId, customerId), eq(consents.channel, channel)));
  const r = rows.find((x) => (x.familyMemberId ?? null) === (familyMemberId ?? null));
  if (!r || r.address !== address) return 'NOT_RECORDED';
  return r.status as 'GIVEN' | 'WITHDRAWN';
}

export async function emailSuppressed(dbx: DbOrTx, email: string): Promise<boolean> {
  const [r] = await dbx.select().from(emailSuppressions).where(eq(emailSuppressions.email, email.toLowerCase()));
  return !!r;
}

// ---------- checks at send time ----------
type Verdict = { status: 'CANCELLED' | 'SKIPPED' | 'FAILED'; reason: string } | { retryAt: Date } | null;
type SendCheck = (m: Message) => Promise<Verdict>;
const purposeChecks = new Map<string, SendCheck>();
/** Purpose-specific checks (renewal still open, greetings still on …) registered by their modules. */
export const registerSendCheck = (purpose: string, fn: SendCheck) => void purposeChecks.set(purpose, fn);

/** IST minutes since midnight. */
const istMinutes = (d: Date) => {
  const t = new Date(d.getTime() + 330 * 60_000);
  return t.getUTCHours() * 60 + t.getUTCMinutes();
};
const hm = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

/** WhatsApp sending window (CFG-64): null inside it; the next start before it; 'closed' after it. */
export function windowState(now = clock.now()): null | Date | 'closed' {
  const w = settings.get('CFG-64');
  const m = istMinutes(now);
  if (m < hm(w.from)) return new Date(now.getTime() + (hm(w.from) - m) * 60_000);
  if (m >= hm(w.to)) return 'closed';
  return null;
}

async function generalChecks(m: Message): Promise<Verdict> {
  const [a] = await db.select({ status: accounts.status }).from(accounts).where(eq(accounts.id, m.accountId));
  if (a?.status !== 'ACTIVE') return { status: 'CANCELLED', reason: 'Account not active' };
  if (m.customerId) {
    const [c] = await db.select({ status: customers.status }).from(customers).where(eq(customers.id, m.customerId));
    if (c?.status !== 'ACTIVE') return { status: 'CANCELLED', reason: 'Customer inactive' };
    if (m.familyMemberId) {
      const [f] = await db.select({ status: familyMembers.status }).from(familyMembers).where(eq(familyMembers.id, m.familyMemberId));
      if (f?.status !== 'ACTIVE') return { status: 'CANCELLED', reason: 'Person inactive' };
    }
    const state = await consentState(db, m.customerId, m.familyMemberId, m.channel as 'EMAIL' | 'WHATSAPP', m.recipient);
    if (m.channel === 'EMAIL' && state === 'WITHDRAWN') return { status: 'CANCELLED', reason: 'Consent withdrawn' };
    if (m.channel === 'WHATSAPP' && state !== 'GIVEN') return { status: 'CANCELLED', reason: state === 'WITHDRAWN' ? 'Consent withdrawn' : 'No WhatsApp consent' };
  }
  if (m.channel === 'EMAIL' && (await emailSuppressed(db, m.recipient))) return { status: 'SKIPPED', reason: 'Email address bounced' };
  if (m.channel === 'WHATSAPP') {
    const win = windowState();
    if (win === 'closed') return { status: 'FAILED', reason: 'Sending window closed' };
    if (win) return { retryAt: win };
    if (!isPremium(await currentSubscription(db, m.accountId))) return { status: 'CANCELLED', reason: 'Not on Premium plan' };
    if (m.templateId) {
      const t = await activeTemplate(db, m.purpose as Purpose, 'WHATSAPP', m.templateId);
      if (!t) return { status: 'SKIPPED', reason: 'Template inactive' };
    }
    const [w] = await db.select().from(whatsappNumbers).where(eq(whatsappNumbers.accountId, m.accountId));
    if (w?.status !== 'READY' || !w.number) return { status: 'SKIPPED', reason: 'WhatsApp number not ready' };
  } else if (m.templateId) {
    const t = await activeTemplate(db, m.purpose as Purpose, 'EMAIL', m.templateId);
    if (!t) return { status: 'SKIPPED', reason: 'Template inactive' };
  }
  return null;
}

async function setStatus(id: string, status: string, extra: Partial<Message> = {}) {
  await db
    .update(outgoingMessages)
    .set({ status, statusAt: clock.now(), version: sql`${outgoingMessages.version} + 1`, ...extra })
    .where(and(eq(outgoingMessages.id, id), inArray(outgoingMessages.status, ['QUEUED', 'SENT'])));
}

const unsubscribeLink = (id: string) => `${env.APP_URL}/unsubscribe?t=${id}.${createHmac('sha256', env.JWT_ACCESS_SECRET).update(`unsub:${id}`).digest('base64url')}`;
export const readUnsubscribe = (token: string): string | null => {
  const [id, sig] = token.split('.');
  if (!id || !sig) return null;
  return createHmac('sha256', env.JWT_ACCESS_SECRET).update(`unsub:${id}`).digest('base64url') === sig ? id : null;
};

// Wallet debit for an automated WhatsApp message that reached SENT (P-56), registered by the wallet module
type Charger = (m: Message) => Promise<void>;
let charger: Charger = () => Promise.resolve();
export const registerCharger = (fn: Charger) => void (charger = fn);
type BalanceCheck = (accountId: string) => Promise<boolean>;
let balanceOk: BalanceCheck = () => Promise.resolve(true);
export const registerBalanceCheck = (fn: BalanceCheck) => void (balanceOk = fn);

/** SYS-08: send one queued message (repeat-safe). */
export async function sendMessage(id: string): Promise<void> {
  const [m] = await db.select().from(outgoingMessages).where(eq(outgoingMessages.id, id));
  if (!m || m.status !== 'QUEUED') return;
  if (m.nextAttemptAt && m.nextAttemptAt > clock.now()) return;
  let verdict = await generalChecks(m);
  if (!verdict && purposeChecks.has(m.purpose)) verdict = await purposeChecks.get(m.purpose)!(m);
  if (!verdict && m.channel === 'WHATSAPP' && !(await balanceOk(m.accountId))) verdict = { status: 'SKIPPED', reason: 'Wallet balance low' };
  if (verdict && 'retryAt' in verdict) {
    await db.update(outgoingMessages).set({ nextAttemptAt: verdict.retryAt }).where(eq(outgoingMessages.id, id));
    return;
  }
  if (verdict) return setStatus(id, verdict.status, { reason: verdict.reason });

  let result: { ok: true; providerId: string | null } | { ok: false; permanent: boolean; error: string };
  if (m.channel === 'EMAIL') {
    try {
      const pid = await deliver({
        to: m.recipient,
        subject: m.subject ?? PURPOSE_NAMES[m.purpose as Purpose] ?? 'Message',
        text: m.body,
        dedupeKey: m.id,
        replyTo: (m.variables as Record<string, string>)['advisor email'] ?? null,
        attachments: m.attachmentFileId ? [{ filename: `${m.subject ?? 'document'}.pdf`.replace(/[^\w .-]/g, ''), fileId: m.attachmentFileId }] : [],
        footer: m.customerId ? `To stop these emails, open ${unsubscribeLink(m.id)}` : null,
      });
      result = { ok: true, providerId: pid };
    } catch (err) {
      result = { ok: false, permanent: false, error: err instanceof Error ? err.message : String(err) };
    }
  } else {
    const [w] = await db.select().from(whatsappNumbers).where(eq(whatsappNumbers.accountId, m.accountId));
    const t = m.templateId ? await activeTemplate(db, m.purpose as Purpose, 'WHATSAPP', m.templateId) : undefined;
    result = await sendWhatsapp({ from: w!.number!, to: m.recipient, template: t?.metaName ?? t?.name ?? m.purpose, language: t?.language ?? 'English', variables: m.variables as Record<string, string>, text: m.body });
  }
  if (result.ok) {
    await setStatus(id, 'SENT', { providerId: result.providerId ?? `local-${id}`, sentAt: clock.now(), attempts: m.attempts + 1, nextAttemptAt: null });
    if (m.channel === 'WHATSAPP') await charger({ ...m, status: 'SENT' });
    return;
  }
  const attempts = m.attempts + 1;
  const waits = settings.get('CFG-68');
  if (result.permanent || attempts > settings.get('CFG-67')) {
    await setStatus(id, 'FAILED', { attempts, providerError: result.error, reason: result.error === 'Not on WhatsApp' ? 'Not on WhatsApp' : result.permanent ? 'Provider rejected' : 'Provider failed after retries' });
    return;
  }
  const minutes = waits[Math.min(attempts - 1, waits.length - 1)] ?? 60;
  const at = new Date(clock.now().getTime() + minutes * 60_000);
  await db.update(outgoingMessages).set({ attempts, providerError: result.error, nextAttemptAt: at }).where(eq(outgoingMessages.id, id));
  logger.warn({ id, attempts, error: result.error }, 'Message send failed; will retry');
  await dispatch(id, minutes * 60).catch(() => undefined);
}

defineJob('send-message', async (data) => sendMessage(String(data.id)));

/** SYS-08 sweep: messages whose retry or window time has come (also catches any missed queue item). */
export async function sendDue(): Promise<number> {
  const due = await db
    .select({ id: outgoingMessages.id })
    .from(outgoingMessages)
    .where(and(eq(outgoingMessages.status, 'QUEUED'), or(sql`${outgoingMessages.nextAttemptAt} is null`, lt(outgoingMessages.nextAttemptAt, clock.now()))))
    .limit(500);
  for (const d of due) await sendMessage(d.id).catch((err: unknown) => logger.error({ err, id: d.id }, 'send failed'));
  return due.length;
}
defineJob('send-due', async () => void (await sendDue()), '* * * * *');

/** SYS-09 hourly: SENT with no update after CFG-71 hours → STATUS_UNKNOWN. */
export async function markUnknown(): Promise<number> {
  const before = new Date(clock.now().getTime() - settings.get('CFG-71') * 3600_000);
  const rows = await db
    .update(outgoingMessages)
    .set({ status: 'STATUS_UNKNOWN', statusAt: clock.now() })
    .where(and(eq(outgoingMessages.status, 'SENT'), lt(outgoingMessages.sentAt, before)))
    .returning({ id: outgoingMessages.id });
  return rows.length;
}
defineJob('message-timeouts', async () => void (await markUnknown()), '7 * * * *');

// Consent withdrawn, number changed or person deactivated: cancel their QUEUED messages (P-17, P-19)
registerMessageCanceller(async (tx, scope) => {
  const conds: SQL[] = [eq(outgoingMessages.accountId, scope.accountId), eq(outgoingMessages.customerId, scope.customerId), eq(outgoingMessages.status, 'QUEUED')];
  if (scope.familyMemberId !== undefined) conds.push(scope.familyMemberId ? eq(outgoingMessages.familyMemberId, scope.familyMemberId) : sql`${outgoingMessages.familyMemberId} is null`);
  if (scope.channel) conds.push(eq(outgoingMessages.channel, scope.channel));
  if (scope.address) conds.push(eq(outgoingMessages.recipient, scope.address));
  const rows = await tx
    .update(outgoingMessages)
    .set({ status: 'CANCELLED', reason: scope.channel ? 'Consent withdrawn' : 'Person inactive', statusAt: clock.now() })
    .where(and(...conds))
    .returning({ id: outgoingMessages.id });
  return rows.length;
});

/** Cancel every QUEUED message of an account matching a filter (greetings off, plan lost, account suspended). */
export async function cancelWhere(tx: DbOrTx, accountId: string, reason: string, filter?: SQL): Promise<number> {
  const rows = await tx
    .update(outgoingMessages)
    .set({ status: 'CANCELLED', reason, statusAt: clock.now() })
    .where(and(eq(outgoingMessages.accountId, accountId), eq(outgoingMessages.status, 'QUEUED'), filter))
    .returning({ id: outgoingMessages.id });
  return rows.length;
}

// ---------- P-43 Communication history ----------
export function messageView(m: Message) {
  return {
    id: m.id,
    channel: m.channel,
    purpose: m.purpose,
    purposeName: PURPOSE_NAMES[m.purpose as Purpose] ?? (m.purpose === 'COMPARISON_EMAIL' ? 'Comparison email' : m.purpose === 'QUOTATION_WHATSAPP' ? 'Quotation (your WhatsApp)' : m.purpose),
    personName: m.personName,
    customerId: m.customerId,
    recipient: m.channel === 'WHATSAPP' ? maskMobile(m.recipient) : m.recipient,
    subject: m.subject,
    body: m.body,
    status: m.status,
    reason: m.reason,
    createdAt: m.createdAt.toISOString(),
    sentAt: m.sentAt?.toISOString() ?? null,
    deliveredAt: m.deliveredAt?.toISOString() ?? null,
    readAt: m.readAt?.toISOString() ?? null,
    statusAt: m.statusAt?.toISOString() ?? null,
    relatedType: m.relatedType,
    relatedId: m.relatedId,
    resendOf: m.resendOf,
    canCancel: m.status === 'QUEUED',
    version: m.version,
  };
}

export async function listMessages(auth: AuthContext, f: { tab?: string; channel?: string; purpose?: string; status?: string; from?: string; to?: string; customerId?: string; page?: number }) {
  const conds: SQL[] = [eq(outgoingMessages.accountId, auth.accountId!)];
  if (f.tab === 'scheduled') conds.push(eq(outgoingMessages.status, 'QUEUED'));
  else if (f.tab === 'sent') conds.push(inArray(outgoingMessages.status, SENT_GROUP));
  else if (f.tab === 'notsent') conds.push(inArray(outgoingMessages.status, NOT_SENT));
  if (f.channel) conds.push(eq(outgoingMessages.channel, f.channel));
  if (f.purpose) conds.push(eq(outgoingMessages.purpose, f.purpose));
  if (f.status) conds.push(eq(outgoingMessages.status, f.status));
  if (f.customerId && /^[0-9a-f-]{36}$/.test(f.customerId)) conds.push(eq(outgoingMessages.customerId, f.customerId));
  if (f.from && /^\d{4}-\d{2}-\d{2}$/.test(f.from)) conds.push(gte(outgoingMessages.createdAt, new Date(`${f.from}T00:00:00+05:30`)));
  if (f.to && /^\d{4}-\d{2}-\d{2}$/.test(f.to)) conds.push(lt(outgoingMessages.createdAt, new Date(new Date(`${f.to}T00:00:00+05:30`).getTime() + 86_400_000)));
  const page = Math.max(1, f.page ?? 1);
  const size = settings.get('CFG-23');
  const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(outgoingMessages).where(and(...conds))) as [{ n: number }];
  const rows = await db.select().from(outgoingMessages).where(and(...conds)).orderBy(desc(outgoingMessages.createdAt)).limit(size).offset((page - 1) * size);
  const canResend = await Promise.all(rows.map((m) => resendBlock(m).then((b) => b === null)));
  return { items: rows.map((m, i) => ({ ...messageView(m), canResend: canResend[i] })), total: n, page, pageSize: size };
}

export async function cancelMessage(req: Request, auth: AuthContext, id: string) {
  return db.transaction(async (tx) => {
    const [m] = await tx.select().from(outgoingMessages).where(and(eq(outgoingMessages.id, id), eq(outgoingMessages.accountId, auth.accountId!))).for('update');
    if (!m) throw notFound();
    if (m.status !== 'QUEUED') throw stateConflict('message', m.status);
    await tx.update(outgoingMessages).set({ status: 'CANCELLED', reason: 'Cancelled by advisor', statusAt: clock.now(), version: m.version + 1 }).where(eq(outgoingMessages.id, id));
    await audit(tx, req, { action: 'MESSAGE_CANCELLED', entity: 'message', entityId: id });
    return { message: msg('COM-10') };
  });
}

/** Why a message cannot be resent (COM-12), or null when it can. */
async function resendBlock(m: Message): Promise<string | null> {
  if (!['QUOTATION_EMAIL', 'RENEWAL_REMINDER'].includes(m.purpose)) return 'COM-12';
  if (!['FAILED', 'STATUS_UNKNOWN'].includes(m.status)) return 'COM-12';
  if (m.resendCount >= settings.get('CFG-140')) return 'COM-12';
  if (m.relatedType === 'QUOTATION' && m.relatedId) {
    const [r] = await db.select().from(quotationRevisions).where(eq(quotationRevisions.id, m.relatedId));
    if (!r || !['SHARED', 'ACCEPTED'].includes(r.status) || (r.validUntil && r.validUntil < istToday())) return 'COM-12';
  }
  if (m.relatedType === 'RENEWAL' && m.relatedId) {
    const [c] = await db.select().from(renewalCycles).where(eq(renewalCycles.id, m.relatedId));
    if (!c || !['DUE', 'IN_FOLLOW_UP'].includes(c.status)) return 'COM-12';
  }
  return null;
}

export async function resendMessage(req: Request, auth: AuthContext, id: string) {
  const [m] = await db.select().from(outgoingMessages).where(and(eq(outgoingMessages.id, id), eq(outgoingMessages.accountId, auth.accountId!)));
  if (!m) throw notFound();
  const block = await resendBlock(m);
  if (block) throw new AppError(409, block);
  if (m.customerId) {
    const state = await consentState(db, m.customerId, m.familyMemberId, m.channel as 'EMAIL' | 'WHATSAPP', m.recipient);
    if (state === 'WITHDRAWN' || (m.channel === 'WHATSAPP' && state !== 'GIVEN')) throw new AppError(409, 'COM-12');
  }
  if ((await sentToday(db, m.accountId, m.channel as 'EMAIL' | 'WHATSAPP')) >= dailyLimit(m.channel as 'EMAIL' | 'WHATSAPP')) throw new AppError(429, 'QT-24');
  const created = await db.transaction(async (tx) => {
    const n = m.resendCount + 1;
    const [locked] = await tx.update(outgoingMessages).set({ resendCount: n }).where(and(eq(outgoingMessages.id, id), eq(outgoingMessages.resendCount, m.resendCount))).returning();
    if (!locked) throw new AppError(409, 'COM-12');
    const row = await queueMessage(tx, {
      ...m,
      channel: m.channel as 'EMAIL' | 'WHATSAPP',
      variables: m.variables as Record<string, string>,
      occurrenceKey: `${m.occurrenceKey}:resend:${n}`,
      resendOf: m.id,
      createdBy: auth.userId,
      status: 'QUEUED',
      reason: null,
    });
    await audit(tx, req, { action: 'MESSAGE_RESENT', entity: 'message', entityId: id });
    return row;
  });
  if (created) await dispatch(created.id);
  return { message: msg('COM-11') };
}
