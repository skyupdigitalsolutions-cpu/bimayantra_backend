// /api/v1/leads — P-12 to P-14. Advisor and assistants (Section 3.2); marking lost and reopening is the
// advisor's only (checked in the service). Writes need a writable account (SUB-03).
import { Router } from 'express';
import { authenticate, requireRole, requireWritable } from '../../http/auth.js';
import { idempotent } from '../../http/idempotency.js';
import { exportLeads } from './export.service.js';
import { board, changeStatus, checkLeadDuplicate, convertLead, createLead, editLead, getLead, leadOptions, listLeads, logContact } from './leads.service.js';

const q = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
export const leadsRouter = Router();
leadsRouter.use(authenticate(), requireRole('ADV', 'AST'));

leadsRouter.get('/options', async (req, res) => {
  res.json(await leadOptions(req.auth!));
});
leadsRouter.get('/check-duplicate', async (req, res) => {
  res.json(await checkLeadDuplicate(req.auth!, { mobile: q(req.query.mobile), name: q(req.query.name), exceptId: q(req.query.exceptId) }));
});
leadsRouter.get('/', async (req, res) => {
  res.json(await listLeads(req.auth!, { status: q(req.query.status), pipelineId: q(req.query.pipelineId), q: q(req.query.q), page: Number(req.query.page) || 1, from: q(req.query.from), to: q(req.query.to) }));
});
// Download Excel: every detail of the leads in the current filter (advisor only, audited)
leadsRouter.get('/export', requireRole('ADV'), async (req, res) => {
  res.json(await exportLeads(req, req.auth!, { status: q(req.query.status), pipelineId: q(req.query.pipelineId), q: q(req.query.q), from: q(req.query.from), to: q(req.query.to) }));
});
leadsRouter.get('/board/:pipelineId', async (req, res) => {
  res.json(await board(req.auth!, String(req.params.pipelineId)));
});
leadsRouter.post('/', requireWritable, idempotent('lead.create', { required: true }), async (req, res) => {
  res.json(await createLead(req, req.auth!, req.body));
});
leadsRouter.get('/:id', async (req, res) => {
  res.json(await getLead(req.auth!, String(req.params.id)));
});
leadsRouter.post('/:id', requireWritable, async (req, res) => {
  res.json(await editLead(req, req.auth!, String(req.params.id), req.body));
});
leadsRouter.post('/:id/contact', requireWritable, idempotent('lead.contact'), async (req, res) => {
  res.json(await logContact(req, req.auth!, String(req.params.id), req.body));
});
leadsRouter.post('/:id/status', requireWritable, async (req, res) => {
  res.json(await changeStatus(req, req.auth!, String(req.params.id), req.body));
});
leadsRouter.post('/:id/convert', requireWritable, idempotent('lead.convert', { required: true }), async (req, res) => {
  res.json(await convertLead(req, req.auth!, String(req.params.id), req.body));
});
