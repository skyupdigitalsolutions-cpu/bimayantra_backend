// P-47 Trial, choose a plan and pay. Plans activate only from the gateway's signed notification (or an ADM
// offline payment with an extra OTP). GST: CGST + SGST inside SkyUp's home state (CFG-161), otherwise IGST
// (CFG-160). Periods for one account never overlap. SYS-05 moves statuses; SYS-13 sends trial reminders.
import type { Request } from 'express';
import { and, asc, desc, eq, gt, lte, ne, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.js';
import { accounts, advisorProfiles, invoiceCounters, occasionSettings, outgoingMessages, subscriptionInvoices, subscriptions, users, whatsappNumbers } from '../../db/schema.js';
import { addDays, clock, formatDate, istToday } from '../../lib/clock.js';
import { AppError, fieldError, forbidden, notFound } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import { money, pct, round2, add } from '../../lib/money.js';
import { msg } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { currentSubscription, isPremium } from '../accounts/accounts.service.js';
import { consumeStepUp } from '../auth/auth.service.js';
import { endAllSessions } from '../auth/sessions.service.js';
import { defineDaily } from '../jobs/daily.js';
import { cancelWhere } from '../messages/messages.service.js';
import { notify } from '../notifications/notifications.service.js';
import { settings } from '../settings/settings.service.js';
import { createOrder, gatewayAvailable, registerSettler } from './gateway.js';
import { addYears } from '../policies/policies.service.js';

export const PLANS = ['NORMAL', 'PREMIUM'] as const;
export const CYCLES = ['MONTHLY', 'YEARLY'] as const;
const PLAN_NAME: Record<string, string> = { NORMAL: 'Normal', PREMIUM: 'Premium' };

function addMonths(iso: string, n: number) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y!, m! - 1 + n, d));
  if (t.getUTCDate() !== d) return addDays(t.toISOString().slice(0, 10), -t.getUTCDate());
  return t.toISOString().slice(0, 10);
}
export const periodEnd = (start: string, cycle: string) => addDays(cycle === 'YEARLY' ? addYears(start, 1) : addMonths(start, 1), -1);

/** Price before GST from CFG-82; null until SkyUp confirms prices (DEC-06). */
export function planPrice(plan: string, cycle: string): string | null {
  const prices = settings.get('CFG-82') as Record<string, { monthly: number | string | null; yearly: number | string | null }>;
  const v = prices[plan]?.[cycle === 'YEARLY' ? 'yearly' : 'monthly'];
  return v === null || v === undefined ? null : round2(money(String(v)));
}

export function gstSplit(amount: string, state: string | null) {
  const g = settings.get('CFG-160');
  const inside = !!state && state.toLowerCase() === String(settings.get('CFG-161')).toLowerCase();
  const base = money(amount);
  const cgst = inside ? round2(pct(base, String(g.insideHomeState.cgst))) : '0.00';
  const sgst = inside ? round2(pct(base, String(g.insideHomeState.sgst))) : '0.00';
  const igst = inside ? '0.00' : round2(pct(base, String(g.outsideHomeState.igst)));
  return { inside, cgst, sgst, igst, total: round2(add(base, money(cgst), money(sgst), money(igst))) };
}

async function nextInvoiceNumber(tx: DbOrTx) {
  const today = istToday();
  const y = Number(today.slice(0, 4));
  const fy = Number(today.slice(5, 7)) >= 4 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
  const [r] = await tx.insert(invoiceCounters).values({ financialYear: fy, value: 1 }).onConflictDoUpdate({ target: invoiceCounters.financialYear, set: { value: sql`${invoiceCounters.value} + 1` } }).returning();
  return `BY/${fy}/${String(r!.value).padStart(6, '0')}`;
}

/** Plans screen (Settings → My plan). */
export async function planView(auth: AuthContext, accountId = auth.accountId!) {
  const cur = await currentSubscription(db, accountId);
  const next = await db.select().from(subscriptions).where(and(eq(subscriptions.accountId, accountId), eq(subscriptions.isCurrent, false), gt(subscriptions.periodStart, istToday()))).orderBy(asc(subscriptions.periodStart));
  const [p] = await db.select({ state: advisorProfiles.state, gstin: advisorProfiles.gstin }).from(advisorProfiles).where(eq(advisorProfiles.accountId, accountId));
  const invoices = await db.select().from(subscriptionInvoices).where(eq(subscriptionInvoices.accountId, accountId)).orderBy(desc(subscriptionInvoices.createdAt));
  const [w] = await db.select().from(whatsappNumbers).where(eq(whatsappNumbers.accountId, accountId));
  const options = PLANS.flatMap((plan) =>
    CYCLES.map((cycle) => {
      const price = planPrice(plan, cycle);
      return { plan, cycle, name: `${PLAN_NAME[plan]} · ${cycle === 'YEARLY' ? 'Yearly' : 'Monthly'}`, price, gst: price ? gstSplit(price, p?.state ?? null) : null, available: !!price && gatewayAvailable() };
    }),
  );
  const daysLeft = cur ? Math.max(0, Math.round((new Date(`${cur.periodEnd}T00:00:00Z`).getTime() - new Date(`${istToday()}T00:00:00Z`).getTime()) / 86_400_000) + 1) : 0;
  return {
    current: cur ? { status: cur.status, plan: cur.plan, planName: cur.plan ? PLAN_NAME[cur.plan] : 'Free trial', periodStart: cur.periodStart, periodEnd: cur.periodEnd, daysLeft } : null,
    scheduled: next.map((n) => ({ plan: n.plan, planName: PLAN_NAME[n.plan ?? ''] ?? '', periodStart: n.periodStart, periodEnd: n.periodEnd })),
    options,
    pricesSet: options.some((o) => o.price),
    gatewayAvailable: gatewayAvailable(),
    gstin: p?.gstin ?? null,
    state: p?.state ?? null,
    invoices: invoices.map((i) => ({ id: i.id, number: i.number, plan: i.plan, periodStart: i.periodStart, periodEnd: i.periodEnd, amount: i.amount, cgst: i.cgst, sgst: i.sgst, igst: i.igst, total: i.total, source: i.source, createdAt: i.createdAt.toISOString() })),
    whatsappNumber: w ? { status: w.status, number: w.number, message: w.status === 'READY' ? msg('SUB-16', { number: w.number ?? '' }) : msg('SUB-15') } : null,
  };
}

/** Where the new period starts: renew before the end → day after; upgrade to Premium → today; downgrade → after the end. */
function startFor(cur: Awaited<ReturnType<typeof currentSubscription>>, plan: string): string {
  const today = istToday();
  if (!cur || cur.status === 'TRIAL' || cur.status === 'EXPIRED' || cur.status === 'GRACE') return today;
  if (plan === 'PREMIUM' && cur.plan === 'NORMAL') return today;
  return addDays(cur.periodEnd, 1);
}

export async function startPlanPayment(req: Request, auth: AuthContext, body: unknown) {
  if (auth.role !== 'ADV') throw forbidden();
  const v = F.parseFields(body, { plan: { label: 'Plan', required: true, oneOf: PLANS }, cycle: { label: 'Billing', required: true, oneOf: CYCLES }, gstin: { label: 'GSTIN', rule: F.gstin } }) as { plan: string; cycle: string; gstin?: string };
  const price = planPrice(v.plan, v.cycle);
  if (!price) throw new AppError(503, 'SUB-18');
  const cur = await currentSubscription(db, auth.accountId!);
  const [p] = await db.select({ state: advisorProfiles.state, gstin: advisorProfiles.gstin }).from(advisorProfiles).where(eq(advisorProfiles.accountId, auth.accountId!));
  const gst = gstSplit(price, p?.state ?? null);
  const start = startFor(cur, v.plan);
  const details = { plan: v.plan, cycle: v.cycle, start, end: periodEnd(start, v.cycle), price, gstin: v.gstin ?? p?.gstin ?? null, state: p?.state ?? null, ...gst };
  const order = await createOrder(auth.accountId!, auth.userId, 'SUBSCRIPTION', gst.total, details);
  await audit(db, req, { action: 'PLAN_PAYMENT_STARTED', entity: 'subscription', entityId: auth.accountId!, newValue: { plan: v.plan, cycle: v.cycle, total: gst.total } });
  return { ...order, details, message: msg('SUB-13'), downgradeWarning: cur && isPremium(cur) && v.plan === 'NORMAL' ? msg('SUB-09', { date: formatDate(addDays(cur.periodEnd, 1)) }) : null };
}

/** Write a period and its invoice; promote it at once when it starts today. */
async function applyPeriod(tx: DbOrTx, accountId: string, d: { plan: string; start: string; end: string; price: string; gstin: string | null; state: string | null; cgst: string; sgst: string; igst: string; total: string }, source: 'GATEWAY' | 'OFFLINE', reference: string | null, userId: string | null, replace = false) {
  const today = istToday();
  if (replace) await tx.update(subscriptions).set({ isCurrent: false }).where(and(eq(subscriptions.accountId, accountId), gt(subscriptions.periodStart, today)));
  const startsNow = d.start <= today;
  if (startsNow) await tx.update(subscriptions).set({ isCurrent: false }).where(and(eq(subscriptions.accountId, accountId), eq(subscriptions.isCurrent, true)));
  const [s] = await tx.insert(subscriptions).values({ accountId, plan: d.plan, status: 'ACTIVE', periodStart: d.start, periodEnd: d.end, isCurrent: startsNow, createdAt: clock.now() }).returning();
  const number = await nextInvoiceNumber(tx);
  await tx.insert(subscriptionInvoices).values({ accountId, number, subscriptionId: s!.id, plan: d.plan, periodStart: d.start, periodEnd: d.end, amount: d.price, cgst: d.cgst, sgst: d.sgst, igst: d.igst, total: d.total, gstin: d.gstin, state: d.state, source, reference, referenceNorm: reference ? reference.toUpperCase().replace(/[\s-]/g, '') : null, createdBy: userId, createdAt: clock.now() });
  if (d.plan === 'PREMIUM') await tx.insert(whatsappNumbers).values({ accountId, status: 'SETTING_UP', requestedAt: clock.now() }).onConflictDoNothing();
  const [adv] = await tx.select({ id: users.id }).from(users).where(and(eq(users.accountId, accountId), eq(users.role, 'ADV')));
  const [p] = await tx.select({ email: advisorProfiles.email }).from(advisorProfiles).where(eq(advisorProfiles.accountId, accountId));
  if (adv) await notify(tx, { userId: adv.id, accountId, messageId: 'SUB-14', params: { plan: PLAN_NAME[d.plan], 'end date': formatDate(d.end) }, link: { type: 'PLAN', id: accountId }, dedupeKey: `sub-paid:${s!.id}`, email: { to: p?.email, subject: `Bimayantra GST invoice ${number}` } });
  return { subscription: s!, invoiceNumber: number };
}

registerSettler(
  'SUBSCRIPTION',
  async (o) => {
    const d = o.details as Parameters<typeof applyPeriod>[2];
    await db.transaction(async (tx) => {
      const r = await applyPeriod(tx, o.accountId, d, 'GATEWAY', null, null);
      await audit(tx, null, { action: 'PLAN_ACTIVATED', entity: 'subscription', entityId: r.subscription.id, accountId: o.accountId, newValue: { plan: d.plan, start: d.start, end: d.end, invoice: r.invoiceNumber }, actor: { job: 'payment-gateway' } });
    });
  },
  () => Promise.resolve(),
);

/** ADM records an offline payment (bank transfer or cheque to SkyUp) with an extra OTP. */
export async function recordOfflinePayment(req: Request, auth: AuthContext, accountId: string, body: unknown) {
  if (auth.role !== 'ADM') throw forbidden();
  const b = (body ?? {}) as Record<string, unknown>;
  const v = F.parseFields(b, {
    plan: { label: 'Plan', required: true, oneOf: PLANS },
    cycle: { label: 'Billing', required: true, oneOf: CYCLES },
    periodStart: { label: 'Period start', required: true, rule: F.date },
    amount: { label: 'Amount before GST', required: true, rule: F.amount() },
    reference: { label: 'Payment reference', required: true, rule: F.transactionRef },
  }) as { plan: string; cycle: string; periodStart: string; amount: string; reference: string };
  const [a] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!a) throw notFound();
  const cur = await currentSubscription(db, accountId);
  const end = periodEnd(v.periodStart, v.cycle);
  const replace = b.replaceCurrent === true;
  if (cur && cur.status === 'ACTIVE' && v.periodStart <= cur.periodEnd && !replace) throw new AppError(409, 'SUB-08', { date: formatDate(cur.periodEnd), 'next date': formatDate(addDays(cur.periodEnd, 1)) });
  const norm = v.reference.toUpperCase().replace(/[\s-]/g, '');
  const [dup] = await db.select({ accountId: subscriptionInvoices.accountId }).from(subscriptionInvoices).where(and(eq(subscriptionInvoices.referenceNorm, norm), eq(subscriptionInvoices.source, 'OFFLINE')));
  if (dup) {
    const [adv] = await db.select({ name: users.name }).from(users).where(and(eq(users.accountId, dup.accountId), eq(users.role, 'ADV')));
    throw fieldError('reference', 'SUB-10', { account: adv?.name ?? 'another account' });
  }
  const [p] = await db.select({ state: advisorProfiles.state, gstin: advisorProfiles.gstin }).from(advisorProfiles).where(eq(advisorProfiles.accountId, accountId));
  const gst = gstSplit(v.amount, p?.state ?? null);
  return db.transaction(async (tx) => {
    const ticket = await consumeStepUp(tx, auth, req.get('x-step-up-token'), 'PLAN_CHANGE');
    if (replace && cur && cur.status === 'ACTIVE') await tx.update(subscriptions).set({ periodEnd: addDays(v.periodStart, -1) > cur.periodStart ? addDays(v.periodStart, -1) : cur.periodStart }).where(eq(subscriptions.id, cur.id));
    const r = await applyPeriod(tx, accountId, { plan: v.plan, start: v.periodStart, end, price: v.amount, gstin: p?.gstin ?? null, state: p?.state ?? null, ...gst }, 'OFFLINE', v.reference, auth.userId, replace);
    await audit(tx, req, { action: 'PLAN_OFFLINE_PAYMENT', entity: 'subscription', entityId: r.subscription.id, accountId, newValue: { plan: v.plan, start: v.periodStart, end, total: gst.total, reference: v.reference, ticket } });
    return { message: msg('SUB-14', { plan: PLAN_NAME[v.plan], 'end date': formatDate(end) }), invoiceNumber: r.invoiceNumber };
  });
}

/** SkyUp marks the dedicated WhatsApp number ready (SUB-16). */
export async function setWhatsappNumber(req: Request, auth: AuthContext, accountId: string, body: unknown) {
  if (auth.role !== 'ADM') throw forbidden();
  const v = F.parseFields(body, { number: { label: 'WhatsApp number', required: true, rule: F.mobile } }) as { number: string };
  const [w] = await db.update(whatsappNumbers).set({ status: 'READY', number: v.number, readyAt: clock.now(), version: sql`${whatsappNumbers.version} + 1` }).where(eq(whatsappNumbers.accountId, accountId)).returning();
  if (!w) throw notFound();
  const [adv] = await db.select({ id: users.id }).from(users).where(and(eq(users.accountId, accountId), eq(users.role, 'ADV')));
  if (adv) await notify(db, { userId: adv.id, accountId, messageId: 'SUB-16', params: { number: v.number }, link: { type: 'PLAN', id: accountId }, dedupeKey: `wa-ready:${accountId}:${v.number}` });
  await audit(db, req, { action: 'WHATSAPP_NUMBER_READY', entity: 'account', entityId: accountId, accountId, newValue: { number: v.number } });
  return { message: msg('SUB-16', { number: v.number }) };
}

/** Leaving Premium: greetings off, queued automated WhatsApp cancelled, assistants disabled (P-40, P-53). */
async function leavePremium(tx: DbOrTx, accountId: string) {
  await tx.update(occasionSettings).set({ enabled: false }).where(eq(occasionSettings.accountId, accountId));
  await cancelWhere(tx, accountId, 'Not on Premium plan', eq(outgoingMessages.channel, 'WHATSAPP'));
  const asts = await tx.update(users).set({ status: 'DISABLED' }).where(and(eq(users.accountId, accountId), eq(users.role, 'AST'), ne(users.status, 'DISABLED'))).returning({ id: users.id });
  for (const a of asts) await endAllSessions(tx, a.id, 'USER_DISABLED');
}

// ---------- SYS-05 subscriptions, daily at CFG-118 ----------
export async function runSubscriptions() {
  const today = istToday();
  const stats = { started: 0, grace: 0, expired: 0, closed: 0, reminders: 0 };
  // 1. Scheduled periods that start today become current
  const starting = await db.select().from(subscriptions).where(and(eq(subscriptions.isCurrent, false), eq(subscriptions.status, 'ACTIVE'), lte(subscriptions.periodStart, today), sql`${subscriptions.periodEnd} >= ${today}`)).orderBy(asc(subscriptions.periodStart));
  for (const s of starting) {
    await db.transaction(async (tx) => {
      const [cur] = await tx.select().from(subscriptions).where(and(eq(subscriptions.accountId, s.accountId), eq(subscriptions.isCurrent, true)));
      if (cur && cur.periodStart >= s.periodStart) return;
      if (cur) await tx.update(subscriptions).set({ isCurrent: false }).where(eq(subscriptions.id, cur.id));
      await tx.update(subscriptions).set({ isCurrent: true }).where(eq(subscriptions.id, s.id));
      if (cur && isPremium(cur) && s.plan !== 'PREMIUM') await leavePremium(tx, s.accountId);
      stats.started++;
    });
  }
  const current = await db.select({ s: subscriptions, a: accounts }).from(subscriptions).innerJoin(accounts, eq(accounts.id, subscriptions.accountId)).where(and(eq(subscriptions.isCurrent, true), ne(accounts.status, 'CLOSED')));
  for (const { s, a } of current) {
    const [adv] = await db.select().from(users).where(and(eq(users.accountId, s.accountId), eq(users.role, 'ADV')));
    const graceEnd = addDays(s.periodEnd, settings.get('CFG-79'));
    await db.transaction(async (tx) => {
      if (s.status === 'ACTIVE' && s.periodEnd < today) {
        await tx.update(subscriptions).set({ status: 'GRACE', version: s.version + 1 }).where(eq(subscriptions.id, s.id));
        if (adv) await notify(tx, { userId: adv.id, accountId: s.accountId, messageId: 'SUB-05', params: { date: formatDate(s.periodEnd), days: settings.get('CFG-79') }, link: { type: 'PLAN', id: s.accountId }, dedupeKey: `sub-grace:${s.id}` });
        stats.grace++;
      } else if ((s.status === 'GRACE' && graceEnd < today) || (s.status === 'TRIAL' && s.periodEnd < today)) {
        await tx.update(subscriptions).set({ status: 'EXPIRED', version: s.version + 1 }).where(eq(subscriptions.id, s.id));
        if (isPremium(s)) await leavePremium(tx, s.accountId);
        stats.expired++;
      } else if (s.status === 'EXPIRED') {
        const readOnlyFrom = s.plan ? graceEnd : s.periodEnd;
        if (addDays(readOnlyFrom, settings.get('CFG-81')) < today && a.status !== 'CLOSED') {
          await tx.update(accounts).set({ status: 'CLOSED', statusReason: 'Read-only period ended', closedAt: clock.now() }).where(eq(accounts.id, s.accountId));
          const people = await tx.select({ id: users.id }).from(users).where(eq(users.accountId, s.accountId));
          for (const u of people) await endAllSessions(tx, u.id, 'ACCOUNT_CLOSED');
          await audit(tx, null, { action: 'ACCOUNT_CLOSED', entity: 'account', entityId: s.accountId, accountId: s.accountId, newValue: { reason: 'Read-only period ended' }, actor: { job: 'SYS-05' } });
          stats.closed++;
        }
      } else if (s.status === 'ACTIVE' && adv) {
        // CFG-80 reminders before the end (DSH-18), unless a next period is already paid
        const left = Math.round((new Date(`${s.periodEnd}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86_400_000);
        if (settings.get('CFG-80').includes(left)) {
          const [next] = await tx.select({ id: subscriptions.id }).from(subscriptions).where(and(eq(subscriptions.accountId, s.accountId), gt(subscriptions.periodStart, s.periodEnd)));
          const [p] = await tx.select({ email: advisorProfiles.email }).from(advisorProfiles).where(eq(advisorProfiles.accountId, s.accountId));
          if (!next && (await notify(tx, { userId: adv.id, accountId: s.accountId, messageId: 'DSH-18', params: { plan: PLAN_NAME[s.plan ?? ''] ?? '', date: formatDate(s.periodEnd) }, link: { type: 'PLAN', id: s.accountId }, dedupeKey: `sub-end:${s.id}:${left}`, email: { to: p?.email, subject: 'Your Bimayantra plan is ending' } }))) stats.reminders++;
        }
      }
    });
  }
  return stats;
}
defineDaily('SYS-05', 'CFG-118', runSubscriptions);

// ---------- SYS-13 trial reminders ----------
export async function runTrialReminders() {
  const today = istToday();
  const trials = await db.select().from(subscriptions).where(and(eq(subscriptions.isCurrent, true), eq(subscriptions.status, 'TRIAL')));
  let n = 0;
  for (const s of trials) {
    const left = Math.round((new Date(`${s.periodEnd}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86_400_000);
    if (!settings.get('CFG-178').includes(left)) continue;
    const [adv] = await db.select().from(users).where(and(eq(users.accountId, s.accountId), eq(users.role, 'ADV')));
    const [p] = await db.select({ email: advisorProfiles.email }).from(advisorProfiles).where(eq(advisorProfiles.accountId, s.accountId));
    if (adv && (await notify(db, { userId: adv.id, accountId: s.accountId, messageId: 'SUB-11', params: { date: formatDate(s.periodEnd) }, link: { type: 'PLAN', id: s.accountId }, dedupeKey: `trial:${s.id}:${left}`, email: { to: p?.email, subject: 'Your Bimayantra free trial is ending' } }))) n++;
  }
  return { reminders: n };
}
defineDaily('SYS-13', 'CFG-118', runTrialReminders);

