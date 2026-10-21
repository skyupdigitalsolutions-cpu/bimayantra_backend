// /api/v1/files — upload (multipart), a short-lived link, and the content behind it.
import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { authenticate, requireWritable } from '../../http/auth.js';
import { AppError, fieldError, notFound } from '../../lib/errors.js';
import { audit } from '../audit/audit.js';
import { db } from '../../db/client.js';
import { settings } from '../settings/settings.service.js';
import { and, eq, isNull } from 'drizzle-orm';
import { sessions, users } from '../../db/schema.js';
import { clock } from '../../lib/clock.js';
import type { Role } from '../../types/express.js';
import { PURPOSES, UPLOADERS, fileLink, getFile, mayOpen, readLink, readStored, sessionOfLink, storeFiles, type Purpose } from './files.service.js';

export const filesRouter = Router();

// Larger than any allowed file so the exact VAL-24 message can be given by the size check
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024, files: 20 } });

/** Multipart is the one non-JSON write: a custom header is required so a cross-site form cannot post it. */
const uploadGuard: RequestHandler = (req, _res, next) => {
  if (req.get('x-upload') !== '1') return next(new AppError(403, 'GEN-03'));
  next();
};

filesRouter.post(
  '/',
  authenticate(),
  requireWritable,
  uploadGuard,
  (req, res, next) => {
    upload.array('files')(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_COUNT') return next(fieldError('files', 'VAL-25'));
        if (err.code === 'LIMIT_FILE_SIZE') return next(fieldError('files', 'VAL-24', { 'size limit': Math.max(settings.get('CFG-27'), settings.get('CFG-29')) }));
      }
      next(err as Error | undefined);
    });
  },
  async (req, res) => {
    const a = req.auth!;
    const raw = (req.body as { purpose?: unknown }).purpose;
    const purpose = (typeof raw === 'string' ? raw : '') as Purpose;
    if (!PURPOSES.includes(purpose)) throw fieldError('purpose', 'VAL-22');
    if (!UPLOADERS[purpose].includes(a.role)) throw new AppError(403, 'GEN-03');
    const saved = await storeFiles(a, purpose, (req.files as Express.Multer.File[] | undefined) ?? []);
    await audit(db, req, { action: 'FILE_UPLOADED', entity: 'file', entityId: saved.map((f) => f.id).join(','), newValue: { purpose, count: saved.length } });
    res.json({ items: saved });
  },
);

filesRouter.get('/:id/link', authenticate(), async (req, res) => {
  const f = await getFile(String(req.params.id));
  if (!f || !mayOpen(req.auth!, f)) throw notFound(); // never reveals that another account's file exists
  res.json({ ...fileLink(req.auth!.userId, req.auth!.sessionId, f.id), name: f.originalName, mime: f.mime });
});

filesRouter.get('/:id/content', authenticate({ required: false, touch: false }), async (req, res) => {
  const f = await getFile(String(req.params.id));
  const sessionId = sessionOfLink(req.query.t);
  if (!f || !sessionId) throw notFound();
  // The session in the link must still be active (idle rule CFG-07 and the 12-hour limit apply)
  const [row] = await db
    .select({ s: sessions, u: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sessionId), isNull(sessions.endedAt)));
  const now = clock.now().getTime();
  if (!row || row.u.status !== 'ACTIVE' || now - row.s.lastActiveAt.getTime() > settings.get('CFG-07') * 60_000 || now - row.s.createdAt.getTime() > settings.get('CFG-08') * 3_600_000) throw notFound();
  const who = { userId: row.u.id, sessionId, role: row.u.role as Role, accountId: row.u.accountId, name: row.u.name, mobile: row.u.mobile, readOnly: false };
  // A signed-in caller must be the user the link was made for
  if ((req.auth && req.auth.userId !== row.u.id) || !mayOpen(who, f) || !readLink(f.id, req.query.t, row.u.id)) throw notFound();
  const buf = await readStored(f.storageKey);
  res.setHeader('content-type', f.mime);
  res.setHeader('content-disposition', `inline; filename="${encodeURIComponent(f.originalName)}"`);
  res.setHeader('x-content-type-options', 'nosniff');
  res.send(buf);
});
