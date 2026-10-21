// Daily system jobs at the IST time held in configuration (SYS-01 at CFG-48, SYS-03 at CFG-63 …). A tick
// every minute starts each job once per IST date when its time has come; the job_runs row makes a second
// start on the same date a no-op (GR-28). A job missed while the server was down runs at the next tick.
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { jobRuns } from '../../db/schema.js';
import { clock, istToday } from '../../lib/clock.js';
import { logger } from '../../lib/logger.js';
import type { SettingId } from '../../config/settings.js';
import { settings } from '../settings/settings.service.js';
import { defineJob } from './jobs.js';

type Daily = { name: string; at: () => string; run: () => Promise<unknown> };
const dailies: Daily[] = [];

/** `timeSetting` is a CFG id holding "HH:MM" IST, or a fixed "HH:MM". */
export function defineDaily(name: string, timeSetting: string, run: () => Promise<unknown>): void {
  dailies.push({ name, at: () => (timeSetting.startsWith('CFG-') ? (settings.get(timeSetting as SettingId) as unknown as string) : timeSetting), run });
}

const istNow = () => new Date(clock.now().getTime() + 330 * 60_000).toISOString().slice(11, 16);

/** Run one daily job now for today, if it has not run today. Returns false when it already ran. */
export async function runDaily(name: string, force = false): Promise<boolean> {
  const d = dailies.find((x) => x.name === name);
  if (!d) throw new Error(`Unknown daily job ${name}`);
  const today = istToday();
  if (force) await db.delete(jobRuns).where(and(eq(jobRuns.name, name), eq(jobRuns.runDate, today)));
  const claimed = await db.insert(jobRuns).values({ name, runDate: today, startedAt: clock.now() }).onConflictDoNothing().returning();
  if (!claimed.length) return false;
  try {
    const result = await d.run();
    await db.update(jobRuns).set({ finishedAt: clock.now(), result: (result ?? null) }).where(and(eq(jobRuns.name, name), eq(jobRuns.runDate, today)));
  } catch (err) {
    // Let the next tick try again: remove the claim
    await db.delete(jobRuns).where(and(eq(jobRuns.name, name), eq(jobRuns.runDate, today)));
    logger.error({ err, job: name }, 'Daily job failed');
    throw err;
  }
  return true;
}

export async function dailyTick(): Promise<void> {
  const now = istNow();
  for (const d of dailies) {
    if (now >= d.at()) await runDaily(d.name).catch(() => undefined);
  }
}

defineJob('daily-tick', dailyTick, '* * * * *');
