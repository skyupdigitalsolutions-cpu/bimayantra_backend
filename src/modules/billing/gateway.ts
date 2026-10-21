// Payment gateway for SkyUp's own charges: plans (P-47) and WhatsApp wallet recharges (P-56).
// Money is credited only from the gateway's signed notification, never from the browser (AC-P47-4, AC-P56-3);
// every notification is processed once by its payment ID.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import { env, isProduction } from '../../config/env.js';
import { db } from '../../db/client.js';
import { gatewayOrders, webhookEvents } from '../../db/schema.js';
import { clock } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

export type Order = typeof gatewayOrders.$inferSelect;
type Settler = (o: Order, paymentId: string) => Promise<void>;
type Failer = (o: Order) => Promise<void>;
const settlers = new Map<string, { paid: Settler; failed: Failer }>();
/** The wallet and subscription modules register what happens when their order is paid or fails. */
export const registerSettler = (purpose: string, paid: Settler, failed: Failer) => void settlers.set(purpose, { paid, failed });

export const gatewayAvailable = () => env.PAYMENT_GATEWAY !== 'none';

/** Create an order. Returns what the browser needs to open the gateway's page. */
export async function createOrder(accountId: string, userId: string, purpose: 'SUBSCRIPTION' | 'WALLET', amount: string, details: Record<string, unknown>) {
  if (!gatewayAvailable()) throw new AppError(503, 'SUB-18');
  const [o] = await db.insert(gatewayOrders).values({ accountId, purpose, amount, details, status: 'CREATED', createdBy: userId, createdAt: clock.now() }).returning();
  let gatewayOrderId: string;
  if (env.PAYMENT_GATEWAY === 'razorpay') {
    try {
      const r = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')}` },
        body: JSON.stringify({ amount: Math.round(Number(amount) * 100), currency: 'INR', receipt: o!.id }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await r.json()) as { id?: string };
      if (!r.ok || !body.id) throw new Error(`Razorpay ${r.status}`);
      gatewayOrderId = body.id;
    } catch (err) {
      logger.error({ err }, 'Gateway order failed');
      await db.update(gatewayOrders).set({ status: 'FAILED' }).where(eq(gatewayOrders.id, o!.id));
      throw new AppError(503, 'SUB-18');
    }
  } else gatewayOrderId = `test_${randomUUID()}`;
  await db.update(gatewayOrders).set({ gatewayOrderId }).where(eq(gatewayOrders.id, o!.id));
  return {
    orderId: o!.id,
    gateway: env.PAYMENT_GATEWAY,
    checkout: env.PAYMENT_GATEWAY === 'razorpay' ? { keyId: env.RAZORPAY_KEY_ID, gatewayOrderId, amountPaise: Math.round(Number(amount) * 100), currency: 'INR' } : { testUrl: `/pay/test?order=${o!.id}` },
  };
}

export function sign(raw: Buffer | string): string {
  return createHmac('sha256', env.PAYMENT_WEBHOOK_SECRET || env.JWT_ACCESS_SECRET).update(raw).digest('hex');
}
export function signatureOk(raw: Buffer | undefined, signature: string | undefined): boolean {
  if (!raw || !signature) return false;
  const a = Buffer.from(sign(raw));
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

type Event = { event: string; payload?: { payment?: { entity?: { id?: string; order_id?: string; amount?: number; status?: string } } } };

/** A signed gateway notification (Razorpay format: payment.captured / payment.failed). */
export async function processGatewayEvent(eventId: string, e: Event): Promise<void> {
  const p = e.payload?.payment?.entity;
  if (!p?.id || !p.order_id) return;
  const first = await db.insert(webhookEvents).values({ provider: 'gateway', eventId: `${eventId}:${p.id}:${e.event}` }).onConflictDoNothing().returning();
  if (!first.length) return; // repeat: acknowledged and ignored
  const [o] = await db.select().from(gatewayOrders).where(eq(gatewayOrders.gatewayOrderId, p.order_id));
  if (!o) return;
  const s = settlers.get(o.purpose);
  if (e.event === 'payment.captured') {
    if (Math.round(Number(o.amount) * 100) !== p.amount) {
      logger.error({ order: o.id, amount: p.amount }, 'Gateway amount does not match the order; not credited');
      return;
    }
    // A late success after a failure is still credited once (WAL-01 / SUB-14)
    const done = await db.update(gatewayOrders).set({ status: 'PAID', gatewayPaymentId: p.id, settledAt: clock.now() }).where(and(eq(gatewayOrders.id, o.id), ne(gatewayOrders.status, 'PAID'))).returning();
    if (done.length && s) await s.paid(done[0]!, p.id);
  } else if (e.event === 'payment.failed' && o.status === 'CREATED') {
    await db.update(gatewayOrders).set({ status: 'FAILED', settledAt: clock.now() }).where(eq(gatewayOrders.id, o.id));
    if (s) await s.failed(o);
  }
}

/** Development only: complete a test order as the gateway would (signed event built on the server). */
export async function completeTestOrder(orderId: string, outcome: 'success' | 'failure', accountId: string) {
  if (isProduction || env.PAYMENT_GATEWAY !== 'test') throw new AppError(404, 'GEN-11');
  const [o] = await db.select().from(gatewayOrders).where(and(eq(gatewayOrders.id, orderId), eq(gatewayOrders.accountId, accountId)));
  if (!o) throw new AppError(404, 'GEN-11');
  await processGatewayEvent(`test-${randomUUID()}`, { event: outcome === 'success' ? 'payment.captured' : 'payment.failed', payload: { payment: { entity: { id: `pay_${randomUUID()}`, order_id: o.gatewayOrderId!, amount: Math.round(Number(o.amount) * 100), status: outcome === 'success' ? 'captured' : 'failed' } } } });
}

export async function orderStatus(orderId: string, accountId: string) {
  const [o] = await db.select().from(gatewayOrders).where(and(eq(gatewayOrders.id, orderId), eq(gatewayOrders.accountId, accountId)));
  if (!o) throw new AppError(404, 'GEN-11');
  return o;
}
