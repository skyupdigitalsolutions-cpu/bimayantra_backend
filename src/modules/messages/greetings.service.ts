// P-40 Occasion greetings (Premium) and P-41 the daily greeting run (SYS-04 at CFG-65).
// Occurrence key = account + person + occasion + year: a greeting goes at most once a year (AC-P41-1).
import type { Request } from 'express';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { accounts, customers, familyMembers, occasionExclusions, occasionSettings, outgoingMessages, users, wallets, whatsappNumbers } from '../../db/schema.js';
import { addDays, clock, istToday } from '../../lib/clock.js';
import { AppError, fieldErrors, forbidden, versionConflict } from '../../lib/errors.js';
import { msg } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { currentSubscription, isPremium } from '../accounts/accounts.service.js';
import { readVersion } from '../clients/common.js';
import { defineDaily } from '../jobs/daily.js';
import { defineJob } from '../jobs/jobs.js';
import { notify } from '../notifications/notifications.service.js';
import { settings } from '../settings/settings.service.js';
import { advisorFacts } from '../quotations/engine.js';
import { cancelWhere, consentState, dispatch, queueMessage, registerSendCheck, sentToday, windowState } from './messages.service.js';
import { activeTemplate, fill, type Purpose } from './templates.js';

type Occasion = 'BIRTHDAY' | 'ANNIVERSARY';
type PersonRow = { key: string; customerId: string; familyMemberId: string | null; name: string; relationship: string; dob: string | null; anniversary: string | null; mobile: string | null; customerName: string; customerMobile: string; customerAnniversary: string | null };

async function settingsOf(accountId: string) {
  const [s] = await db.select().from(occasionSettings).where(eq(occasionSettings.accountId, accountId));
  return s ?? { accountId, enabled: false, birthdayTemplateId: null, familyBirthdayTemplateId: null, anniversaryTemplateId: null, updatedAt: null, version: 0 };
}

async function people(accountId: string): Promise<PersonRow[]> {
  const cs = await db.select().from(customers).where(and(eq(customers.accountId, accountId), eq(customers.status, 'ACTIVE')));
  const byId = new Map(cs.map((c) => [c.id, c]));
  const fs = cs.length ? await db.select().from(familyMembers).where(and(inArray(familyMembers.customerId, cs.map((c) => c.id)), eq(familyMembers.status, 'ACTIVE'))) : [];
  return [
    ...cs.map((c) => ({ key: `customer:${c.id}`, customerId: c.id, familyMemberId: null, name: c.fullName, relationship: 'Self', dob: c.dateOfBirth, anniversary: c.anniversary, mobile: c.mobile, customerName: c.fullName, customerMobile: c.mobile, customerAnniversary: c.anniversary })),
    ...fs.map((f) => {
      const c = byId.get(f.customerId)!;
      return { key: `member:${f.id}`, customerId: f.customerId, familyMemberId: f.id, name: f.fullName, relationship: f.relationship, dob: f.dateOfBirth, anniversary: f.anniversary, mobile: f.mobile, customerName: c.fullName, customerMobile: c.mobile, customerAnniversary: c.anniversary };
    }),
  ];
}

/** Who receives a greeting and with which template purpose (P-40 table). null = not sent. */
async function recipientFor(p: PersonRow, occasion: Occasion) {
  if (occasion === 'BIRTHDAY') {
    if (!p.familyMemberId) return { purpose: 'BIRTHDAY' as Purpose, to: p.mobile, toCustomer: true, consentMember: null };
    if (p.mobile && (await consentState(db, p.customerId, p.familyMemberId, 'WHATSAPP', p.mobile)) === 'GIVEN') return { purpose: 'BIRTHDAY' as Purpose, to: p.mobile, toCustomer: false, consentMember: p.familyMemberId };
    return { purpose: 'FAMILY_BIRTHDAY' as Purpose, to: p.customerMobile, toCustomer: true, consentMember: null };
  }
  if (!p.familyMemberId) return { purpose: 'ANNIVERSARY' as Purpose, to: p.mobile, toCustomer: true, consentMember: null };
  // A spouse with the same anniversary as the customer: the customer's greeting covers it
  if (p.relationship === 'Spouse' && p.anniversary && p.customerAnniversary && p.anniversary.slice(5) === p.customerAnniversary.slice(5)) return null;
  if (p.mobile && (await consentState(db, p.customerId, p.familyMemberId, 'WHATSAPP', p.mobile)) === 'GIVEN') return { purpose: 'ANNIVERSARY' as Purpose, to: p.mobile, toCustomer: false, consentMember: p.familyMemberId };
  return null;
}

/** Day and month equal today; 29 February is greeted on 28 February in a non-leap year (CFG-66). */
export function isToday(date: string | null, today = istToday()): boolean {
  if (!date) return false;
  const md = date.slice(5);
  const y = Number(today.slice(0, 4));
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  if (md === '02-29' && !leap) return today.slice(5) === (settings.get('CFG-66') === 'SEND_ON_28_FEBRUARY' ? '02-28' : '03-01');
  return md === today.slice(5);
}

async function statusFor(accountId: string, p: PersonRow, occasion: Occasion, excluded: Set<string>) {
  const date = occasion === 'BIRTHDAY' ? p.dob : p.anniversary;
  if (excluded.has(p.key)) return 'Excluded';
  if (!date) return 'Missing date';
  const r = await recipientFor(p, occasion);
  if (!r) return occasion === 'ANNIVERSARY' && p.relationship === 'Spouse' ? 'Covered by the customer' : 'No mobile';
  if (!r.to) return 'No mobile';
  const memberForConsent = r.toCustomer ? null : r.consentMember;
  if ((await consentState(db, p.customerId, memberForConsent, 'WHATSAPP', r.to)) !== 'GIVEN') return 'No WhatsApp consent';
  void accountId;
  return 'Eligible';
}

export async function greetingSettings(auth: AuthContext) {
  const sub = await currentSubscription(db, auth.accountId!);
  if (!isPremium(sub)) return { premium: false, message: msg('SUB-01') };
  const s = await settingsOf(auth.accountId!);
  const ex = new Set((await db.select({ k: occasionExclusions.personKey }).from(occasionExclusions).where(eq(occasionExclusions.accountId, auth.accountId!))).map((r) => r.k));
  const list = await people(auth.accountId!);
  const rows = [];
  for (const p of list) {
    for (const occasion of ['BIRTHDAY', 'ANNIVERSARY'] as Occasion[]) {
      const date = occasion === 'BIRTHDAY' ? p.dob : p.anniversary;
      if (occasion === 'ANNIVERSARY' && !date) continue;
      const r = await recipientFor(p, occasion);
      rows.push({ key: p.key, name: p.name, relationship: p.relationship, occasion, date, recipient: r ? (r.toCustomer ? p.customerName : p.name) : '—', status: await statusFor(auth.accountId!, p, occasion, ex), excluded: ex.has(p.key) });
    }
  }
  const advisor = await advisorFacts(db, auth.accountId!);
  const [adv] = await db.select({ mobile: users.mobile }).from(users).where(and(eq(users.accountId, auth.accountId!), eq(users.role, 'ADV')));
  const vars = { 'person first name': 'Asha', 'customer first name': 'Ravi', relationship: 'Daughter', 'advisor name': advisor.name, 'business name': advisor.businessName ?? advisor.name, 'advisor mobile': (adv?.mobile ?? '').replace('+91', '+91 ') };
  const templates = async (purpose: Purpose) => {
    const { messageTemplates } = await import('../../db/schema.js');
    const ts = await db.select().from(messageTemplates).where(and(eq(messageTemplates.purpose, purpose), eq(messageTemplates.channel, 'WHATSAPP'), eq(messageTemplates.status, 'ACTIVE')));
    return ts.map((t) => ({ id: t.id, name: t.name, preview: fill(t.body, vars) }));
  };
  const today = istToday();
  const horizon = settings.get('CFG-139');
  const upcoming = rows
    .filter((r) => r.date && r.status === 'Eligible')
    .map((r) => {
      for (let i = 0; i <= horizon; i++) if (isToday(r.date, addDays(today, i))) return { ...r, on: addDays(today, i) };
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => a!.on.localeCompare(b!.on));
  const [w] = await db.select().from(whatsappNumbers).where(eq(whatsappNumbers.accountId, auth.accountId!));
  return {
    premium: true,
    enabled: s.enabled,
    birthdayTemplateId: s.birthdayTemplateId,
    familyBirthdayTemplateId: s.familyBirthdayTemplateId,
    anniversaryTemplateId: s.anniversaryTemplateId,
    templates: { BIRTHDAY: await templates('BIRTHDAY'), FAMILY_BIRTHDAY: await templates('FAMILY_BIRTHDAY'), ANNIVERSARY: await templates('ANNIVERSARY') },
    people: rows,
    upcoming,
    whatsappNumber: w ? { status: w.status, number: w.number } : null,
    version: s.version,
  };
}

export async function saveGreetingSettings(req: Request, auth: AuthContext, body: unknown) {
  if (auth.role !== 'ADV') throw forbidden();
  if (!isPremium(await currentSubscription(db, auth.accountId!))) throw new AppError(403, 'SUB-01');
  const b = (body ?? {}) as Record<string, unknown>;
  const enabled = b.enabled === true;
  const ids = { birthdayTemplateId: b.birthdayTemplateId, familyBirthdayTemplateId: b.familyBirthdayTemplateId, anniversaryTemplateId: b.anniversaryTemplateId } as Record<string, unknown>;
  const purposes: Record<string, Purpose> = { birthdayTemplateId: 'BIRTHDAY', familyBirthdayTemplateId: 'FAMILY_BIRTHDAY', anniversaryTemplateId: 'ANNIVERSARY' };
  const clean: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(ids)) {
    clean[k] = typeof v === 'string' && v ? ((await activeTemplate(db, purposes[k]!, 'WHATSAPP', v))?.id ?? null) : null;
    if (typeof v === 'string' && v && !clean[k]) throw fieldErrors([{ field: k, code: 'VAL-22' }]);
  }
  if (enabled && Object.values(clean).some((v) => !v)) throw new AppError(422, 'COM-09');
  const advisor = await advisorFacts(db, auth.accountId!);
  if (enabled && !advisor.name) throw new AppError(422, 'PRF-03', { 'missing items': 'Full name' });
  return db.transaction(async (tx) => {
    const cur = await settingsOf(auth.accountId!);
    if (cur.version !== readVersion(body)) throw versionConflict('greeting settings');
    await tx
      .insert(occasionSettings)
      .values({ accountId: auth.accountId!, enabled, ...clean, updatedAt: clock.now(), version: 1 })
      .onConflictDoUpdate({ target: occasionSettings.accountId, set: { enabled, ...clean, updatedAt: clock.now(), version: sql`${occasionSettings.version} + 1` } });
    let n = 0;
    if (!enabled) n = await cancelWhere(tx, auth.accountId!, 'Greetings off', inArray(outgoingMessages.purpose, ['BIRTHDAY', 'FAMILY_BIRTHDAY', 'ANNIVERSARY']));
    await audit(tx, req, { action: 'GREETINGS_SAVED', entity: 'occasion_settings', entityId: auth.accountId!, newValue: { enabled, ...clean } });
    return { message: msg(!enabled && cur.enabled ? 'COM-08' : 'COM-06'), cancelled: n };
  });
}

export async function setExcluded(req: Request, auth: AuthContext, body: unknown) {
  if (auth.role !== 'ADV') throw forbidden();
  if (!isPremium(await currentSubscription(db, auth.accountId!))) throw new AppError(403, 'SUB-01');
  const b = (body ?? {}) as { personKey?: unknown; excluded?: unknown };
  const key = typeof b.personKey === 'string' && /^(customer|member):[0-9a-f-]{36}$/.test(b.personKey) ? b.personKey : null;
  if (!key) throw fieldErrors([{ field: 'personKey', code: 'VAL-22' }]);
  const list = await people(auth.accountId!);
  if (!list.some((p) => p.key === key)) throw fieldErrors([{ field: 'personKey', code: 'VAL-22' }]);
  if (b.excluded === true) await db.insert(occasionExclusions).values({ accountId: auth.accountId!, personKey: key, by: auth.userId, at: clock.now() }).onConflictDoNothing();
  else await db.delete(occasionExclusions).where(and(eq(occasionExclusions.accountId, auth.accountId!), eq(occasionExclusions.personKey, key)));
  await audit(db, req, { action: b.excluded === true ? 'GREETING_EXCLUDED' : 'GREETING_INCLUDED', entity: 'occasion_settings', entityId: auth.accountId!, newValue: { personKey: key } });
  return { message: msg('COM-06') };
}

// ---------- SYS-04 ----------
export async function runGreetings(): Promise<{ queued: number; skipped: number }> {
  const today = istToday();
  const year = today.slice(0, 4);
  let queued = 0;
  let skipped = 0;
  const rows = await db.select({ s: occasionSettings }).from(occasionSettings).innerJoin(accounts, eq(accounts.id, occasionSettings.accountId)).where(and(eq(occasionSettings.enabled, true), eq(accounts.status, 'ACTIVE')));
  for (const { s } of rows) {
    const accountId = s.accountId;
    if (!isPremium(await currentSubscription(db, accountId))) continue;
    const ex = new Set((await db.select({ k: occasionExclusions.personKey }).from(occasionExclusions).where(eq(occasionExclusions.accountId, accountId))).map((r) => r.k));
    const advisor = await advisorFacts(db, accountId);
    const [adv] = await db.select({ mobile: users.mobile }).from(users).where(and(eq(users.accountId, accountId), eq(users.role, 'ADV')));
    const [w] = await db.select().from(whatsappNumbers).where(eq(whatsappNumbers.accountId, accountId));
    const [wal] = await db.select().from(wallets).where(eq(wallets.accountId, accountId));
    const ids: Record<string, string | null> = { BIRTHDAY: s.birthdayTemplateId, FAMILY_BIRTHDAY: s.familyBirthdayTemplateId, ANNIVERSARY: s.anniversaryTemplateId };
    const toSend: string[] = [];
    for (const p of await people(accountId)) {
      for (const occasion of ['BIRTHDAY', 'ANNIVERSARY'] as Occasion[]) {
        const date = occasion === 'BIRTHDAY' ? p.dob : p.anniversary;
        if (!isToday(date, today)) continue;
        const r = await recipientFor(p, occasion);
        if (!r) continue;
        const key = `occ:${accountId}:${p.key}:${occasion}:${year}`;
        const t = await activeTemplate(db, r.purpose, 'WHATSAPP', ids[r.purpose]);
        const vars = {
          'person first name': p.name.split(' ')[0]!,
          'customer first name': p.customerName.split(' ')[0]!,
          relationship: p.relationship,
          'advisor name': advisor.name,
          'business name': advisor.businessName ?? advisor.name,
          'advisor mobile': (adv?.mobile ?? '').replace('+91', '+91 '),
        };
        let reason: string | null = null;
        const consentPerson = r.toCustomer ? null : r.consentMember;
        if (ex.has(p.key)) reason = 'Excluded';
        else if (!r.to) reason = 'No mobile';
        else if ((await consentState(db, p.customerId, consentPerson, 'WHATSAPP', r.to)) !== 'GIVEN') reason = 'No WhatsApp consent';
        else if (!t) reason = 'Template inactive';
        else if ((await sentToday(db, accountId, 'WHATSAPP')) >= settings.get('CFG-69')) reason = 'Daily limit reached';
        else if (w?.status !== 'READY') reason = 'WhatsApp number not ready';
        else if (!wal || Number(wal.balance) < Number(settings.get('CFG-162'))) reason = 'Wallet balance low';
        const m = await queueMessage(db, {
          accountId,
          customerId: p.customerId,
          familyMemberId: r.toCustomer ? null : p.familyMemberId,
          personName: r.toCustomer ? p.customerName : p.name,
          channel: 'WHATSAPP',
          purpose: r.purpose,
          recipient: r.to ?? '',
          templateId: t?.id ?? null,
          templateVersion: t?.templateVersion ?? null,
          variables: vars,
          body: t ? fill(t.body, vars) : '',
          occurrenceKey: key,
          relatedType: 'OCCASION',
          status: reason ? 'SKIPPED' : 'QUEUED',
          reason,
        });
        if (!m) continue;
        if (m.status === 'QUEUED') {
          queued++;
          toSend.push(m.id);
        } else skipped++;
      }
    }
    for (const id of toSend) await dispatch(id).catch(() => undefined);
  }
  return { queued, skipped };
}
defineDaily('SYS-04', 'CFG-65', runGreetings);

// Checked again just before sending (P-41 step 4)
const greetingCheck = async (m: { accountId: string; relatedId: string | null }) => {
  const s = await settingsOf(m.accountId);
  if (!s.enabled) return { status: 'CANCELLED' as const, reason: 'Greetings off' };
  return null;
};
registerSendCheck('BIRTHDAY', greetingCheck);
registerSendCheck('FAMILY_BIRTHDAY', greetingCheck);
registerSendCheck('ANNIVERSARY', greetingCheck);

/** End of the sending window: one DSH-17 per account when any automated message failed or was skipped. */
export async function windowSummary(): Promise<number> {
  if (windowState() !== 'closed') return 0;
  const today = istToday();
  const start = new Date(`${today}T00:00:00+05:30`);
  const rows = await db
    .select({ accountId: outgoingMessages.accountId, n: sql<number>`count(*)::int` })
    .from(outgoingMessages)
    .where(and(eq(outgoingMessages.channel, 'WHATSAPP'), inArray(outgoingMessages.status, ['FAILED', 'SKIPPED']), sql`${outgoingMessages.createdAt} >= ${start}`, sql`coalesce(${outgoingMessages.reason}, '') <> 'Excluded'`))
    .groupBy(outgoingMessages.accountId);
  for (const r of rows) {
    const [adv] = await db.select({ id: users.id }).from(users).where(and(eq(users.accountId, r.accountId), eq(users.role, 'ADV')));
    if (adv) await notify(db, { userId: adv.id, accountId: r.accountId, messageId: 'DSH-17', params: { n: r.n }, link: { type: 'COMMUNICATIONS', id: r.accountId }, dedupeKey: `dsh17:${today}` });
  }
  return rows.length;
}
defineJob('message-day-summary', async () => void (await windowSummary()), '*/15 * * * *');
