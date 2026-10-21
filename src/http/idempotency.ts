// GR-10 double-submit protection and GR-17 "Check status".
// The browser makes a key when a form opens and sends it as the Idempotency-Key header; a retry reuses it.
// - first request with a key: runs; a successful (2xx) result is saved with the key
// - same key again after success: 409 GEN-06 with the saved result (never a second record)
// - same key while the first is still running: 409 GEN-13
// - failed requests (4xx/5xx) are not saved, so the user can correct the form and retry with the same key
import { createHash } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { TECHNICAL } from '../config/technical.js';
import { db } from '../db/client.js';
import { idempotencyKeys } from '../db/schema.js';
import { clock } from '../lib/clock.js';
import { AppError, fieldError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { msg } from '../messages/messages.js';

type Stored = { body: unknown; private?: Record<string, unknown> };
/** Runs when a saved result is shown again (replay or Check status), e.g. to restore the sign-in cookies. */
export type ReplayHook = (req: Request, res: Response, saved: Stored) => Promise<void>;

const hooks = new Map<string, ReplayHook>();
const KEY_PATTERN = /^[A-Za-z0-9_-]{16,100}$/;

const scopeOf = (req: Request) => req.auth?.userId ?? 'public';
const hashOf = (name: string, body: unknown) => createHash('sha256').update(`${name}\n${JSON.stringify(body ?? null)}`).digest('base64url');

export function idempotent(name: string, opts: { required?: boolean; onReplay?: ReplayHook } = {}): RequestHandler {
  if (opts.onReplay) hooks.set(name, opts.onReplay);
  return async (req, res, next) => {
    const key = req.get('idempotency-key');
    if (!key) {
      if (opts.required) throw fieldError('Idempotency-Key', 'GEN-01', { 'Field label': 'Request key' });
      return next();
    }
    if (!KEY_PATTERN.test(key)) throw fieldError('Idempotency-Key', 'GEN-01', { 'Field label': 'Request key' });

    const scope = scopeOf(req);
    const requestHash = hashOf(name, req.body);
    const now = clock.now();
    const inserted = await db
      .insert(idempotencyKeys)
      .values({ scope, key, method: req.method, path: name, requestHash, createdAt: now })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });

    if (inserted.length === 0) {
      const [row] = await db.select().from(idempotencyKeys).where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));
      if (!row) throw new AppError(409, 'GEN-13', {}, [], { reason: 'in_progress' });
      if (row.state === 'DONE') {
        if (row.requestHash !== requestHash || row.path !== name) throw new AppError(409, 'GEN-06', {}, [], { reason: 'key_reused' });
        const saved = row.response as Stored;
        await hooks.get(name)?.(req, res, saved);
        throw new AppError(409, 'GEN-06', {}, [], { reason: 'replay', originalStatus: row.statusCode, result: saved.body });
      }
      const stale = now.getTime() - row.createdAt.getTime() > TECHNICAL.idempotencyStaleSeconds * 1000;
      if (!stale) throw new AppError(409, 'GEN-13', {}, [], { reason: 'in_progress' });
      await db.update(idempotencyKeys).set({ createdAt: now, requestHash, path: name }).where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));
    }

    // Save the outcome before the response leaves, so a retry right after it always sees it
    const send = res.json.bind(res);
    res.json = (body: unknown) => {
      const where = and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key));
      const op =
        res.statusCode >= 200 && res.statusCode < 300
          ? db
              .update(idempotencyKeys)
              .set({ state: 'DONE', statusCode: res.statusCode, response: { body, private: res.locals.idempotencyPrivate } satisfies Stored, completedAt: clock.now() })
              .where(where)
          : db.delete(idempotencyKeys).where(where);
      op.then(
        () => send(body),
        (err: unknown) => {
          logger.error({ err, requestId: req.requestId }, 'Could not save idempotency result');
          send(body);
        },
      );
      return res;
    };
    next();
  };
}

/** GET /api/v1/requests/:key — GR-17 Check status after a timeout. */
export const checkStatus: RequestHandler = async (req, res) => {
  const key = String(req.params.key ?? '');
  if (!KEY_PATTERN.test(key)) throw fieldError('key', 'GEN-01', { 'Field label': 'Request key' });
  const [row] = await db
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.scope, scopeOf(req)), eq(idempotencyKeys.key, key)));
  if (!row) return res.json({ status: 'NOT_COMPLETED', message: msg('GEN-21') });
  if (row.state !== 'DONE') return res.json({ status: 'IN_PROGRESS', message: msg('GEN-13') });
  const saved = row.response as Stored;
  await hooks.get(row.path)?.(req, res, saved);
  res.json({ status: 'COMPLETED', message: msg('GEN-20'), result: saved.body });
};
