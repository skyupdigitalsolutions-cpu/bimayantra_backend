// Phase 6 routes: renewals (P-37, P-38), communications and greetings (P-39 to P-43), wallet (P-56),
// referral (P-44 to P-46), plans (P-47), SkyUp users (P-48), configuration (P-49), audit (P-50),
// accounts (P-51), support grants (P-57) and account export (P-52).
import { Router, type RequestHandler } from 'express';
import { authenticate, requireRole, requireWritable } from '../../http/auth.js';
import { idempotent } from '../../http/idempotency.js';
import { forbidden } from '../../lib/errors.js';
import { getRenewal, listRenewals, logContact, markNotRenewing, recordPremium, renewalQuotation, reopenRenewal, setPaused } from '../policies/renewals.service.js';
import { cancelMessage, listMessages, resendMessage } from '../messages/messages.service.js';
import { greetingSettings, saveGreetingSettings, setExcluded } from '../messages/greetings.service.js';
import { approveTemplate, createTemplate, editTemplate, getTemplate, listTemplates, rejectTemplate, setTemplateActive, submitTemplate } from '../messages/templates.service.js';
import { manualCredit, startRecharge, walletView } from '../billing/wallet.service.js';
import { planView, recordOfflinePayment, setWhatsappNumber, startPlanPayment } from '../billing/subscription.service.js';
import { completeTestOrder, orderStatus } from '../billing/gateway.js';
import { addReferrer, listReferrers, newLink, referralForm, referrerDashboard, setReferrerActive, submitReferral } from '../referral/referral.service.js';
import { accountSummary, addStaff, changeAccountStatus, changeStaff, configHistory, decideConfigChange, exportAudit, listAccounts, listAudit, listConfig, listStaff, requestConfigChange, SUSPEND_REASONS } from './admin.service.js';
import { endGrant, giveGrant, listGrants, myGrants, supportCustomer, supportCustomers, supportPeople } from './support.service.js';
import { downloadExport, listExports, requestExport } from './export.service.js';

const q = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const p = (v: unknown) => String(v);
const query = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, q(v)]));
const advOnly: RequestHandler = (req, _res, next) => {
  if (req.auth?.role !== 'ADV') throw forbidden();
  next();
};

// ---------- renewals ----------
export const renewalsRouter = Router();
renewalsRouter.use(authenticate(), requireRole('ADV', 'AST'));
renewalsRouter.get('/', async (req, res) => res.json(await listRenewals(req.auth!, { window: q(req.query.window), from: q(req.query.from), to: q(req.query.to), status: q(req.query.status), insurerId: q(req.query.insurerId), typeId: q(req.query.typeId), customerId: q(req.query.customerId), page: Number(req.query.page) || 1 })));
renewalsRouter.get('/:id', async (req, res) => res.json(await getRenewal(req.auth!, p(req.params.id))));
renewalsRouter.post('/:id/contact', requireWritable, async (req, res) => res.json(await logContact(req, req.auth!, p(req.params.id), req.body)));
renewalsRouter.post('/:id/quotation', requireWritable, idempotent('renewal.quote', { required: true }), async (req, res) => res.json(await renewalQuotation(req, req.auth!, p(req.params.id), req.body)));
renewalsRouter.post('/:id/premium', requireWritable, advOnly, idempotent('renewal.premium', { required: true }), async (req, res) => res.json(await recordPremium(req, req.auth!, p(req.params.id), req.body)));
renewalsRouter.post('/:id/not-renewing', requireWritable, async (req, res) => res.json(await markNotRenewing(req, req.auth!, p(req.params.id), req.body)));
renewalsRouter.post('/:id/reopen', requireWritable, async (req, res) => res.json(await reopenRenewal(req, req.auth!, p(req.params.id), req.body)));
renewalsRouter.post('/:id/pause', requireWritable, async (req, res) => res.json(await setPaused(req, req.auth!, p(req.params.id), true, req.body)));
renewalsRouter.post('/:id/resume', requireWritable, async (req, res) => res.json(await setPaused(req, req.auth!, p(req.params.id), false, req.body)));

// ---------- communications ----------
export const communicationsRouter = Router();
communicationsRouter.use(authenticate(), requireRole('ADV', 'AST'));
communicationsRouter.get('/', async (req, res) => res.json(await listMessages(req.auth!, { ...query({ tab: req.query.tab, channel: req.query.channel, purpose: req.query.purpose, status: req.query.status, from: req.query.from, to: req.query.to, customerId: req.query.customerId }), page: Number(req.query.page) || 1 })));
communicationsRouter.post('/:id/cancel', requireWritable, advOnly, async (req, res) => res.json(await cancelMessage(req, req.auth!, p(req.params.id))));
communicationsRouter.post('/:id/resend', requireWritable, advOnly, idempotent('message.resend', { required: true }), async (req, res) => res.json(await resendMessage(req, req.auth!, p(req.params.id))));
communicationsRouter.get('/templates', async (req, res) => res.json(await listTemplates(req.auth!)));
communicationsRouter.get('/greetings', advOnly, async (req, res) => res.json(await greetingSettings(req.auth!)));
communicationsRouter.post('/greetings', requireWritable, advOnly, async (req, res) => res.json(await saveGreetingSettings(req, req.auth!, req.body)));
communicationsRouter.post('/greetings/exclusion', requireWritable, advOnly, async (req, res) => res.json(await setExcluded(req, req.auth!, req.body)));

// ---------- templates (SkyUp) ----------
export const templatesRouter = Router();
templatesRouter.use(authenticate(), requireRole('STF', 'ADM'));
templatesRouter.get('/', async (req, res) => res.json(await listTemplates(req.auth!)));
templatesRouter.post('/', idempotent('template.create', { required: true }), async (req, res) => res.json(await createTemplate(req, req.auth!, req.body)));
templatesRouter.get('/:id', async (req, res) => res.json(await getTemplate(req.auth!, p(req.params.id))));
templatesRouter.post('/:id', async (req, res) => res.json(await editTemplate(req, req.auth!, p(req.params.id), req.body)));
templatesRouter.post('/:id/submit', async (req, res) => res.json(await submitTemplate(req, req.auth!, p(req.params.id), req.body)));
templatesRouter.post('/:id/approve', idempotent('template.approve', { required: true }), async (req, res) => res.json(await approveTemplate(req, req.auth!, p(req.params.id), req.body)));
templatesRouter.post('/:id/reject', async (req, res) => res.json(await rejectTemplate(req, req.auth!, p(req.params.id), req.body)));
templatesRouter.post('/:id/deactivate', async (req, res) => res.json(await setTemplateActive(req, req.auth!, p(req.params.id), false, req.body)));
templatesRouter.post('/:id/activate', async (req, res) => res.json(await setTemplateActive(req, req.auth!, p(req.params.id), true, req.body)));

// ---------- wallet, plans, gateway ----------
export const billingRouter = Router();
billingRouter.use(authenticate(), requireRole('ADV'));
billingRouter.get('/wallet', async (req, res) => res.json(await walletView(req.auth!)));
billingRouter.post('/wallet/recharge', requireWritable, idempotent('wallet.recharge', { required: true }), async (req, res) => res.json(await startRecharge(req, req.auth!, req.body)));
billingRouter.get('/plan', async (req, res) => res.json(await planView(req.auth!)));
// Paying for a plan must work in read-only mode: it is how full access comes back
billingRouter.post('/plan/pay', idempotent('plan.pay', { required: true }), async (req, res) => res.json(await startPlanPayment(req, req.auth!, req.body)));
billingRouter.get('/orders/:id', async (req, res) => {
  const o = await orderStatus(p(req.params.id), req.auth!.accountId!);
  res.json({ id: o.id, purpose: o.purpose, status: o.status, amount: o.amount });
});
billingRouter.post('/orders/:id/test-complete', async (req, res) => {
  await completeTestOrder(p(req.params.id), (req.body as { outcome?: string })?.outcome === 'failure' ? 'failure' : 'success', req.auth!.accountId!);
  res.json({ ok: true });
});

// ---------- referral ----------
export const referrersRouter = Router();
referrersRouter.use(authenticate(), requireRole('ADV'));
referrersRouter.get('/', async (req, res) => res.json(await listReferrers(req.auth!)));
referrersRouter.post('/', requireWritable, idempotent('referrer.add', { required: true }), async (req, res) => res.json(await addReferrer(req, req.auth!, req.body)));
referrersRouter.post('/:id/disable', requireWritable, async (req, res) => res.json(await setReferrerActive(req, req.auth!, p(req.params.id), false)));
referrersRouter.post('/:id/enable', requireWritable, async (req, res) => res.json(await setReferrerActive(req, req.auth!, p(req.params.id), true)));
referrersRouter.post('/:id/new-link', requireWritable, async (req, res) => res.json(await newLink(req, req.auth!, p(req.params.id))));

export const referrerRouter = Router();
referrerRouter.use(authenticate(), requireRole('REF'));
referrerRouter.get('/dashboard', async (req, res) => res.json(await referrerDashboard(req.auth!)));

export const publicReferralRouter = Router();
publicReferralRouter.get('/referral/:code', async (req, res) => res.json(await referralForm(p(req.params.code))));
publicReferralRouter.post('/referral/:code', idempotent('referral.submit'), async (req, res) => res.json(await submitReferral(req, p(req.params.code), req.body)));

// ---------- advisor: support grants, export, activity log ----------
export const advisorAdminRouter = Router();
advisorAdminRouter.use(authenticate(), requireRole('ADV'));
advisorAdminRouter.get('/support-grants', async (req, res) => res.json({ ...(await listGrants(req.auth!)), people: (await supportPeople()).items, maxHours: (await supportPeople()).maxHours }));
advisorAdminRouter.post('/support-grants', requireWritable, idempotent('grant.give', { required: true }), async (req, res) => res.json(await giveGrant(req, req.auth!, req.body)));
advisorAdminRouter.post('/support-grants/:id/end', async (req, res) => res.json(await endGrant(req, req.auth!, p(req.params.id))));
advisorAdminRouter.get('/exports', async (req, res) => res.json(await listExports(req.auth!)));
advisorAdminRouter.post('/exports', idempotent('export.request', { required: true }), async (req, res) => res.json(await requestExport(req, req.auth!, req.body)));
advisorAdminRouter.get('/exports/:id/download', async (req, res) => res.json(await downloadExport(req.auth!, p(req.params.id))));
advisorAdminRouter.get('/activity-log', async (req, res) => res.json(await listAudit(req.auth!, query(req.query as Record<string, unknown>))));
advisorAdminRouter.post('/activity-log/export', async (req, res) => res.json(await exportAudit(req, req.auth!, query(req.query as Record<string, unknown>))));

// ---------- SkyUp admin ----------
export const skyupAdminRouter = Router();
skyupAdminRouter.use(authenticate(), requireRole('STF', 'ADM'));
const admOnly: RequestHandler = (req, _res, next) => {
  if (req.auth?.role !== 'ADM') throw forbidden();
  next();
};
skyupAdminRouter.get('/users', admOnly, async (_req, res) => res.json(await listStaff()));
skyupAdminRouter.post('/users', admOnly, idempotent('staff.add', { required: true }), async (req, res) => res.json(await addStaff(req, req.auth!, req.body)));
skyupAdminRouter.post('/users/:id', admOnly, async (req, res) => res.json(await changeStaff(req, req.auth!, p(req.params.id), req.body)));
skyupAdminRouter.get('/config', admOnly, async (_req, res) => res.json(await listConfig()));
skyupAdminRouter.get('/config/history', admOnly, async (_req, res) => res.json(await configHistory()));
skyupAdminRouter.post('/config/:id', admOnly, async (req, res) => res.json(await requestConfigChange(req, req.auth!, p(req.params.id), req.body)));
skyupAdminRouter.post('/config-changes/:id/approve', admOnly, idempotent('config.approve', { required: true }), async (req, res) => res.json(await decideConfigChange(req, req.auth!, p(req.params.id), true, req.body)));
skyupAdminRouter.post('/config-changes/:id/reject', admOnly, async (req, res) => res.json(await decideConfigChange(req, req.auth!, p(req.params.id), false, req.body)));
skyupAdminRouter.get('/audit', async (req, res) => {
  // STF sees metadata only; ADM sees values with personal data masked (Section 3.2)
  const r = await listAudit(req.auth!, query(req.query));
  res.json(req.auth!.role === 'ADM' ? r : { ...r, items: r.items.map((i) => ({ ...i, oldValue: null, newValue: null })) });
});
skyupAdminRouter.post('/audit/export', admOnly, async (req, res) => res.json(await exportAudit(req, req.auth!, query(req.query as Record<string, unknown>))));
skyupAdminRouter.get('/accounts', async (req, res) => res.json({ ...(await listAccounts({ q: q(req.query.q), status: q(req.query.status), page: Number(req.query.page) || 1 })), suspendReasons: SUSPEND_REASONS }));
skyupAdminRouter.get('/accounts/:id', async (req, res) => res.json(await accountSummary(req.auth!, p(req.params.id))));
skyupAdminRouter.post('/accounts/:id/suspend', admOnly, async (req, res) => res.json(await changeAccountStatus(req, req.auth!, p(req.params.id), 'SUSPENDED', req.body)));
skyupAdminRouter.post('/accounts/:id/reactivate', admOnly, async (req, res) => res.json(await changeAccountStatus(req, req.auth!, p(req.params.id), 'ACTIVE', req.body)));
skyupAdminRouter.post('/accounts/:id/close', admOnly, async (req, res) => res.json(await changeAccountStatus(req, req.auth!, p(req.params.id), 'CLOSED', req.body)));
skyupAdminRouter.post('/accounts/:id/offline-payment', admOnly, idempotent('plan.offline', { required: true }), async (req, res) => res.json(await recordOfflinePayment(req, req.auth!, p(req.params.id), req.body)));
skyupAdminRouter.post('/accounts/:id/wallet-credit', admOnly, idempotent('wallet.credit', { required: true }), async (req, res) => res.json(await manualCredit(req, req.auth!, p(req.params.id), req.body)));
skyupAdminRouter.post('/accounts/:id/whatsapp-number', admOnly, async (req, res) => res.json(await setWhatsappNumber(req, req.auth!, p(req.params.id), req.body)));
skyupAdminRouter.get('/support/grants', async (req, res) => res.json(await myGrants(req.auth!)));
skyupAdminRouter.get('/support/:accountId/customers', async (req, res) => res.json(await supportCustomers(req, req.auth!, p(req.params.accountId), q(req.query.q))));
skyupAdminRouter.get('/support/:accountId/customers/:customerId', async (req, res) => res.json(await supportCustomer(req, req.auth!, p(req.params.accountId), p(req.params.customerId))));
