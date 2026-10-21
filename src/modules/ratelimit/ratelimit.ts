// Fixed-window counters kept in PostgreSQL (works with several server instances, no Redis needed).
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { rateCounters } from '../../db/schema.js';
import { clock } from '../../lib/clock.js';
import { defineJob } from '../jobs/jobs.js';

export type Hit = { count: number; windowEndsAt: Date };

/** Count one request in the current window and return the new count. */
export async function hit(key: string, windowSeconds: number): Promise<Hit> {
  const now = clock.now().getTime();
  const windowMs = windowSeconds * 1000;
  const start = new Date(Math.floor(now / windowMs) * windowMs);
  const [row] = await db
    .insert(rateCounters)
    .values({ key, windowStart: start, count: 1 })
    .onConflictDoUpdate({ target: [rateCounters.key, rateCounters.windowStart], set: { count: sql`${rateCounters.count} + 1` } })
    .returning({ count: rateCounters.count });
  return { count: row!.count, windowEndsAt: new Date(start.getTime() + windowMs) };
}

export function secondsUntil(at: Date): number {
  return Math.max(1, Math.ceil((at.getTime() - clock.now().getTime()) / 1000));
}

/** Old windows are useless after a day; called by the housekeeping job. */
export async function pruneRateCounters(): Promise<void> {
  await db.delete(rateCounters).where(sql`${rateCounters.windowStart} < now() - interval '1 day'`);
}

defineJob('ratelimit-prune', pruneRateCounters, '41 2 * * *');
