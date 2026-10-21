// /api/v1/dashboard/* (P-08) — one call per widget
import { Router } from 'express';
import { authenticate, requireRole } from '../../http/auth.js';
import { banners, profileCard, recentActivity, tasksWidget } from './dashboard.service.js';
import { counts, funnel, search } from './counts.service.js';
import { gettingStarted } from './guide.service.js';

export const dashboardRouter = Router();
dashboardRouter.use(authenticate(), requireRole('ADV', 'AST'));

dashboardRouter.get('/banners', async (req, res) => {
  res.json({ items: await banners(req.auth!.accountId!) });
});
dashboardRouter.get('/profile', async (req, res) => {
  res.json({ card: await profileCard(req.auth!.accountId!) });
});
dashboardRouter.get('/tasks', async (req, res) => {
  res.json(await tasksWidget(req.auth!.accountId!));
});
dashboardRouter.get('/activity', async (req, res) => {
  res.json(await recentActivity(req.auth!.accountId!));
});
// "What to do next": the advisor's set-up checklist
dashboardRouter.get('/getting-started', async (req, res) => {
  res.json(await gettingStarted(req.auth!.accountId!));
});
dashboardRouter.get('/counts', async (req, res) => {
  res.json(await counts(req.auth!.accountId!));
});
dashboardRouter.get('/funnel', async (req, res) => {
  const p = typeof req.query.period === 'string' && ['month', '3months', 'year'].includes(req.query.period) ? req.query.period : 'month';
  res.json(await funnel(req.auth!.accountId!, p));
});
// P-09 global search (the advisor; assistants work the same records)
dashboardRouter.get('/search', async (req, res) => {
  res.json(await search(req.auth!.accountId!, typeof req.query.q === 'string' ? req.query.q : ''));
});
