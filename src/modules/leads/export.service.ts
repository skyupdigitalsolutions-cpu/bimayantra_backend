// "Download Excel" on Leads and on Customers: every detail of every record, as sheets the website turns into
// one .xlsx file. Leads follow the same filters as the list on screen (stage, pipeline, search, dates).
// Customers come with two more sheets: Family members and Policies. PAN / Aadhaar only as the masked copy.
// Advisor only (it is the whole book of business); every download is written to the audit log.
import type { Request } from 'express';
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { customers, familyMembers, insuranceTypes, insurers, leadEvents, leads, pipelines, policies, quotations, users } from '../../db/schema.js';
import { addDays, istToday } from '../../lib/clock.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { settings } from '../settings/settings.service.js';
import { istInstant } from '../tasks/tasks.service.js';
import { isUuid } from '../clients/common.js';
import { NEXT, OPEN, STATUS_TEXT } from './leads.service.js';

type Cell = string | number | null;
export type Sheet = { name: string; columns: string[]; widths?: number[]; rows: Cell[][] };
const MAX = 20_000;

const d = (iso: string | null | undefined) => (iso ? iso.slice(0, 10).split('-').reverse().join('-') : null);
const dt = (at: Date | null | undefined) => {
  if (!at) return null;
  const ist = new Date(at.getTime() + 330 * 60_000).toISOString();
  return `${d(ist.slice(0, 10))} ${ist.slice(11, 16)}`;
};
const ph = (v: string | null | undefined) => (v ? v.replace(/^\+91/, '') : null); // as on screen; imports back as is
const num = (v: string | null | undefined) => (v == null || v === '' ? null : Number(v));
const word = (v: string | null | undefined) => (v ? v.charAt(0) + v.slice(1).toLowerCase().replace(/_/g, ' ') : null);
const ageOf = (dob: string | null) => {
  if (!dob) return null;
  const t = istToday();
  let a = Number(t.slice(0, 4)) - Number(dob.slice(0, 4));
  if (t.slice(5) < dob.slice(5)) a--;
  return a;
};
const OUTCOME: Record<string, string> = { SPOKE: 'Spoke to customer', NOT_REACHABLE: 'Not reachable', CALL_BACK: 'Asked to call back' };

async function userNames(accountId: string) {
  const rows = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.accountId, accountId));
  return new Map(rows.map((u) => [u.id, u.name]));
}

export async function exportLeads(req: Request, auth: AuthContext, f: { status?: string; pipelineId?: string; q?: string; from?: string; to?: string }) {
  const accountId = auth.accountId!;
  const statuses = f.status === 'OPEN' ? [...OPEN] : f.status ? f.status.split(',').filter((s) => s in NEXT) : [];
  const term = f.q?.trim().replace(/[%_\\]/g, '');
  const digits = term?.replace(/\D/g, '') ?? '';
  const rows = await db.select().from(leads).where(and(
    eq(leads.accountId, accountId),
    statuses.length ? inArray(leads.status, statuses) : sql`true`,
    isUuid(f.pipelineId) ? eq(leads.pipelineId, f.pipelineId) : sql`true`,
    f.from ? sql`${leads.createdAt} >= ${istInstant(f.from, '00:00')}` : sql`true`,
    f.to ? sql`${leads.createdAt} < ${istInstant(addDays(f.to, 1), '00:00')}` : sql`true`,
    term ? or(ilike(leads.name, `%${term}%`), ilike(leads.number, `%${term}%`), ilike(leads.email, `%${term}%`), digits.length >= settings.get('CFG-132') ? ilike(leads.mobile, `%${digits}%`) : sql`false`) : sql`true`,
  )).orderBy(desc(leads.createdAt)).limit(MAX);

  const names = await userNames(accountId);
  const pipes = new Map((await db.select({ id: pipelines.id, name: pipelines.name }).from(pipelines).where(eq(pipelines.accountId, accountId))).map((p) => [p.id, p.name]));
  const types = new Map((await db.select({ id: insuranceTypes.id, name: insuranceTypes.name }).from(insuranceTypes)).map((t) => [t.id, t.name]));
  const custIds = [...new Set(rows.flatMap((l) => [l.customerId, l.referredByCustomerId]).filter((x): x is string => !!x))];
  const custs = new Map(custIds.length ? (await db.select({ id: customers.id, number: customers.number, fullName: customers.fullName }).from(customers).where(inArray(customers.id, custIds))).map((c) => [c.id, c]) : []);
  // contacts: count, last one
  const events = rows.length ? await db.select().from(leadEvents).where(and(eq(leadEvents.accountId, accountId), eq(leadEvents.kind, 'CONTACT'))).orderBy(asc(leadEvents.at)) : [];
  const contacts = new Map<string, { n: number; last: (typeof events)[number] }>();
  for (const e of events) contacts.set(e.leadId, { n: (contacts.get(e.leadId)?.n ?? 0) + 1, last: e });

  const sheet: Sheet = {
    name: 'Leads',
    columns: ['Lead number', 'Name', 'Mobile', 'Alternate mobile', 'Email', 'Stage', 'Priority', 'Pipeline', 'Interested in', 'Source', 'Campaign', 'Referred by (referrer)', 'Referred by (customer)', 'Next follow-up', 'Times contacted', 'Last contacted', 'Last contact result', 'Last contact note', 'Lost reason', 'Lost note', 'Converted to customer', 'Converted on', 'Notes', 'Added on', 'Added by', 'Last updated'],
    widths: [14, 24, 15, 15, 26, 12, 10, 16, 24, 16, 16, 20, 22, 17, 10, 17, 20, 30, 18, 24, 24, 17, 34, 17, 16, 17],
    rows: rows.map((l) => {
      const c = contacts.get(l.id);
      const conv = l.customerId ? custs.get(l.customerId) : undefined;
      const refC = l.referredByCustomerId ? custs.get(l.referredByCustomerId) : undefined;
      return [
        l.number, l.name, ph(l.mobile), ph(l.altMobile), l.email, STATUS_TEXT[l.status] ?? l.status, word(l.priority), pipes.get(l.pipelineId) ?? null,
        l.interestTypeIds.map((id) => types.get(id) ?? '').filter(Boolean).join(', ') || null,
        l.source, l.campaign, l.referrerUserId ? (names.get(l.referrerUserId) ?? null) : null, refC ? `${refC.fullName} (${refC.number})` : null,
        dt(l.nextFollowUpAt), c?.n ?? 0, dt(c?.last.at), c?.last.outcome ? (OUTCOME[c.last.outcome] ?? c.last.outcome) : null, c?.last.note ?? null,
        l.lostReason, l.lostNote, conv ? `${conv.fullName} (${conv.number})` : null, dt(l.convertedAt), l.notes,
        dt(l.createdAt), names.get(l.createdBy) ?? null, dt(l.updatedAt),
      ];
    }),
  };
  await audit(db, req, { action: 'LEADS_EXPORTED', entity: 'lead', entityId: accountId, newValue: { count: rows.length, filters: f } });
  return { fileName: `Leads ${d(istToday())}.xlsx`, sheets: [sheet] };
}

export async function exportCustomers(req: Request, auth: AuthContext, f: { status?: string; q?: string }) {
  const accountId = auth.accountId!;
  const term = f.q?.trim().replace(/[%_\\]/g, '');
  const digits = term?.replace(/\D/g, '') ?? '';
  const cs = await db.select().from(customers).where(and(
    eq(customers.accountId, accountId),
    f.status === 'ACTIVE' || f.status === 'INACTIVE' ? eq(customers.status, f.status) : sql`true`,
    term ? or(ilike(customers.fullName, `%${term}%`), ilike(customers.number, `%${term}%`), ilike(customers.email, `%${term}%`), digits.length >= settings.get('CFG-132') ? ilike(customers.mobile, `%${digits}%`) : sql`false`) : sql`true`,
  )).orderBy(asc(customers.fullName)).limit(MAX);
  const ids = cs.map((c) => c.id);
  const byId = new Map(cs.map((c) => [c.id, c]));
  const names = await userNames(accountId);
  const fam = ids.length ? await db.select().from(familyMembers).where(and(inArray(familyMembers.customerId, ids), eq(familyMembers.status, 'ACTIVE'))).orderBy(asc(familyMembers.fullName)) : [];
  const pols = ids.length ? await db.select({ p: policies, insurer: insurers.name }).from(policies).leftJoin(insurers, eq(insurers.id, policies.insurerId)).where(inArray(policies.customerId, ids)).orderBy(desc(policies.createdAt)) : [];
  const quotes = ids.length ? await db.select({ customerId: quotations.customerId, number: quotations.number, createdAt: quotations.createdAt }).from(quotations).where(and(inArray(quotations.customerId, ids), sql`${quotations.number} is not null`)).orderBy(desc(quotations.createdAt)) : [];
  const leadNos = new Map(cs.some((c) => c.leadId) ? (await db.select({ id: leads.id, number: leads.number }).from(leads).where(eq(leads.accountId, accountId))).map((l) => [l.id, l.number]) : []);
  const today = istToday();

  const customersSheet: Sheet = {
    name: 'Customers',
    columns: ['Customer number', 'Full name', 'Mobile', 'Alternate mobile', 'Email', 'Preferred contact', 'Date of birth', 'Age', 'Gender', 'Address line 1', 'Address line 2', 'City', 'State', 'PIN code', 'Occupation', 'Anniversary', 'PAN (masked)', 'Aadhaar (masked)', 'Family members', 'Quotations', 'Latest quotation', 'Policies', 'Active policies', 'Total yearly premium (₹)', 'Next renewal', 'Source', 'From lead', 'Campaign', 'Referred by (referrer)', 'Referred by (customer)', 'Default nominee', 'Status', 'Inactive reason', 'Notes', 'Added on', 'Added by'],
    widths: [15, 24, 15, 15, 26, 12, 13, 6, 10, 28, 22, 14, 14, 9, 16, 13, 13, 15, 34, 10, 16, 9, 9, 14, 13, 14, 12, 14, 18, 22, 22, 9, 18, 34, 17, 16],
    rows: cs.map((c) => {
      const fm = fam.filter((x) => x.customerId === c.id);
      const ps = pols.filter((x) => x.p.customerId === c.id).map((x) => x.p);
      const active = ps.filter((p) => p.status === 'ISSUED' && (!p.endDate || p.endDate >= today));
      const qs = quotes.filter((q) => q.customerId === c.id);
      const renewal = active.map((p) => p.endDate).filter((x): x is string => !!x).sort()[0] ?? null;
      const premium = active.reduce((s, p) => s + (Number(p.premium) || 0), 0);
      const ref = c.referredByCustomerId ? byId.get(c.referredByCustomerId) : undefined;
      const nominee = c.defaultNominee as { name?: string; relationship?: string; sharePercent?: number } | null;
      return [
        c.number, c.fullName, ph(c.mobile), ph(c.altMobile), c.email, word(c.preferredContact), d(c.dateOfBirth), ageOf(c.dateOfBirth), word(c.gender),
        c.addressLine1, c.addressLine2, c.city, c.state, c.pinCode, c.occupation, d(c.anniversary), c.panMasked, c.aadhaarMasked,
        fm.map((m) => `${m.fullName} (${word(m.relationship)}${m.dateOfBirth ? `, ${ageOf(m.dateOfBirth)}` : ''})`).join('; ') || null,
        qs.length, qs[0]?.number ?? null, ps.length, active.length, premium || null, d(renewal),
        c.source, c.leadId ? (leadNos.get(c.leadId) ?? null) : null, c.campaign, c.referrerUserId ? (names.get(c.referrerUserId) ?? null) : null, ref ? `${ref.fullName} (${ref.number})` : null,
        nominee?.name ? `${nominee.name}${nominee.relationship ? ` (${word(nominee.relationship)})` : ''}${nominee.sharePercent ? ` ${nominee.sharePercent}%` : ''}` : null,
        word(c.status), c.inactiveReason, c.notes, dt(c.createdAt), names.get(c.createdBy) ?? null,
      ];
    }),
  };
  const familySheet: Sheet = {
    name: 'Family members',
    columns: ['Customer number', 'Customer name', 'Member name', 'Relationship', 'Date of birth', 'Age', 'Gender', 'Mobile', 'Email', 'Anniversary'],
    widths: [15, 24, 24, 14, 13, 6, 10, 15, 26, 13],
    rows: fam.map((m) => {
      const c = byId.get(m.customerId)!;
      return [c.number, c.fullName, m.fullName, word(m.relationship), d(m.dateOfBirth), ageOf(m.dateOfBirth), word(m.gender), ph(m.mobile), m.email, d(m.anniversary)];
    }),
  };
  const policySheet: Sheet = {
    name: 'Policies',
    columns: ['Customer number', 'Customer name', 'Policy (app number)', 'Insurer policy number', 'Insurer', 'Product', 'Status', 'Start date', 'End date', 'Next due date', 'Payment frequency', 'Sum insured (₹)', 'Premium (₹)', 'People covered', 'Sold by me', 'Notes'],
    widths: [15, 24, 16, 22, 28, 26, 12, 12, 12, 13, 13, 14, 12, 34, 10, 30],
    rows: pols.map(({ p, insurer }) => {
      const c = byId.get(p.customerId)!;
      const insured = Array.isArray(p.insured) ? (p.insured as { name?: string; fullName?: string; relationship?: string }[]).map((i) => i.fullName ?? i.name).filter(Boolean).join(', ') : '';
      return [c.number, c.fullName, p.number, p.insurerPolicyNumber, insurer, p.productName, word(p.status), d(p.startDate), d(p.endDate), d(p.nextDueDate), word(p.frequency), num(p.sumInsured), num(p.premium), insured || null, p.soldByMe ? 'Yes' : 'No', p.notes];
    }),
  };
  await audit(db, req, { action: 'CUSTOMERS_EXPORTED', entity: 'customer', entityId: accountId, newValue: { count: cs.length, filters: f } });
  return { fileName: `Customers ${d(istToday())}.xlsx`, sheets: [customersSheet, familySheet, policySheet] };
}
