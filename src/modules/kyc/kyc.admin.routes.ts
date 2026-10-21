// /api/v1/admin/kyc — Admin → Approvals → Advisor KYC (STF, ADM)
import { Router } from 'express';
import { authenticate, requireRole } from '../../http/auth.js';
import { idempotent } from '../../http/idempotency.js';
import { decide, reviewItem, reviewQueue } from './kyc.service.js';

export const kycAdminRouter = Router();
kycAdminRouter.use(authenticate(), requireRole('STF', 'ADM'));

kycAdminRouter.get('/', async (_req, res) => {
  res.json({ items: await reviewQueue() });
});
kycAdminRouter.get('/:accountId', async (req, res) => {
  res.json(await reviewItem(req, String(req.params.accountId)));
});
kycAdminRouter.post('/:accountId/decision', idempotent('kyc.decide'), async (req, res) => {
  res.json(await decide(req, req.auth!, String(req.params.accountId), req.body));
});
