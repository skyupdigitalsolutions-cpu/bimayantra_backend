// Shared catalogue rules (Section 9). Maker-checker: whoever creates or edits an item can never approve it
// (CAT-05); approval needs a second ADM and the extra OTP (CFG-83, AUTH-26). Two approvers at once: the
// second gets GEN-04. Every change is audited in the same transaction (GR-30).
import { inArray } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { AppError, fieldError, forbidden } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import type { AuthContext } from '../../types/express.js';

export const isUnique = (err: unknown, constraint?: string): boolean => {
  const e = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const code = e?.code ?? e?.cause?.code;
  const name = e?.constraint ?? e?.cause?.constraint;
  return code === '23505' && (!constraint || name === constraint);
};

/** A form value as text: strings, numbers and booleans only (objects become empty). */
export const scalar = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/** Only a different ADM may approve or reject (CAT-05). */
export function assertChecker(auth: AuthContext, makers: readonly string[]): void {
  if (auth.role !== 'ADM') throw forbidden('GEN-03');
  if (makers.includes(auth.userId)) throw new AppError(403, 'CAT-05');
}

export const addMaker = (makers: readonly string[], userId: string): string[] => (makers.includes(userId) ? [...makers] : [...makers, userId]);

/** Reject needs a reason (FLD-29). */
export function readReason(body: unknown, field = 'reason'): string {
  const raw = (body as Record<string, unknown> | null)?.[field];
  if (typeof raw !== 'string' || raw.trim() === '') throw fieldError(field, 'GEN-01', { 'Field label': 'Reason' });
  const r = F.shortText(raw);
  if (!r.ok) throw fieldError(field, r.code, r.params);
  return r.value;
}

export function readVersion(body: unknown): number {
  const v = Number((body as { version?: unknown } | null)?.version);
  return Number.isInteger(v) ? v : -1;
}

export async function namesOf(dbx: DbOrTx, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await dbx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...ids]));
  return ids.map((id) => rows.find((r) => r.id === id)?.name ?? 'Unknown');
}

/** FLD-20 choice list check with VAL-22. */
export function oneOf<T extends string>(value: unknown, list: readonly T[], field: string, label: string, required = true): T | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw fieldError(field, 'GEN-01', { 'Field label': label });
    return undefined;
  }
  if (typeof value !== 'string' || !list.includes(value as T)) throw fieldError(field, 'VAL-22');
  return value as T;
}
