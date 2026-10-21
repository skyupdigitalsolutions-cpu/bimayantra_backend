// P-06 Submit and review KYC. PAN is encrypted field by field and shown masked everywhere except the
// advisor's KYC screen and the reviewer's screen (GR-36). Decisions, reasons and times are audited.
import type { Request } from 'express';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { advisorKyc, advisorProfiles, users } from '../../db/schema.js';
import { clock } from '../../lib/clock.js';
import { blindIndex, encryptField, tryDecryptField } from '../../lib/crypto.js';
import { fieldError, notFound, stateConflict, versionConflict } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import { maskPan } from '../../lib/mask.js';
import { msg } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { ownFile } from '../files/files.service.js';
import { notify, notifyRoles } from '../notifications/notifications.service.js';
import { recalc } from '../profile/profile.service.js';
import { settings } from '../settings/settings.service.js';

export const REJECT_REASONS = {
  DOCUMENT_UNCLEAR: 'Document unclear',
  NAME_MISMATCH: 'Name does not match',
  PAN_INVALID: 'PAN invalid',
  LICENCE_EXPIRED: 'Licence expired',
  OTHER: 'Other',
} as const;
type Reason = keyof typeof REJECT_REASONS;

type Kyc = typeof advisorKyc.$inferSelect;
const pan = (k: Kyc) => tryDecryptField(k.panEnc); // null if saved with a key that is no longer here
const rejectText = (k: Pick<Kyc, 'rejectReason' | 'rejectNote'>) =>
  k.rejectReason === 'OTHER' ? (k.rejectNote ?? '') : `${REJECT_REASONS[k.rejectReason as Reason] ?? ''}${k.rejectNote ? ` (${k.rejectNote})` : ''}`;

/** The advisor's own KYC screen: the full PAN is shown here only. */
export async function getOwnKyc(auth: AuthContext) {
  const [k] = await db.select().from(advisorKyc).where(eq(advisorKyc.accountId, auth.accountId!));
  if (!k) throw notFound();
  return {
    status: k.status,
    pan: pan(k),
    nameOnPan: k.nameOnPan,
    panFileId: k.panFileId,
    licenceFileId: k.licenceFileId,
    submittedAt: k.submittedAt,
    reviewedAt: k.reviewedAt,
    rejection: k.status === 'REJECTED' ? msg('PRF-06', { reason: rejectText(k) }) : null,
    version: k.version,
  };
}

/** Masked view for everywhere else (dashboard, assistants). */
export async function kycSummary(accountId: string) {
  const [k] = await db.select({ status: advisorKyc.status, panEnc: advisorKyc.panEnc }).from(advisorKyc).where(eq(advisorKyc.accountId, accountId));
  return { status: k?.status ?? 'NOT_SUBMITTED', panMasked: (() => { const p = tryDecryptField(k?.panEnc); return p ? maskPan(p) : null; })() };
}

export async function submitKyc(req: Request, auth: AuthContext, body: unknown) {
  const v = F.parseFields(body, {
    pan: { label: 'PAN', required: true, rule: F.pan },
    nameOnPan: { label: 'Name as on PAN', required: true, rule: F.personName },
    panFileId: { label: 'PAN card image', required: true },
    licenceFileId: { label: 'IRDAI licence or POSP certificate', required: true },
    declaration: { label: 'Declaration', checkbox: true },
  }) as { pan: string; nameOnPan: string; panFileId: string; licenceFileId: string };
  const panFile = await ownFile(auth, v.panFileId, ['KYC_PAN'], 'panFileId');
  const licenceFile = await ownFile(auth, v.licenceFileId, ['KYC_LICENCE'], 'licenceFileId');
  const version = Number((body as { version?: unknown }).version);
  const accountId = auth.accountId!;

  return db.transaction(async (tx) => {
    const [k] = await tx.select().from(advisorKyc).where(eq(advisorKyc.accountId, accountId)).for('update');
    if (!k) throw notFound();
    if (k.version !== version) throw versionConflict('KYC', ['pan', 'nameOnPan', 'panFileId', 'licenceFileId']);
    const same = pan(k) === v.pan && k.nameOnPan === v.nameOnPan && k.panFileId === panFile.id && k.licenceFileId === licenceFile.id;
    if (same && (k.status === 'VERIFIED' || k.status === 'PENDING_REVIEW')) {
      return { status: k.status, version: k.version, message: k.status === 'PENDING_REVIEW' ? msg('PRF-04') : msg('PRF-05') };
    }
    // Section 4.3: NOT_SUBMITTED / REJECTED / VERIFIED (a change) / PENDING_REVIEW (a correction) → PENDING_REVIEW
    const now = clock.now();
    await tx
      .update(advisorKyc)
      .set({
        status: 'PENDING_REVIEW',
        panEnc: encryptField(v.pan),
        panIndex: blindIndex('pan', v.pan),
        nameOnPan: v.nameOnPan,
        panFileId: panFile.id,
        licenceFileId: licenceFile.id,
        declaredAt: now,
        submittedAt: now,
        reviewedBy: null,
        reviewedAt: null,
        rejectReason: null,
        rejectNote: null,
        version: sql`${advisorKyc.version} + 1`,
      })
      .where(eq(advisorKyc.accountId, accountId));
    await audit(tx, req, {
      action: 'KYC_SUBMITTED',
      entity: 'advisor_kyc',
      entityId: accountId,
      oldValue: { status: k.status, pan: k.panEnc ? maskPan(pan(k)!) : null },
      newValue: { status: 'PENDING_REVIEW', pan: maskPan(v.pan), nameOnPan: v.nameOnPan },
    });
    const [p] = await tx.select({ fullName: advisorProfiles.fullName }).from(advisorProfiles).where(eq(advisorProfiles.accountId, accountId));
    await notifyRoles(tx, ['STF', 'ADM'], {
      accountId: null,
      messageId: 'DSH-21',
      params: { 'advisor name': p?.fullName ?? auth.name },
      dedupeKey: `kyc-review:${accountId}:${now.toISOString()}`,
      link: { type: 'KYC_REVIEW', id: accountId },
    });
    await recalc(tx, accountId);
    return { status: 'PENDING_REVIEW', version: k.version + 1, message: msg('PRF-04') };
  });
}

/** Working days after a date (Monday to Friday) for the CFG-125 review target. */
function addWorkingDays(from: Date, days: number): Date {
  const d = new Date(from);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = new Date(d.getTime() + 330 * 60_000).getUTCDay();
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return d;
}

/** Admin → Approvals → Advisor KYC: pending items, oldest first, with the review target. */
export async function reviewQueue() {
  const rows = await db
    .select({ accountId: advisorKyc.accountId, submittedAt: advisorKyc.submittedAt, fullName: advisorProfiles.fullName, version: advisorKyc.version })
    .from(advisorKyc)
    .innerJoin(advisorProfiles, eq(advisorProfiles.accountId, advisorKyc.accountId))
    .where(eq(advisorKyc.status, 'PENDING_REVIEW'))
    .orderBy(asc(advisorKyc.submittedAt));
  const target = settings.get('CFG-125');
  return rows.map((r) => {
    const due = addWorkingDays(r.submittedAt!, target);
    return { ...r, reviewBy: due.toISOString(), overdue: due < clock.now() };
  });
}

export async function reviewItem(req: Request, accountId: string) {
  if (!/^[0-9a-f-]{36}$/.test(accountId)) throw notFound();
  const [row] = await db
    .select({ k: advisorKyc, p: advisorProfiles })
    .from(advisorKyc)
    .innerJoin(advisorProfiles, eq(advisorProfiles.accountId, advisorKyc.accountId))
    .where(eq(advisorKyc.accountId, accountId));
  if (!row || row.k.status === 'NOT_SUBMITTED') throw notFound();
  const [adv] = await db.select({ mobile: users.mobile }).from(users).where(and(eq(users.accountId, accountId), eq(users.role, 'ADV')));
  await audit(db, req, { action: 'KYC_VIEWED', entity: 'advisor_kyc', entityId: accountId, accountId });
  return {
    accountId,
    status: row.k.status,
    pan: pan(row.k),
    nameOnPan: row.k.nameOnPan,
    panFileId: row.k.panFileId,
    licenceFileId: row.k.licenceFileId,
    submittedAt: row.k.submittedAt,
    version: row.k.version,
    profile: { fullName: row.p.fullName, licenceNumber: row.p.licenceNumber, licenceValidUntil: row.p.licenceValidUntil, advisorType: row.p.advisorType, mobile: adv?.mobile ?? null },
    reasons: Object.entries(REJECT_REASONS).map(([value, label]) => ({ value, label })),
  };
}

export async function decide(req: Request, auth: AuthContext, accountId: string, body: unknown) {
  const v = F.parseFields(body, { decision: { label: 'Decision', required: true, oneOf: ['VERIFY', 'REJECT'] as const } }) as { decision: 'VERIFY' | 'REJECT' };
  const b = (body ?? {}) as { reason?: unknown; note?: unknown; version?: unknown };
  let reason: Reason | null = null;
  let note: string | null = null;
  if (v.decision === 'REJECT') {
    if (typeof b.reason !== 'string' || b.reason === '') throw fieldError('reason', 'GEN-01', { 'Field label': 'Reason' });
    if (!(b.reason in REJECT_REASONS)) throw fieldError('reason', 'VAL-22');
    reason = b.reason as Reason;
    const n = typeof b.note === 'string' && b.note.trim() ? F.notes(b.note) : null;
    if (n && !n.ok) throw fieldError('note', n.code, n.params);
    note = n?.ok ? n.value : null;
    if (reason === 'OTHER' && !note) throw fieldError('note', 'GEN-01', { 'Field label': 'Note' });
  }
  const version = Number(b.version);
  const result = await db.transaction(async (tx) => {
    const [k] = await tx.select().from(advisorKyc).where(eq(advisorKyc.accountId, accountId)).for('update');
    if (!k) throw notFound();
    // Two reviewers at once: the second decision gets GEN-04 (P-06)
    if (k.status !== 'PENDING_REVIEW' || k.version !== version) throw stateConflict('KYC', k.status === 'PENDING_REVIEW' ? 'changed' : k.status);
    const status = v.decision === 'VERIFY' ? 'VERIFIED' : 'REJECTED';
    await tx
      .update(advisorKyc)
      .set({ status, reviewedBy: auth.userId, reviewedAt: clock.now(), rejectReason: reason, rejectNote: note, version: sql`${advisorKyc.version} + 1` })
      .where(eq(advisorKyc.accountId, accountId));
    await audit(tx, req, { action: status === 'VERIFIED' ? 'KYC_VERIFIED' : 'KYC_REJECTED', entity: 'advisor_kyc', entityId: accountId, accountId, oldValue: { status: k.status }, newValue: { status, reason, note } });
    const [adv] = await tx.select({ id: users.id }).from(users).where(and(eq(users.accountId, accountId), eq(users.role, 'ADV')));
    const [p] = await tx.select({ email: advisorProfiles.email }).from(advisorProfiles).where(eq(advisorProfiles.accountId, accountId));
    if (adv) {
      const messageId = status === 'VERIFIED' ? 'PRF-05' : 'PRF-06';
      await notify(tx, {
        userId: adv.id,
        accountId,
        messageId,
        params: { reason: rejectText({ rejectReason: reason, rejectNote: note }) },
        dedupeKey: `kyc-decision:${accountId}:${k.version}`,
        link: { type: 'KYC', id: accountId },
        email: { to: p?.email, subject: status === 'VERIFIED' ? 'Your KYC is verified' : 'Your KYC needs a correction' },
      });
    }
    await recalc(tx, accountId);
    return { status };
  });
  return result;
}

