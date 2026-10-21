// /api/v1/admin/agent-codes — Admin → Approvals → Agent codes (STF, ADM): appointment letters that did not
// match automatically. Approve → "Verified"; Reject → the advisor sees the reason on My insurers.
import { Router } from 'express';
import { authenticate, requireRole } from '../../http/auth.js';
import { idempotent } from '../../http/idempotency.js';
import { agentCodeQueue, decideAgentCode } from './verify.service.js';

export const agentCodesAdminRouter = Router();
agentCodesAdminRouter.use(authenticate(), requireRole('STF', 'ADM'));

agentCodesAdminRouter.get('/', async (req, res) => {
  res.json({ items: await agentCodeQueue(req.query.status) });
});
agentCodesAdminRouter.post('/:id/decision', idempotent('agentcode.decide'), async (req, res) => {
  res.json(await decideAgentCode(req, req.auth!, String(req.params.id), req.body));
});
