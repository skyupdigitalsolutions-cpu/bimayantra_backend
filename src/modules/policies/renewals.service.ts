// P-37 Create renewal cycles and send reminders (SYS-03, daily at CFG-63) and P-38 Follow up and close a
// renewal. A reminder sent never means renewed; only a recorded renewal policy or premium payment does.
// Occurrence keys (cycle + offset + channel) make every run repeat-safe (AC-P37-1).
import type { Request } from 'express';
import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.js';
import { accounts, customers, insuranceTypes, insurers, outgoingMessages, payments, policies, policyHistory, quotationRevisions, quotations, renewalCycles, renewalEvents, users } from '../../db/schema.js';
import { addDays, clock, formatDate, istToday } from '../../lib/clock.js';
import { AppError, fieldError, fieldErrors, notFound, stateConflict, versionConflict } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import { logger } from '../../lib/logger.js';
import { msg } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { currentSubscription, isPremium } from '../accounts/accounts.service.js';
import { isUuid, readVersion } from '../clients/common.js';
import { registerCounts } from '../dashboard/counts.service.js';
import { defineDaily } from '../jobs/daily.js';
import { consentState, dailyLimit, dispatch, queueMessage, registerSendCheck, sentToday } from '../messages/messages.service.js';
import { activeTemplate, fill } from '../messages/templates.js';
import { notify } from '../notifications/notifications.service.js';
import { settings } from '../settings/settings.service.js';
import { advisorFacts, productCtx } from '../quotations/engine.js';
import { cancelCycleMessages, createCycle } from './policies.service.js';

type Cycle = typeof renewalCycles.$inferSelect;
export const OUTCOMES = ['Spoke to customer', 'Not reachable', 'Asked to call back'] as const;
export const NOT_RENEWING_REASONS = ['Customer not interested', 'Moved to another advisor', 'Bought elsewhere', 'Cover no longer needed', 'Other'] as const;
export const STATUS_TEXT: Record<string, string> = { UPCOMING: 'Upcoming', DUE: 'Due', IN_FOLLOW_UP: 'In follow-up', RENEWED: 'Renewed', NOT_RENEWING: 'Not renewing', LAPSED: 'Lapsed' };
const OPEN = ['DUE', 'IN_FOLLOW_UP'];

const daysBetween = (a: string, b: string) => Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000);

// ---------- SYS-03 ----------
export async function runRenewals(): Promise<Record<string, number>> {
  const today = istToday();
  const stats = { due: 0, advisorReminders: 0, customerReminders: 0, expired: 0, lapsed: 0 };
  const catchUp = settings.get('CFG-137');
  const accountRows = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.status, 'ACTIVE'));
  for (const { id: accountId } of accountRows) {
    try {
      // 1. UPCOMING → DUE
      const dueRows = await db
        .update(renewalCycles)
        .set({ status: 'DUE', version: sql`${renewalCycles.version} + 1` })
        .where(and(eq(renewalCycles.accountId, accountId), eq(renewalCycles.status, 'UPCOMING'), lte(renewalCycles.renewalDate, addDays(today, settings.get('CFG-59')))))
        .returning({ id: renewalCycles.id });
      stats.due += dueRows.length;
      const open = await db
        .select({ c: renewalCycles, p: policies, cu: customers })
        .from(renewalCycles)
        .innerJoin(policies, eq(policies.id, renewalCycles.policyId))
        .innerJoin(customers, eq(customers.id, renewalCycles.customerId))
        .where(and(eq(renewalCycles.accountId, accountId), inArray(renewalCycles.status, OPEN)));
      const [adv] = await db.select().from(users).where(and(eq(users.accountId, accountId), eq(users.role, 'ADV')));
      const advisor = await advisorFacts(db, accountId);
      const premium = isPremium(await currentSubscription(db, accountId));
      const queued: string[] = [];
      for (const { c, p, cu } of open) {
        const left = daysBetween(today, c.renewalDate);
        // 2. Advisor reminders (DSH-14), a missed day caught up within CFG-137
        for (const off of settings.get('CFG-60')) {
          if (left <= off && left >= off - catchUp && adv) {
            if (await notify(db, { userId: adv.id, accountId, messageId: 'DSH-14', params: { Customer: cu.fullName, product: p.productName, date: formatDate(c.renewalDate) }, link: { type: 'RENEWAL', id: c.id }, dedupeKey: `ren-adv:${c.id}:${off}` })) stats.advisorReminders++;
          }
        }
        // 3. Customer reminders
        if (c.remindersPaused || cu.status !== 'ACTIVE' || p.status === 'CANCELLED') continue;
        const offsets = settings.get('CFG-61');
        const due = [...offsets.before.map((d) => ({ key: `b${d}`, at: d })), ...offsets.after.map((d) => ({ key: `a${d}`, at: -d }))].filter((o) => left <= o.at && left >= o.at - catchUp);
        for (const o of due) {
          const vars = {
            'customer first name': cu.fullName.split(' ')[0]!,
            product: p.productName,
            'policy last 4': (p.insurerPolicyNumber ?? p.number).slice(-4),
            'renewal date': formatDate(c.renewalDate),
            'advisor name': advisor.name,
            'advisor mobile': (adv?.mobile ?? '').replace('+91', '+91 '),
          };
          const channels: ('EMAIL' | 'WHATSAPP')[] = ['EMAIL', ...(premium ? (['WHATSAPP'] as const) : [])];
          for (const ch of channels) {
            const recipient = ch === 'EMAIL' ? cu.email : cu.mobile;
            if (!recipient) continue;
            const state = await consentState(db, cu.id, null, ch, recipient);
            if (ch === 'EMAIL' ? state === 'WITHDRAWN' : state !== 'GIVEN') continue;
            const t = await activeTemplate(db, 'RENEWAL_REMINDER', ch);
            const over = (await sentToday(db, accountId, ch)) >= dailyLimit(ch);
            const m = await queueMessage(db, {
              accountId,
              customerId: cu.id,
              personName: cu.fullName,
              channel: ch,
              purpose: 'RENEWAL_REMINDER',
              recipient,
              templateId: t?.id ?? null,
              templateVersion: t?.templateVersion ?? null,
              variables: vars,
              subject: t?.subject ? fill(t.subject, vars) : null,
              body: t ? fill(t.body, vars) : '',
              occurrenceKey: `ren:${c.id}:${o.key}:${ch}`,
              relatedType: 'RENEWAL',
              relatedId: c.id,
              status: !t || over ? 'SKIPPED' : 'QUEUED',
              reason: !t ? 'Template inactive' : over ? 'Daily limit reached' : null,
            });
            if (m) {
              stats.customerReminders++;
              if (m.status === 'QUEUED') queued.push(m.id);
              await db.update(renewalCycles).set({ remindersSent: sql`${renewalCycles.remindersSent} + 1` }).where(eq(renewalCycles.id, c.id));
            }
          }
        }
      }
      for (const id of queued) await dispatch(id).catch(() => undefined);
      // 4. Expiry: ISSUED policies past their end date and not renewed
      const exp = await db
        .update(policies)
        .set({ status: 'EXPIRED', statusAt: clock.now(), version: sql`${policies.version} + 1` })
        .where(and(eq(policies.accountId, accountId), eq(policies.status, 'ISSUED'), sql`${policies.endDate} < ${today}`))
        .returning({ id: policies.id });
      stats.expired += exp.length;
      // 5. Lapse: past renewal date + grace
      const lapsed = await db
        .update(renewalCycles)
        .set({ status: 'LAPSED', closedAt: clock.now(), version: sql`${renewalCycles.version} + 1` })
        .where(and(eq(renewalCycles.accountId, accountId), inArray(renewalCycles.status, OPEN), sql`${renewalCycles.graceEnd} < ${today}`))
        .returning();
      for (const c of lapsed) {
        stats.lapsed++;
        await cancelCycleMessages(db, c.id, 'Lapsed');
        const [row] = await db.select({ name: customers.fullName, product: policies.productName }).from(policies).innerJoin(customers, eq(customers.id, policies.customerId)).where(eq(policies.id, c.policyId));
        if (adv && row) await notify(db, { userId: adv.id, accountId, messageId: 'DSH-25', params: { Customer: row.name, product: row.product, date: formatDate(c.graceEnd) }, link: { type: 'RENEWAL', id: c.id }, dedupeKey: `ren-lapsed:${c.id}` });
      }
    } catch (err) {
      logger.error({ err, accountId }, 'Renewal run failed for an account; the next run continues');
    }
  }
  return stats;
}
defineDaily('SYS-03', 'CFG-63', runRenewals);

// Checked again just before sending (P-37 skip rules)
registerSendCheck('RENEWAL_REMINDER', async (m) => {
  if (!m.relatedId) return null;
  const [row] = await db.select({ c: renewalCycles, status: policies.status }).from(renewalCycles).innerJoin(policies, eq(policies.id, renewalCycles.policyId)).where(eq(renewalCycles.id, m.relatedId));
  if (!row) return { status: 'CANCELLED', reason: 'Renewal not found' };
  if (row.status === 'CANCELLED') return { status: 'CANCELLED', reason: 'Policy cancelled' };
  if (!OPEN.includes(row.c.status)) return { status: 'CANCELLED', reason: `Renewal ${STATUS_TEXT[row.c.status]?.toLowerCase()}` };
  if (row.c.remindersPaused) return { status: 'CANCELLED', reason: 'Reminders paused' };
  return null;
});

registerCounts(async (accountId) => {
  const [d] = await db.select({ n: sql<number>`count(*)::int` }).from(renewalCycles).where(and(eq(renewalCycles.accountId, accountId), inArray(renewalCycles.status, OPEN)));
  return [{ key: 'renewalsDue', label: 'Renewals due', value: d?.n ?? 0, link: '/renewals' }];
});

// ---------- P-38 ----------
async function loadCycle(dbx: DbOrTx, auth: AuthContext, id: string, lock = false): Promise<Cycle> {
  if (!isUuid(id)) throw notFound();
  const base = dbx.select().from(renewalCycles).where(and(eq(renewalCycles.id, id), eq(renewalCycles.accountId, auth.accountId!)));
  const [c] = lock ? await base.for('update') : await base;
  if (!c) throw notFound();
  return c;
}

async function event(tx: DbOrTx, c: Cycle, e: { kind: string; to?: string; outcome?: string | null; note?: string | null }, userId: string) {
  await tx.insert(renewalEvents).values({ cycleId: c.id, kind: e.kind, outcome: e.outcome ?? null, fromStatus: e.to ? c.status : null, toStatus: e.to ?? null, note: e.note ?? null, userId, at: clock.now() });
}

export async function listRenewals(auth: AuthContext, f: { window?: string; from?: string; to?: string; status?: string; insurerId?: string; typeId?: string; customerId?: string; page?: number }) {
  const today = istToday();
  const conds: SQL[] = [eq(renewalCycles.accountId, auth.accountId!)];
  if (f.customerId && isUuid(f.customerId)) conds.push(eq(renewalCycles.customerId, f.customerId));
  if (f.status && STATUS_TEXT[f.status]) conds.push(eq(renewalCycles.status, f.status));
  else if (f.status !== 'ALL') conds.push(inArray(renewalCycles.status, ['DUE', 'IN_FOLLOW_UP', 'NOT_RENEWING', 'LAPSED', 'UPCOMING']));
  if (f.window === 'today') conds.push(eq(renewalCycles.renewalDate, today));
  else if (f.window && /^\d+$/.test(f.window)) conds.push(lte(renewalCycles.renewalDate, addDays(today, Number(f.window))));
  if (f.from && /^\d{4}-\d{2}-\d{2}$/.test(f.from)) conds.push(gte(renewalCycles.renewalDate, f.from));
  if (f.to && /^\d{4}-\d{2}-\d{2}$/.test(f.to)) conds.push(lte(renewalCycles.renewalDate, f.to));
  if (f.insurerId && isUuid(f.insurerId)) conds.push(eq(policies.insurerId, f.insurerId));
  if (f.typeId && isUuid(f.typeId)) conds.push(eq(policies.typeId, f.typeId));
  const page = Math.max(1, f.page ?? 1);
  const size = settings.get('CFG-23');
  const rows = await db
    .select({ c: renewalCycles, p: policies, customerName: customers.fullName, insurerName: insurers.name })
    .from(renewalCycles)
    .innerJoin(policies, eq(policies.id, renewalCycles.policyId))
    .innerJoin(customers, eq(customers.id, renewalCycles.customerId))
    .innerJoin(insurers, eq(insurers.id, policies.insurerId))
    .where(and(...conds))
    .orderBy(asc(renewalCycles.renewalDate))
    .limit(size)
    .offset((page - 1) * size);
  const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(renewalCycles).innerJoin(policies, eq(policies.id, renewalCycles.policyId)).where(and(...conds))) as [{ n: number }];
  return {
    items: rows.map(({ c, p, customerName, insurerName }) => ({
      id: c.id,
      policyId: p.id,
      customerId: c.customerId,
      customerName,
      policyNumber: p.insurerPolicyNumber ?? p.number,
      product: p.productName,
      insurerName,
      renewalDate: c.renewalDate,
      daysLeft: daysBetween(today, c.renewalDate),
      status: c.status,
      kind: c.kind,
      lastContactAt: c.lastContactAt?.toISOString() ?? null,
      lastOutcome: c.lastOutcome,
      remindersSent: c.remindersSent,
      remindersPaused: c.remindersPaused,
    })),
    total: n,
    page,
    pageSize: size,
    presets: settings.get('CFG-136'),
    dueDays: settings.get('CFG-59'),
  };
}

export async function getRenewal(auth: AuthContext, id: string) {
  const c = await loadCycle(db, auth, id);
  const [p] = await db.select().from(policies).where(eq(policies.id, c.policyId));
  const [cu] = await db.select().from(customers).where(eq(customers.id, c.customerId));
  const [ins] = await db.select({ name: insurers.name }).from(insurers).where(eq(insurers.id, p!.insurerId));
  const [type] = p!.typeId ? await db.select({ name: insuranceTypes.name }).from(insuranceTypes).where(eq(insuranceTypes.id, p!.typeId)) : [];
  const events = await db.select({ e: renewalEvents, by: users.name }).from(renewalEvents).leftJoin(users, eq(users.id, renewalEvents.userId)).where(eq(renewalEvents.cycleId, c.id)).orderBy(desc(renewalEvents.at));
  const msgs = await db.select().from(outgoingMessages).where(and(eq(outgoingMessages.relatedType, 'RENEWAL'), eq(outgoingMessages.relatedId, c.id))).orderBy(desc(outgoingMessages.createdAt));
  const [rq] = c.renewalQuotationId ? await db.select({ id: quotationRevisions.id, number: quotations.number, status: quotationRevisions.status }).from(quotations).innerJoin(quotationRevisions, eq(quotationRevisions.quotationId, quotations.id)).where(eq(quotations.id, c.renewalQuotationId)).orderBy(desc(quotationRevisions.revisionNo)).limit(1) : [];
  const today = istToday();
  return {
    id: c.id,
    status: c.status,
    statusText: STATUS_TEXT[c.status],
    kind: c.kind,
    renewalDate: c.renewalDate,
    graceEnd: c.graceEnd,
    daysLeft: daysBetween(today, c.renewalDate),
    remindersPaused: c.remindersPaused,
    reason: c.reason,
    note: c.note,
    policy: { id: p!.id, number: p!.number, insurerPolicyNumber: p!.insurerPolicyNumber, product: p!.productName, productId: p!.productId, insurer: ins?.name, type: type?.name ?? null, endDate: p!.endDate, nextDueDate: p!.nextDueDate, premium: p!.premium, status: p!.status },
    customer: { id: cu!.id, name: cu!.fullName, mobile: cu!.mobile },
    renewalQuotation: rq ?? null,
    events: events.map(({ e, by }) => ({ kind: e.kind, outcome: e.outcome, from: e.fromStatus, to: e.toStatus, note: e.note, by, at: e.at.toISOString() })),
    messages: msgs.map((m) => ({ id: m.id, channel: m.channel, status: m.status, reason: m.reason, createdAt: m.createdAt.toISOString() })),
    actions: {
      canContact: OPEN.includes(c.status),
      canQuote: ['DUE', 'IN_FOLLOW_UP', 'LAPSED'].includes(c.status) && c.kind === 'END_DATE' && !!p!.productId,
      canRecordPremium: ['DUE', 'IN_FOLLOW_UP', 'LAPSED'].includes(c.status) && c.kind === 'PREMIUM_DUE',
      canNotRenew: OPEN.includes(c.status),
      canReopen: c.status === 'NOT_RENEWING',
      canPause: OPEN.includes(c.status),
    },
    options: { outcomes: OUTCOMES, reasons: NOT_RENEWING_REASONS },
    version: c.version,
  };
}

export async function logContact(req: Request, auth: AuthContext, id: string, body: unknown) {
  const v = F.parseFields(body, { outcome: { label: 'Outcome', required: true, oneOf: OUTCOMES }, note: { label: 'Note', rule: F.notes } }) as { outcome: string; note?: string };
  return db.transaction(async (tx) => {
    const c = await loadCycle(tx, auth, id, true);
    if (c.version !== readVersion(body)) throw versionConflict('renewal');
    if (!OPEN.includes(c.status)) throw stateConflict('renewal', c.status);
    await tx.update(renewalCycles).set({ status: 'IN_FOLLOW_UP', lastContactAt: clock.now(), lastOutcome: v.outcome, version: c.version + 1 }).where(eq(renewalCycles.id, c.id));
    await event(tx, c, { kind: 'CONTACT', outcome: v.outcome, note: v.note, to: c.status === 'DUE' ? 'IN_FOLLOW_UP' : undefined }, auth.userId);
    await audit(tx, req, { action: 'RENEWAL_CONTACT', entity: 'renewal', entityId: c.id, newValue: v });
    return { message: msg('REN-01') };
  });
}

/** Create renewal quotation: P-27 with the same customer, product, people and sum insured (even if WITHDRAWN). */
export async function renewalQuotation(req: Request, auth: AuthContext, id: string, body: unknown) {
  return db.transaction(async (tx) => {
    const c = await loadCycle(tx, auth, id, true);
    if (c.version !== readVersion(body)) throw versionConflict('renewal');
    if (!['DUE', 'IN_FOLLOW_UP', 'LAPSED'].includes(c.status)) throw stateConflict('renewal', c.status);
    const [p] = await tx.select().from(policies).where(eq(policies.id, c.policyId));
    if (c.renewalQuotationId) {
      const [r] = await tx.select({ id: quotationRevisions.id }).from(quotationRevisions).where(eq(quotationRevisions.quotationId, c.renewalQuotationId)).orderBy(desc(quotationRevisions.revisionNo)).limit(1);
      return { revisionId: r!.id, message: msg('REN-02', { 'policy number': p!.insurerPolicyNumber ?? p!.number }) };
    }
    if (!p!.productId) throw new AppError(409, 'QT-11', { Product: p!.productName });
    const pc = await productCtx(tx, auth.accountId!, p!.productId);
    if (!pc) throw new AppError(409, 'QT-11', { Product: p!.productName });
    const now = clock.now();
    const people = (p!.insured as { key: string }[]).map((x) => x.key);
    const inputs = { typeId: pc.typeId, insurerId: pc.insurerId, productId: pc.productId, people, sumInsured: p!.sumInsured ?? undefined, term: pc.data.policyTerms.includes(1) ? '1' : String(pc.data.policyTerms[0] ?? ''), startDate: addDays(p!.endDate!, 1) < istToday() ? istToday() : addDays(p!.endDate!, 1) };
    const [q] = await tx.insert(quotations).values({ accountId: auth.accountId!, customerId: c.customerId, productId: pc.productId, insurerId: pc.insurerId, typeId: pc.typeId, renewalOfPolicyId: p!.id, createdBy: auth.userId, createdAt: now }).returning();
    const [r] = await tx.insert(quotationRevisions).values({ quotationId: q!.id, accountId: auth.accountId!, revisionNo: 1, status: 'DRAFT', step: 6, inputs, createdBy: auth.userId, createdAt: now, updatedAt: now }).returning();
    const to = c.status === 'DUE' ? 'IN_FOLLOW_UP' : c.status;
    await tx.update(renewalCycles).set({ status: to, renewalQuotationId: q!.id, version: c.version + 1 }).where(eq(renewalCycles.id, c.id));
    await event(tx, c, { kind: 'QUOTATION', to: to !== c.status ? to : undefined }, auth.userId);
    await audit(tx, req, { action: 'RENEWAL_QUOTATION_STARTED', entity: 'renewal', entityId: c.id, newValue: { quotationId: q!.id } });
    return { revisionId: r!.id, message: msg('REN-02', { 'policy number': p!.insurerPolicyNumber ?? p!.number }) };
  });
}

/** Regular-premium policies: the next premium is recorded; the same policy continues with a new cycle. */
export async function recordPremium(req: Request, auth: AuthContext, id: string, body: unknown) {
  const v = F.parseFields(body, {
    paidOn: { label: 'Payment date', required: true, rule: F.pastOrToday },
    receiptNumber: { label: 'Insurer receipt number', required: true, rule: F.transactionRef },
    amount: { label: 'Amount', required: true, rule: F.amount() },
    nextDueDate: { label: 'New next premium due date', required: true, rule: F.date },
  }) as { paidOn: string; receiptNumber: string; amount: string; nextDueDate: string };
  return db.transaction(async (tx) => {
    const c = await loadCycle(tx, auth, id, true);
    if (c.version !== readVersion(body)) throw versionConflict('renewal');
    if (!['DUE', 'IN_FOLLOW_UP', 'LAPSED'].includes(c.status) || c.kind !== 'PREMIUM_DUE') throw stateConflict('renewal', c.status);
    const [p] = await tx.select().from(policies).where(eq(policies.id, c.policyId)).for('update');
    if (v.nextDueDate <= c.renewalDate || v.nextDueDate > p!.endDate!) throw fieldError('nextDueDate', 'REN-09', { 'old date': formatDate(c.renewalDate) });
    const norm = v.receiptNumber.toUpperCase().replace(/[\s-]/g, '');
    const [dup] = await tx.select({ id: payments.id }).from(payments).where(and(eq(payments.accountId, auth.accountId!), eq(payments.insurerId, p!.insurerId), eq(payments.referenceNorm, norm), eq(payments.status, 'PAID')));
    if (dup) throw fieldError('receiptNumber', 'PAY-08', { record: p!.insurerPolicyNumber ?? p!.number });
    const now = clock.now();
    await tx.insert(payments).values({ accountId: auth.accountId!, kind: 'RENEWAL_PREMIUM', policyId: p!.id, insurerId: p!.insurerId, status: 'PAID', amount: v.amount, paidOn: v.paidOn, reference: v.receiptNumber, referenceNorm: norm, recordedBy: auth.userId, recordedAt: now, createdBy: auth.userId, createdAt: now });
    await tx.update(renewalCycles).set({ status: 'RENEWED', closedAt: now, version: c.version + 1 }).where(eq(renewalCycles.id, c.id));
    await event(tx, c, { kind: 'STATUS', to: 'RENEWED', note: `Premium paid, receipt ${v.receiptNumber}` }, auth.userId);
    await cancelCycleMessages(tx, c.id, 'Renewed');
    const [updated] = await tx.update(policies).set({ nextDueDate: v.nextDueDate, status: p!.status === 'EXPIRED' ? 'ISSUED' : p!.status, updatedAt: now, version: p!.version + 1 }).where(eq(policies.id, p!.id)).returning();
    await createCycle(tx, updated!);
    await tx.insert(policyHistory).values({ policyId: p!.id, kind: 'PREMIUM_PAID', oldValue: { nextDueDate: p!.nextDueDate }, newValue: v, userId: auth.userId, at: now });
    await audit(tx, req, { action: 'RENEWAL_PREMIUM_RECORDED', entity: 'renewal', entityId: c.id, newValue: v });
    return { message: msg('REN-03', { date: formatDate(v.nextDueDate) }) };
  });
}

export async function markNotRenewing(req: Request, auth: AuthContext, id: string, body: unknown) {
  const v = F.parseFields(body, { reason: { label: 'Reason', required: true, oneOf: NOT_RENEWING_REASONS }, note: { label: 'Note', rule: F.notes } }) as { reason: string; note?: string };
  if (v.reason === 'Other' && !v.note) throw fieldErrors([{ field: 'note', code: 'GEN-01', params: { 'Field label': 'Note' } }]);
  return db.transaction(async (tx) => {
    const c = await loadCycle(tx, auth, id, true);
    if (c.version !== readVersion(body)) throw versionConflict('renewal');
    if (!OPEN.includes(c.status)) throw stateConflict('renewal', c.status);
    await tx.update(renewalCycles).set({ status: 'NOT_RENEWING', reason: v.reason, note: v.note ?? null, version: c.version + 1 }).where(eq(renewalCycles.id, c.id));
    await event(tx, c, { kind: 'STATUS', to: 'NOT_RENEWING', note: [v.reason, v.note].filter(Boolean).join(': ') }, auth.userId);
    await cancelCycleMessages(tx, c.id, 'Not renewing');
    await audit(tx, req, { action: 'RENEWAL_NOT_RENEWING', entity: 'renewal', entityId: c.id, newValue: v });
    return { message: msg('REN-04') };
  });
}

export async function reopenRenewal(req: Request, auth: AuthContext, id: string, body: unknown) {
  const v = F.parseFields(body, { note: { label: 'Note', required: true, rule: F.notes } }) as { note: string };
  return db.transaction(async (tx) => {
    const c = await loadCycle(tx, auth, id, true);
    if (c.version !== readVersion(body)) throw versionConflict('renewal');
    if (c.status !== 'NOT_RENEWING') throw stateConflict('renewal', c.status);
    if (istToday() > c.graceEnd) throw new AppError(409, 'REN-08', { date: formatDate(c.graceEnd) });
    await tx.update(renewalCycles).set({ status: 'IN_FOLLOW_UP', reason: null, version: c.version + 1 }).where(eq(renewalCycles.id, c.id));
    await event(tx, c, { kind: 'STATUS', to: 'IN_FOLLOW_UP', note: v.note }, auth.userId);
    await audit(tx, req, { action: 'RENEWAL_REOPENED', entity: 'renewal', entityId: c.id, newValue: v });
    return { message: msg('REN-05') };
  });
}

export async function setPaused(req: Request, auth: AuthContext, id: string, paused: boolean, body: unknown) {
  return db.transaction(async (tx) => {
    const c = await loadCycle(tx, auth, id, true);
    if (c.version !== readVersion(body)) throw versionConflict('renewal');
    if (!OPEN.includes(c.status)) throw stateConflict('renewal', c.status);
    await tx.update(renewalCycles).set({ remindersPaused: paused, version: c.version + 1 }).where(eq(renewalCycles.id, c.id));
    if (paused) await cancelCycleMessages(tx, c.id, 'Reminders paused');
    await event(tx, c, { kind: paused ? 'PAUSED' : 'RESUMED' }, auth.userId);
    await audit(tx, req, { action: paused ? 'RENEWAL_REMINDERS_PAUSED' : 'RENEWAL_REMINDERS_RESUMED', entity: 'renewal', entityId: c.id });
    return { message: msg(paused ? 'REN-06' : 'REN-07') };
  });
}


