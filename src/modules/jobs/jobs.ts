// Background jobs (GR-26, GR-28) on pg-boss, which keeps its queue in PostgreSQL (no Redis).
// Business records are saved first; provider calls (email …) run here, so a provider failure never undoes
// a saved record. Every job is repeat-safe: handlers check what was already done.
// JOBS_MODE=inline runs a job at once in the same process (automated tests); off = nothing runs.
import { PgBoss } from 'pg-boss';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

type Handler = (data: Record<string, unknown>) => Promise<void>;
const handlers = new Map<string, Handler>();
const schedules: { name: string; cron: string }[] = [];
let boss: PgBoss | null = null;

export function defineJob(name: string, handler: Handler, schedule?: string): void {
  handlers.set(name, handler);
  if (schedule) schedules.push({ name, cron: schedule });
}

/** Queue a job. `singletonKey` makes a repeated request with the same key a no-op while one is waiting. */
export async function enqueue(name: string, data: Record<string, unknown>, opts: { singletonKey?: string; startAfterSeconds?: number } = {}): Promise<void> {
  if (env.JOBS_MODE === 'off') return;
  if (env.JOBS_MODE === 'inline') {
    const h = handlers.get(name);
    if (!h) throw new Error(`Unknown job ${name}`);
    await h(data).catch((err: unknown) => logger.error({ err, job: name }, 'Inline job failed'));
    return;
  }
  if (!boss) throw new Error('Job queue not started');
  await boss.send(name, data, {
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    ...(opts.singletonKey ? { singletonKey: opts.singletonKey } : {}),
    ...(opts.startAfterSeconds ? { startAfter: opts.startAfterSeconds } : {}),
  });
}

/** Run a job's handler directly (tests, or a manual run). */
export async function runJob(name: string, data: Record<string, unknown> = {}): Promise<void> {
  const h = handlers.get(name);
  if (!h) throw new Error(`Unknown job ${name}`);
  await h(data);
}

export async function startJobs(): Promise<void> {
  if (env.JOBS_MODE !== 'queue') return;
  boss = new PgBoss({ connectionString: env.DATABASE_URL, ...(env.DATABASE_SSL ? { ssl: { rejectUnauthorized: false } } : {}) });
  boss.on('error', (err) => logger.error({ err }, 'Job queue error'));
  await boss.start();
  for (const [name, handler] of handlers) {
    await boss.createQueue(name);
    await boss.work<Record<string, unknown>>(name, async (jobs) => {
      for (const job of jobs) await handler(job.data ?? {});
    });
  }
  // Schedules are in IST (GR-25)
  for (const s of schedules) await boss.schedule(s.name, s.cron, {}, { tz: 'Asia/Kolkata' });
  logger.info(`Background jobs started (${handlers.size} job types)`);
}

export async function stopJobs(): Promise<void> {
  await boss?.stop({ graceful: true });
  boss = null;
}
