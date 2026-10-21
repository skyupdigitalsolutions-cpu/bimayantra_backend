// /api/v1/tasks (P-11)
import { Router } from 'express';
import { authenticate, requireRole, requireWritable } from '../../http/auth.js';
import { idempotent } from '../../http/idempotency.js';
import { fieldError } from '../../lib/errors.js';
import { createTask, editTask, listTasks, setTaskStatus, type Tab } from './tasks.service.js';

export const tasksRouter = Router();
tasksRouter.use(authenticate(), requireRole('ADV', 'AST'));

tasksRouter.get('/', async (req, res) => {
  const tab = (typeof req.query.tab === 'string' ? req.query.tab : 'today') as Tab;
  if (!['overdue', 'today', 'upcoming', 'done'].includes(tab)) throw fieldError('tab', 'VAL-22');
  res.json(await listTasks(req.auth!.accountId!, tab, Math.max(1, Number(req.query.page) || 1)));
});
tasksRouter.post('/', requireWritable, idempotent('tasks.create'), async (req, res) => {
  res.json(await createTask(req, req.auth!, req.body));
});
tasksRouter.post('/:id', requireWritable, async (req, res) => {
  res.json(await editTask(req, req.auth!, String(req.params.id), req.body));
});
for (const [action, to] of [['done', 'DONE'], ['reopen', 'OPEN'], ['cancel', 'CANCELLED']] as const) {
  tasksRouter.post(`/:id/${action}`, requireWritable, idempotent(`tasks.${action}`), async (req, res) => {
    res.json(await setTaskStatus(req, req.auth!, String(req.params.id), to, Number((req.body as { version?: unknown }).version)));
  });
}
