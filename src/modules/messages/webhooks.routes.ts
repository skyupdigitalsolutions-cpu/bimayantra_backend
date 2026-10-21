// P-42 Delivery updates and opt-outs, and the payment gateway notification (P-47, P-56).
// Every webhook must carry a valid HMAC-SHA256 signature of the exact body; a forged call changes nothing
// and is logged as a security event (AC-P42-1). Events are processed once by their event ID.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { emailSuppressions, outgoingMessages, webhookEvents, whatsappNumbers } from '../../db/schema.js';
import { clock } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../audit/audit.js';
import { systemOptOut } from '../customers/consent.service.js';
import { processGatewayEvent, signatureOk } from '../billing/gateway.js';
import { readUnsubscribe } from './messages.service.js';
import { metaDecision } from './templates.service.js';

const ORDER = ['SENT', 'DELIVERED', 'READ'];

function verified(secret: string, raw: Buffer | undefined, sig: string | undefined): boolean {
  if (!secret || !raw || !sig) return false;
  const a = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'));
  const b = Buffer.from(sig.replace(/^sha256=/, ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

async function once(provider: string, eventId: string): Promise<boolean> {
  const r = await db.insert(webhookEvents).values({ provider, eventId }).onConflictDoNothing().returning();
  return r.length > 0;
}

/** Status only moves forward (SENT → DELIVERED → READ); FAILED stores the provider's error code. */
async function applyStatus(providerId: string, status: string, error?: string) {
  const [m] = await db.select().from(outgoingMessages).where(eq(outgoingMessages.providerId, providerId));
  if (!m) return;
  const now = clock.now();
  if (status === 'FAILED') {
    if (['SENT', 'STATUS_UNKNOWN'].includes(m.status)) await db.update(outgoingMessages).set({ status: 'FAILED', providerError: error ?? null, reason: error === 'NOT_ON_WHATSAPP' ? 'Not on WhatsApp' : 'Provider rejected', statusAt: now }).where(eq(outgoingMessages.id, m.id));
    return;
  }
  const from = ORDER.indexOf(m.status === 'STATUS_UNKNOWN' ? 'SENT' : m.status);
  const to = ORDER.indexOf(status);
  if (to <= from || from < 0) return; // an older update arriving late is ignored (AC-P42-2)
  await db.update(outgoingMessages).set({ status, statusAt: now, ...(status === 'DELIVERED' ? { deliveredAt: now } : { readAt: now }) }).where(eq(outgoingMessages.id, m.id));
}

export const webhooksRouter = Router();

webhooksRouter.post('/whatsapp', async (req, res) => {
  if (!verified(env.WHATSAPP_WEBHOOK_SECRET, req.rawBody, req.get('x-signature'))) {
    await audit(db, req, { action: 'WEBHOOK_REFUSED', entity: 'webhook', entityId: null, result: 'FAILURE', newValue: { provider: 'whatsapp' } });
    throw new AppError(401, 'GEN-03');
  }
  const b = req.body as { eventId?: string; type?: string; providerMessageId?: string; status?: string; error?: string; from?: string; to?: string; text?: string; button?: string; templateId?: string; approved?: boolean; reason?: string };
  if (!b.eventId || !(await once('whatsapp', b.eventId))) return res.json({ ok: true });
  if (b.type === 'status' && b.providerMessageId && b.status) await applyStatus(b.providerMessageId, b.status, b.error);
  if (b.type === 'template' && b.templateId) await metaDecision(b.templateId, b.approved === true, b.reason);
  if (b.type === 'reply' && b.from && b.to && (/^\s*stop\s*$/i.test(b.text ?? '') || b.button === 'Stop messages')) {
    // STOP: WhatsApp consent WITHDRAWN for every person of that account using this number (AC-P42-3)
    const [w] = await db.select().from(whatsappNumbers).where(eq(whatsappNumbers.number, b.to.startsWith('+') ? b.to : `+${b.to}`));
    if (w) {
      const from = b.from.startsWith('+') ? b.from : `+${b.from}`;
      const n = await systemOptOut(w.accountId, 'WHATSAPP', from);
      logger.info({ account: w.accountId, withdrawn: n }, 'WhatsApp opt-out processed');
    }
  }
  res.json({ ok: true });
});

webhooksRouter.post('/email', async (req, res) => {
  if (!verified(env.EMAIL_WEBHOOK_SECRET, req.rawBody, req.get('x-signature'))) {
    await audit(db, req, { action: 'WEBHOOK_REFUSED', entity: 'webhook', entityId: null, result: 'FAILURE', newValue: { provider: 'email' } });
    throw new AppError(401, 'GEN-03');
  }
  const b = req.body as { eventId?: string; type?: string; providerMessageId?: string; email?: string; bounceType?: string };
  if (!b.eventId || !(await once('email', b.eventId))) return res.json({ ok: true });
  if (b.type === 'delivered' && b.providerMessageId) await applyStatus(b.providerMessageId, 'DELIVERED');
  if (b.type === 'bounce' && b.email) {
    if (b.bounceType === 'hard') await db.insert(emailSuppressions).values({ email: b.email.toLowerCase(), reason: 'Hard bounce' }).onConflictDoNothing();
    if (b.providerMessageId) await applyStatus(b.providerMessageId, 'FAILED', 'BOUNCED');
  }
  if ((b.type === 'complaint' || b.type === 'unsubscribe') && b.email && b.providerMessageId) {
    const [m] = await db.select().from(outgoingMessages).where(eq(outgoingMessages.providerId, b.providerMessageId));
    if (m) await systemOptOut(m.accountId, 'EMAIL', b.email);
  }
  res.json({ ok: true });
});

webhooksRouter.post('/payments', async (req, res) => {
  const sig = req.get('x-razorpay-signature') ?? req.get('x-signature');
  if (!signatureOk(req.rawBody, sig)) {
    await audit(db, req, { action: 'WEBHOOK_REFUSED', entity: 'webhook', entityId: null, result: 'FAILURE', newValue: { provider: 'gateway' } });
    throw new AppError(401, 'GEN-03');
  }
  await processGatewayEvent(req.get('x-razorpay-event-id') ?? 'event', req.body as Parameters<typeof processGatewayEvent>[1]);
  res.json({ ok: true });
});

/** Email unsubscribe link (P-42 step 4): email consent WITHDRAWN for that address. */
export const unsubscribeRouter = Router();
unsubscribeRouter.post('/unsubscribe', async (req, res) => {
  const id = readUnsubscribe(typeof (req.body as { t?: unknown })?.t === 'string' ? (req.body as { t: string }).t : '');
  if (!id) throw new AppError(404, 'GEN-11');
  const [m] = await db.select().from(outgoingMessages).where(and(eq(outgoingMessages.id, id), inArray(outgoingMessages.channel, ['EMAIL'])));
  if (!m) throw new AppError(404, 'GEN-11');
  await systemOptOut(m.accountId, 'EMAIL', m.recipient);
  res.json({ ok: true, text: 'You will not receive further emails from your advisor through Bimayantra.' });
});
