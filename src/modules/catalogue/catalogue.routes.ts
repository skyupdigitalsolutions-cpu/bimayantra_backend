// /api/v1/catalogue — the catalogue as advisors and assistants see it (verified products plus the account's
// own). Own products, prices and commission are the advisor's only; assistants view (permission table).
import { Router } from 'express';
import { authenticate, requireRole, requireWritable } from '../../http/auth.js';
import { idempotent } from '../../http/idempotency.js';
import { correctionFields, myCorrections, submitCorrection } from './corrections.service.js';
import { acceptHigh, applyJob, getJob, retryJob, saveDecisions, startForOwn } from './ocr.service.js';
import { cancelPrice, checkPrice, createPrice, getPrice, listPrices, rateTemplateCsv, referencePrice } from './prices.service.js';
import { createOwn, detailForAccount, editOwn, listForAccount, productFormOptions, saveCommercials, setOwnStatus, useCurrentTemplate } from './products.service.js';

const q = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const id = (v: unknown) => String(v);

export const catalogueRouter = Router();
catalogueRouter.use(authenticate(), requireRole('ADV', 'AST'));
const adv = [requireRole('ADV'), requireWritable];

catalogueRouter.get('/products', async (req, res) => {
  res.json({ items: await listForAccount(req.auth!, { q: q(req.query.q), typeId: q(req.query.typeId), insurerId: q(req.query.insurerId), kind: q(req.query.kind) }) });
});
catalogueRouter.get('/options', async (_req, res) => {
  res.json(await productFormOptions());
});
catalogueRouter.get('/products/:id', async (req, res) => {
  res.json(await detailForAccount(req.auth!, id(req.params.id)));
});

// ---- Own products (P-22) ----
catalogueRouter.post('/my-products', ...adv, idempotent('own-product.create'), async (req, res) => {
  res.json(await createOwn(req, req.auth!, req.body));
});
catalogueRouter.post('/my-products/:id', ...adv, async (req, res) => {
  res.json(await editOwn(req, req.auth!, id(req.params.id), req.body));
});
catalogueRouter.post('/my-products/:id/status', ...adv, async (req, res) => {
  res.json(await setOwnStatus(req, req.auth!, id(req.params.id), req.body));
});
catalogueRouter.post('/product-versions/:id/use-current-template', ...adv, async (req, res) => {
  res.json(await useCurrentTemplate(req, req.auth!, id(req.params.id), req.body));
});

// ---- My commercials ----
catalogueRouter.post('/products/:id/commercials', ...adv, async (req, res) => {
  res.json(await saveCommercials(req, req.auth!, id(req.params.id), req.body));
});

// ---- My prices (P-24) ----
catalogueRouter.get('/products/:id/prices', requireRole('ADV'), async (req, res) => {
  res.json(await listPrices(req.auth!, id(req.params.id)));
});
catalogueRouter.get('/products/:id/prices/template.csv', requireRole('ADV'), async (req, res) => {
  const t = await rateTemplateCsv(req.auth!, id(req.params.id));
  res.type('text/csv').attachment(t.name).send(t.csv);
});
catalogueRouter.get('/products/:id/prices/reference', requireRole('ADV'), async (req, res) => {
  res.json(await referencePrice(req.auth!, id(req.params.id)));
});
catalogueRouter.post('/products/:id/prices/check', requireRole('ADV'), async (req, res) => {
  res.json(await checkPrice(req.auth!, id(req.params.id), req.body));
});
catalogueRouter.post('/products/:id/prices', ...adv, idempotent('price.create'), async (req, res) => {
  res.json(await createPrice(req, req.auth!, id(req.params.id), req.body));
});
catalogueRouter.get('/products/:id/prices/:priceId', requireRole('ADV'), async (req, res) => {
  res.json(await getPrice(req.auth!, id(req.params.id), id(req.params.priceId)));
});
catalogueRouter.post('/products/:id/prices/:priceId/cancel', ...adv, async (req, res) => {
  res.json(await cancelPrice(req, req.auth!, id(req.params.id), id(req.params.priceId)));
});

// ---- Brochure preview for own products (P-22 step 2, P-23) ----
catalogueRouter.post('/ocr', ...adv, idempotent('ocr.start'), async (req, res) => {
  res.json(await startForOwn(req, req.auth!, req.body));
});
catalogueRouter.get('/ocr/:id', requireRole('ADV'), async (req, res) => {
  res.json(await getJob(req.auth!, id(req.params.id)));
});
catalogueRouter.post('/ocr/:id/decisions', ...adv, async (req, res) => {
  res.json(await saveDecisions(req, req.auth!, id(req.params.id), req.body));
});
catalogueRouter.post('/ocr/:id/accept-high', ...adv, async (req, res) => {
  res.json(await acceptHigh(req, req.auth!, id(req.params.id), req.body));
});
catalogueRouter.post('/ocr/:id/apply', ...adv, async (req, res) => {
  res.json(await applyJob(req, req.auth!, id(req.params.id), req.body));
});
catalogueRouter.post('/ocr/:id/retry', ...adv, async (req, res) => {
  res.json(await retryJob(req, req.auth!, id(req.params.id)));
});

// ---- Suggest a correction (P-58) ----
catalogueRouter.get('/products/:id/correction-fields', requireRole('ADV'), async (req, res) => {
  res.json({ items: await correctionFields(id(req.params.id)) });
});
catalogueRouter.post('/products/:id/corrections', ...adv, idempotent('correction.create'), async (req, res) => {
  res.json(await submitCorrection(req, req.auth!, id(req.params.id), req.body));
});
catalogueRouter.get('/corrections', requireRole('ADV'), async (req, res) => {
  res.json({ items: await myCorrections(req.auth!, q(req.query.productId)) });
});
