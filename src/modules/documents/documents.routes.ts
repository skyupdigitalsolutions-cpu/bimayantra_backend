// /api/v1/documents — P-18. Upload and view: advisor and assistants; label changes: advisor only.
// There is no delete for any role (DOC-07): every DELETE is refused with that message.
import { Router } from 'express';
import { authenticate, requireRole, requireWritable } from '../../http/auth.js';
import { idempotent } from '../../http/idempotency.js';
import { AppError } from '../../lib/errors.js';
import { changeLabel, confirmVersion, customerPicker, documentOptions, getVersion, uploadDocument } from './documents.service.js';

export const documentsRouter = Router();
documentsRouter.delete('/{*any}', () => {
  throw new AppError(403, 'DOC-07');
});
documentsRouter.use(authenticate(), requireRole('ADV', 'AST'));
documentsRouter.get('/options', (_req, res) => {
  res.json(documentOptions());
});
documentsRouter.get('/customers', async (req, res) => {
  res.json(await customerPicker(req.auth!, typeof req.query.q === 'string' ? req.query.q : ''));
});
documentsRouter.post('/', requireWritable, idempotent('document.upload', { required: true }), async (req, res) => {
  res.json(await uploadDocument(req, req.auth!, req.body));
});
documentsRouter.get('/versions/:id', async (req, res) => {
  res.json(await getVersion(req.auth!, String(req.params.id)));
});
documentsRouter.post('/versions/:id/confirm', requireWritable, idempotent('document.confirm'), async (req, res) => {
  res.json(await confirmVersion(req, req.auth!, String(req.params.id), req.body));
});
documentsRouter.post('/:id/label', requireWritable, async (req, res) => {
  res.json(await changeLabel(req, req.auth!, String(req.params.id), req.body));
});
