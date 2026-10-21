// Shared rules for leads and customers (Sections 7 and 8).
import type { Request } from 'express';
import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { accountCounters } from '../../db/schema.js';
import { clock } from '../../lib/clock.js';

/** Duplicate rule: names compared ignoring case, spaces and dots (Section 7). */
export const normName = (name: string) => name.toLowerCase().replace(/[\s.]+/g, '');

export const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);

/** Records with a unique-constraint clash from PostgreSQL. */
export const isUnique = (err: unknown, constraint?: string): boolean => {
  const e = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  return (e?.code ?? e?.cause?.code) === '23505' && (!constraint || (e?.constraint ?? e?.cause?.constraint) === constraint);
};

/**
 * Next reference number (Section 4.2), given only when the record is first saved and never reused.
 * LD-YYMM-NNNNN (lead), CU-NNNNNN (customer), QT/CQ/PR-YYYYMM-NNNNN, PL-NNNNNN. The counter row is locked, so two saves never share a number.
 */
export async function nextNumber(tx: DbOrTx, accountId: string, kind: 'LD' | 'CU' | 'QT' | 'CQ' | 'PR' | 'PL'): Promise<string> {
  const [row] = await tx
    .insert(accountCounters)
    .values({ accountId, kind, value: 1 })
    .onConflictDoUpdate({ target: [accountCounters.accountId, accountCounters.kind], set: { value: sql`${accountCounters.value} + 1` } })
    .returning({ value: accountCounters.value });
  const n = row!.value;
  if (kind === 'CU' || kind === 'PL') return `${kind}-${String(n).padStart(6, '0')}`;
  const ist = new Date(clock.now().getTime() + 330 * 60_000).toISOString();
  // QT, CQ (Section 4.2) and PR (CFG-177): YYYYMM; LD: YYMM
  if (kind !== 'LD') return `${kind}-${ist.slice(0, 4)}${ist.slice(5, 7)}-${String(n).padStart(5, '0')}`;
  return `LD-${ist.slice(2, 4)}${ist.slice(5, 7)}-${String(n).padStart(5, '0')}`;
}

/** Read a version number from a body (GR-11); -1 never matches. */
export const readVersion = (body: unknown): number => {
  const v = Number((body as { version?: unknown } | null)?.version);
  return Number.isInteger(v) ? v : -1;
};

/** True when the request asked to save despite a warning (LD-03, LD-04, CU-03, CU-29). */
export const overrides = (body: unknown, key = 'saveAnyway') => (body as Record<string, unknown> | null)?.[key] === true;

export type ReqLike = Request;
