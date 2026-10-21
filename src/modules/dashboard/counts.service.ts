// P-08 count widgets and the lead funnel, and P-09 global search. Every query is scoped to the account
// (GR-20); later modules add their own counts and search groups through the registries below.
import { and, eq, gte, ilike, inArray, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { customers, familyMembers, leads } from '../../db/schema.js';
import { addDays, istToday } from '../../lib/clock.js';
import { msg } from '../../messages/messages.js';
import { settings } from '../settings/settings.service.js';
import { istInstant } from '../tasks/tasks.service.js';

export type Count = { key: string; label: string; value: number; sub?: string | null; link: string };
type CountFn = (accountId: string) => Promise<Count[]>;
type SearchHit = { id: string; title: string; subtitle: string; status: string; link: string };
type SearchFn = (accountId: string, term: string, digits: string, limit: number) => Promise<{ group: string; items: SearchHit[] }>;
const countFns: CountFn[] = [];
const searchFns: SearchFn[] = [];
export const registerCounts = (fn: CountFn) => void countFns.push(fn);
export const registerSearch = (fn: SearchFn) => void searchFns.push(fn);

const OPEN = ['NEW', 'CONTACTED', 'QUALIFIED', 'FOLLOW_UP'];

registerCounts(async (accountId) => {
  const [l] = await db.select({ n: sql<number>`count(*)::int` }).from(leads).where(and(eq(leads.accountId, accountId), inArray(leads.status, OPEN)));
  const [c] = await db.select({ n: sql<number>`count(*)::int` }).from(customers).where(and(eq(customers.accountId, accountId), eq(customers.status, 'ACTIVE')));
  return [
    { key: 'openLeads', label: 'Open leads', value: l?.n ?? 0, link: '/leads?status=OPEN' },
    { key: 'activeCustomers', label: 'Active customers', value: c?.n ?? 0, link: '/customers?status=ACTIVE' },
  ];
});

export async function counts(accountId: string) {
  const all = await Promise.all(countFns.map((fn) => fn(accountId)));
  return { items: all.flat() };
}

/** Lead funnel: leads created in the period, count per status, and how many reached CONVERTED. */
export async function funnel(accountId: string, period: string) {
  const today = istToday();
  const from = period === 'year' ? `${today.slice(0, 4)}-01-01` : period === '3months' ? addDays(`${today.slice(0, 7)}-01`, -62).slice(0, 7) + '-01' : `${today.slice(0, 7)}-01`;
  const rows = await db
    .select({ status: leads.status, n: sql<number>`count(*)::int` })
    .from(leads)
    .where(and(eq(leads.accountId, accountId), gte(leads.createdAt, istInstant(from, '00:00'))))
    .groupBy(leads.status);
  const stages = settings.get('CFG-170');
  const total = rows.reduce((s, r) => s + r.n, 0);
  return {
    period,
    from,
    to: today,
    total,
    bars: stages.map((s) => ({ status: s, count: rows.find((r) => r.status === s)?.n ?? 0 })),
    converted: rows.find((r) => r.status === 'CONVERTED')?.n ?? 0,
    empty: total ? null : msg('DSH-04'),
  };
}

registerSearch(async (accountId, term, digits, limit) => {
  const rows = await db
    .select()
    .from(leads)
    .where(and(eq(leads.accountId, accountId), or(ilike(leads.name, `%${term}%`), ilike(leads.number, `%${term}%`), ilike(leads.email, `%${term}%`), digits ? ilike(leads.mobile, `%${digits}%`) : sql`false`)))
    .limit(limit);
  return { group: 'Leads', items: rows.map((l) => ({ id: l.id, title: l.name, subtitle: `${l.number} · ${l.mobile}`, status: l.status, link: `/leads/${l.id}` })) };
});
registerSearch(async (accountId, term, digits, limit) => {
  const rows = await db
    .select()
    .from(customers)
    .where(and(eq(customers.accountId, accountId), or(ilike(customers.fullName, `%${term}%`), ilike(customers.number, `%${term}%`), ilike(customers.email, `%${term}%`), digits ? ilike(customers.mobile, `%${digits}%`) : sql`false`)))
    .limit(limit);
  return { group: 'Customers', items: rows.map((c) => ({ id: c.id, title: c.fullName, subtitle: `${c.number} · ${c.mobile}`, status: c.status, link: `/customers/${c.id}` })) };
});
registerSearch(async (accountId, term, digits, limit) => {
  const rows = await db
    .select({ m: familyMembers, customerName: customers.fullName })
    .from(familyMembers)
    .innerJoin(customers, eq(customers.id, familyMembers.customerId))
    .where(and(eq(familyMembers.accountId, accountId), or(ilike(familyMembers.fullName, `%${term}%`), ilike(familyMembers.email, `%${term}%`), digits ? ilike(familyMembers.mobile, `%${digits}%`) : sql`false`)))
    .limit(limit);
  // A family member opens their customer's Family tab (P-09 step 4)
  return { group: 'Family members', items: rows.map(({ m, customerName }) => ({ id: m.id, title: m.fullName, subtitle: `${m.relationship} of ${customerName}`, status: m.status, link: `/customers/${m.customerId}?tab=family` })) };
});

/** Global search (P-09): CFG-24 characters at least; results grouped, CFG-25 in total; inactive included. */
export async function search(accountId: string, q: string) {
  const text = q.trim();
  const min = settings.get('CFG-24');
  if (text.length < min) return { groups: [], message: msg('DSH-02', { 'CFG-24': min }) };
  const term = text.replace(/[%_\\]/g, '');
  const d = text.replace(/\D/g, '');
  const digits = d.length >= settings.get('CFG-132') ? d : '';
  const max = settings.get('CFG-25');
  const groups = (await Promise.all(searchFns.map((fn) => fn(accountId, term, digits, max)))).filter((g) => g.items.length);
  // Up to CFG-25 in total, shared across the groups in order
  let left = max;
  const trimmed = groups.map((g) => {
    const items = g.items.slice(0, Math.max(0, left));
    left -= items.length;
    return { ...g, items, more: g.items.length > items.length };
  }).filter((g) => g.items.length);
  return { groups: trimmed, message: trimmed.length ? null : msg('DSH-03', { text }) };
}
