// /api/v1/assistants (P-53) — the advisor only
import { Router } from 'express';
import { authenticate, requireRole, requireWritable } from '../../http/auth.js';
import { idempotent } from '../../http/idempotency.js';
import { addAssistant, disableAssistant, enableAssistant, listAssistants } from './assistants.service.js';

export const assistantsRouter = Router();
assistantsRouter.use(authenticate(), requireRole('ADV'));

assistantsRouter.get('/', async (req, res) => {
  res.json(await listAssistants(req.auth!.accountId!));
});
assistantsRouter.post('/', requireWritable, idempotent('assistants.add', { required: true }), async (req, res) => {
  res.json(await addAssistant(req, req.auth!, req.body));
});
assistantsRouter.post('/:id/disable', async (req, res) => {
  res.json(await disableAssistant(req, req.auth!, String(req.params.id)));
});
assistantsRouter.post('/:id/enable', requireWritable, async (req, res) => {
  res.json(await enableAssistant(req, req.auth!, String(req.params.id)));
});
