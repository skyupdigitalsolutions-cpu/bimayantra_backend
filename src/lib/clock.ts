// The one source of "now" for the server (GR-25), with a test-only override (NFR-13) so date-based
// rules can be tested in minutes. The override is impossible in production (env check + this guard).
import { env, isProduction } from '../config/env.js';

let offsetMs = 0;

export const clock = {
  now(): Date {
    return new Date(Date.now() + offsetMs);
  },
  /** Test / QA only: move the clock forward or back by a number of milliseconds. */
  setOffset(ms: number): void {
    if (isProduction || (!env.TEST_CLOCK_ENABLED && env.NODE_ENV !== 'test')) throw new Error('Test clock is not enabled');
    offsetMs = ms;
  },
  offset(): number {
    return offsetMs;
  },
};

const IST_OFFSET_MS = 330 * 60 * 1000; // UTC+05:30

/** "IST today" as YYYY-MM-DD (GR-25: "today" always means IST today). */
export function istToday(at: Date = clock.now()): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Add whole days to a YYYY-MM-DD date (date-only fields never shift by a time zone). */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 12-hour IST time with AM/PM, e.g. "04:35 PM" (GR-25). */
export function formatIstTime(at: Date): string {
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true })
    .format(at)
    .toUpperCase();
}

/** DD-MM-YYYY (Section 1.2 date format). */
export function formatDate(isoDate: string): string {
  if (/^\d{2}-\d{2}-\d{4}$/.test(isoDate.trim())) return isoDate.trim(); // already DD-MM-YYYY (typed input)
  const [y, m, d] = isoDate.slice(0, 10).split('-');
  return `${d}-${m}-${y}`;
}
