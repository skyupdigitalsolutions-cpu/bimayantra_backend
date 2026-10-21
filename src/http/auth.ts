// Session check on every request (P-02 backend rules, P-03): session → idle (CFG-07) → longest
// session (CFG-08) → account status → user status. Then CFG-99 per-user request limit.
import type { Request, RequestHandler, Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { accounts, sessions, subscriptions, users } from '../db/schema.js';
import { clock, formatDate, istToday } from '../lib/clock.js';
import { AppError, forbidden, tooMany, unauthorized } from '../lib/errors.js';
import { hit, secondsUntil } from '../modules/ratelimit/ratelimit.js';
import { settings } from '../modules/settings/settings.service.js';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  checkRefresh,
  clearSession,
  deliverSession,
  endAllSessions,
  isMobileClient,
  endSession,
  parseRefreshCookie,
  rotateRefresh,
  verifyAccess,
} from '../modules/auth/sessions.service.js';
import type { AuthContext, Role } from '../types/express.js';

type Options = { required?: boolean; touch?: boolean };

/** Message for a request whose session has ended, by the reason it ended. */
function endedError(reason: string | null): AppError {
  if (reason === 'REPLACED') return unauthorized('AUTH-17', 'replaced');
  if (reason === 'IDLE') return unauthorized('AUTH-18', 'idle');
  return unauthorized('GEN-09', reason?.toLowerCase() ?? 'ended');
}

async function loadSession(sessionId: string) {
  const [row] = await db
    .select({ session: sessions, user: users, account: accounts })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .leftJoin(accounts, eq(accounts.id, users.accountId))
    .where(eq(sessions.id, sessionId));
  return row;
}

async function isReadOnly(accountId: string | null): Promise<boolean> {
  if (!accountId) return false;
  const [sub] = await db
    .select({ status: subscriptions.status })
    .from(subscriptions)
    .where(and(eq(subscriptions.accountId, accountId), eq(subscriptions.isCurrent, true)));
  return sub?.status === 'EXPIRED';
}

/** Messages for a user who may not have a session (P-02 failure table). Shared with sign-in. */
export function accessBlock(user: { role: string; status: string; invitedAt: Date | null }, account: { status: string; closedAt: Date | null } | null): AppError | null {
  if (account?.status === 'SUSPENDED') return new AppError(403, 'AUTH-10', { 'support email': env.SUPPORT_EMAIL });
  if (account?.status === 'CLOSED') {
    const closed = account.closedAt ? formatDate(istToday(account.closedAt)) : '';
    return new AppError(403, 'AUTH-14', { date: closed, 'support email': env.SUPPORT_EMAIL });
  }
  if (user.status === 'DISABLED') return new AppError(403, user.role === 'STF' || user.role === 'ADM' ? 'AUTH-19' : 'AUTH-11');
  if (user.status === 'INVITED' && user.role === 'REF' && user.invitedAt) {
    const validUntil = user.invitedAt.getTime() + settings.get('CFG-122') * 86_400_000;
    if (clock.now().getTime() > validUntil) return new AppError(403, 'AUTH-20');
  }
  return null;
}

/** The access token: Authorization: Bearer … (mobile app) or the bm_at cookie (website). */
export function accessTokenOf(req: Request): string | undefined {
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '')?.[1];
  if (bearer) return bearer;
  const c = ((req.cookies ?? {}) as Record<string, unknown>)[ACCESS_COOKIE];
  return typeof c === 'string' ? c : undefined;
}

/**
 * `explicitRefresh`: a refresh token sent by the mobile app to POST /auth/refresh. The website's refresh
 * token is the bm_rt cookie and is used automatically when the access token has expired.
 */
export async function resolve(req: Request, res: Response, touch: boolean, explicitRefresh?: string): Promise<AuthContext | null> {
  const cookies = (req.cookies ?? {}) as Record<string, unknown>;
  const mobile = isMobileClient(req);
  const rawAccess = explicitRefresh ? undefined : accessTokenOf(req);
  const access = rawAccess ? await verifyAccess(rawAccess) : null;
  // The app refreshes on its own: an expired access token gets 401 so it calls POST /auth/refresh
  if (mobile && rawAccess && !access) throw unauthorized('GEN-09', 'access_expired');
  const refresh = access ? null : parseRefreshCookie(explicitRefresh ?? (mobile ? undefined : cookies[REFRESH_COOKIE]));
  const sessionId = access?.sessionId ?? refresh?.sessionId;
  if (!sessionId) return null;

  const row = await loadSession(sessionId);
  if (!row) {
    clearSession(req, res);
    throw unauthorized('GEN-09', 'unknown');
  }
  const { session, user, account } = row;
  const fail = (e: AppError) => {
    clearSession(req, res);
    return e;
  };
  if (session.endedAt) throw fail(endedError(session.endReason));

  const now = clock.now().getTime();
  if (now - session.lastActiveAt.getTime() > settings.get('CFG-07') * 60_000) {
    await endSession(db, session.id, 'IDLE');
    throw fail(unauthorized('AUTH-18', 'idle'));
  }
  if (now - session.createdAt.getTime() > settings.get('CFG-08') * 3_600_000) {
    await endSession(db, session.id, 'MAX_AGE');
    throw fail(unauthorized('GEN-09', 'max_age'));
  }

  if (refresh) {
    const check = checkRefresh(session, refresh.token);
    if (check === 'INVALID') {
      // An old refresh token used again: treat as stolen and end the session
      await endSession(db, session.id, 'REFRESH_REUSED');
      throw fail(unauthorized('GEN-09', 'refresh_reused'));
    }
    const newRefresh = check === 'CURRENT' ? await rotateRefresh(db, session.id) : undefined;
    await deliverSession(req, res, user.id, session.id, newRefresh);
  }

  // Account and user status are re-checked on every request
  const block = accessBlock(user, account);
  if (block || user.status !== 'ACTIVE') {
    const reason = account?.status === 'SUSPENDED' ? 'ACCOUNT_SUSPENDED' : account?.status === 'CLOSED' ? 'ACCOUNT_CLOSED' : 'USER_DISABLED';
    await endAllSessions(db, user.id, reason);
    const e = block ?? unauthorized('GEN-09', 'user_status');
    throw fail(new AppError(401, e.code, e.params, [], { reason: reason.toLowerCase() }));
  }

  const limit = await hit(`user:${user.id}`, 60);
  if (limit.count > settings.get('CFG-99')) {
    const seconds = secondsUntil(limit.windowEndsAt);
    throw tooMany('GEN-15', { seconds }, seconds);
  }

  if (touch) await db.update(sessions).set({ lastActiveAt: clock.now() }).where(eq(sessions.id, session.id));

  return {
    userId: user.id,
    sessionId: session.id,
    role: user.role as Role,
    accountId: user.accountId,
    name: user.name,
    mobile: user.mobile,
    readOnly: await isReadOnly(user.accountId),
  };
}

/** Sets req.auth. `required` (default) → 401 GEN-09 when not signed in. `touch: false` does not reset the idle timer. */
export function authenticate(opts: Options = {}): RequestHandler {
  const required = opts.required ?? true;
  const touch = opts.touch ?? true;
  return async (req, res, next) => {
    const ctx = await resolve(req, res, touch);
    if (!ctx && required) throw unauthorized('GEN-09', 'not_signed_in');
    if (ctx) req.auth = ctx;
    next();
  };
}

export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) throw forbidden();
    next();
  };
}

/** GR-33: blocked in read-only mode (create, edit, send). */
export const requireWritable: RequestHandler = (req, _res, next) => {
  if (req.auth?.readOnly) throw forbidden('SUB-03');
  next();
};
