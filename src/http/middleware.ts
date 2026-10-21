// Request plumbing shared by every route: request ID, JSON-only writes, settings refresh, error mapping.
import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { render } from '../messages/messages.js';
import { settings } from '../modules/settings/settings.service.js';

export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.get('x-request-id');
  req.requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
};

/**
 * Writes must be JSON. A cross-site HTML form cannot send application/json without a CORS preflight,
 * so together with SameSite cookies this blocks cross-site request forgery.
 */
export const jsonOnlyWrites: RequestHandler = (req, _res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const hasBody = Number(req.get('content-length') ?? 0) > 0 || req.get('transfer-encoding') !== undefined;
    // The upload route takes multipart and is guarded by its own custom header (files.routes.ts)
    const upload = req.path === '/files' && req.is('multipart/form-data');
    if (hasBody && !upload && !req.is('application/json')) return next(new AppError(415, 'GEN-99', {}, [], { reason: 'json_required' }));
    if (!hasBody && req.get('sec-fetch-site') === 'cross-site') return next(new AppError(403, 'GEN-03'));
  }
  next();
};

/** NFR-13: a changed CFG value reaches every request within a few seconds. */
export const refreshSettings: RequestHandler = async (_req, _res, next) => {
  await settings.refreshIfStale();
  next();
};

export const notFoundRoute: RequestHandler = (_req, _res, next) => next(new AppError(404, 'GEN-11'));

/** Section 2.5: server results → message IDs. Every message is sent with its exact text. */
export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  if (res.headersSent) return;
  let e: AppError;
  if (err instanceof AppError) e = err;
  else if (isBodyParserError(err)) {
    e = err.type === 'entity.too.large' ? new AppError(413, 'GEN-99', {}, [], { reason: 'too_large' }) : new AppError(400, 'GEN-99', {}, [], { reason: 'bad_json' });
  } else {
    // GEN-99 only for unknown causes, always with a reference the user can give to support
    e = new AppError(500, 'GEN-99');
  }
  const errorId = e.code === 'GEN-99' ? req.requestId : undefined;
  if (e.status >= 500) logger.error({ err, requestId: req.requestId, path: req.path }, 'Unexpected error');
  // The test logger is silent; show unexpected errors so a failing test says why
  if (e.status >= 500 && process.env.NODE_ENV === 'test') console.error(err);
  const params = errorId ? { ...e.params, errorId } : e.params;
  if (e.status === 429 && typeof e.extra.retryAfterSeconds === 'number') res.setHeader('retry-after', String(e.extra.retryAfterSeconds));
  res.status(e.status).json({
    error: {
      code: e.code,
      message: render(e.code, params),
      params,
      fields: e.fields.map((f) => ({ field: f.field, code: f.code, message: render(f.code, f.params) })),
      ...(errorId ? { errorId } : {}),
      ...e.extra,
    },
  });
};

function isBodyParserError(err: unknown): err is { type: string } {
  return typeof err === 'object' && err !== null && 'type' in err && typeof err.type === 'string' && 'status' in err;
}
