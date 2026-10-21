// P-56 WhatsApp wallet: recharge through the gateway, a debit of CFG-162 for each automated WhatsApp
// message that reaches SENT (once per message, database rule), and ADM manual credits with a reason.
// The balance can never go below ₹0 (database rule).
import type { Request } from 'express';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { accounts, outgoingMessages, users, walletTransactions, wallets } from '../../db/schema.js';
import { clock, istToday } from '../../lib/clock.js';
import { AppError, fieldErrors, forbidden, notFound } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import { logger } from '../../lib/logger.js';
import { money } from '../../lib/money.js';
import { msg } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { currentSubscription, isPremium } from '../accounts/accounts.service.js';
import { consumeStepUp } from '../auth/auth.service.js';
import { registerBalanceCheck, registerCharger } from '../messages/messages.service.js';
import { notify } from '../notifications/notifications.service.js';
import { settings } from '../settings/settings.service.js';
import { createOrder, registerSettler } from './gateway.js';

async function balanceOf(accountId: string) {
  const [w] = await db.select().from(wallets).where(eq(wallets.accountId, accountId));
  return w?.balance ?? '0.00';
}

export async function walletView(auth: AuthContext, accountId = auth.accountId!) {
  const sub = await currentSubscription(db, accountId);
  const tx = await db.select().from(walletTransactions).where(eq(walletTransactions.accountId, accountId)).orderBy(desc(walletTransactions.createdAt)).limit(200);
  return {
    premium: isPremium(sub),
    message: isPremium(sub) ? null : msg('SUB-01'),
    balance: await balanceOf(accountId),
    pricePerMessage: settings.get('CFG-162'),
    minimumRecharge: settings.get('CFG-163'),
    lowBelow: settings.get('CFG-164'),
    transactions: tx.map((t) => ({ id: t.id, kind: t.kind, status: t.status, amount: t.amount, balanceAfter: t.balanceAfter, messageId: t.messageId, reason: t.reason, createdAt: t.createdAt.toISOString() })),
  };
}

export async function startRecharge(req: Request, auth: AuthContext, body: unknown) {
  if (auth.role !== 'ADV') throw forbidden();
  if (!isPremium(await currentSubscription(db, auth.accountId!))) throw new AppError(403, 'SUB-01');
  const v = F.parseFields(body, { amount: { label: 'Amount', required: true, rule: F.amount() } }) as { amount: string };
  if (money(v.amount) < money(String(settings.get('CFG-163')))) throw fieldErrors([{ field: 'amount', code: 'WAL-04' }]);
  const order = await createOrder(auth.accountId!, auth.userId, 'WALLET', v.amount, {});
  await db.insert(walletTransactions).values({ accountId: auth.accountId!, kind: 'RECHARGE', status: 'PENDING', amount: v.amount, orderId: order.orderId, by: auth.userId, createdAt: clock.now() });
  await audit(db, req, { action: 'WALLET_RECHARGE_STARTED', entity: 'wallet', entityId: auth.accountId!, newValue: { amount: v.amount } });
  return order;
}

registerSettler(
  'WALLET',
  async (o) => {
    await db.transaction(async (tx) => {
      const [w] = await tx.update(wallets).set({ balance: sql`${wallets.balance} + ${o.amount}`, version: sql`${wallets.version} + 1` }).where(eq(wallets.accountId, o.accountId)).returning();
      const rows = await tx.update(walletTransactions).set({ status: 'SUCCESS', balanceAfter: w!.balance, settledAt: clock.now() }).where(eq(walletTransactions.orderId, o.id)).returning();
      if (!rows.length) await tx.insert(walletTransactions).values({ accountId: o.accountId, kind: 'RECHARGE', status: 'SUCCESS', amount: o.amount, balanceAfter: w!.balance, orderId: o.id, createdAt: clock.now(), settledAt: clock.now() });
      const [adv] = await tx.select({ id: users.id }).from(users).where(and(eq(users.accountId, o.accountId), eq(users.role, 'ADV')));
      if (adv) await notify(tx, { userId: adv.id, accountId: o.accountId, messageId: 'WAL-01', params: { amount: F.groupIndian(o.amount), balance: F.groupIndian(w!.balance) }, link: { type: 'WALLET', id: o.accountId }, dedupeKey: `wal-recharge:${o.id}` });
      await audit(tx, null, { action: 'WALLET_RECHARGED', entity: 'wallet', entityId: o.accountId, accountId: o.accountId, newValue: { amount: o.amount, balance: w!.balance }, actor: { job: 'payment-gateway' } });
    });
  },
  async (o) => {
    await db.update(walletTransactions).set({ status: 'FAILED', settledAt: clock.now() }).where(and(eq(walletTransactions.orderId, o.id), eq(walletTransactions.status, 'PENDING')));
  },
);

// One debit per message that reached SENT; retries are never charged again (AC-P56-1)
registerCharger(async (m) => {
  const price = String(settings.get('CFG-162'));
  try {
    await db.transaction(async (tx) => {
      const [w] = await tx.update(wallets).set({ balance: sql`${wallets.balance} - ${price}`, version: sql`${wallets.version} + 1` }).where(and(eq(wallets.accountId, m.accountId), gte(wallets.balance, price))).returning();
      if (!w) return logger.warn({ message: m.id }, 'Wallet could not cover a sent message');
      await tx.insert(walletTransactions).values({ accountId: m.accountId, kind: 'DEBIT', status: 'SUCCESS', amount: price, balanceAfter: w.balance, messageId: m.id, reason: m.purpose, createdAt: clock.now(), settledAt: clock.now() });
      await tx.update(outgoingMessages).set({ charged: true }).where(eq(outgoingMessages.id, m.id));
      // SYS-15: WAL-02 once a day when the balance falls below CFG-164
      if (money(w.balance) < money(String(settings.get('CFG-164')))) {
        const [adv] = await tx.select({ id: users.id }).from(users).where(and(eq(users.accountId, m.accountId), eq(users.role, 'ADV')));
        if (adv) await notify(tx, { userId: adv.id, accountId: m.accountId, messageId: 'WAL-02', params: { balance: F.groupIndian(w.balance) }, link: { type: 'WALLET', id: m.accountId }, dedupeKey: `wal-low:${istToday()}` });
      }
    });
  } catch (err) {
    if ((err as { code?: string; cause?: { code?: string } })?.code === '23505' || (err as { cause?: { code?: string } })?.cause?.code === '23505') return; // already charged
    throw err;
  }
});
registerBalanceCheck(async (accountId) => money(await balanceOf(accountId)) >= money(String(settings.get('CFG-162'))));

/** Manual credit (ADM, extra OTP, reason required), shown on the advisor's statement. */
export async function manualCredit(req: Request, auth: AuthContext, accountId: string, body: unknown) {
  if (auth.role !== 'ADM') throw forbidden();
  const v = F.parseFields(body, { amount: { label: 'Amount', required: true, rule: F.amount() }, reason: { label: 'Reason', required: true, rule: F.notes } }) as { amount: string; reason: string };
  return db.transaction(async (tx) => {
    const [a] = await tx.select().from(accounts).where(eq(accounts.id, accountId));
    if (!a) throw notFound();
    const ticket = await consumeStepUp(tx, auth, req.get('x-step-up-token'), 'WALLET_CREDIT');
    const [w] = await tx.update(wallets).set({ balance: sql`${wallets.balance} + ${v.amount}`, version: sql`${wallets.version} + 1` }).where(eq(wallets.accountId, accountId)).returning();
    await tx.insert(walletTransactions).values({ accountId, kind: 'CREDIT', status: 'SUCCESS', amount: v.amount, balanceAfter: w!.balance, reason: v.reason, by: auth.userId, createdAt: clock.now(), settledAt: clock.now() });
    await audit(tx, req, { action: 'WALLET_MANUAL_CREDIT', entity: 'wallet', entityId: accountId, accountId, newValue: { amount: v.amount, reason: v.reason, ticket } });
    return { balance: w!.balance, message: msg('GEN-08', { 'Record type': 'Wallet credit' }) };
  });
}

