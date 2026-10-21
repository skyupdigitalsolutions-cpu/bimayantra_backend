// OTP challenges (P-01 backend rules, used by P-02, P-04 and step-up).
// - only a salted hash is stored; the code never reaches logs, audit, responses or analytics
// - one open challenge per mobile + purpose; a newer one replaces the older (REPLACED)
// - constant-time comparison; CFG-03 wrong tries lock the mobile for that purpose for CFG-06
// - CFG-04 wait before resend; CFG-05 sends per mobile in any 60 minutes (then locked for CFG-06)
// - CFG-10 registration/login requests per IP address per hour
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { env, isProduction } from '../../config/env.js';
import { db, type DbOrTx } from '../../db/client.js';
import { otpChallenges, otpLocks } from '../../db/schema.js';
import { clock, formatIstTime } from '../../lib/clock.js';
import { hashOtp, randomDigits, safeEqual } from '../../lib/crypto.js';
import { AppError, fieldError, tooMany } from '../../lib/errors.js';
import { maskMobile } from '../../lib/mask.js';
import { msg } from '../../messages/messages.js';
import { audit } from '../audit/audit.js';
import { hit, secondsUntil } from '../ratelimit/ratelimit.js';
import { settings } from '../settings/settings.service.js';
import { SmsSendError, sms } from '../sms/sms.js';

export type OtpPurpose = 'REGISTER' | 'LOGIN' | 'CHANGE_MOBILE' | 'CHANGE_MOBILE_NEW' | 'STEP_UP';
export type Challenge = typeof otpChallenges.$inferSelect;

const SEND_LOCK = 'ANY'; // CFG-05 lock covers every purpose for that mobile
const minutes = (n: number) => n * 60_000;

/** CFG-10: registration and login requests per IP address per hour; refused for the rest of the hour. */
export async function checkIpLimit(req: Request): Promise<void> {
  const h = await hit(`ip-auth:${req.ip ?? 'unknown'}`, 3600);
  if (h.count > settings.get('CFG-10')) {
    const seconds = secondsUntil(h.windowEndsAt);
    throw tooMany('GEN-15', { seconds }, seconds);
  }
}

async function activeLock(mobile: string, purpose: OtpPurpose) {
  const rows = await db
    .select()
    .from(otpLocks)
    .where(and(eq(otpLocks.mobile, mobile), inArray(otpLocks.purpose, [purpose, SEND_LOCK]), gt(otpLocks.lockedUntil, clock.now())));
  return rows.sort((a, b) => b.lockedUntil.getTime() - a.lockedUntil.getTime())[0];
}

function lockError(lock: { lockedUntil: Date; reason: string }): AppError {
  const code = lock.reason === 'TOO_MANY_SENDS' ? 'AUTH-06' : 'AUTH-04';
  return tooMany(code, { time: formatIstTime(lock.lockedUntil) }, secondsUntil(lock.lockedUntil));
}

async function lock(mobile: string, purpose: string, reason: 'WRONG_TRIES' | 'TOO_MANY_SENDS'): Promise<Date> {
  const lockedUntil = new Date(clock.now().getTime() + minutes(settings.get('CFG-06')));
  await db
    .insert(otpLocks)
    .values({ mobile, purpose, lockedUntil, reason })
    .onConflictDoUpdate({ target: [otpLocks.mobile, otpLocks.purpose], set: { lockedUntil, reason } });
  return lockedUntil;
}

function newCode(): string {
  const length = settings.get('CFG-01');
  // Fixed code for development and testing only (env.ts refuses it in production)
  if (!isProduction && env.OTP_FIXED_CODE && env.OTP_FIXED_CODE.length === length) return env.OTP_FIXED_CODE;
  return randomDigits(length);
}

export type IssueResult = {
  challengeId: string;
  maskedMobile: string;
  expiresAt: string;
  resendAfterSeconds: number;
  resent: boolean;
  message: { code: string; text: string };
};

export async function issueOtp(
  req: Request,
  input: { mobile: string; purpose: OtpPurpose; userId?: string | null; context?: Record<string, unknown> },
): Promise<IssueResult> {
  const { mobile, purpose } = input;
  const masked = maskMobile(mobile);
  const now = clock.now();

  const l = await activeLock(mobile, purpose);
  if (l) throw lockError(l);

  // Inside CFG-04 of the last sent code: no new SMS, the OTP step opens for the existing code (AUTH-05)
  const [open] = await db
    .select()
    .from(otpChallenges)
    .where(and(eq(otpChallenges.mobile, mobile), eq(otpChallenges.purpose, purpose), eq(otpChallenges.status, 'ISSUED')));
  if (open?.sent && open.sentAt && open.expiresAt > now && (input.userId ?? null) === open.userId) {
    const waitUntil = open.sentAt.getTime() + settings.get('CFG-04') * 1000;
    if (waitUntil > now.getTime()) {
      if (input.context) await db.update(otpChallenges).set({ context: input.context }).where(eq(otpChallenges.id, open.id));
      const seconds = secondsUntil(new Date(waitUntil));
      return {
        challengeId: open.id,
        maskedMobile: masked,
        expiresAt: open.expiresAt.toISOString(),
        resendAfterSeconds: seconds,
        resent: false,
        message: msg('AUTH-05', { seconds }),
      };
    }
  }

  // CFG-05: sends per mobile in any 60 minutes (failed sends do not count)
  const [{ sent } = { sent: 0 }] = await db
    .select({ sent: sql<number>`count(*)::int` })
    .from(otpChallenges)
    .where(and(eq(otpChallenges.mobile, mobile), eq(otpChallenges.sent, true), gt(otpChallenges.sentAt, new Date(now.getTime() - minutes(60)))));
  if (sent >= settings.get('CFG-05')) {
    const until = await lock(mobile, SEND_LOCK, 'TOO_MANY_SENDS');
    throw tooMany('AUTH-06', { time: formatIstTime(until) }, secondsUntil(until));
  }

  const id = randomUUID();
  const code = newCode();
  const expiresAt = new Date(now.getTime() + minutes(settings.get('CFG-02')));
  await db.transaction(async (tx) => {
    await tx
      .update(otpChallenges)
      .set({ status: 'REPLACED' })
      .where(and(eq(otpChallenges.mobile, mobile), eq(otpChallenges.purpose, purpose), eq(otpChallenges.status, 'ISSUED')));
    await tx.insert(otpChallenges).values({
      id,
      mobile,
      purpose,
      userId: input.userId ?? null,
      codeHash: hashOtp(id, code),
      context: input.context ?? null,
      ip: req.ip ?? null,
      expiresAt,
      createdAt: now,
    });
  });

  try {
    await sms.send({ kind: 'OTP', to: mobile, code, minutes: settings.get('CFG-02') });
  } catch (err) {
    if (!(err instanceof SmsSendError)) throw err;
    await audit(db, req, { action: 'OTP_REQUESTED', entity: 'otp', entityId: id, newValue: { mobile: masked, purpose, sent: false }, result: 'FAILURE' });
    throw new AppError(503, 'AUTH-13');
  }
  await db.update(otpChallenges).set({ sent: true, sentAt: clock.now() }).where(eq(otpChallenges.id, id));
  await audit(db, req, { action: 'OTP_REQUESTED', entity: 'otp', entityId: id, newValue: { mobile: masked, purpose, sent: true } });

  return {
    challengeId: id,
    maskedMobile: masked,
    expiresAt: expiresAt.toISOString(),
    resendAfterSeconds: settings.get('CFG-04'),
    resent: true,
    message: msg('AUTH-01', { 'masked mobile': masked }),
  };
}

const expired = () => fieldError('code', 'AUTH-03');

/**
 * Check a code. Wrong tries and expiry are saved before the error is returned. A correct code is NOT yet
 * used up: call consumeOtp() inside the transaction that does the work, so a failure leaves it usable.
 */
export async function checkOtp(
  req: Request,
  input: { challengeId: string; code: string; purpose: OtpPurpose; userId?: string | null },
): Promise<Challenge> {
  const [ch] = /^[0-9a-f-]{36}$/.test(input.challengeId)
    ? await db.select().from(otpChallenges).where(and(eq(otpChallenges.id, input.challengeId), eq(otpChallenges.purpose, input.purpose)))
    : [];
  if (!ch || (input.userId !== undefined && ch.userId !== input.userId)) throw expired();
  const masked = maskMobile(ch.mobile);
  const failed = (reason: string) =>
    audit(db, req, { action: 'OTP_VERIFIED', entity: 'otp', entityId: ch.id, newValue: { mobile: masked, purpose: ch.purpose, reason }, result: 'FAILURE' });

  const l = await activeLock(ch.mobile, input.purpose);
  if (l && l.reason === 'WRONG_TRIES') throw lockError(l);
  if (ch.status !== 'ISSUED' || !ch.sent) {
    await failed('not_open');
    throw expired();
  }
  if (ch.expiresAt <= clock.now()) {
    await db.update(otpChallenges).set({ status: 'EXPIRED' }).where(and(eq(otpChallenges.id, ch.id), eq(otpChallenges.status, 'ISSUED')));
    await failed('expired');
    throw expired();
  }
  if (!safeEqual(hashOtp(ch.id, input.code), ch.codeHash)) {
    const [row] = await db
      .update(otpChallenges)
      .set({ wrongTries: sql`${otpChallenges.wrongTries} + 1` })
      .where(and(eq(otpChallenges.id, ch.id), eq(otpChallenges.status, 'ISSUED')))
      .returning({ wrongTries: otpChallenges.wrongTries });
    await failed('wrong_code');
    if (!row) throw expired();
    const left = settings.get('CFG-03') - row.wrongTries;
    if (left <= 0) {
      await db.update(otpChallenges).set({ status: 'LOCKED' }).where(eq(otpChallenges.id, ch.id));
      const until = await lock(ch.mobile, input.purpose, 'WRONG_TRIES');
      throw tooMany('AUTH-04', { time: formatIstTime(until) }, secondsUntil(until));
    }
    throw fieldError('code', 'AUTH-02', { n: left });
  }
  return ch;
}

/** Use up a checked challenge inside the work's transaction. A second use (double click) fails with AUTH-03. */
export async function consumeOtp(tx: DbOrTx, challengeId: string): Promise<void> {
  const rows = await tx
    .update(otpChallenges)
    .set({ status: 'VERIFIED', verifiedAt: clock.now() })
    .where(and(eq(otpChallenges.id, challengeId), eq(otpChallenges.status, 'ISSUED')))
    .returning({ id: otpChallenges.id });
  if (rows.length === 0) throw expired();
}

/** "Change number" link: cancel the open challenge (REPLACED). */
export async function cancelOtp(challengeId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/.test(challengeId)) return;
  await db
    .update(otpChallenges)
    .set({ status: 'REPLACED' })
    .where(and(eq(otpChallenges.id, challengeId), eq(otpChallenges.status, 'ISSUED')));
}
