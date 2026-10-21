// P-01 register, P-02 login, P-04 change mobile, step-up OTP (CFG-83, AUTH-26).
import type { Request, Response } from 'express';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db, type DbOrTx } from '../../db/client.js';
import { accounts, authTickets, otpLocks, sessions, subscriptions, users } from '../../db/schema.js';
import { accessBlock } from '../../http/auth.js';
import { clock, formatIstTime } from '../../lib/clock.js';
import { checkPassword, hashPassword, passwordProblem } from '../../lib/password.js';
import { hit, secondsUntil } from '../ratelimit/ratelimit.js';
import { AppError, fieldError, forbidden, tooMany } from '../../lib/errors.js';
import { maskMobile } from '../../lib/mask.js';
import { msg } from '../../messages/messages.js';
import type { AuthContext, Role } from '../../types/express.js';
import { createAdvisorAccount } from '../accounts/accounts.service.js';
import { audit } from '../audit/audit.js';
import { settings } from '../settings/settings.service.js';
import { sms } from '../sms/sms.js';
import { checkIpLimit, checkOtp, consumeOtp, issueOtp } from './otp.service.js';
import { createSession, deliverSession, endAllSessions, rotateRefresh } from './sessions.service.js';

// ---------- home screen and deep links (P-02 step 5) ----------
export const HOME: Record<Role, string> = { ADV: '/dashboard', AST: '/dashboard', REF: '/referral', STF: '/admin', ADM: '/admin' };

export function mayOpen(role: Role, path: string): boolean {
  if (path.startsWith('/admin')) return role === 'STF' || role === 'ADM';
  if (path.startsWith('/referral')) return role === 'REF';
  if (path.startsWith('/settings')) return true;
  return role === 'ADV' || role === 'AST';
}

/** A deep link is followed only if it is a path on this site and the role may see it; otherwise home. */
export function redirectFor(role: Role, next: unknown): string {
  if (typeof next === 'string' && /^\/(?!\/)[\w\-./?=&%#]*$/.test(next) && !next.includes('\\') && mayOpen(role, next)) return next;
  return HOME[role];
}

type UserRow = typeof users.$inferSelect;

async function readOnlyFor(dbx: DbOrTx, accountId: string | null): Promise<boolean> {
  if (!accountId) return false;
  const [s] = await dbx
    .select({ status: subscriptions.status })
    .from(subscriptions)
    .where(and(eq(subscriptions.accountId, accountId), eq(subscriptions.isCurrent, true)));
  return s?.status === 'EXPIRED';
}

/** Start a session inside the transaction; an INVITED user becomes ACTIVE (P-02 step 6). */
async function signIn(tx: DbOrTx, req: Request, user: UserRow) {
  const activated = user.status === 'INVITED';
  await tx
    .update(users)
    .set({
      lastLoginAt: clock.now(),
      ...(activated ? { status: 'ACTIVE', activatedAt: clock.now(), version: sql`${users.version} + 1` } : {}),
    })
    .where(eq(users.id, user.id));
  const s = await createSession(tx, user.id, req);
  await audit(tx, req, { action: 'LOGIN', entity: 'user', entityId: user.id, accountId: user.accountId, actor: { userId: user.id, role: user.role } });
  if (activated)
    await audit(tx, req, {
      action: 'USER_ACTIVATED',
      entity: 'user',
      entityId: user.id,
      accountId: user.accountId,
      oldValue: { status: 'INVITED' },
      newValue: { status: 'ACTIVE' },
      actor: { userId: user.id, role: user.role },
    });
  return { ...s, activated };
}

export type SignedIn = {
  user: { id: string; name: string; role: Role; mobile: string };
  redirectTo: string;
  readOnly: boolean;
  /** AUTH-15 new account, AUTH-07 existing advisor, AUTH-12 first login of an invited user; none otherwise. */
  message?: { code: string; text: string };
  banner?: { code: string; text: string };
};

async function finishSignIn(
  req: Request,
  res: Response,
  user: UserRow,
  s: { sessionId: string; refreshToken: string },
  message: { code: string; text: string } | undefined,
  next: unknown,
  readOnly: boolean,
): Promise<SignedIn> {
  await deliverSession(req, res, user.id, s.sessionId, s.refreshToken);
  res.locals.idempotencyPrivate = { sessionId: s.sessionId, userId: user.id };
  const role = user.role as Role;
  return {
    user: { id: user.id, name: user.name, role, mobile: user.mobile },
    redirectTo: redirectFor(role, next),
    readOnly,
    ...(message ? { message } : {}),
    ...(readOnly ? { banner: msg('SUB-03') } : {}),
  };
}

async function loginFailed(req: Request, user: UserRow, e: AppError): Promise<never> {
  await audit(db, req, { action: 'LOGIN', entity: 'user', entityId: user.id, accountId: user.accountId, newValue: { reason: e.code }, result: 'FAILURE', actor: { userId: user.id, role: user.role } });
  throw e;
}

/**
 * Replay hook for sign-in requests (GR-10 double click, GR-17 Check status after a timeout): when the
 * first request signed the user in but the browser never got the answer, restore the cookies for that
 * same session — only while it is still active and no older than the OTP validity (CFG-02).
 */
export async function restoreSignIn(req: Request, res: Response, saved: { private?: Record<string, unknown> }): Promise<void> {
  const sessionId = saved.private?.sessionId;
  const userId = saved.private?.userId;
  if (typeof sessionId !== 'string' || typeof userId !== 'string') return;
  const [s] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.id, sessionId),
        isNull(sessions.endedAt),
        gt(sessions.createdAt, new Date(clock.now().getTime() - settings.get('CFG-02') * 60_000)),
      ),
    );
  if (!s) return;
  const refreshToken = await rotateRefresh(db, sessionId);
  await deliverSession(req, res, userId, sessionId, refreshToken);
}

// ---------- P-01 Register ----------
export async function registerSendOtp(req: Request, input: { name: string; mobile: string }) {
  await checkIpLimit(req);
  return issueOtp(req, {
    mobile: input.mobile,
    purpose: 'REGISTER',
    context: { name: input.name, termsVersion: env.TERMS_VERSION, termsAcceptedAt: clock.now().toISOString() },
  });
}

export async function registerVerify(req: Request, res: Response, input: { challengeId: string; code: string; next?: unknown }): Promise<SignedIn> {
  await checkIpLimit(req);
  const ch = await checkOtp(req, { challengeId: input.challengeId, code: input.code, purpose: 'REGISTER' });
  const ctx = (ch.context ?? {}) as { name?: string; termsVersion?: string; termsAcceptedAt?: string };

  type Outcome =
    | { kind: 'CREATED' | 'EXISTING'; user: UserRow; s: { sessionId: string; refreshToken: string }; readOnly: boolean }
    | { kind: 'OTHER_ROLE'; user: UserRow }
    | { kind: 'BLOCKED'; user: UserRow; error: AppError };

  const outcome: Outcome = await db.transaction(async (tx) => {
    await consumeOtp(tx, ch.id);
    await audit(tx, req, { action: 'OTP_VERIFIED', entity: 'otp', entityId: ch.id, newValue: { mobile: maskMobile(ch.mobile), purpose: 'REGISTER' } });
    const [existing] = await tx.select().from(users).where(eq(users.mobile, ch.mobile)).for('update');
    if (!existing) {
      const { account, user } = await createAdvisorAccount(tx, {
        name: ctx.name ?? '',
        mobile: ch.mobile,
        termsVersion: ctx.termsVersion ?? env.TERMS_VERSION,
        termsAcceptedAt: ctx.termsAcceptedAt ? new Date(ctx.termsAcceptedAt) : clock.now(),
      });
      await audit(tx, req, {
        action: 'ACCOUNT_CREATED',
        entity: 'account',
        entityId: account.id,
        accountId: account.id,
        newValue: { role: 'ADV', mobile: maskMobile(ch.mobile), subscription: 'TRIAL', termsVersion: user.termsVersion },
        actor: { userId: user.id, role: 'ADV' },
      });
      const s = await signIn(tx, req, user);
      return { kind: 'CREATED', user, s, readOnly: false };
    }
    // b. already an advisor → sign in, ignore the typed name (AUTH-07); c. another role → AUTH-08
    if (existing.role !== 'ADV') return { kind: 'OTHER_ROLE', user: existing };
    const [account] = existing.accountId ? await tx.select().from(accounts).where(eq(accounts.id, existing.accountId)) : [];
    const block = accessBlock(existing, account ?? null);
    if (block) return { kind: 'BLOCKED', user: existing, error: block };
    const s = await signIn(tx, req, existing);
    return { kind: 'EXISTING', user: existing, s, readOnly: await readOnlyFor(tx, existing.accountId) };
  });

  if (outcome.kind === 'OTHER_ROLE') return loginFailed(req, outcome.user, new AppError(409, 'AUTH-08'));
  if (outcome.kind === 'BLOCKED') return loginFailed(req, outcome.user, outcome.error);
  const message = outcome.kind === 'CREATED' ? msg('AUTH-15', { name: outcome.user.name }) : msg('AUTH-07');
  return finishSignIn(req, res, outcome.user, outcome.s, message, input.next, outcome.readOnly);
}

// ---------- P-02 Login ----------
export async function loginSendOtp(req: Request, input: { mobile: string }) {
  await checkIpLimit(req);
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.mobile, input.mobile));
  if (!user) throw fieldError('mobile', 'AUTH-09'); // no SMS is sent
  return issueOtp(req, { mobile: input.mobile, purpose: 'LOGIN', userId: user.id });
}

export async function loginVerify(req: Request, res: Response, input: { challengeId: string; code: string; next?: unknown }): Promise<SignedIn> {
  await checkIpLimit(req);
  const ch = await checkOtp(req, { challengeId: input.challengeId, code: input.code, purpose: 'LOGIN' });

  const outcome = await db.transaction(async (tx) => {
    await consumeOtp(tx, ch.id);
    await audit(tx, req, { action: 'OTP_VERIFIED', entity: 'otp', entityId: ch.id, newValue: { mobile: maskMobile(ch.mobile), purpose: 'LOGIN' } });
    const [user] = ch.userId ? await tx.select().from(users).where(eq(users.id, ch.userId)).for('update') : [];
    // The number moved to another user since the code was sent (P-04): start again
    if (!user || user.mobile !== ch.mobile) return { kind: 'GONE' as const };
    const [account] = user.accountId ? await tx.select().from(accounts).where(eq(accounts.id, user.accountId)) : [];
    // P-02 step 4: account status, then user status, then role
    const block = accessBlock(user, account ?? null);
    if (block) return { kind: 'BLOCKED' as const, user, error: block };
    const s = await signIn(tx, req, user);
    return { kind: 'OK' as const, user, s, readOnly: await readOnlyFor(tx, user.accountId) };
  });

  if (outcome.kind === 'GONE') throw fieldError('mobile', 'AUTH-09');
  if (outcome.kind === 'BLOCKED') return loginFailed(req, outcome.user, outcome.error);
  const message = outcome.s.activated ? msg('AUTH-12', { name: outcome.user.name }) : undefined;
  return finishSignIn(req, res, { ...outcome.user, status: 'ACTIVE' }, outcome.s, message, input.next, outcome.readOnly);
}

// ---------- P-04 Change registered mobile number ----------
const ticketMinutes = () => settings.get('CFG-02');

export async function changeMobileSendCurrent(req: Request, auth: AuthContext) {
  return issueOtp(req, { mobile: auth.mobile, purpose: 'CHANGE_MOBILE', userId: auth.userId });
}

/** Step 2: current number verified → a ticket for the next step, bound to this session. */
export async function changeMobileVerifyCurrent(req: Request, auth: AuthContext, input: { challengeId: string; code: string }) {
  const ch = await checkOtp(req, { ...input, purpose: 'CHANGE_MOBILE', userId: auth.userId });
  const expiresAt = new Date(clock.now().getTime() + ticketMinutes() * 60_000);
  const ticketId = await db.transaction(async (tx) => {
    await consumeOtp(tx, ch.id);
    const [t] = await tx
      .insert(authTickets)
      .values({ userId: auth.userId, sessionId: auth.sessionId, kind: 'CHANGE_MOBILE_CURRENT_VERIFIED', expiresAt, createdAt: clock.now() })
      .returning({ id: authTickets.id });
    await audit(tx, req, { action: 'OTP_VERIFIED', entity: 'otp', entityId: ch.id, newValue: { mobile: maskMobile(ch.mobile), purpose: 'CHANGE_MOBILE' } });
    return t!.id;
  });
  return { ticketId, expiresAt: expiresAt.toISOString() };
}

async function openTicket(dbx: DbOrTx, auth: AuthContext, ticketId: string, kind: string) {
  if (!/^[0-9a-f-]{36}$/.test(ticketId)) return undefined;
  const [t] = await dbx
    .select()
    .from(authTickets)
    .where(
      and(
        eq(authTickets.id, ticketId),
        eq(authTickets.userId, auth.userId),
        eq(authTickets.sessionId, auth.sessionId),
        eq(authTickets.kind, kind),
        isNull(authTickets.usedAt),
        gt(authTickets.expiresAt, clock.now()),
      ),
    );
  return t;
}

export async function changeMobileSendNew(req: Request, auth: AuthContext, input: { ticketId: string; newMobile: string }) {
  const t = await openTicket(db, auth, input.ticketId, 'CHANGE_MOBILE_CURRENT_VERIFIED');
  if (!t) throw new AppError(409, 'GEN-04', { 'record type': 'mobile number change', 'current status': 'expired' }, [], { reason: 'state' });
  if (input.newMobile === auth.mobile) throw fieldError('newMobile', 'AUTH-24');
  const [other] = await db.select({ id: users.id }).from(users).where(eq(users.mobile, input.newMobile));
  if (other) throw fieldError('newMobile', 'AUTH-25');
  return issueOtp(req, { mobile: input.newMobile, purpose: 'CHANGE_MOBILE_NEW', userId: auth.userId, context: { ticketId: t.id } });
}

export async function changeMobileVerifyNew(req: Request, auth: AuthContext, input: { challengeId: string; code: string }) {
  const ch = await checkOtp(req, { ...input, purpose: 'CHANGE_MOBILE_NEW', userId: auth.userId });
  const ticketId = String((ch.context as { ticketId?: string } | null)?.ticketId ?? '');
  const oldMobile = auth.mobile;
  try {
    await db.transaction(async (tx) => {
      const t = await openTicket(tx, auth, ticketId, 'CHANGE_MOBILE_CURRENT_VERIFIED');
      if (!t) throw new AppError(409, 'GEN-04', { 'record type': 'mobile number change', 'current status': 'expired' }, [], { reason: 'state' });
      await consumeOtp(tx, ch.id);
      await tx.update(authTickets).set({ usedAt: clock.now() }).where(eq(authTickets.id, t.id));
      // The unique rule on mobile is the final check (GR-12): two users cannot take the same number
      await tx
        .update(users)
        .set({ mobile: ch.mobile, version: sql`${users.version} + 1` })
        .where(eq(users.id, auth.userId));
      const ended = await endAllSessions(tx, auth.userId, 'MOBILE_CHANGED', auth.sessionId);
      await audit(tx, req, { action: 'OTP_VERIFIED', entity: 'otp', entityId: ch.id, newValue: { mobile: maskMobile(ch.mobile), purpose: 'CHANGE_MOBILE_NEW' } });
      await audit(tx, req, {
        action: 'MOBILE_CHANGED',
        entity: 'user',
        entityId: auth.userId,
        oldValue: { mobile: maskMobile(oldMobile) },
        newValue: { mobile: maskMobile(ch.mobile), otherSessionsEnded: ended },
      });
    });
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') throw fieldError('newMobile', 'AUTH-25');
    if (err instanceof Error && 'cause' in err && (err.cause as { code?: string } | undefined)?.code === '23505') throw fieldError('newMobile', 'AUTH-25');
    throw err;
  }
  // Notice to the old number [TO CONFIRM DLT template]. The change is already saved; a failure here
  // never undoes it (GR-26).
  await sms.send({ kind: 'MOBILE_CHANGED', to: oldMobile, newMaskedMobile: maskMobile(ch.mobile) }).catch(() => undefined);
  return { mobile: ch.mobile, message: msg('AUTH-23', { 'masked new number': maskMobile(ch.mobile) }) };
}

// ---------- Step-up OTP (CFG-83, AUTH-26) ----------
export const STEP_UP_ACTIONS = ['PASSWORD', 'APPROVE', 'PUBLISH', 'PLAN_CHANGE', 'CONFIG_CHANGE', 'SUPPORT_GRANT', 'ADD_ASSISTANT', 'USER_CHANGE', 'ACCOUNT_STATUS', 'EXPORT', 'WALLET_CREDIT'] as const;
export type StepUpAction = (typeof STEP_UP_ACTIONS)[number];

export async function stepUpSend(req: Request, auth: AuthContext, action: StepUpAction) {
  const r = await issueOtp(req, { mobile: auth.mobile, purpose: 'STEP_UP', userId: auth.userId, context: { action } });
  return { ...r, prompt: msg('AUTH-26', { 'masked mobile': r.maskedMobile }) };
}

/** Correct code → a single-use token for that one action, valid for the OTP validity (CFG-02). */
export async function stepUpVerify(req: Request, auth: AuthContext, input: { challengeId: string; code: string }) {
  const ch = await checkOtp(req, { ...input, purpose: 'STEP_UP', userId: auth.userId });
  const action = (ch.context as { action?: string } | null)?.action ?? '';
  const expiresAt = new Date(clock.now().getTime() + ticketMinutes() * 60_000);
  const token = await db.transaction(async (tx) => {
    await consumeOtp(tx, ch.id);
    const [t] = await tx
      .insert(authTickets)
      .values({ userId: auth.userId, sessionId: auth.sessionId, kind: 'STEP_UP', data: { action }, expiresAt, createdAt: clock.now() })
      .returning({ id: authTickets.id });
    await audit(tx, req, { action: 'STEP_UP_VERIFIED', entity: 'otp', entityId: ch.id, newValue: { purpose: 'STEP_UP', action } });
    return t!.id;
  });
  return { stepUpToken: token, action, expiresAt: expiresAt.toISOString() };
}

/** Use up a step-up token for an action (inside the action's transaction). Refused → 403 AUTH-26. */
export async function consumeStepUp(tx: DbOrTx, auth: AuthContext, token: string | undefined, action: StepUpAction): Promise<string | null> {
  if (!settings.get('CFG-83')) return null;
  const t = token ? await openTicket(tx, auth, token, 'STEP_UP') : undefined;
  if (!t || (t.data as { action?: string } | null)?.action !== action) {
    throw forbidden('AUTH-26', { 'masked mobile': maskMobile(auth.mobile) });
  }
  const used = await tx
    .update(authTickets)
    .set({ usedAt: clock.now() })
    .where(and(eq(authTickets.id, t.id), isNull(authTickets.usedAt)))
    .returning({ id: authTickets.id });
  if (used.length === 0) throw forbidden('AUTH-26', { 'masked mobile': maskMobile(auth.mobile) });
  return t.id;
}

// ---------- Password (extra, asked by SkyUp; not in BPD v3.2). OTP login stays as it is. ----------
// Wrong passwords: CFG-03 tries, then that number's password login is locked for CFG-06 minutes
// (OTP login still works, so "Forgot password" = log in with OTP and set a new one).
const PWD_LOCK = 'PASSWORD';

export async function passwordLogin(req: Request, res: Response, input: { mobile: string; password: string; next?: unknown }): Promise<SignedIn> {
  await checkIpLimit(req);
  const [lk] = await db.select().from(otpLocks).where(and(eq(otpLocks.mobile, input.mobile), eq(otpLocks.purpose, PWD_LOCK), gt(otpLocks.lockedUntil, clock.now())));
  if (lk) throw tooMany('PWD-04', { time: formatIstTime(lk.lockedUntil) }, secondsUntil(lk.lockedUntil));
  const [user] = await db.select().from(users).where(eq(users.mobile, input.mobile));
  const ok = await checkPassword(input.password, user?.passwordHash); // same time whether or not the user exists
  if (!user) throw fieldError('mobile', 'AUTH-09');
  if (!user.passwordHash) throw fieldError('password', 'PWD-03');
  if (!ok) {
    const tries = settings.get('CFG-03');
    const h = await hit(`pw-fail:${input.mobile}`, settings.get('CFG-06') * 60);
    await audit(db, req, { action: 'LOGIN', entity: 'user', entityId: user.id, accountId: user.accountId, newValue: { method: 'PASSWORD', reason: 'PWD-02' }, result: 'FAILURE', actor: { userId: user.id, role: user.role } });
    if (h.count >= tries) {
      const lockedUntil = new Date(clock.now().getTime() + settings.get('CFG-06') * 60_000);
      await db.insert(otpLocks).values({ mobile: input.mobile, purpose: PWD_LOCK, lockedUntil, reason: 'WRONG_TRIES' })
        .onConflictDoUpdate({ target: [otpLocks.mobile, otpLocks.purpose], set: { lockedUntil, reason: 'WRONG_TRIES' } });
      throw tooMany('PWD-04', { time: formatIstTime(lockedUntil) }, secondsUntil(lockedUntil));
    }
    throw fieldError('password', 'PWD-02', { tries: tries - h.count });
  }
  const outcome = await db.transaction(async (tx) => {
    const [u] = await tx.select().from(users).where(eq(users.id, user.id)).for('update');
    if (!u || u.mobile !== input.mobile || !u.passwordHash) return { kind: 'GONE' as const };
    const [account] = u.accountId ? await tx.select().from(accounts).where(eq(accounts.id, u.accountId)) : [];
    const block = accessBlock(u, account ?? null);
    if (block) return { kind: 'BLOCKED' as const, user: u, error: block };
    const s = await signIn(tx, req, u);
    return { kind: 'OK' as const, user: u, s, readOnly: await readOnlyFor(tx, u.accountId) };
  });
  if (outcome.kind === 'GONE') throw fieldError('password', 'PWD-02', { tries: settings.get('CFG-03') });
  if (outcome.kind === 'BLOCKED') return loginFailed(req, outcome.user, outcome.error);
  return finishSignIn(req, res, { ...outcome.user, status: 'ACTIVE' }, outcome.s, undefined, input.next, outcome.readOnly);
}

export async function passwordStatus(auth: AuthContext) {
  const [u] = await db.select({ setAt: users.passwordSetAt, has: sql<boolean>`${users.passwordHash} is not null` }).from(users).where(eq(users.id, auth.userId));
  return { set: !!u?.has, setAt: u?.has ? (u.setAt?.toISOString() ?? null) : null };
}

/** The OTP check before setting or removing a password: always required (even when CFG-83 is off). */
async function usePasswordTicket(tx: DbOrTx, auth: AuthContext, token: string | undefined) {
  const t = token ? await openTicket(tx, auth, token, 'STEP_UP') : undefined;
  const fail = () => forbidden('AUTH-26', { 'masked mobile': maskMobile(auth.mobile) });
  if (!t || (t.data as { action?: string } | null)?.action !== 'PASSWORD') throw fail();
  const used = await tx.update(authTickets).set({ usedAt: clock.now() }).where(and(eq(authTickets.id, t.id), isNull(authTickets.usedAt))).returning({ id: authTickets.id });
  if (!used.length) throw fail();
}

export async function setPassword(req: Request, auth: AuthContext, input: { password: string; confirm: string; stepUpToken?: string }) {
  const problem = passwordProblem(input.password, auth.mobile);
  if (problem) throw fieldError('password', problem);
  if (input.password !== input.confirm) throw fieldError('confirm', 'PWD-09');
  const hash = await hashPassword(input.password);
  const had = await db.transaction(async (tx) => {
    await usePasswordTicket(tx, auth, input.stepUpToken);
    const [u] = await tx.select({ had: sql<boolean>`${users.passwordHash} is not null` }).from(users).where(eq(users.id, auth.userId)).for('update');
    await tx.update(users).set({ passwordHash: hash, passwordSetAt: clock.now() }).where(eq(users.id, auth.userId));
    // a changed password signs out every other device
    if (u?.had) await endAllSessions(tx, auth.userId, 'PASSWORD_CHANGED', auth.sessionId);
    await audit(tx, req, { action: u?.had ? 'PASSWORD_CHANGED' : 'PASSWORD_SET', entity: 'user', entityId: auth.userId, accountId: auth.accountId ?? null });
    return !!u?.had;
  });
  return { set: true, changed: had, message: msg('PWD-05') };
}

export async function removePassword(req: Request, auth: AuthContext, input: { stepUpToken?: string }) {
  await db.transaction(async (tx) => {
    await usePasswordTicket(tx, auth, input.stepUpToken);
    await tx.update(users).set({ passwordHash: null, passwordSetAt: null }).where(eq(users.id, auth.userId));
    await audit(tx, req, { action: 'PASSWORD_REMOVED', entity: 'user', entityId: auth.userId, accountId: auth.accountId ?? null });
  });
  return { set: false, message: msg('PWD-06') };
}
