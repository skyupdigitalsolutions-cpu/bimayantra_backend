// P-17 Consent per person (the customer or an ACTIVE family member) and channel, for the exact mobile or
// email it was given for. A withdrawal always wins over a queued message; opt-outs (P-42) are recorded by
// the system. Personal-data consent ("Store personal data") is one row for the customer.
import type { Request } from 'express';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.js';
import { consentHistory, consents, customers, familyMembers, files, users } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { clock } from '../../lib/clock.js';
import { AppError, fieldError, notFound, versionConflict } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import { msg } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { isUuid, readVersion } from '../clients/common.js';
import { cancelQueuedMessages } from '../clients/hooks.js';
import { assertActive, loadCustomer } from './customers.service.js';

export const CHANNELS = ['WHATSAPP', 'EMAIL', 'SMS'] as const;
export const HOW = ['Told me in person or by phone', 'Signed form', 'Replied on WhatsApp', 'Ticked on referral form'] as const;
const CHANNEL_NAME: Record<string, string> = { WHATSAPP: 'WhatsApp', EMAIL: 'Email', SMS: 'SMS', PERSONAL_DATA: 'Personal data' };
type Channel = (typeof CHANNELS)[number] | 'PERSONAL_DATA';
const NO_MEMBER = sql`'00000000-0000-0000-0000-000000000000'::uuid`;

/** The declaration the advisor ticks (P-17 step 2; personal data from InsureHub). Exact wording by legal review (DEC-10). */
export const declaration = (name: string, channel: Channel) =>
  channel === 'PERSONAL_DATA'
    ? `${name} agreed that I may store their identity documents and personal details in Bimayantra for insurance work.`
    : `${name} agreed to receive ${CHANNEL_NAME[channel]} messages from me through Bimayantra. I have explained what they will receive.`;

type Person = { key: string; familyMemberId: string | null; name: string; mobile: string | null; email: string | null; isCustomer: boolean };

async function people(dbx: DbOrTx, customerId: string): Promise<Person[]> {
  const [c] = await dbx.select().from(customers).where(eq(customers.id, customerId));
  const members = await dbx.select().from(familyMembers).where(and(eq(familyMembers.customerId, customerId), eq(familyMembers.status, 'ACTIVE'))).orderBy(asc(familyMembers.fullName));
  return [
    { key: c!.id, familyMemberId: null, name: c!.fullName, mobile: c!.mobile, email: c!.email, isCustomer: true },
    ...members.map((m) => ({ key: m.id, familyMemberId: m.id, name: m.fullName, mobile: m.mobile, email: m.email, isCustomer: false })),
  ];
}

/** Consent tab: one row per person, one cell per channel; plus the personal-data row for the customer. */
export async function consentGrid(auth: AuthContext, customerId: string) {
  const c = await loadCustomer(db, auth.accountId!, customerId);
  const ps = await people(db, c.id);
  const rows = await db.select().from(consents).where(eq(consents.customerId, c.id));
  const cell = (p: Person, ch: Channel) => {
    const r = rows.find((x) => (x.familyMemberId ?? null) === p.familyMemberId && x.channel === ch);
    // Consent belongs to the exact number or address: a GIVEN for an old number no longer counts
    const address = ch === 'EMAIL' ? p.email : ch === 'PERSONAL_DATA' ? null : p.mobile;
    const stale = r && r.status === 'GIVEN' && ch !== 'PERSONAL_DATA' && r.address !== address;
    return { channel: ch, status: !r || stale ? 'NOT_RECORDED' : r.status, at: r?.changedAt ?? null, how: r?.how ?? null, version: r?.version ?? 0, canRecord: ch === 'PERSONAL_DATA' || !!address };
  };
  return {
    people: ps.map((p) => ({ key: p.key, familyMemberId: p.familyMemberId, name: p.name, isCustomer: p.isCustomer, cells: CHANNELS.map((ch) => cell(p, ch)) })),
    personalData: cell(ps[0]!, 'PERSONAL_DATA'),
    how: HOW,
    termsVersion: env.TERMS_VERSION,
  };
}

export async function consentHistoryFor(auth: AuthContext, customerId: string) {
  const c = await loadCustomer(db, auth.accountId!, customerId);
  const rows = await db
    .select({ h: consentHistory, channel: consents.channel, familyMemberId: consents.familyMemberId })
    .from(consentHistory)
    .innerJoin(consents, eq(consents.id, consentHistory.consentId))
    .where(eq(consents.customerId, c.id))
    .orderBy(desc(consentHistory.at));
  const ps = await people(db, c.id);
  const userIds = [...new Set(rows.map((r) => r.h.byUserId).filter((x): x is string => !!x))];
  const names = userIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)) : [];
  return {
    items: rows.map(({ h, channel, familyMemberId }) => ({
      at: h.at,
      person: ps.find((p) => p.familyMemberId === (familyMemberId ?? null))?.name ?? 'Former family member',
      channel,
      from: h.fromStatus,
      to: h.toStatus,
      how: h.how,
      by: h.source === 'SYS' ? 'System (opt-out)' : (names.find((n) => n.id === h.byUserId)?.name ?? null),
      hasEvidence: !!h.evidenceFileId,
    })),
  };
}

function parseTarget(body: unknown): { channel: Channel; familyMemberId: string | null } {
  const b = (body ?? {}) as Record<string, unknown>;
  const channel = b.channel;
  if (channel !== 'WHATSAPP' && channel !== 'EMAIL' && channel !== 'SMS' && channel !== 'PERSONAL_DATA') throw fieldError('channel', 'VAL-22');
  const familyMemberId = b.familyMemberId ? (isUuid(b.familyMemberId) ? b.familyMemberId : '') : null;
  if (familyMemberId === '') throw fieldError('familyMemberId', 'VAL-22');
  if (channel === 'PERSONAL_DATA' && familyMemberId) throw fieldError('familyMemberId', 'VAL-22');
  return { channel, familyMemberId };
}

async function current(tx: DbOrTx, customerId: string, familyMemberId: string | null, channel: Channel) {
  const [r] = await tx
    .select()
    .from(consents)
    .where(and(eq(consents.customerId, customerId), sql`coalesce(${consents.familyMemberId}, ${NO_MEMBER}) = coalesce(${familyMemberId}::uuid, ${NO_MEMBER})`, eq(consents.channel, channel)))
    .for('update');
  return r;
}

/** Record consent (CU-11): how it was given, optional evidence, and the declaration ticked. */
export async function recordConsent(req: Request, auth: AuthContext, customerId: string, body: unknown) {
  const t = parseTarget(body);
  const v = F.parseFields(body, { how: { label: 'How it was given', required: true, oneOf: HOW }, declaration: { label: 'Declaration', checkbox: true } }) as { how: string };
  const evidence = (body as { evidenceFileId?: unknown } | null)?.evidenceFileId;
  const version = readVersion(body);
  return db.transaction(async (tx) => {
    const c = await loadCustomer(tx, auth.accountId!, customerId, true);
    assertActive(c);
    const p = (await people(tx, c.id)).find((x) => x.familyMemberId === t.familyMemberId);
    if (!p) throw notFound();
    const address = t.channel === 'EMAIL' ? p.email : t.channel === 'PERSONAL_DATA' ? null : p.mobile;
    if ((t.channel === 'WHATSAPP' || t.channel === 'SMS') && !p.mobile) throw new AppError(409, 'CU-13', { name: p.name, channel: CHANNEL_NAME[t.channel] });
    if (t.channel === 'EMAIL' && !p.email) throw new AppError(409, 'CU-14', { name: p.name });
    let evidenceFileId: string | null = null;
    if (evidence) {
      const [f] = isUuid(evidence) ? await tx.select().from(files).where(eq(files.id, evidence)) : [];
      if (!f || f.accountId !== c.accountId || f.purpose !== 'CONSENT_EVIDENCE') throw fieldError('evidenceFileId', 'VAL-22');
      evidenceFileId = f.id;
    }
    const r = await current(tx, c.id, t.familyMemberId, t.channel);
    if ((r?.version ?? 0) !== version) throw versionConflict('consent', ['status']);
    const now = clock.now();
    const set = { status: 'GIVEN', address, how: v.how, evidenceFileId, termsVersion: t.channel === 'PERSONAL_DATA' ? env.TERMS_VERSION : null, changedBy: auth.userId, changedAt: now };
    const [row] = r
      ? await tx.update(consents).set({ ...set, version: r.version + 1 }).where(eq(consents.id, r.id)).returning()
      : await tx.insert(consents).values({ accountId: c.accountId, customerId: c.id, familyMemberId: t.familyMemberId, channel: t.channel, ...set }).returning();
    await tx.insert(consentHistory).values({ consentId: row!.id, accountId: c.accountId, fromStatus: r?.status ?? 'NOT_RECORDED', toStatus: 'GIVEN', address, how: v.how, evidenceFileId, byUserId: auth.userId, source: 'ADVISOR', at: now });
    await audit(tx, req, { action: 'CONSENT_GIVEN', entity: 'customer', entityId: c.id, newValue: { channel: CHANNEL_NAME[t.channel], name: p.name, how: v.how } });
    return { message: msg('CU-11', { Channel: CHANNEL_NAME[t.channel], name: p.name }), declaration: declaration(p.name, t.channel) };
  });
}

/** Withdraw (CU-12): QUEUED messages on that channel for that person are cancelled. Personal data: CU-30. */
export async function withdrawConsent(req: Request, auth: AuthContext, customerId: string, body: unknown) {
  const t = parseTarget(body);
  const version = readVersion(body);
  return db.transaction(async (tx) => {
    const c = await loadCustomer(tx, auth.accountId!, customerId, true);
    const p = (await people(tx, c.id)).find((x) => x.familyMemberId === t.familyMemberId);
    if (!p) throw notFound();
    const r = await current(tx, c.id, t.familyMemberId, t.channel);
    if (!r || r.status !== 'GIVEN') throw new AppError(409, 'GEN-04', { 'record type': 'consent', 'current status': r?.status ?? 'NOT_RECORDED' });
    if (r.version !== version) throw versionConflict('consent', ['status']);
    const now = clock.now();
    await tx.update(consents).set({ status: 'WITHDRAWN', changedBy: auth.userId, changedAt: now, version: r.version + 1 }).where(eq(consents.id, r.id));
    await tx.insert(consentHistory).values({ consentId: r.id, accountId: c.accountId, fromStatus: 'GIVEN', toStatus: 'WITHDRAWN', address: r.address, how: 'Withdrawn by the advisor', byUserId: auth.userId, source: 'ADVISOR', at: now });
    if (t.channel !== 'PERSONAL_DATA') await cancelQueuedMessages(tx, { accountId: c.accountId, customerId: c.id, familyMemberId: t.familyMemberId, channel: t.channel });
    await audit(tx, req, { action: 'CONSENT_WITHDRAWN', entity: 'customer', entityId: c.id, newValue: { channel: CHANNEL_NAME[t.channel], name: p.name } });
    return {
      message: t.channel === 'PERSONAL_DATA' ? msg('CU-30', { Customer: c.fullName }) : msg('CU-12', { Channel: CHANNEL_NAME[t.channel], name: p.name, channel: CHANNEL_NAME[t.channel] }),
    };
  });
}

/**
 * System opt-out (P-42): a STOP reply or an unsubscribe click sets WITHDRAWN for the person whose number or
 * address it came from, cancels queued messages and adds a timeline entry. Repeat-safe.
 */
export async function systemOptOut(accountId: string, channel: 'WHATSAPP' | 'EMAIL' | 'SMS', address: string, at = clock.now()): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(consents).where(and(eq(consents.accountId, accountId), eq(consents.channel, channel), eq(consents.address, address), eq(consents.status, 'GIVEN'))).for('update');
    for (const r of rows) {
      // An opt-out wins over a consent recorded at the same time only if its time is later (P-17)
      if (r.changedAt > at) continue;
      await tx.update(consents).set({ status: 'WITHDRAWN', changedBy: null, changedAt: at, version: r.version + 1 }).where(eq(consents.id, r.id));
      await tx.insert(consentHistory).values({ consentId: r.id, accountId, fromStatus: 'GIVEN', toStatus: 'WITHDRAWN', address, how: channel === 'EMAIL' ? 'Unsubscribe link' : 'STOP reply', byUserId: null, source: 'SYS', at });
      await cancelQueuedMessages(tx, { accountId, customerId: r.customerId, familyMemberId: r.familyMemberId, channel });
      await audit(tx, null, { action: 'CONSENT_WITHDRAWN', entity: 'customer', entityId: r.customerId, accountId, newValue: { channel: CHANNEL_NAME[channel], how: 'Opt-out' }, actor: { job: 'opt-out' } });
    }
    return rows.length;
  });
}

/** Does this person have GIVEN consent on this channel for this exact address right now (GR-29 check at send)? */
export async function hasConsent(dbx: DbOrTx, customerId: string, familyMemberId: string | null, channel: Channel, address: string | null): Promise<boolean> {
  const [r] = await dbx
    .select()
    .from(consents)
    .where(and(eq(consents.customerId, customerId), sql`coalesce(${consents.familyMemberId}, ${NO_MEMBER}) = coalesce(${familyMemberId}::uuid, ${NO_MEMBER})`, eq(consents.channel, channel)));
  return !!r && r.status === 'GIVEN' && (channel === 'PERSONAL_DATA' || r.address === address);
}
