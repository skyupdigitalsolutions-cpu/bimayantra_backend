// P-03 sessions. Secure HttpOnly cookies: a short-lived access token (bm_at) and a rotating refresh
// token (bm_rt). Every request also re-checks the session, user and account in the database, so ending
// a session, disabling a user or suspending an account takes effect on the very next request.
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { SignJWT, jwtVerify } from 'jose';
import { UAParser } from 'ua-parser-js';
import { cookieSecure, env } from '../../config/env.js';
import { TECHNICAL } from '../../config/technical.js';
import { db, type DbOrTx } from '../../db/client.js';
import { sessions } from '../../db/schema.js';
import { clock } from '../../lib/clock.js';
import { hashToken, randomToken, safeEqual } from '../../lib/crypto.js';
import { settings } from '../settings/settings.service.js';

export const ACCESS_COOKIE = 'bm_at';
export const REFRESH_COOKIE = 'bm_rt';

export type EndReason =
  | 'LOGOUT'
  | 'IDLE'
  | 'MAX_AGE'
  | 'REPLACED'
  | 'ENDED_BY_USER'
  | 'USER_DISABLED'
  | 'ACCOUNT_SUSPENDED'
  | 'ACCOUNT_CLOSED'
  | 'MOBILE_CHANGED'
  | 'ROLE_CHANGED'
  | 'REFRESH_REUSED'
  | 'PASSWORD_CHANGED';

const jwtKey = new TextEncoder().encode(env.JWT_ACCESS_SECRET);

/** "Chrome on Android" (P-03: device names come from the browser and may be general). */
export function deviceName(userAgent: string | undefined): string {
  if (!userAgent) return 'Unknown device';
  const ua = new UAParser(userAgent).getResult();
  const browser = (ua.browser.name ?? 'Browser').replace(/^Mobile /, '');
  const os = ua.os.name ?? 'unknown system';
  return `${browser} on ${os}`;
}

/**
 * Start a session for a user. Call inside the sign-in transaction, after locking the user row.
 * Beyond CFG-09 active sessions the oldest one ends (REPLACED → that device sees AUTH-17).
 */
export async function createSession(tx: DbOrTx, userId: string, req: Request): Promise<{ sessionId: string; refreshToken: string }> {
  const now = clock.now();
  const active = await tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.endedAt)))
    .orderBy(asc(sessions.createdAt));
  const limit = settings.get('CFG-09');
  const toEnd = active.slice(0, Math.max(0, active.length - limit + 1));
  for (const s of toEnd) await endSession(tx, s.id, 'REPLACED');

  const sessionId = randomUUID();
  const refreshToken = randomToken();
  await tx.insert(sessions).values({
    id: sessionId,
    userId,
    refreshHash: hashToken(refreshToken),
    deviceName: deviceName(req.get('user-agent')),
    userAgent: req.get('user-agent')?.slice(0, 500) ?? null,
    ip: req.ip ?? null,
    createdAt: now,
    lastActiveAt: now,
  });
  return { sessionId, refreshToken };
}

export async function endSession(dbx: DbOrTx, sessionId: string, reason: EndReason): Promise<boolean> {
  const rows = await dbx
    .update(sessions)
    .set({ endedAt: clock.now(), endReason: reason })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.endedAt)))
    .returning({ id: sessions.id });
  return rows.length > 0;
}

/** Disabling a user, suspending an account, changing a role or the mobile ends all (other) sessions. */
export async function endAllSessions(dbx: DbOrTx, userId: string, reason: EndReason, exceptSessionId?: string): Promise<number> {
  const rows = await dbx
    .update(sessions)
    .set({ endedAt: clock.now(), endReason: reason })
    .where(and(eq(sessions.userId, userId), isNull(sessions.endedAt), exceptSessionId ? ne(sessions.id, exceptSessionId) : sql`true`))
    .returning({ id: sessions.id });
  return rows.length;
}

/** New refresh token; the previous one stays valid for a few seconds (parallel tabs). */
export async function rotateRefresh(dbx: DbOrTx, sessionId: string): Promise<string> {
  const refreshToken = randomToken();
  await dbx
    .update(sessions)
    .set({ prevRefreshHash: sql`${sessions.refreshHash}`, refreshHash: hashToken(refreshToken), refreshRotatedAt: clock.now() })
    .where(eq(sessions.id, sessionId));
  return refreshToken;
}

export type RefreshCheck = 'CURRENT' | 'PREVIOUS_IN_GRACE' | 'INVALID';
export function checkRefresh(row: { refreshHash: string; prevRefreshHash: string | null; refreshRotatedAt: Date | null }, token: string): RefreshCheck {
  const h = hashToken(token);
  if (safeEqual(h, row.refreshHash)) return 'CURRENT';
  if (row.prevRefreshHash && row.refreshRotatedAt && safeEqual(h, row.prevRefreshHash)) {
    const age = clock.now().getTime() - row.refreshRotatedAt.getTime();
    if (age <= TECHNICAL.refreshGraceSeconds * 1000) return 'PREVIOUS_IN_GRACE';
  }
  return 'INVALID';
}

export async function signAccess(userId: string, sessionId: string): Promise<string> {
  const now = Math.floor(clock.now().getTime() / 1000);
  return new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt(now)
    .setExpirationTime(now + TECHNICAL.accessTokenSeconds)
    .sign(jwtKey);
}

export async function verifyAccess(token: string): Promise<{ userId: string; sessionId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, jwtKey, { algorithms: ['HS256'], currentDate: clock.now() });
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
    return { userId: payload.sub, sessionId: payload.sid };
  } catch {
    return null;
  }
}

const cookieBase = () => ({ httpOnly: true, secure: cookieSecure, sameSite: env.COOKIE_SAMESITE, path: '/' }) as const;

export async function setSessionCookies(res: Response, userId: string, sessionId: string, refreshToken?: string): Promise<void> {
  res.cookie(ACCESS_COOKIE, await signAccess(userId, sessionId), { ...cookieBase(), maxAge: TECHNICAL.accessTokenSeconds * 1000 });
  if (refreshToken) res.cookie(REFRESH_COOKIE, `${sessionId}.${refreshToken}`, { ...cookieBase(), maxAge: settings.get('CFG-08') * 3600 * 1000 });
}

/**
 * The mobile app (header X-Client: mobile) cannot use browser cookies: it receives the tokens in the
 * response headers X-Access-Token and X-Refresh-Token and keeps them in the phone's secure storage.
 * Same session rules either way (CFG-07, CFG-08, CFG-09). Tokens are never put in a response body, so
 * they are never saved with an idempotent result.
 */
export const isMobileClient = (req: Request) => req.get('x-client') === 'mobile';

export async function deliverSession(req: Request, res: Response, userId: string, sessionId: string, refreshToken?: string): Promise<void> {
  if (!isMobileClient(req)) return setSessionCookies(res, userId, sessionId, refreshToken);
  res.setHeader('x-access-token', await signAccess(userId, sessionId));
  res.setHeader('x-access-expires-in', String(TECHNICAL.accessTokenSeconds));
  if (refreshToken) res.setHeader('x-refresh-token', `${sessionId}.${refreshToken}`);
}

export function clearSession(req: Request, res: Response): void {
  if (!isMobileClient(req)) clearSessionCookies(res);
}

export function clearSessionCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, cookieBase());
  res.clearCookie(REFRESH_COOKIE, cookieBase());
}

export function parseRefreshCookie(value: unknown): { sessionId: string; token: string } | null {
  if (typeof value !== 'string') return null;
  const m = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,})$/.exec(value);
  return m ? { sessionId: m[1]!, token: m[2]! } : null;
}

export async function listActiveSessions(userId: string) {
  return db
    .select({ id: sessions.id, deviceName: sessions.deviceName, createdAt: sessions.createdAt, lastActiveAt: sessions.lastActiveAt })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.endedAt)))
    .orderBy(sql`${sessions.lastActiveAt} desc`);
}
