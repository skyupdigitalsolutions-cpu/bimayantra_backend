// Phase 5 routes: best fit (P-26), quotations (P-27 to P-29), comparisons (P-30), payments (P-31, P-32),
// proposals (P-55) and policies (P-33 to P-36), plus the customer's public view links (P-28).
// Advisor and assistants per Section 3.2; advisor-only actions are checked in the services.
import { Router } from 'express';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { advisorProfiles, insurers } from '../../db/schema.js';
import { authenticate, requireRole, requireWritable } from '../../http/auth.js';
import { idempotent } from '../../http/idempotency.js';
import { notFound } from '../../lib/errors.js';
import { getFile, readStored } from '../files/files.service.js';
import { bestFitOptions, chooseFromRanking, rank } from '../quotations/bestfit.service.js';
import {
  cancelComparison,
  chooseProduct,
  createLinkedQuotation,
  deleteComparison,
  editComparison,
  generateComparison,
  getComparison,
  listComparisons,
  publicComparison,
  saveComparison,
  shareComparison,
  startComparison,
} from '../quotations/comparisons.service.js';
import {
  cancelRevision,
  deleteDraft,
  editRevision,
  generate,
  getQuotation,
  getRevision,
  listQuotations,
  markAccepted,
  markRejected,
  publicQuotation,
  quotationOptions,
  reviseQuotation,
  saveDraft,
  shareRevision,
  startQuotation,
} from '../quotations/quotations.service.js';
import { addPaymentLink, closeAwaiting, paymentOptions, recordPayment, replaceLink, undoPayment } from '../payments/payments.service.js';
import { cancelPolicy, checkNominees, correctPolicy, getPolicy, issuePolicy, listPolicies, policyOptions, recordExisting, saveNominees } from './policies.service.js';
import { cancelProposal, declineProposal, getProposal, listProposals, saveProposal, startProposal, submitProposal } from './proposals.service.js';
import './register.js';

const q = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const id = (p: unknown) => String(p);

// ---------- best fit ----------
export const bestFitRouter = Router();
bestFitRouter.use(authenticate(), requireRole('ADV', 'AST'));
bestFitRouter.get('/options', async (req, res) => res.json(await bestFitOptions(req.auth!, typeof req.query.typeId === 'string' ? req.query.typeId : '')));
bestFitRouter.post('/rank', async (req, res) => res.json(await rank(req, req.auth!, req.body)));
bestFitRouter.post('/:logId/choose', async (req, res) => res.json(await chooseFromRanking(req.auth!, id(req.params.logId), req.body)));

// ---------- quotations ----------
export const quotationsRouter = Router();
quotationsRouter.use(authenticate(), requireRole('ADV', 'AST'));
quotationsRouter.get('/options', (_req, res) => res.json({ ...quotationOptions(), payment: paymentOptions() }));
quotationsRouter.get('/', async (req, res) => res.json(await listQuotations(req.auth!, { status: q(req.query.status), q: q(req.query.q), customerId: q(req.query.customerId), productId: q(req.query.productId), page: Number(req.query.page) || 1 })));
quotationsRouter.post('/', requireWritable, idempotent('quotation.start', { required: true }), async (req, res) => res.json(await startQuotation(req, req.auth!, req.body)));
quotationsRouter.get('/q/:qid', async (req, res) => res.json(await getQuotation(req.auth!, id(req.params.qid))));
quotationsRouter.get('/revisions/:rid', async (req, res) => res.json(await getRevision(req.auth!, id(req.params.rid))));
quotationsRouter.post('/revisions/:rid/draft', requireWritable, async (req, res) => res.json(await saveDraft(req, req.auth!, id(req.params.rid), req.body)));
quotationsRouter.post('/revisions/:rid/generate', requireWritable, idempotent('quotation.generate', { required: true }), async (req, res) => res.json(await generate(req, req.auth!, id(req.params.rid), req.body)));
quotationsRouter.post('/revisions/:rid/edit', requireWritable, async (req, res) => res.json(await editRevision(req, req.auth!, id(req.params.rid), req.body)));
quotationsRouter.post('/revisions/:rid/revise', requireWritable, idempotent('quotation.revise'), async (req, res) => res.json(await reviseQuotation(req, req.auth!, id(req.params.rid), req.body)));
quotationsRouter.post('/revisions/:rid/accept', requireWritable, async (req, res) => res.json(await markAccepted(req, req.auth!, id(req.params.rid), req.body)));
quotationsRouter.post('/revisions/:rid/reject', requireWritable, async (req, res) => res.json(await markRejected(req, req.auth!, id(req.params.rid), req.body)));
quotationsRouter.post('/revisions/:rid/cancel', requireWritable, async (req, res) => res.json(await cancelRevision(req, req.auth!, id(req.params.rid), req.body)));
quotationsRouter.post('/revisions/:rid/delete', requireWritable, async (req, res) => res.json(await deleteDraft(req, req.auth!, id(req.params.rid), req.body)));
quotationsRouter.post('/revisions/:rid/share', requireWritable, idempotent('quotation.share', { required: true }), async (req, res) => res.json(await shareRevision(req, req.auth!, id(req.params.rid), req.body)));
quotationsRouter.post('/revisions/:rid/payment-link', requireWritable, idempotent('payment.link', { required: true }), async (req, res) => res.json(await addPaymentLink(req, req.auth!, id(req.params.rid), req.body)));
quotationsRouter.post('/revisions/:rid/payment', requireWritable, idempotent('payment.record', { required: true }), async (req, res) => res.json(await recordPayment(req, req.auth!, id(req.params.rid), req.body)));
quotationsRouter.post('/revisions/:rid/proposal', requireWritable, idempotent('proposal.start', { required: true }), async (req, res) => res.json(await startProposal(req, req.auth!, id(req.params.rid))));

// ---------- comparisons ----------
export const comparisonsRouter = Router();
comparisonsRouter.use(authenticate(), requireRole('ADV', 'AST'));
comparisonsRouter.get('/', async (req, res) => res.json(await listComparisons(req.auth!, { status: q(req.query.status), q: q(req.query.q), customerId: q(req.query.customerId), page: Number(req.query.page) || 1 })));
comparisonsRouter.post('/', requireWritable, idempotent('comparison.start', { required: true }), async (req, res) => res.json(await startComparison(req, req.auth!, req.body)));
comparisonsRouter.get('/:id', async (req, res) => res.json(await getComparison(req.auth!, id(req.params.id))));
comparisonsRouter.post('/:id/draft', requireWritable, async (req, res) => res.json(await saveComparison(req, req.auth!, id(req.params.id), req.body)));
comparisonsRouter.post('/:id/generate', requireWritable, idempotent('comparison.generate', { required: true }), async (req, res) => res.json(await generateComparison(req, req.auth!, id(req.params.id), req.body)));
comparisonsRouter.post('/:id/edit', requireWritable, async (req, res) => res.json(await editComparison(req, req.auth!, id(req.params.id), req.body)));
comparisonsRouter.post('/:id/cancel', requireWritable, async (req, res) => res.json(await cancelComparison(req, req.auth!, id(req.params.id), req.body)));
comparisonsRouter.post('/:id/delete', requireWritable, async (req, res) => res.json(await deleteComparison(req, req.auth!, id(req.params.id), req.body)));
comparisonsRouter.post('/:id/share', requireWritable, idempotent('comparison.share', { required: true }), async (req, res) => res.json(await shareComparison(req, req.auth!, id(req.params.id), req.body)));
comparisonsRouter.post('/:id/choose', requireWritable, idempotent('comparison.choose', { required: true }), async (req, res) => res.json(await chooseProduct(req, req.auth!, id(req.params.id), req.body)));
comparisonsRouter.post('/:id/create-quotation', requireWritable, idempotent('comparison.quote', { required: true }), async (req, res) => res.json(await createLinkedQuotation(req, req.auth!, id(req.params.id))));

// ---------- payments ----------
export const paymentsRouter = Router();
paymentsRouter.use(authenticate(), requireRole('ADV', 'AST'));
paymentsRouter.post('/:id/replace', requireWritable, idempotent('payment.replace', { required: true }), async (req, res) => res.json(await replaceLink(req, req.auth!, id(req.params.id), req.body)));
paymentsRouter.post('/:id/fail', requireWritable, async (req, res) => res.json(await closeAwaiting(req, req.auth!, id(req.params.id), 'FAILED', req.body)));
paymentsRouter.post('/:id/expire', requireWritable, async (req, res) => res.json(await closeAwaiting(req, req.auth!, id(req.params.id), 'EXPIRED', req.body)));
paymentsRouter.post('/:id/undo', requireWritable, async (req, res) => res.json(await undoPayment(req, req.auth!, id(req.params.id), req.body)));

// ---------- proposals ----------
export const proposalsRouter = Router();
proposalsRouter.use(authenticate(), requireRole('ADV', 'AST'));
proposalsRouter.get('/', async (req, res) => res.json(await listProposals(req.auth!, { tab: q(req.query.tab), customerId: q(req.query.customerId) })));
proposalsRouter.get('/:id', async (req, res) => res.json(await getProposal(req.auth!, id(req.params.id))));
proposalsRouter.post('/:id/draft', requireWritable, async (req, res) => res.json(await saveProposal(req, req.auth!, id(req.params.id), req.body)));
proposalsRouter.post('/:id/submit', requireWritable, idempotent('proposal.submit', { required: true }), async (req, res) => res.json(await submitProposal(req, req.auth!, id(req.params.id), req.body)));
proposalsRouter.post('/:id/decline', requireWritable, async (req, res) => res.json(await declineProposal(req, req.auth!, id(req.params.id), req.body)));
proposalsRouter.post('/:id/cancel', requireWritable, async (req, res) => res.json(await cancelProposal(req, req.auth!, id(req.params.id), req.body)));

// ---------- policies ----------
export const policiesRouter = Router();
policiesRouter.use(authenticate(), requireRole('ADV', 'AST'));
policiesRouter.get('/options', (_req, res) => res.json(policyOptions()));
// P-34: any ACTIVE insurer (no mapping needed for an existing policy)
policiesRouter.get('/insurers', async (_req, res) => {
  res.json({ items: await db.select({ id: insurers.id, name: insurers.name }).from(insurers).where(eq(insurers.status, 'ACTIVE')).orderBy(asc(insurers.name)) });
});
policiesRouter.get('/', async (req, res) => res.json(await listPolicies(req.auth!, { status: q(req.query.status), q: q(req.query.q), customerId: q(req.query.customerId), productId: q(req.query.productId), page: Number(req.query.page) || 1 })));
policiesRouter.post('/existing', requireWritable, idempotent('policy.existing', { required: true }), async (req, res) => res.json(await recordExisting(req, req.auth!, req.body)));
policiesRouter.get('/:id', async (req, res) => res.json(await getPolicy(req.auth!, id(req.params.id))));
policiesRouter.post('/:id/issue', requireWritable, idempotent('policy.issue', { required: true }), async (req, res) => res.json(await issuePolicy(req, req.auth!, id(req.params.id), req.body)));
policiesRouter.post('/:id/nominees/check', async (req, res) => res.json(await checkNominees(req.auth!, id(req.params.id), req.body)));
policiesRouter.post('/:id/nominees', requireWritable, idempotent('policy.nominees', { required: true }), async (req, res) => res.json(await saveNominees(req, req.auth!, id(req.params.id), req.body)));
policiesRouter.post('/:id/correct', requireWritable, async (req, res) => res.json(await correctPolicy(req, req.auth!, id(req.params.id), req.body)));
policiesRouter.post('/:id/cancel', requireWritable, async (req, res) => res.json(await cancelPolicy(req, req.auth!, id(req.params.id), req.body)));

// ---------- public view links (no login; hidden from search engines) ----------
export const publicSalesRouter = Router();
publicSalesRouter.use((_req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});
publicSalesRouter.get('/quotations/:token', async (req, res) => res.json(await publicQuotation(id(req.params.token))));
publicSalesRouter.get('/comparisons/:token', async (req, res) => res.json(await publicComparison(id(req.params.token))));
/** The advisor's business logo for public pages (logo only; no other file is public). */
publicSalesRouter.get('/logo/:accountId', async (req, res) => {
  const accountId = id(req.params.accountId);
  if (!/^[0-9a-f-]{36}$/.test(accountId)) throw notFound();
  const [p] = await db.select({ logo: advisorProfiles.logoFileId }).from(advisorProfiles).where(and(eq(advisorProfiles.accountId, accountId)));
  const f = p?.logo ? await getFile(p.logo) : undefined;
  if (!f || f.purpose !== 'BUSINESS_LOGO') throw notFound();
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(await readStored(f.storageKey));
});
