// Health checks, GR-17 Check status, NFR-13 test clock (non-production only), and the public settings
// the website needs (OTP length, resend wait, idle warning) so the browser never hard-codes them.
import { Router } from 'express';
import { env, isProduction } from '../../config/env.js';
import { db, pingDb } from '../../db/client.js';
import { testClock } from '../../db/schema.js';
import { authenticate, requireRole } from '../../http/auth.js';
import { checkStatus } from '../../http/idempotency.js';
import { clock } from '../../lib/clock.js';
import { fieldError } from '../../lib/errors.js';
import { audit } from '../audit/audit.js';
import { settings } from '../settings/settings.service.js';

export const systemRouter = Router();

systemRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

systemRouter.get('/ready', async (_req, res) => {
  const ok = await pingDb();
  res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'database unavailable' });
});

export const apiSystemRouter = Router();

apiSystemRouter.get('/requests/:key', authenticate({ required: false, touch: false }), checkStatus);

apiSystemRouter.get('/public-settings', (_req, res) => {
  res.json({
    otpLength: settings.get('CFG-01'),
    otpValidityMinutes: settings.get('CFG-02'),
    resendWaitSeconds: settings.get('CFG-04'),
    idleMinutes: settings.get('CFG-07'),
    idleWarningMinutes: settings.get('CFG-123'),
    spinnerAfterMs: settings.get('CFG-19'),
    stillWorkingAfterSeconds: settings.get('CFG-20'),
    requestTimeoutSeconds: settings.get('CFG-21'),
    trialDays: settings.get('CFG-78'),
    toastSeconds: settings.get('CFG-22'),
    notesMax: settings.get('CFG-13'),
    paymentConfirmMinutes: settings.get('CFG-180'),
    termsVersion: env.TERMS_VERSION,
    supportEmail: env.SUPPORT_EMAIL,
  });
});

/** Load the saved test-clock offset at start-up (only when the test clock is enabled). */
export async function loadTestClock(): Promise<void> {
  if (isProduction || !env.TEST_CLOCK_ENABLED) return;
  const [row] = await db.select().from(testClock);
  if (row) clock.setOffset(row.offsetMs);
}

if (!isProduction && env.TEST_CLOCK_ENABLED) {
  apiSystemRouter.get('/test/clock', authenticate(), requireRole('ADM'), (_req, res) => {
    res.json({ now: clock.now().toISOString(), offsetMs: clock.offset() });
  });
  apiSystemRouter.post('/test/clock', authenticate(), requireRole('ADM'), async (req, res) => {
    const minutes = (req.body as { offsetMinutes?: unknown } | undefined)?.offsetMinutes;
    if (typeof minutes !== 'number' || !Number.isFinite(minutes)) throw fieldError('offsetMinutes', 'GEN-01', { 'Field label': 'Offset minutes' });
    const offsetMs = Math.round(minutes * 60_000);
    clock.setOffset(offsetMs);
    await db.insert(testClock).values({ id: 1, offsetMs }).onConflictDoUpdate({ target: testClock.id, set: { offsetMs } });
    await audit(db, req, { action: 'TEST_CLOCK_SET', entity: 'test_clock', newValue: { offsetMs } });
    res.json({ now: clock.now().toISOString(), offsetMs });
  });
}
