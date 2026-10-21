// Agent code check (P-07). The advisor uploads the insurer's appointment letter; the letter is read by the
// document reader and compared with what the advisor typed:
//   agent code      = the code on the letter (spaces, dashes and case ignored)
//   insurer         = the insurer chosen (every main word of the insurer's name is on the letter)
//   advisor name    = the profile name or the name on PAN (initials allowed)
//   valid until     = the letter is not expired; an empty "Code valid until" is filled from the letter
// All match → VERIFIED at once. Anything else (or the letter cannot be read) → REVIEW: SkyUp checks it by hand
// in Admin → Approvals → Agent codes and selects Approve or Reject. No letter → UNVERIFIED.
// Quotations are never blocked by this; My insurers shows the result.
import type { Request } from 'express';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { accounts, advisorKyc, advisorProfiles, insurerMappings, insurers } from '../../db/schema.js';
import { clock, formatDate, istToday } from '../../lib/clock.js';
import { fieldError, notFound, stateConflict, versionConflict } from '../../lib/errors.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { getFile, readStored } from '../files/files.service.js';
import { readAppointmentLetter } from '../documents/reader.js';
import { logger } from '../../lib/logger.js';

export type Verification = 'UNVERIFIED' | 'VERIFIED' | 'REVIEW' | 'REJECTED';

const code = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const STOP = new Set(['the', 'of', 'and', 'insurance', 'assurance', 'company', 'co', 'corporation', 'ltd', 'limited', 'pvt', 'private', 'general', 'india', 'indian', 'life', 'health', 'allied']);
const words = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(Boolean);
const main = (s: string | null | undefined) => words(s).filter((w) => !STOP.has(w));

/** Every main word of the catalogue insurer name appears on the letter. */
export function sameInsurer(catalogue: string, onLetter: string | null) {
  const name = catalogue.replace(/\([^)]*\)/g, ' '); // "(formerly …)"
  const want = main(name).length ? main(name) : words(name);
  const have = new Set(words(onLetter));
  return want.length > 0 && want.every((w) => have.has(w));
}

/** Names match when every part of the shorter name is in the longer one; a single letter matches an initial. */
export function sameName(a: string | null | undefined, b: string | null | undefined) {
  const x = words(a), y = words(b);
  if (!x.length || !y.length) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const left = [...long];
  for (const w of short) {
    const i = left.findIndex((l) => l === w || (w.length === 1 && l.startsWith(w)) || (l.length === 1 && w.startsWith(l)));
    if (i < 0) return false;
    left.splice(i, 1);
  }
  // at least one full word (not only initials) must match
  return short.some((w) => w.length > 1 && long.includes(w));
}

const NOTE: Record<Verification, string> = {
  UNVERIFIED: 'Upload the appointment letter from the insurer to verify this code.',
  VERIFIED: 'Verified from the appointment letter.',
  REVIEW: 'SkyUp is checking your appointment letter (usually within 1 working day).',
  REJECTED: '',
};

/**
 * Check one entry against its appointment letter and save the result. Never throws: a reading problem
 * sends the entry to SkyUp review. Returns the new state for the toast.
 */
export async function verifyMapping(mappingId: string): Promise<{ verification: Verification; note: string }> {
  const [row] = await db
    .select({ m: insurerMappings, insurer: insurers.name })
    .from(insurerMappings)
    .innerJoin(insurers, eq(insurers.id, insurerMappings.insurerId))
    .where(eq(insurerMappings.id, mappingId));
  if (!row) return { verification: 'UNVERIFIED', note: NOTE.UNVERIFIED };
  const { m } = row;
  const ins = row.insurer.replace(/\.$/, '');
  const save = async (verification: Verification, note: string, read: unknown, extra: Partial<typeof insurerMappings.$inferInsert> = {}) => {
    await db.update(insurerMappings).set({ verification, verificationNote: note, verificationRead: read, verifiedAt: verification === 'VERIFIED' ? clock.now() : null, verifiedBy: null, ...extra }).where(eq(insurerMappings.id, m.id));
    return { verification, note };
  };
  if (!m.appointmentFileId) return save('UNVERIFIED', NOTE.UNVERIFIED, null);

  const f = await getFile(m.appointmentFileId);
  let letter: Awaited<ReturnType<typeof readAppointmentLetter>> = null;
  try {
    if (f) letter = await readAppointmentLetter(await readStored(f.storageKey), f.mime, f.originalName);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Agent code check: could not read the letter');
  }
  if (!letter) return save('REVIEW', NOTE.REVIEW, { reasons: ['The letter could not be read automatically. Check it by hand.'] });

  const [p] = await db.select({ fullName: advisorProfiles.fullName }).from(advisorProfiles).where(eq(advisorProfiles.accountId, m.accountId));
  const [k] = await db.select({ nameOnPan: advisorKyc.nameOnPan }).from(advisorKyc).where(eq(advisorKyc.accountId, m.accountId));
  const today = istToday();
  const reasons: string[] = []; // for SkyUp
  const tell: string[] = []; // for the advisor
  if (!letter.agentCode) { reasons.push('No agent code found on the letter.'); tell.push('the agent code was not found on the letter'); }
  else if (code(letter.agentCode) !== code(m.agentCode)) { reasons.push(`Agent code on the letter is ${letter.agentCode}; the advisor typed ${m.agentCode}.`); tell.push(`the letter shows agent code ${letter.agentCode}, you typed ${m.agentCode}`); }
  if (!sameInsurer(row.insurer, letter.insurerName)) { reasons.push(`Insurer on the letter: ${letter.insurerName?.replace(/\.$/, '') ?? 'not found'}; chosen: ${ins}.`); tell.push(`the letter does not look like it is from ${ins}`); }
  if (!sameName(letter.advisorName, p?.fullName) && !sameName(letter.advisorName, k?.nameOnPan)) {
    reasons.push(`Name on the letter: ${letter.advisorName ?? 'not found'}; profile: ${p?.fullName ?? '—'}${k?.nameOnPan ? `, PAN: ${k.nameOnPan}` : ''}.`);
    tell.push('the name on the letter is not the name in your profile');
  }
  if (letter.validUntil && letter.validUntil < today) { reasons.push(`The letter expired on ${formatDate(letter.validUntil)}.`); tell.push(`the letter expired on ${formatDate(letter.validUntil)}`); }
  else if (letter.validUntil && m.codeValidUntil && m.codeValidUntil > letter.validUntil) { reasons.push(`Advisor typed valid until ${formatDate(m.codeValidUntil)}; the letter says ${formatDate(letter.validUntil)}.`); tell.push(`the letter is valid only until ${formatDate(letter.validUntil)}`); }
  // Same code in another account (DEC-09): SkyUp checks, the advisor is never told why
  if (m.flaggedForReview) reasons.push('The same insurer and agent code is used in another advisor account.');

  const extra = !m.codeValidUntil && letter.validUntil && letter.validUntil >= today ? { codeValidUntil: letter.validUntil } : {};
  if (!reasons.length) return save('VERIFIED', NOTE.VERIFIED, { letter, reasons }, extra);
  const note = tell.length ? `Not matching: ${tell.join('; ')}. SkyUp will check it, or fix it and save again.` : NOTE.REVIEW;
  return save('REVIEW', note, { letter, reasons }, extra);
}

// ---------- SkyUp: Admin → Approvals → Agent codes ----------

export async function agentCodeQueue(status: unknown) {
  const want = status === 'ALL' ? ['REVIEW', 'VERIFIED', 'REJECTED'] : [typeof status === 'string' && ['REVIEW', 'VERIFIED', 'REJECTED'].includes(status) ? status : 'REVIEW'];
  const rows = await db
    .select({ m: insurerMappings, insurer: insurers.name, advisor: advisorProfiles.fullName })
    .from(insurerMappings)
    .innerJoin(insurers, eq(insurers.id, insurerMappings.insurerId))
    .innerJoin(accounts, eq(accounts.id, insurerMappings.accountId))
    .leftJoin(advisorProfiles, eq(advisorProfiles.accountId, insurerMappings.accountId))
    .where(inArray(insurerMappings.verification, want))
    .orderBy(want.length === 1 && want[0] === 'REVIEW' ? asc(insurerMappings.createdAt) : desc(insurerMappings.createdAt))
    .limit(300);
  return rows.map(({ m, insurer, advisor }) => {
    const read = (m.verificationRead ?? {}) as { letter?: Record<string, string | null>; reasons?: string[] };
    return {
      id: m.id,
      accountId: m.accountId,
      advisorName: advisor ?? '—',
      insurerName: insurer,
      agentCode: m.agentCode,
      codeValidUntil: m.codeValidUntil,
      appointmentFileId: m.appointmentFileId,
      verification: m.verification,
      note: m.verificationNote,
      letter: read.letter ?? null,
      reasons: read.reasons ?? [],
      flaggedForReview: m.flaggedForReview,
      createdAt: m.createdAt,
    };
  });
}

export async function decideAgentCode(req: Request, auth: AuthContext, id: string, body: unknown) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound();
  const b = (body ?? {}) as { decision?: unknown; reason?: unknown };
  const decision = b.decision === 'APPROVE' ? 'APPROVE' : b.decision === 'REJECT' ? 'REJECT' : null;
  if (!decision) throw fieldError('decision', 'VAL-22');
  const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 500) : '';
  if (decision === 'REJECT' && !reason) throw fieldError('reason', 'GEN-01', { 'Field label': 'Reason' });
  const [m] = await db.select().from(insurerMappings).where(eq(insurerMappings.id, id));
  if (!m) throw notFound();
  if (!m.appointmentFileId) throw stateConflict('agent code', m.verification);
  const to: Verification = decision === 'APPROVE' ? 'VERIFIED' : 'REJECTED';
  const note = to === 'VERIFIED' ? 'Verified by SkyUp.' : `SkyUp could not verify this code: ${reason} Upload the correct letter or fix the code and save again.`;
  const rows = await db
    .update(insurerMappings)
    .set({ verification: to, verificationNote: note, verifiedAt: to === 'VERIFIED' ? clock.now() : null, verifiedBy: auth.userId, flaggedForReview: to === 'VERIFIED' ? false : m.flaggedForReview })
    .where(and(eq(insurerMappings.id, id), eq(insurerMappings.verification, m.verification)))
    .returning({ id: insurerMappings.id });
  if (!rows.length) throw versionConflict('agent code', ['verification']);
  await audit(db, req, { action: to === 'VERIFIED' ? 'AGENT_CODE_APPROVED' : 'AGENT_CODE_REJECTED', entity: 'insurer_mapping', entityId: id, oldValue: { verification: m.verification }, newValue: { verification: to, reason: reason || null } });
  return { verification: to };
}
