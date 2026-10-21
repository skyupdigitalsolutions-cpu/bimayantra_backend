// Phase 5 hooks into earlier modules: customer deactivation open items (P-19), the cover map (P-15),
// dashboard counts and global search (P-08, P-09), and the daily jobs SYS-01 (expiry) and SYS-06
// (advisor reminders for payment status, CFG-49, and awaiting issuance, CFG-57).
import { and, eq, ilike, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { customers, payments, policies, quotationRevisions, quotations, users } from '../../db/schema.js';
import { addDays, clock, istToday } from '../../lib/clock.js';
import { registerOpenItemsCheck } from '../clients/hooks.js';
import { registerHeldTypes } from '../customers/customers.service.js';
import { registerCounts, registerSearch } from '../dashboard/counts.service.js';
import { defineDaily } from '../jobs/daily.js';
import { notify } from '../notifications/notifications.service.js';
import { settings } from '../settings/settings.service.js';
import { CUSTOMER_KEY } from '../quotations/engine.js';
import { expireComparisons } from '../quotations/comparisons.service.js';
import { expireQuotations } from '../quotations/quotations.service.js';

registerOpenItemsCheck(async (tx, accountId, customerId) => {
  const revs = await tx
    .select({ number: quotations.number, status: quotationRevisions.status })
    .from(quotationRevisions)
    .innerJoin(quotations, eq(quotations.id, quotationRevisions.quotationId))
    .where(and(eq(quotations.accountId, accountId), eq(quotations.customerId, customerId), inArray(quotationRevisions.status, ['READY', 'SHARED'])));
  const pays = await tx
    .select({ number: quotations.number })
    .from(payments)
    .innerJoin(quotations, eq(quotations.id, payments.quotationId))
    .where(and(eq(quotations.customerId, customerId), eq(payments.status, 'AWAITING_PAYMENT')));
  return [...revs.map((r) => ({ type: 'Quotation', number: r.number ?? '—' })), ...pays.map((p) => ({ type: 'Payment awaited on', number: p.number ?? '—' }))];
});

registerHeldTypes(async (accountId, customerIds, memberIds) => {
  const map = new Map<string, Set<string>>();
  if (!customerIds.length) return map;
  const rows = await db
    .select({ customerId: policies.customerId, typeId: policies.typeId, insured: policies.insured })
    .from(policies)
    .where(and(eq(policies.accountId, accountId), inArray(policies.customerId, customerIds), eq(policies.status, 'ISSUED'), isNotNull(policies.typeId)));
  for (const r of rows) {
    for (const p of r.insured as { key: string }[]) {
      const key = p.key === CUSTOMER_KEY ? r.customerId : p.key;
      if (p.key !== CUSTOMER_KEY && !memberIds.includes(p.key)) continue;
      if (!map.has(key)) map.set(key, new Set());
      map.get(key)!.add(r.typeId!);
    }
  }
  return map;
});

registerCounts(async (accountId) => {
  const [q] = await db.select({ n: sql<number>`count(*)::int` }).from(quotationRevisions).where(and(eq(quotationRevisions.accountId, accountId), inArray(quotationRevisions.status, ['READY', 'SHARED', 'ACCEPTED'])));
  const [a] = await db.select({ n: sql<number>`count(*)::int` }).from(policies).where(and(eq(policies.accountId, accountId), eq(policies.status, 'AWAITING_ISSUANCE')));
  const [i] = await db.select({ n: sql<number>`count(*)::int` }).from(policies).where(and(eq(policies.accountId, accountId), eq(policies.status, 'ISSUED')));
  // Cash and cheque payments stay flagged until the policy is recorded (P-32 backend rules)
  const [cc] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(payments)
    .where(and(eq(payments.accountId, accountId), eq(payments.status, 'PAID'), inArray(payments.mode, ['Cash', 'Cheque']), sql`not exists (select 1 from ${policies} where ${policies.paymentId} = ${payments.id} and ${policies.status} in ('ISSUED','RENEWED','EXPIRED'))`));
  return [
    { key: 'openQuotations', label: 'Open quotations', value: q?.n ?? 0, link: '/quotations?status=OPEN' },
    { key: 'awaitingIssuance', label: 'Awaiting issuance', value: a?.n ?? 0, link: '/policies?status=AWAITING_ISSUANCE' },
    { key: 'activePolicies', label: 'Active policies', value: i?.n ?? 0, link: '/policies?status=ISSUED' },
    { key: 'cashCheque', label: 'Cash or cheque, policy not recorded', value: cc?.n ?? 0, link: '/policies?status=AWAITING_ISSUANCE' },
  ];
});

registerSearch(async (accountId, term, _digits, limit) => {
  const t = `%${term.replace(/[%_\\]/g, '')}%`;
  const rows = await db
    .select({ q: quotations, name: customers.fullName })
    .from(quotations)
    .innerJoin(customers, eq(customers.id, quotations.customerId))
    .where(and(eq(quotations.accountId, accountId), isNotNull(quotations.number), ilike(quotations.number, t)))
    .limit(limit);
  return { group: 'Quotations', items: rows.map(({ q, name }) => ({ id: q.id, title: q.number!, subtitle: name, status: '', link: `/quotations/q/${q.id}` })) };
});
registerSearch(async (accountId, term, _digits, limit) => {
  const t = `%${term.replace(/[%_\\]/g, '')}%`;
  const rows = await db
    .select({ p: policies, name: customers.fullName })
    .from(policies)
    .innerJoin(customers, eq(customers.id, policies.customerId))
    .where(and(eq(policies.accountId, accountId), or(ilike(policies.number, t), ilike(policies.insurerPolicyNumber, t))))
    .limit(limit);
  return { group: 'Policies', items: rows.map(({ p, name }) => ({ id: p.id, title: p.insurerPolicyNumber ?? p.number, subtitle: `${p.number} · ${name} · ${p.productName}`, status: p.status, link: `/policies/${p.id}` })) };
});

// SYS-01 Quotation and comparison expiry, daily at CFG-48
defineDaily('SYS-01', 'CFG-48', async () => ({ ...(await expireQuotations()), comparisons: await expireComparisons() }));

// SYS-06 Advisor reminders, daily at CFG-119
export async function advisorReminders() {
  const today = istToday();
  const staleBefore = new Date(clock.now().getTime() - settings.get('CFG-49') * 86_400_000);
  const pays = await db
    .select({ p: payments, number: quotations.number, accountId: quotations.accountId, name: customers.fullName })
    .from(payments)
    .innerJoin(quotations, eq(quotations.id, payments.quotationId))
    .innerJoin(customers, eq(customers.id, quotations.customerId))
    .where(and(eq(payments.status, 'AWAITING_PAYMENT'), lt(sql`coalesce(${payments.updatedAt}, ${payments.createdAt})`, staleBefore)));
  let n = 0;
  for (const r of pays) {
    const [adv] = await db.select({ id: users.id }).from(users).where(and(eq(users.accountId, r.accountId), eq(users.role, 'ADV')));
    if (adv && (await notify(db, { userId: adv.id, accountId: r.accountId, messageId: 'DSH-12', params: { 'quotation number': r.number ?? '', customer: r.name }, link: { type: 'QUOTATION', id: r.p.quotationId! }, dedupeKey: `pay-stale:${r.p.id}:${today}` }))) n++;
  }
  const waitBefore = new Date(clock.now().getTime() - settings.get('CFG-57') * 86_400_000);
  const pols = await db
    .select({ p: policies, name: customers.fullName })
    .from(policies)
    .innerJoin(customers, eq(customers.id, policies.customerId))
    .where(and(eq(policies.status, 'AWAITING_ISSUANCE'), lt(policies.createdAt, waitBefore)));
  for (const r of pols) {
    const [adv] = await db.select({ id: users.id }).from(users).where(and(eq(users.accountId, r.p.accountId), eq(users.role, 'ADV')));
    if (adv && (await notify(db, { userId: adv.id, accountId: r.p.accountId, messageId: 'DSH-13', params: { customer: r.name, product: r.p.productName }, link: { type: 'POLICY', id: r.p.id }, dedupeKey: `await-issue:${r.p.id}:${today}` }))) n++;
  }
  void addDays;
  return { reminders: n };
}
defineDaily('SYS-06', 'CFG-119', advisorReminders);
