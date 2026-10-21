// P-44 Invite and manage referrers, P-45 Referrer dashboard, P-46 Submit a referral (public form).
// A referrer belongs to exactly one advisor account. Referrers see only their own referrals and never
// premium, product, policy, document, nominee or payment data (AC-P45-2). Hidden when CFG-103 is off.
import { randomInt } from 'node:crypto';
import type { Request } from 'express';
import { and, asc, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { accounts, advisorProfiles, customers, insuranceTypes, leadEvents, leads, pipelines, policies, referralCodes, referralSubmissions, referrerProfiles, subscriptions, users } from '../../db/schema.js';
import { addDays, clock, formatDate, istToday } from '../../lib/clock.js';
import { AppError, fieldErrors, forbidden, notFound, stateConflict, tooMany } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import { maskMobile } from '../../lib/mask.js';
import { msg } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { endAllSessions } from '../auth/sessions.service.js';
import { isUnique, isUuid, nextNumber, normName } from '../clients/common.js';
import { defineJob } from '../jobs/jobs.js';
import { notify } from '../notifications/notifications.service.js';
import { hit, secondsUntil } from '../ratelimit/ratelimit.js';
import { settings } from '../settings/settings.service.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // FLD-26: no 0, O, 1, I
const newCode = () => Array.from({ length: settings.get('CFG-73') }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
const linkFor = (code: string) => `${env.APP_URL}/r/${code}`;
const enabled = () => settings.get('CFG-103') === true;
const assertOn = () => {
  if (!enabled()) throw notFound();
};

async function issueCode(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], accountId: string, referrerUserId: string) {
  for (let i = 0; i < 5; i++) {
    try {
      const [c] = await tx.insert(referralCodes).values({ accountId, referrerUserId, code: newCode(), validUntil: addDays(istToday(), settings.get('CFG-74')), status: 'ACTIVE', createdAt: clock.now() }).returning();
      return c!;
    } catch (err) {
      if (!isUnique(err, 'referral_code_unique')) throw err;
    }
  }
  throw new Error('Could not make a unique referral code');
}

/** The referrer's status as they see it (P-45 mapping). */
async function referrerStatus(s: typeof referralSubmissions.$inferSelect): Promise<string> {
  if (s.result === 'LINKED_TO_EXISTING') return 'Already known to the advisor';
  const [l] = s.leadId ? await db.select().from(leads).where(eq(leads.id, s.leadId)) : [];
  if (!l) return 'New';
  if (l.status === 'CONVERTED' && l.customerId) {
    const [p] = await db.select({ id: policies.id }).from(policies).where(and(eq(policies.customerId, l.customerId), inArray(policies.status, ['ISSUED', 'RENEWED', 'EXPIRED']), gte(policies.createdAt, s.createdAt)));
    return p ? 'Policy taken' : 'Became a customer';
  }
  if (l.status === 'LOST') return 'Closed';
  if (l.status === 'NEW') return 'New';
  return 'In progress';
}

export async function listReferrers(auth: AuthContext) {
  assertOn();
  const refs = await db.select({ u: users, note: referrerProfiles.note }).from(users).leftJoin(referrerProfiles, eq(referrerProfiles.userId, users.id)).where(and(eq(users.accountId, auth.accountId!), eq(users.role, 'REF'))).orderBy(asc(users.name));
  const items = [];
  for (const { u, note } of refs) {
    const [code] = await db.select().from(referralCodes).where(eq(referralCodes.referrerUserId, u.id)).orderBy(desc(referralCodes.createdAt)).limit(1);
    const subs = await db.select().from(referralSubmissions).where(eq(referralSubmissions.referrerUserId, u.id));
    let convertedN = 0;
    for (const s of subs) if (['Became a customer', 'Policy taken'].includes(await referrerStatus(s))) convertedN++;
    const expired = code && code.status === 'ACTIVE' && code.validUntil < istToday();
    items.push({ id: u.id, name: u.name, mobile: u.mobile, note, status: u.status, code: code?.code ?? null, codeStatus: expired ? 'EXPIRED' : (code?.status ?? null), validUntil: code?.validUntil ?? null, link: code ? linkFor(code.code) : null, sent: subs.length, converted: convertedN, version: u.version });
  }
  return { items, max: settings.get('CFG-76') };
}

const invitation = (advisorName: string, name: string) => `Hi ${name.split(' ')[0]}, ${advisorName} has added you as a referrer on Bimayantra. Log in with your mobile number here to get your referral link: ${env.APP_URL}/login`;

export async function addReferrer(req: Request, auth: AuthContext, body: unknown) {
  assertOn();
  if (auth.role !== 'ADV') throw forbidden();
  const v = F.parseFields(body, { name: { label: 'Name', required: true, rule: F.personName }, mobile: { label: 'Mobile', required: true, rule: F.mobile }, note: { label: 'Note', rule: F.notes } }) as { name: string; mobile: string; note?: string };
  const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.mobile, v.mobile));
  if (taken) throw fieldErrors([{ field: 'mobile', code: 'REF-02' }]);
  const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(users).where(and(eq(users.accountId, auth.accountId!), eq(users.role, 'REF'), ne(users.status, 'DISABLED')))) as [{ n: number }];
  if (n >= settings.get('CFG-76')) throw new AppError(409, 'REF-03');
  try {
    return await db.transaction(async (tx) => {
      const now = clock.now();
      const [u] = await tx.insert(users).values({ accountId: auth.accountId!, role: 'REF', name: v.name, mobile: v.mobile, status: 'INVITED', invitedBy: auth.userId, invitedAt: now, createdAt: now }).returning();
      await tx.insert(referrerProfiles).values({ userId: u!.id, accountId: auth.accountId!, note: v.note ?? null, createdAt: now });
      const code = await issueCode(tx, auth.accountId!, u!.id);
      await audit(tx, req, { action: 'REFERRER_ADDED', entity: 'user', entityId: u!.id, newValue: { name: v.name, mobile: maskMobile(v.mobile) } });
      const [adv] = await tx.select({ name: advisorProfiles.fullName }).from(advisorProfiles).where(eq(advisorProfiles.accountId, auth.accountId!));
      const text = invitation(adv?.name ?? 'Your advisor', v.name);
      return { id: u!.id, code: code.code, invitation: text, whatsappUrl: `https://wa.me/${v.mobile.replace('+', '')}?text=${encodeURIComponent(text)}`, message: msg('REF-01', { name: v.name }) };
    });
  } catch (err) {
    if (isUnique(err, 'users_mobile_unique')) throw fieldErrors([{ field: 'mobile', code: 'REF-02' }]);
    throw err;
  }
}

async function loadReferrer(auth: AuthContext, id: string) {
  if (!isUuid(id)) throw notFound();
  const [u] = await db.select().from(users).where(and(eq(users.id, id), eq(users.accountId, auth.accountId!), eq(users.role, 'REF')));
  if (!u) throw notFound();
  return u;
}

export async function setReferrerActive(req: Request, auth: AuthContext, id: string, active: boolean) {
  assertOn();
  if (auth.role !== 'ADV') throw forbidden();
  const u = await loadReferrer(auth, id);
  return db.transaction(async (tx) => {
    if (!active) {
      if (u.status === 'DISABLED') throw stateConflict('referrer', 'DISABLED');
      await tx.update(users).set({ status: 'DISABLED', version: u.version + 1 }).where(eq(users.id, u.id));
      await endAllSessions(tx, u.id, 'USER_DISABLED');
      await tx.update(referralCodes).set({ status: 'REVOKED', revokedAt: clock.now() }).where(and(eq(referralCodes.referrerUserId, u.id), eq(referralCodes.status, 'ACTIVE')));
      await audit(tx, req, { action: 'REFERRER_DISABLED', entity: 'user', entityId: u.id });
      return { message: msg('REF-07', { name: u.name }) };
    }
    if (u.status !== 'DISABLED') throw stateConflict('referrer', u.status);
    if (await activeCount(auth.accountId!) >= settings.get('CFG-76')) throw new AppError(409, 'REF-03');
    await tx.update(users).set({ status: u.activatedAt ? 'ACTIVE' : 'INVITED', invitedAt: u.activatedAt ? u.invitedAt : clock.now(), version: u.version + 1 }).where(eq(users.id, u.id));
    await issueCode(tx, auth.accountId!, u.id);
    await audit(tx, req, { action: 'REFERRER_ENABLED', entity: 'user', entityId: u.id });
    return { message: msg('GEN-08', { 'Record type': 'Referrer' }) };
  });
}
async function activeCount(accountId: string) {
  const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(users).where(and(eq(users.accountId, accountId), eq(users.role, 'REF'), ne(users.status, 'DISABLED')))) as [{ n: number }];
  return n;
}

export async function newLink(req: Request, auth: AuthContext, id: string) {
  assertOn();
  if (auth.role !== 'ADV') throw forbidden();
  const u = await loadReferrer(auth, id);
  if (u.status === 'DISABLED') throw stateConflict('referrer', 'DISABLED');
  return db.transaction(async (tx) => {
    await tx.update(referralCodes).set({ status: 'REVOKED', revokedAt: clock.now() }).where(and(eq(referralCodes.referrerUserId, u.id), inArray(referralCodes.status, ['ACTIVE', 'EXPIRED'])));
    const c = await issueCode(tx, auth.accountId!, u.id);
    await audit(tx, req, { action: 'REFERRAL_LINK_RENEWED', entity: 'user', entityId: u.id });
    return { code: c.code, link: linkFor(c.code), message: msg('REF-06') };
  });
}

// ---------- P-45 referrer dashboard ----------
export async function referrerDashboard(auth: AuthContext) {
  if (auth.role !== 'REF') throw forbidden();
  const [p] = await db.select({ name: advisorProfiles.fullName, business: advisorProfiles.businessName }).from(advisorProfiles).where(eq(advisorProfiles.accountId, auth.accountId!));
  const [code] = await db.select().from(referralCodes).where(and(eq(referralCodes.referrerUserId, auth.userId), inArray(referralCodes.status, ['ACTIVE', 'EXPIRED']))).orderBy(desc(referralCodes.createdAt)).limit(1);
  const expired = !code || code.status === 'EXPIRED' || code.validUntil < istToday();
  const subs = await db.select().from(referralSubmissions).where(eq(referralSubmissions.referrerUserId, auth.userId)).orderBy(desc(referralSubmissions.createdAt));
  return {
    advisor: { name: p?.name ?? '', businessName: p?.business ?? null },
    link: !expired && code ? { code: code.code, url: linkFor(code.code), validUntil: code.validUntil } : null,
    expiredMessage: expired ? msg('REF-12', { date: code ? formatDate(code.validUntil) : '—', 'advisor name': p?.name ?? '' }) : null,
    referrals: await Promise.all(subs.map(async (s) => ({ id: s.id, name: s.name, mobile: maskMobile(s.mobile), date: s.createdAt.toISOString(), status: await referrerStatus(s) }))),
  };
}

// ---------- P-46 public form ----------
async function activeCode(code: string) {
  if (!enabled() || !/^[A-Z0-9]{4,20}$/.test(code)) return null;
  const [row] = await db
    .select({ c: referralCodes, u: users, a: accounts })
    .from(referralCodes)
    .innerJoin(users, eq(users.id, referralCodes.referrerUserId))
    .innerJoin(accounts, eq(accounts.id, referralCodes.accountId))
    .where(eq(referralCodes.code, code));
  if (!row || row.c.status !== 'ACTIVE' || row.c.validUntil < istToday() || row.u.status === 'DISABLED' || row.a.status !== 'ACTIVE') return null;
  const [s] = await db.select({ status: subscriptions.status }).from(subscriptions).where(and(eq(subscriptions.accountId, row.c.accountId), eq(subscriptions.isCurrent, true)));
  if (!s || !['TRIAL', 'ACTIVE', 'GRACE'].includes(s.status)) return null;
  return row;
}

export async function referralForm(code: string) {
  const row = await activeCode(code);
  if (!row) return { active: false, message: msg('REF-04') };
  const [p] = await db.select({ name: advisorProfiles.fullName, business: advisorProfiles.businessName, logo: advisorProfiles.logoFileId }).from(advisorProfiles).where(eq(advisorProfiles.accountId, row.c.accountId));
  const types = await db.select({ id: insuranceTypes.id, name: insuranceTypes.name }).from(insuranceTypes).where(eq(insuranceTypes.status, 'ACTIVE')).orderBy(asc(insuranceTypes.position));
  return {
    active: true,
    advisor: { name: p?.name ?? '', businessName: p?.business ?? null, logoUrl: p?.logo ? `/api/v1/public/logo/${row.c.accountId}` : null },
    referrerFirstName: row.u.name.split(' ')[0],
    knowsAs: settings.get('CFG-141'),
    types,
    permission: `I agree that ${p?.name ?? 'the advisor'} may contact me by phone and WhatsApp about insurance.`,
  };
}

export async function submitReferral(req: Request, code: string, body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  // Invisible trap field: a robot that fills it gets the normal thank-you and nothing is stored
  const trap = typeof b.website === 'string' && b.website.trim() !== '';
  const h = await hit(`ref:${req.ip}`, 3600);
  if (h.count > settings.get('CFG-75')) throw tooMany('REF-09', {}, secondsUntil(h.windowEndsAt));
  const row = await activeCode(code);
  if (!row) throw new AppError(409, 'REF-04');
  const v = F.parseFields(b, {
    name: { label: 'Your name', required: true, rule: F.personName },
    mobile: { label: 'Mobile', required: true, rule: F.mobile },
    email: { label: 'Email', rule: F.email },
    knowsAs: { label: `How you know ${row.u.name.split(' ')[0]}`, required: true, oneOf: settings.get('CFG-141') },
    interestTypeId: { label: 'Insurance you are interested in', required: true },
    city: { label: 'City', rule: F.city },
    message: { label: 'Message', rule: F.notes },
    permission: { label: 'Permission', checkbox: true },
  }) as { name: string; mobile: string; email?: string; knowsAs: string; interestTypeId: string; city?: string; message?: string };
  const [type] = isUuid(v.interestTypeId) ? await db.select().from(insuranceTypes).where(and(eq(insuranceTypes.id, v.interestTypeId), eq(insuranceTypes.status, 'ACTIVE'))) : [];
  if (!type) throw fieldErrors([{ field: 'interestTypeId', code: 'VAL-22' }]);
  const [adv] = await db.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.accountId, row.c.accountId), eq(users.role, 'ADV')));
  const thanks = msg('REF-05', { 'first name': v.name.split(' ')[0], 'Advisor name': adv?.name ?? '' });
  if (trap) return { message: thanks };
  const accountId = row.c.accountId;
  await db.transaction(async (tx) => {
    const since = new Date(clock.now().getTime() - settings.get('CFG-77') * 86_400_000);
    const [openLead] = await tx.select().from(leads).where(and(eq(leads.accountId, accountId), eq(leads.mobile, v.mobile), sql`(${leads.status} not in ('CONVERTED','LOST') or ${leads.createdAt} >= ${since})`)).limit(1);
    const [cust] = await tx.select().from(customers).where(and(eq(customers.accountId, accountId), eq(customers.mobile, v.mobile))).limit(1);
    const base = { accountId, codeId: row.c.id, referrerUserId: row.u.id, name: v.name, mobile: v.mobile, email: v.email ?? null, knowsAs: v.knowsAs, interestTypeId: type.id, city: v.city ?? null, message: v.message ?? null, createdAt: clock.now() };
    if (openLead || cust) {
      const [s] = await tx.insert(referralSubmissions).values({ ...base, result: 'LINKED_TO_EXISTING', leadId: openLead?.id ?? null, customerId: cust?.id ?? null, lastStatus: 'Already known to the advisor' }).returning();
      if (adv) await notify(tx, { userId: adv.id, accountId, messageId: 'DSH-16', params: { referrer: row.u.name, 'prospect name': `${v.name} (existing)` }, link: openLead ? { type: 'LEAD', id: openLead.id } : cust ? { type: 'CUSTOMER', id: cust.id } : null, dedupeKey: `ref-sub:${s!.id}` });
      return;
    }
    const pls = await tx.select().from(pipelines).where(eq(pipelines.accountId, accountId)).orderBy(asc(pipelines.position));
    const pl = pls.find((p) => type.name.toLowerCase().includes(p.name.toLowerCase().split(' ')[0]!)) ?? pls.find((p) => p.name === 'Other') ?? pls[0]!;
    const number = await nextNumber(tx, accountId, 'LD');
    const notes = [v.message, `WhatsApp consent: Ticked on referral form (${v.mobile}).`, `Knows the referrer as: ${v.knowsAs}.`, v.city ? `City: ${v.city}.` : null].filter(Boolean).join('\n');
    const [l] = await tx
      .insert(leads)
      .values({ accountId, number, pipelineId: pl.id, name: v.name, nameNorm: normName(v.name), mobile: v.mobile, email: v.email ?? null, source: 'Referred by a referrer', referrerUserId: row.u.id, interestTypeIds: [type.id], status: 'NEW', notes, createdBy: row.u.id, createdAt: clock.now(), updatedAt: clock.now() })
      .returning();
    await tx.insert(leadEvents).values({ leadId: l!.id, accountId, kind: 'CREATED', toStatus: 'NEW', note: 'Referral form', userId: row.u.id, at: clock.now() });
    const [s] = await tx.insert(referralSubmissions).values({ ...base, result: 'LEAD_CREATED', leadId: l!.id, lastStatus: 'New' }).returning();
    await audit(tx, null, { action: 'REFERRAL_SUBMITTED', entity: 'lead', entityId: l!.id, accountId, newValue: { number, mobile: maskMobile(v.mobile) }, actor: { job: 'referral-form' } });
    if (adv) await notify(tx, { userId: adv.id, accountId, messageId: 'DSH-16', params: { referrer: row.u.name, 'prospect name': v.name }, link: { type: 'LEAD', id: l!.id }, dedupeKey: `ref-sub:${s!.id}` });
  });
  return { message: thanks };
}

/** REF-08: tell the referrer when their referral's status changes (dedupe per referral and status). */
export async function referralUpdates(): Promise<number> {
  const rows = await db.select().from(referralSubmissions).where(eq(referralSubmissions.result, 'LEAD_CREATED'));
  let n = 0;
  for (const s of rows) {
    const st = await referrerStatus(s);
    if (st === s.lastStatus) continue;
    await db.update(referralSubmissions).set({ lastStatus: st }).where(eq(referralSubmissions.id, s.id));
    if (await notify(db, { userId: s.referrerUserId, accountId: s.accountId, messageId: 'REF-08', params: { 'prospect first name': s.name.split(' ')[0], status: st }, link: null, dedupeKey: `ref-status:${s.id}:${st}` })) n++;
  }
  return n;
}
defineJob('referral-updates', async () => void (await referralUpdates()), '*/10 * * * *');

/** Expired codes become EXPIRED (CFG-74). */
export async function expireCodes() {
  await db.update(referralCodes).set({ status: 'EXPIRED' }).where(and(eq(referralCodes.status, 'ACTIVE'), sql`${referralCodes.validUntil} < ${istToday()}`));
}
defineJob('referral-expiry', expireCodes, '20 0 * * *');
