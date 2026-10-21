// P-01 step 5a: everything a new advisor gets, created in ONE transaction (pass the transaction handle).
// Account ACTIVE; user ADV ACTIVE; empty advisor profile (KYC NOT_SUBMITTED); TRIAL subscription with no
// plan for CFG-78 days (features CFG-173); WhatsApp wallet at ₹0; default lead pipelines (CFG-169).
import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { accounts, advisorKyc, advisorProfiles, pipelines, subscriptions, users, wallets } from '../../db/schema.js';
import { addDays, clock, istToday } from '../../lib/clock.js';
import { recalc } from '../profile/profile.service.js';
import { settings } from '../settings/settings.service.js';

export type NewAdvisor = { name: string; mobile: string; termsVersion: string; termsAcceptedAt: Date };

export async function createAdvisorAccount(tx: DbOrTx, input: NewAdvisor) {
  const now = clock.now();
  const [account] = await tx.insert(accounts).values({ status: 'ACTIVE', createdAt: now }).returning();
  const accountId = account!.id;
  const [user] = await tx
    .insert(users)
    .values({
      accountId,
      role: 'ADV',
      name: input.name,
      mobile: input.mobile,
      status: 'ACTIVE',
      activatedAt: now,
      termsVersion: input.termsVersion,
      termsAcceptedAt: input.termsAcceptedAt,
      createdAt: now,
    })
    .returning();
  await tx.insert(advisorProfiles).values({ accountId, fullName: input.name, createdAt: now });
  await tx.insert(advisorKyc).values({ accountId });

  // The trial covers CFG-78 calendar days starting today (IST); periodEnd is the last trial day
  const start = istToday(now);
  await tx.insert(subscriptions).values({
    accountId,
    plan: null,
    status: 'TRIAL',
    periodStart: start,
    periodEnd: addDays(start, settings.get('CFG-78') - 1),
    createdAt: now,
  });
  await tx.insert(wallets).values({ accountId, balance: '0.00', createdAt: now });
  const names = settings.get('CFG-169');
  await tx.insert(pipelines).values(names.map((name, i) => ({ accountId, name, position: i + 1, createdAt: now })));
  await recalc(tx, accountId); // the name from registration already counts (P-05)
  return { account: account!, user: user! };
}

// ---------- subscription helpers (Section 3.3; full plan management is P-47) ----------
export async function currentSubscription(dbx: DbOrTx, accountId: string) {
  const [s] = await dbx.select().from(subscriptions).where(and(eq(subscriptions.accountId, accountId), eq(subscriptions.isCurrent, true)));
  return s;
}

/** Assistant users: Trial yes, Normal no, Premium yes (Section 3.3, P-53 preconditions). */
export function allowsAssistants(s: { status: string; plan: string | null } | undefined): boolean {
  if (!s) return false;
  if (s.status === 'TRIAL') return true;
  return (s.status === 'ACTIVE' || s.status === 'GRACE') && s.plan === 'PREMIUM';
}

/** Automated WhatsApp, greetings and the wallet: Premium plan, ACTIVE or GRACE (Section 3.3; not in the trial, CFG-173). */
export function isPremium(s: { status: string; plan: string | null } | undefined): boolean {
  return !!s && (s.status === 'ACTIVE' || s.status === 'GRACE') && s.plan === 'PREMIUM';
}
