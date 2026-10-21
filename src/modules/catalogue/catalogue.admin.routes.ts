// /api/v1/admin/catalogue — Admin → Catalogue (STF and ADM make; a different ADM approves) and
// /api/v1/admin/approvals — the single approvals list (P-25 step 1).
import { Router } from 'express';
import { authenticate, requireRole } from '../../http/auth.js';
import { idempotent } from '../../http/idempotency.js';
import { approvalsList } from './approvals.service.js';
import { correctionQueue, decideCorrection } from './corrections.service.js';
import {
  approveInsurer,
  createInsurer,
  discardInsurerChange,
  editInsurer,
  getInsurer,
  insurerImpact,
  listInsurers,
  rejectInsurer,
  setInsurerActive,
  submitInsurer,
} from './insurers.service.js';
import { acceptHigh, applyJob, getJob, retryJob, saveDecisions, startForVersion } from './ocr.service.js';
import { cancelPrice, checkPrice, createPrice, getPrice, listPrices, rateTemplateCsv } from './prices.service.js';
import {
  approveVerified,
  createVerified,
  getVerified,
  getVersionForAdmin,
  listVerified,
  openVerifiedDraft,
  productFormOptions,
  rejectVerified,
  saveVerifiedDraft,
  setVerifiedAvailability,
  submitVerified,
  useCurrentTemplate,
} from './products.service.js';
import {
  approveTemplate,
  createType,
  decideTypeChange,
  FACTOR_KINDS,
  FEATURE_GROUPS,
  DATA_TYPES,
  FILLED_FROM,
  LABELS,
  getTemplate,
  getType,
  listTypes,
  openTemplateDraft,
  rejectTemplate,
  renameType,
  saveTemplate,
  setTypeActive,
  submitTemplate,
  typeImpact,
} from './types.service.js';

const q = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const id = (v: unknown) => String(v);

export const approvalsRouter = Router();
approvalsRouter.use(authenticate(), requireRole('STF', 'ADM'));
approvalsRouter.get('/', async (req, res) => {
  res.json({ items: await approvalsList(req.auth!) });
});

export const catalogueAdminRouter = Router();
catalogueAdminRouter.use(authenticate(), requireRole('STF', 'ADM'));

// ---- P-20 Insurers ----
catalogueAdminRouter.get('/insurers', async (req, res) => {
  res.json({ items: await listInsurers(q(req.query.q), q(req.query.status)) });
});
catalogueAdminRouter.post('/insurers', idempotent('insurer.create'), async (req, res) => {
  res.json(await createInsurer(req, req.auth!, req.body));
});
catalogueAdminRouter.get('/insurers/:id', async (req, res) => {
  res.json(await getInsurer(id(req.params.id)));
});
catalogueAdminRouter.post('/insurers/:id', async (req, res) => {
  res.json(await editInsurer(req, req.auth!, id(req.params.id), req.body));
});
catalogueAdminRouter.post('/insurers/:id/submit', async (req, res) => {
  res.json(await submitInsurer(req, req.auth!, id(req.params.id), req.body));
});
catalogueAdminRouter.post('/insurers/:id/approve', idempotent('insurer.approve'), async (req, res) => {
  res.json(await approveInsurer(req, req.auth!, id(req.params.id), req.body));
});
catalogueAdminRouter.post('/insurers/:id/reject', async (req, res) => {
  res.json(await rejectInsurer(req, req.auth!, id(req.params.id), req.body));
});
catalogueAdminRouter.post('/insurers/:id/discard-change', async (req, res) => {
  res.json(await discardInsurerChange(req, id(req.params.id), req.body));
});
catalogueAdminRouter.get('/insurers/:id/impact', async (req, res) => {
  res.json(await insurerImpact(id(req.params.id)));
});
catalogueAdminRouter.post('/insurers/:id/deactivate', async (req, res) => {
  res.json(await setInsurerActive(req, req.auth!, id(req.params.id), false, req.body));
});
catalogueAdminRouter.post('/insurers/:id/activate', async (req, res) => {
  res.json(await setInsurerActive(req, req.auth!, id(req.params.id), true, req.body));
});

// ---- P-21 Insurance types and feature templates ----
catalogueAdminRouter.get('/template-options', (_req, res) => {
  res.json({ groups: FEATURE_GROUPS, dataTypes: DATA_TYPES, kinds: FACTOR_KINDS, filledFrom: FILLED_FROM, labels: LABELS });
});
catalogueAdminRouter.get('/types', async (_req, res) => {
  res.json({ items: await listTypes() });
});
catalogueAdminRouter.post('/types', idempotent('type.create'), async (req, res) => {
  res.json(await createType(req, req.auth!, req.body));
});
catalogueAdminRouter.get('/types/:id', async (req, res) => {
  res.json(await getType(id(req.params.id)));
});
catalogueAdminRouter.post('/types/:id', async (req, res) => {
  res.json(await renameType(req, req.auth!, id(req.params.id), req.body));
});
catalogueAdminRouter.post('/types/:id/template', async (req, res) => {
  res.json(await openTemplateDraft(req, req.auth!, id(req.params.id)));
});
catalogueAdminRouter.post('/types/:id/change/approve', idempotent('type.change.approve'), async (req, res) => {
  res.json(await decideTypeChange(req, req.auth!, id(req.params.id), true, req.body));
});
catalogueAdminRouter.post('/types/:id/change/reject', async (req, res) => {
  res.json(await decideTypeChange(req, req.auth!, id(req.params.id), false, req.body));
});
catalogueAdminRouter.get('/types/:id/impact', async (req, res) => {
  res.json(await typeImpact(id(req.params.id)));
});
catalogueAdminRouter.post('/types/:id/deactivate', async (req, res) => {
  res.json(await setTypeActive(req, req.auth!, id(req.params.id), false, req.body));
});
catalogueAdminRouter.post('/types/:id/activate', async (req, res) => {
  res.json(await setTypeActive(req, req.auth!, id(req.params.id), true, req.body));
});
catalogueAdminRouter.get('/templates/:id', async (req, res) => {
  res.json(await getTemplate(id(req.params.id)));
});
catalogueAdminRouter.post('/templates/:id', async (req, res) => {
  res.json(await saveTemplate(req, req.auth!, id(req.params.id), req.body));
});
catalogueAdminRouter.post('/templates/:id/submit', async (req, res) => {
  res.json(await submitTemplate(req, req.auth!, id(req.params.id), req.body));
});
catalogueAdminRouter.post('/templates/:id/approve', idempotent('template.approve'), async (req, res) => {
  res.json(await approveTemplate(req, req.auth!, id(req.params.id), req.body));
});
catalogueAdminRouter.post('/templates/:id/reject', async (req, res) => {
  res.json(await rejectTemplate(req, req.auth!, id(req.params.id), req.body));
});

// ---- P-22 / P-25 Verified products ----
catalogueAdminRouter.get('/product-options', async (_req, res) => {
  res.json(await productFormOptions());
});
catalogueAdminRouter.get('/products', async (req, res) => {
  res.json({ items: await listVerified(q(req.query.q), q(req.query.status)) });
});
catalogueAdminRouter.post('/products', idempotent('product.create'), async (req, res) => {
  res.json(await createVerified(req, req.auth!, req.body));
});
catalogueAdminRouter.get('/products/:id', async (req, res) => {
  res.json(await getVerified(id(req.params.id)));
});
catalogueAdminRouter.post('/products/:id/edit', async (req, res) => {
  res.json(await openVerifiedDraft(req, req.auth!, id(req.params.id)));
});
catalogueAdminRouter.post('/products/:id/withdraw', async (req, res) => {
  res.json(await setVerifiedAvailability(req, req.auth!, id(req.params.id), true, req.body));
});
catalogueAdminRouter.post('/products/:id/make-available', async (req, res) => {
  res.json(await setVerifiedAvailability(req, req.auth!, id(req.params.id), false, req.body));
});
catalogueAdminRouter.get('/product-versions/:id', async (req, res) => {
  res.json(await getVersionForAdmin(id(req.params.id)));
});
catalogueAdminRouter.post('/product-versions/:id', async (req, res) => {
  res.json(await saveVerifiedDraft(req, req.auth!, id(req.params.id), req.body));
});
catalogueAdminRouter.post('/product-versions/:id/use-current-template', async (req, res) => {
  res.json(await useCurrentTemplate(req, req.auth!, id(req.params.id), req.body));
});
catalogueAdminRouter.post('/product-versions/:id/submit', async (req, res) => {
  res.json(await submitVerified(req, req.auth!, id(req.params.id), req.body));
});
catalogueAdminRouter.post('/product-versions/:id/approve', idempotent('product.approve'), async (req, res) => {
  res.json(await approveVerified(req, req.auth!, id(req.params.id), req.body));
});
catalogueAdminRouter.post('/product-versions/:id/reject', async (req, res) => {
  res.json(await rejectVerified(req, req.auth!, id(req.params.id), req.body));
});

// ---- P-23 Brochure reading ----
catalogueAdminRouter.post('/product-versions/:id/ocr', idempotent('ocr.start'), async (req, res) => {
  res.json(await startForVersion(req, req.auth!, id(req.params.id), req.body));
});
catalogueAdminRouter.get('/ocr/:id', async (req, res) => {
  res.json(await getJob(req.auth!, id(req.params.id)));
});
catalogueAdminRouter.post('/ocr/:id/decisions', async (req, res) => {
  res.json(await saveDecisions(req, req.auth!, id(req.params.id), req.body));
});
catalogueAdminRouter.post('/ocr/:id/accept-high', async (req, res) => {
  res.json(await acceptHigh(req, req.auth!, id(req.params.id), req.body));
});
catalogueAdminRouter.post('/ocr/:id/apply', async (req, res) => {
  res.json(await applyJob(req, req.auth!, id(req.params.id), req.body));
});
catalogueAdminRouter.post('/ocr/:id/retry', async (req, res) => {
  res.json(await retryJob(req, req.auth!, id(req.params.id)));
});

// ---- P-24 SkyUp reference price ----
catalogueAdminRouter.get('/products/:id/prices', async (req, res) => {
  res.json(await listPrices(req.auth!, id(req.params.id)));
});
catalogueAdminRouter.get('/products/:id/prices/template.csv', async (req, res) => {
  const t = await rateTemplateCsv(req.auth!, id(req.params.id));
  res.type('text/csv').attachment(t.name).send(t.csv);
});
catalogueAdminRouter.post('/products/:id/prices/check', async (req, res) => {
  res.json(await checkPrice(req.auth!, id(req.params.id), req.body));
});
catalogueAdminRouter.post('/products/:id/prices', idempotent('price.create'), async (req, res) => {
  res.json(await createPrice(req, req.auth!, id(req.params.id), req.body));
});
catalogueAdminRouter.get('/products/:id/prices/:priceId', async (req, res) => {
  res.json(await getPrice(req.auth!, id(req.params.id), id(req.params.priceId)));
});
catalogueAdminRouter.post('/products/:id/prices/:priceId/cancel', async (req, res) => {
  res.json(await cancelPrice(req, req.auth!, id(req.params.id), id(req.params.priceId)));
});

// ---- P-58 Product corrections ----
catalogueAdminRouter.get('/corrections', async (_req, res) => {
  res.json({ items: await correctionQueue() });
});
catalogueAdminRouter.post('/corrections/:id/accept', async (req, res) => {
  res.json(await decideCorrection(req, req.auth!, id(req.params.id), true, req.body));
});
catalogueAdminRouter.post('/corrections/:id/reject', async (req, res) => {
  res.json(await decideCorrection(req, req.auth!, id(req.params.id), false, req.body));
});
