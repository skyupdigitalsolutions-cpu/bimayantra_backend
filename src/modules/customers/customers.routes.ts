// /api/v1/customers — P-15 to P-19 and P-54 (vehicles). Advisor and assistants; PAN/Aadhaar reveal,
// deactivation and document labels are the advisor's only (checked in the services).
import { Router } from 'express';
import { authenticate, requireRole, requireWritable } from '../../http/auth.js';
import { idempotent } from '../../http/idempotency.js';
import { consentGrid, consentHistoryFor, recordConsent, withdrawConsent } from './consent.service.js';
import {
  addLink,
  checkCustomerDuplicate,
  coverMap,
  createCustomer,
  customerActivity,
  customerOptions,
  deactivateCustomer,
  editCustomer,
  getCustomer,
  listCustomers,
  listLinks,
  reactivateCustomer,
  revealIdentity,
  saveDefaultNominee,
  saveIdentity,
} from './customers.service.js';
import { addMember, editMember, listFamily, setMemberActive } from './family.service.js';
import { importCustomers, readListPhoto } from './import.service.js';
import { exportCustomers } from '../leads/export.service.js';
import { customerJourney } from '../dashboard/guide.service.js';
import { listDocuments } from '../documents/documents.service.js';
import { addVehicle, addVehicleFile, listVehicles, markSold } from '../vehicles/vehicles.service.js';

const q = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const p = (v: unknown) => String(v);
export const customersRouter = Router();
customersRouter.use(authenticate(), requireRole('ADV', 'AST'));
const w = requireWritable;

customersRouter.get('/options', (_req, res) => {
  res.json(customerOptions());
});
customersRouter.get('/check-duplicate', async (req, res) => {
  res.json(await checkCustomerDuplicate(req.auth!, { mobile: q(req.query.mobile), name: q(req.query.name), exceptId: q(req.query.exceptId) }));
});
// Download Excel: customers + family members + policies (advisor only, audited)
customersRouter.get('/export', requireRole('ADV'), async (req, res) => {
  res.json(await exportCustomers(req, req.auth!, { q: q(req.query.q), status: q(req.query.status) }));
});
customersRouter.get('/', async (req, res) => {
  res.json(await listCustomers(req.auth!, { q: q(req.query.q), status: q(req.query.status), page: Number(req.query.page) || 1 }));
});
// Bulk customers from Excel / CSV (rows read by the website; check=true only checks)
customersRouter.post('/import/photo', w, async (req, res) => {
  res.json(await readListPhoto(req.auth!, req.body));
});
customersRouter.post('/import', w, async (req, res) => {
  res.json(await importCustomers(req, req.auth!, req.body));
});
customersRouter.post('/', w, idempotent('customer.create', { required: true }), async (req, res) => {
  res.json(await createCustomer(req, req.auth!, req.body));
});
// "What to do next" for one customer
customersRouter.get('/:id/journey', async (req, res) => {
  res.json(await customerJourney(req.auth!.accountId!, p(req.params.id)));
});
customersRouter.get('/:id', async (req, res) => {
  res.json(await getCustomer(req.auth!, p(req.params.id)));
});
customersRouter.post('/:id', w, async (req, res) => {
  res.json(await editCustomer(req, req.auth!, p(req.params.id), req.body));
});
customersRouter.get('/:id/activity', async (req, res) => {
  res.json(await customerActivity(req.auth!, p(req.params.id)));
});
customersRouter.post('/:id/identity', w, async (req, res) => {
  res.json(await saveIdentity(req, req.auth!, p(req.params.id), req.body));
});
customersRouter.post('/:id/reveal', async (req, res) => {
  res.json(await revealIdentity(req, req.auth!, p(req.params.id), (req.body as { field?: unknown })?.field));
});
customersRouter.post('/:id/default-nominee', w, async (req, res) => {
  res.json(await saveDefaultNominee(req, req.auth!, p(req.params.id), req.body));
});
customersRouter.get('/:id/links', async (req, res) => {
  res.json(await listLinks(req.auth!, p(req.params.id)));
});
customersRouter.post('/:id/links', w, async (req, res) => {
  res.json(await addLink(req, req.auth!, p(req.params.id), req.body));
});
customersRouter.get('/:id/cover-map', async (req, res) => {
  res.json(await coverMap(req.auth!, p(req.params.id)));
});
customersRouter.post('/:id/deactivate', w, async (req, res) => {
  res.json(await deactivateCustomer(req, req.auth!, p(req.params.id), req.body));
});
customersRouter.post('/:id/reactivate', w, async (req, res) => {
  res.json(await reactivateCustomer(req, req.auth!, p(req.params.id), req.body));
});
// P-16 family
customersRouter.get('/:id/family', async (req, res) => {
  res.json(await listFamily(req.auth!, p(req.params.id)));
});
customersRouter.post('/:id/family', w, idempotent('family.add'), async (req, res) => {
  res.json(await addMember(req, req.auth!, p(req.params.id), req.body));
});
customersRouter.post('/:id/family/:memberId', w, async (req, res) => {
  res.json(await editMember(req, req.auth!, p(req.params.id), p(req.params.memberId), req.body));
});
customersRouter.post('/:id/family/:memberId/deactivate', w, async (req, res) => {
  res.json(await setMemberActive(req, req.auth!, p(req.params.id), p(req.params.memberId), false, req.body));
});
customersRouter.post('/:id/family/:memberId/activate', w, async (req, res) => {
  res.json(await setMemberActive(req, req.auth!, p(req.params.id), p(req.params.memberId), true, req.body));
});
// P-17 consent
customersRouter.get('/:id/consent', async (req, res) => {
  res.json(await consentGrid(req.auth!, p(req.params.id)));
});
customersRouter.get('/:id/consent/history', async (req, res) => {
  res.json(await consentHistoryFor(req.auth!, p(req.params.id)));
});
customersRouter.post('/:id/consent/record', w, async (req, res) => {
  res.json(await recordConsent(req, req.auth!, p(req.params.id), req.body));
});
customersRouter.post('/:id/consent/withdraw', w, async (req, res) => {
  res.json(await withdrawConsent(req, req.auth!, p(req.params.id), req.body));
});
// P-18 documents of this customer
customersRouter.get('/:id/documents', async (req, res) => {
  res.json(await listDocuments(req.auth!, p(req.params.id)));
});
// P-54 vehicles
customersRouter.get('/:id/vehicles', async (req, res) => {
  res.json(await listVehicles(req.auth!, p(req.params.id)));
});
customersRouter.post('/:id/vehicles', w, idempotent('vehicle.add'), async (req, res) => {
  res.json(await addVehicle(req, req.auth!, p(req.params.id), req.body));
});
customersRouter.post('/:id/vehicles/:vehicleId/files', w, async (req, res) => {
  res.json(await addVehicleFile(req, req.auth!, p(req.params.id), p(req.params.vehicleId), req.body));
});
customersRouter.post('/:id/vehicles/:vehicleId/sold', w, async (req, res) => {
  res.json(await markSold(req, req.auth!, p(req.params.id), p(req.params.vehicleId), req.body));
});
