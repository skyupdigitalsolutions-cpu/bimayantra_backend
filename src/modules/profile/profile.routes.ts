// /api/v1/profile (P-05), /api/v1/kyc (P-06), /api/v1/insurers (P-07), /api/v1/insurance-types
import { Router } from 'express';
import { asc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { insuranceTypes } from '../../db/schema.js';
import { authenticate, requireRole, requireWritable } from '../../http/auth.js';
import { idempotent } from '../../http/idempotency.js';
import { fieldError } from '../../lib/errors.js';
import { addMapping, availableInsurers, editMapping, listMappings, setMappingStatus } from '../insurers/mappings.service.js';
import { getOwnKyc, kycSummary, submitKyc } from '../kyc/kyc.service.js';
import { SECTIONS, getProfile, saveSection, type Section } from './profile.service.js';

export const profileRouter = Router();
// Guards per route: this router sits on /api/v1, so unknown paths must still reach the 404 handler
const g = [authenticate(), requireRole('ADV', 'AST')];

// ---- P-05 ----
profileRouter.get('/profile', ...g, async (req, res) => {
  res.json(await getProfile(req.auth!));
});
profileRouter.post('/profile/sections/:section', ...g, requireRole('ADV'), requireWritable, async (req, res) => {
  const section = String(req.params.section) as Section;
  if (!SECTIONS.includes(section)) throw fieldError('section', 'VAL-22');
  res.json(await saveSection(req, req.auth!, section, req.body));
});

// ---- P-06 (advisor side). Assistants see the status and a masked PAN only (GR-36) ----
profileRouter.get('/kyc', ...g, async (req, res) => {
  const a = req.auth!;
  res.json(a.role === 'ADV' ? await getOwnKyc(a) : await kycSummary(a.accountId!));
});
profileRouter.post('/kyc', ...g, requireRole('ADV'), requireWritable, idempotent('kyc.submit'), async (req, res) => {
  res.json(await submitKyc(req, req.auth!, req.body));
});

// ---- P-07 ----
profileRouter.get('/insurers/mine', ...g, async (req, res) => {
  res.json({ items: await listMappings(req.auth!.accountId!) });
});
profileRouter.get('/insurers/available', ...g, async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 60) : undefined;
  res.json({ items: await availableInsurers(req.auth!.accountId!, q) });
});
profileRouter.post('/insurers/mine', ...g, requireRole('ADV'), requireWritable, idempotent('insurers.add'), async (req, res) => {
  res.json(await addMapping(req, req.auth!, req.body));
});
profileRouter.post('/insurers/mine/:id', ...g, requireRole('ADV'), requireWritable, async (req, res) => {
  res.json(await editMapping(req, req.auth!, String(req.params.id), req.body));
});
for (const [action, to] of [['activate', 'ACTIVE'], ['deactivate', 'INACTIVE']] as const) {
  profileRouter.post(`/insurers/mine/:id/${action}`, ...g, requireRole('ADV'), requireWritable, async (req, res) => {
    res.json(await setMappingStatus(req, req.auth!, String(req.params.id), to, Number((req.body as { version?: unknown }).version)));
  });
}

profileRouter.get('/insurance-types', ...g, async (_req, res) => {
  res.json({ items: await db.select({ id: insuranceTypes.id, name: insuranceTypes.name }).from(insuranceTypes).where(eq(insuranceTypes.status, 'ACTIVE')).orderBy(asc(insuranceTypes.position)) });
});
