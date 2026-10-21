// /api/v1/notifications (P-10) — each user sees only their own
import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { notifications } from '../../db/schema.js';
import { authenticate } from '../../http/auth.js';
import { clock } from '../../lib/clock.js';
import { notFound } from '../../lib/errors.js';
import { listNotifications } from './notifications.service.js';

export const notificationsRouter = Router();
notificationsRouter.use(authenticate());

notificationsRouter.get('/', async (req, res) => {
  const r = await listNotifications(req.auth!.userId);
  res.json({
    unread: r.unread,
    badge: r.unread > r.cap ? `${r.cap}+` : String(r.unread),
    items: r.items.map((n) => ({ id: n.id, text: n.text, messageId: n.messageId, at: n.createdAt.toISOString(), unread: n.status === 'UNREAD', link: n.linkType ? { type: n.linkType, id: n.linkId } : null })),
  });
});

notificationsRouter.post('/read-all', async (req, res) => {
  await db.update(notifications).set({ status: 'READ', readAt: clock.now() }).where(and(eq(notifications.userId, req.auth!.userId), eq(notifications.status, 'UNREAD')));
  res.json({ ok: true });
});

notificationsRouter.post('/:id/read', async (req, res) => {
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound();
  const [n] = await db
    .update(notifications)
    .set({ status: 'READ', readAt: clock.now() })
    .where(and(eq(notifications.id, id), eq(notifications.userId, req.auth!.userId)))
    .returning();
  if (!n) throw notFound();
  res.json({ link: n.linkType ? { type: n.linkType, id: n.linkId } : null });
});
