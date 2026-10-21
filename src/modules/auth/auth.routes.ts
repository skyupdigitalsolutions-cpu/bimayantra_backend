// /api/v1/auth — P-01 to P-04 and step-up OTP.
import { Router } from 'express';
import { accessTokenOf, authenticate, resolve } from '../../http/auth.js';
import { idempotent } from '../../http/idempotency.js';
import { clock, istToday } from '../../lib/clock.js';
import { notFound, unauthorized } from '../../lib/errors.js';
import { mobile, otp, parseFields, personName } from '../../lib/fields.js';
import { msg } from '../../messages/messages.js';
import { audit } from '../audit/audit.js';
import { db } from '../../db/client.js';
import { settings } from '../settings/settings.service.js';
import * as auth from './auth.service.js';
import { accountName } from '../dashboard/dashboard.service.js';
import { cancelOtp } from './otp.service.js';
import { REFRESH_COOKIE, clearSession, endSession, isMobileClient, listActiveSessions, parseRefreshCookie, verifyAccess } from './sessions.service.js';
import { sessions, subscriptions } from '../../db/schema.js';
import { and, eq } from 'drizzle-orm';

export const authRouter = Router();

const otpFields = {
  challengeId: { label: 'Code request', required: true },
  code: { label: 'OTP', required: true, rule: otp },
};
type OtpInput = { challengeId: string; code: string };

// ---- P-01 ----
authRouter.post('/register/send-otp', idempotent('auth.register.send'), async (req, res) => {
  const f = parseFields(req.body, {
    name: { label: 'Full name', required: true, rule: personName },
    mobile: { label: 'Mobile number', required: true, rule: mobile },
    termsAccepted: { label: 'Terms', checkbox: true },
  }) as { name: string; mobile: string };
  res.json(await auth.registerSendOtp(req, f));
});

authRouter.post('/register/verify', idempotent('auth.register.verify', { required: true, onReplay: auth.restoreSignIn }), async (req, res) => {
  const f = parseFields(req.body, otpFields) as OtpInput;
  res.json(await auth.registerVerify(req, res, { ...f, next: (req.body as { next?: unknown }).next }));
});

// ---- P-02 ----
authRouter.post('/login/send-otp', idempotent('auth.login.send'), async (req, res) => {
  const f = parseFields(req.body, { mobile: { label: 'Mobile number', required: true, rule: mobile } }) as { mobile: string };
  res.json(await auth.loginSendOtp(req, f));
});

authRouter.post('/login/verify', idempotent('auth.login.verify', { onReplay: auth.restoreSignIn }), async (req, res) => {
  const f = parseFields(req.body, otpFields) as OtpInput;
  res.json(await auth.loginVerify(req, res, { ...f, next: (req.body as { next?: unknown }).next }));
});

// ---- Password login (extra) ----
authRouter.post('/login/password', idempotent('auth.login.password', { onReplay: auth.restoreSignIn }), async (req, res) => {
  const f = parseFields(req.body, {
    mobile: { label: 'Mobile number', required: true, rule: mobile },
    password: { label: 'Password', required: true },
  }) as { mobile: string; password: string };
  res.json(await auth.passwordLogin(req, res, { ...f, next: (req.body as { next?: unknown }).next }));
});

authRouter.get('/password', authenticate(), async (req, res) => {
  res.json(await auth.passwordStatus(req.auth!));
});

authRouter.post('/password', authenticate(), async (req, res) => {
  const f = parseFields(req.body, { password: { label: 'New password', required: true }, confirm: { label: 'Type it again', required: true } }) as { password: string; confirm: string };
  res.json(await auth.setPassword(req, req.auth!, { ...f, stepUpToken: req.get('X-Step-Up-Token') ?? undefined }));
});

authRouter.post('/password/remove', authenticate(), async (req, res) => {
  res.json(await auth.removePassword(req, req.auth!, { stepUpToken: req.get('X-Step-Up-Token') ?? undefined }));
});

/** "Change number" link on the OTP step: the open challenge is cancelled (REPLACED). */
authRouter.post('/otp/cancel', async (req, res) => {
  const id = (req.body as { challengeId?: unknown } | undefined)?.challengeId;
  if (typeof id === 'string') await cancelOtp(id);
  res.json({ cancelled: true });
});

// ---- P-03 ----
/** Who is signed in, and where they belong. Opening the login page while signed in goes straight home. */
authRouter.get('/me', authenticate(), async (req, res) => {
  const a = req.auth!;
  const [sub] = a.accountId
    ? await db
        .select({ status: subscriptions.status, plan: subscriptions.plan, periodStart: subscriptions.periodStart, periodEnd: subscriptions.periodEnd })
        .from(subscriptions)
        .where(and(eq(subscriptions.accountId, a.accountId), eq(subscriptions.isCurrent, true)))
    : [];
  res.json({
    user: { id: a.userId, name: a.name, role: a.role, mobile: a.mobile, accountId: a.accountId },
    // P-53: an assistant sees the advisor's business name in the header
    accountName: a.accountId ? await accountName(a.accountId) : null,
    subscription: sub
      ? { ...sub, daysLeft: Math.max(0, Math.round((Date.parse(sub.periodEnd) - Date.parse(istToday())) / 86_400_000) + 1) }
      : null,
    home: auth.HOME[a.role],
    readOnly: a.readOnly,
    ...(a.readOnly ? { banner: msg('SUB-03') } : {}),
  });
});

/** Idle timer for the warning dialog (AUTH-21). Does not count as activity. */
authRouter.get('/session', authenticate({ touch: false }), async (req, res) => {
  const [s] = await db.select().from(sessions).where(eq(sessions.id, req.auth!.sessionId));
  const idleMs = settings.get('CFG-07') * 60_000;
  const idleEndsAt = new Date(s!.lastActiveAt.getTime() + idleMs);
  const maxEndsAt = new Date(s!.createdAt.getTime() + settings.get('CFG-08') * 3_600_000);
  const endsAt = idleEndsAt < maxEndsAt ? idleEndsAt : maxEndsAt;
  res.json({
    serverNow: clock.now().toISOString(),
    idleEndsAt: idleEndsAt.toISOString(),
    maxEndsAt: maxEndsAt.toISOString(),
    warnAt: new Date(endsAt.getTime() - settings.get('CFG-123') * 60_000).toISOString(),
    warning: msg('AUTH-21'),
  });
});

/** "Stay signed in": any request resets the idle timer; this one does nothing else. */
authRouter.post('/keep-alive', authenticate(), (_req, res) => {
  res.json({ ok: true });
});

/** Log out. Works even when the session already ended (the browser is cleared either way). */
authRouter.post('/logout', async (req, res) => {
  const cookies = (req.cookies ?? {}) as Record<string, unknown>;
  const raw = accessTokenOf(req);
  const access = raw ? await verifyAccess(raw) : null;
  const bodyRefresh = (req.body as { refreshToken?: unknown } | undefined)?.refreshToken;
  const sessionId = access?.sessionId ?? parseRefreshCookie(isMobileClient(req) ? bodyRefresh : cookies[REFRESH_COOKIE])?.sessionId;
  if (sessionId) {
    const ended = await endSession(db, sessionId, 'LOGOUT');
    if (ended) await audit(db, req, { action: 'LOGOUT', entity: 'session', entityId: sessionId, actor: access ? { userId: access.userId } : {} });
  }
  clearSession(req, res);
  res.json({ message: msg('AUTH-16') });
});

/**
 * Mobile app only: a new access token (and a rotated refresh token) in the response headers.
 * Not activity: it does not reset the idle timer. Every session rule is checked as on any request.
 */
authRouter.post('/refresh', async (req, res) => {
  const token = (req.body as { refreshToken?: unknown } | undefined)?.refreshToken;
  if (!isMobileClient(req) || typeof token !== 'string') throw unauthorized('GEN-09', 'not_signed_in');
  const ctx = await resolve(req, res, false, token);
  if (!ctx) throw unauthorized('GEN-09', 'not_signed_in');
  res.json({ ok: true });
});

authRouter.get('/sessions', authenticate(), async (req, res) => {
  const list = await listActiveSessions(req.auth!.userId);
  res.json({
    items: list.map((s) => ({
      id: s.id,
      device: s.deviceName,
      firstSignIn: s.createdAt.toISOString(),
      lastActive: s.lastActiveAt.toISOString(),
      thisDevice: s.id === req.auth!.sessionId,
    })),
  });
});

/** End another session (AUTH-22). Ending one that already ended does nothing and shows AUTH-22. */
authRouter.post('/sessions/:id/end', authenticate(), async (req, res) => {
  const id = String(req.params.id);
  const a = req.auth!;
  const [s] = /^[0-9a-f-]{36}$/.test(id)
    ? await db.select().from(sessions).where(and(eq(sessions.id, id), eq(sessions.userId, a.userId)))
    : [];
  if (!s) throw notFound();
  const ended = await endSession(db, id, id === a.sessionId ? 'LOGOUT' : 'ENDED_BY_USER');
  if (ended) await audit(db, req, { action: 'SESSION_ENDED', entity: 'session', entityId: id, newValue: { device: s.deviceName } });
  if (id === a.sessionId) clearSession(req, res);
  res.json({ message: msg('AUTH-22', { device: s.deviceName }), thisDevice: id === a.sessionId });
});

// ---- P-04 ----
authRouter.post('/mobile/send-current-otp', authenticate(), idempotent('auth.mobile.sendCurrent'), async (req, res) => {
  res.json(await auth.changeMobileSendCurrent(req, req.auth!));
});

authRouter.post('/mobile/verify-current', authenticate(), idempotent('auth.mobile.verifyCurrent'), async (req, res) => {
  const f = parseFields(req.body, otpFields) as OtpInput;
  res.json(await auth.changeMobileVerifyCurrent(req, req.auth!, f));
});

authRouter.post('/mobile/send-new-otp', authenticate(), idempotent('auth.mobile.sendNew'), async (req, res) => {
  const f = parseFields(req.body, {
    ticketId: { label: 'Current number check', required: true },
    newMobile: { label: 'New mobile number', required: true, rule: mobile },
  }) as { ticketId: string; newMobile: string };
  res.json(await auth.changeMobileSendNew(req, req.auth!, f));
});

authRouter.post('/mobile/verify-new', authenticate(), idempotent('auth.mobile.verifyNew', { required: true }), async (req, res) => {
  const f = parseFields(req.body, otpFields) as OtpInput;
  res.json(await auth.changeMobileVerifyNew(req, req.auth!, f));
});

// ---- Step-up OTP ----
authRouter.post('/step-up/send-otp', authenticate(), async (req, res) => {
  const f = parseFields(req.body, { action: { label: 'Action', required: true, oneOf: auth.STEP_UP_ACTIONS } }) as { action: auth.StepUpAction };
  res.json(await auth.stepUpSend(req, req.auth!, f.action));
});

authRouter.post('/step-up/verify', authenticate(), async (req, res) => {
  const f = parseFields(req.body, otpFields) as OtpInput;
  res.json(await auth.stepUpVerify(req, req.auth!, f));
});
