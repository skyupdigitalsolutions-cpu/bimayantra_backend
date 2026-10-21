// P-39 Manage message templates. STF (or ADM) drafts; a different ADM approves with an extra OTP (CAT-05).
// Email templates become ACTIVE on approval; WhatsApp templates go to Meta through the provider and stay
// SUBMITTED_TO_META until Meta's answer arrives (never treated as ACTIVE before, AC-P39-1).
import type { Request } from 'express';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db, type DbOrTx } from '../../db/client.js';
import { messageTemplates, outgoingMessages, users } from '../../db/schema.js';
import { clock } from '../../lib/clock.js';
import { AppError, fieldErrors, forbidden, notFound, stateConflict, versionConflict, type FieldError } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import { msg } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { consumeStepUp } from '../auth/auth.service.js';
import { addMaker, assertChecker } from '../catalogue/common.js';
import { isUuid, readVersion } from '../clients/common.js';
import { ownFile } from '../files/files.service.js';
import { notifyRoles } from '../notifications/notifications.service.js';
import { settings } from '../settings/settings.service.js';
import { DEFAULT_TEMPLATES, fill, PURPOSE_CHANNELS, PURPOSE_NAMES, PURPOSES, SAMPLE, SYSTEM_PURPOSES, VARIABLES, variablesIn, type Purpose, type Template } from './templates.js';

const STATUS_TEXT: Record<string, string> = { DRAFT: 'Draft', PENDING_APPROVAL: 'Waiting for approval', SUBMITTED_TO_META: 'Sent to Meta', ACTIVE: 'Active', REJECTED: 'Rejected', INACTIVE: 'Inactive' };

export async function templateView(t: Template, auth?: AuthContext) {
  const makers = t.makers.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, t.makers)) : [];
  return {
    id: t.id,
    name: t.name,
    channel: t.channel,
    purpose: t.purpose,
    purposeName: PURPOSE_NAMES[t.purpose as Purpose],
    metaCategory: t.metaCategory,
    language: t.language,
    subject: t.subject,
    body: t.body,
    headerFileId: t.headerFileId,
    status: t.status,
    statusText: STATUS_TEXT[t.status],
    rejectReason: t.rejectReason,
    templateVersion: t.templateVersion,
    preview: { subject: t.subject ? fill(t.subject, SAMPLE) : null, body: fill(t.body, SAMPLE) },
    allowedVariables: VARIABLES[t.purpose as Purpose],
    makers: makers.map((m) => m.name),
    youMadeThis: auth ? t.makers.includes(auth.userId) : false,
    submittedAt: t.submittedAt?.toISOString() ?? null,
    approvedAt: t.approvedAt?.toISOString() ?? null,
    version: t.version,
  };
}

function parseTemplate(body: unknown): { name: string; channel: 'WHATSAPP' | 'EMAIL'; purpose: Purpose; metaCategory: string | null; language: string; subject: string | null; body: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const v = F.parseFields(b, {
    name: { label: 'Template name', required: true, rule: F.shortText },
    channel: { label: 'Channel', required: true, oneOf: ['WHATSAPP', 'EMAIL'] },
    purpose: { label: 'Purpose', required: true, oneOf: PURPOSES },
    language: { label: 'Language', required: true, oneOf: ['English'] },
  }) as { name: string; channel: 'WHATSAPP' | 'EMAIL'; purpose: Purpose; language: string };
  const e: FieldError[] = [];
  if (!PURPOSE_CHANNELS[v.purpose].includes(v.channel)) e.push({ field: 'channel', code: 'VAL-22' });
  const text = typeof b.body === 'string' ? b.body.trim() : '';
  if (!text) e.push({ field: 'body', code: 'GEN-01', params: { 'Field label': 'Body' } });
  let subject: string | null = null;
  if (v.channel === 'EMAIL') {
    const s = typeof b.subject === 'string' ? b.subject.trim() : '';
    if (!s) e.push({ field: 'subject', code: 'GEN-01', params: { 'Field label': 'Subject' } });
    else {
      const r = F.shortText(s);
      if (!r.ok) e.push({ field: 'subject', code: r.code });
      else subject = r.value;
    }
  }
  let metaCategory: string | null = null;
  if (v.channel === 'WHATSAPP') {
    metaCategory = v.purpose === 'RENEWAL_REMINDER' ? 'UTILITY' : 'MARKETING';
    if (text.length > settings.get('CFG-138')) e.push({ field: 'body', code: 'COM-04' });
  }
  const allowed = VARIABLES[v.purpose];
  const used = [...variablesIn(text), ...variablesIn(subject ?? '')];
  if (used.some((u) => !allowed.some((a) => a.toLowerCase() === u.toLowerCase()))) e.push({ field: 'body', code: 'COM-03', params: { purpose: PURPOSE_NAMES[v.purpose], list: allowed.map((a) => `{${a}}`).join(', ') } });
  if (e.length) throw fieldErrors(e);
  return { ...v, metaCategory, subject, body: text };
}

async function load(dbx: DbOrTx, id: string, lock = false): Promise<Template> {
  if (!isUuid(id)) throw notFound();
  const base = dbx.select().from(messageTemplates).where(eq(messageTemplates.id, id));
  const [t] = lock ? await base.for('update') : await base;
  if (!t) throw notFound();
  return t;
}

const isUniqueErr = (err: unknown) => (err as { code?: string; cause?: { code?: string } })?.code === '23505' || (err as { cause?: { code?: string } })?.cause?.code === '23505';

export async function listTemplates(auth: AuthContext) {
  const rows = await db.select().from(messageTemplates).orderBy(asc(messageTemplates.purpose), asc(messageTemplates.name));
  const items = await Promise.all(rows.filter((t) => auth.role === 'STF' || auth.role === 'ADM' || t.status === 'ACTIVE').map((t) => templateView(t, auth)));
  return { items, purposes: PURPOSES.map((p) => ({ value: p, label: PURPOSE_NAMES[p], channels: PURPOSE_CHANNELS[p], variables: VARIABLES[p] })), maxWhatsapp: settings.get('CFG-138') };
}

export async function getTemplate(auth: AuthContext, id: string) {
  const t = await load(db, id);
  if (auth.role !== 'STF' && auth.role !== 'ADM' && t.status !== 'ACTIVE') throw notFound();
  return templateView(t, auth);
}

export async function createTemplate(req: Request, auth: AuthContext, body: unknown) {
  const v = parseTemplate(body);
  const b = body as Record<string, unknown>;
  const headerFileId = b.headerFileId && v.channel === 'WHATSAPP' ? (await ownFile({ ...auth, accountId: null }, b.headerFileId, ['TEMPLATE_IMAGE'], 'headerFileId')).id : null;
  try {
    const [t] = await db.insert(messageTemplates).values({ ...v, headerFileId, makers: [auth.userId], createdBy: auth.userId, createdAt: clock.now(), updatedAt: clock.now() }).returning();
    await audit(db, req, { action: 'TEMPLATE_CREATED', entity: 'template', entityId: t!.id, newValue: { name: v.name, channel: v.channel, purpose: v.purpose } });
    return { template: await templateView(t!, auth), message: msg('GEN-08', { 'Record type': 'Template' }) };
  } catch (err) {
    if (isUniqueErr(err)) throw fieldErrors([{ field: 'name', code: 'CAT-07' }]);
    throw err;
  }
}

export async function editTemplate(req: Request, auth: AuthContext, id: string, body: unknown) {
  const v = parseTemplate(body);
  return db.transaction(async (tx) => {
    const t = await load(tx, id, true);
    if (t.version !== readVersion(body)) throw versionConflict('template');
    if (!['DRAFT', 'REJECTED'].includes(t.status)) throw stateConflict('template', t.status);
    try {
      const [n] = await tx
        .update(messageTemplates)
        .set({ ...v, status: 'DRAFT', rejectReason: null, makers: addMaker(t.makers, auth.userId), templateVersion: t.templateVersion + 1, updatedAt: clock.now(), version: t.version + 1 })
        .where(eq(messageTemplates.id, t.id))
        .returning();
      await audit(tx, req, { action: 'TEMPLATE_EDITED', entity: 'template', entityId: t.id, oldValue: { body: t.body, subject: t.subject }, newValue: { body: v.body, subject: v.subject } });
      return { template: await templateView(n!, auth), message: msg('GEN-08', { 'Record type': 'Template' }) };
    } catch (err) {
      if (isUniqueErr(err)) throw fieldErrors([{ field: 'name', code: 'CAT-07' }]);
      throw err;
    }
  });
}

export async function submitTemplate(req: Request, auth: AuthContext, id: string, body: unknown) {
  return db.transaction(async (tx) => {
    const t = await load(tx, id, true);
    if (t.version !== readVersion(body)) throw versionConflict('template');
    if (t.status !== 'DRAFT') throw stateConflict('template', t.status);
    const [n] = await tx.update(messageTemplates).set({ status: 'PENDING_APPROVAL', makers: addMaker(t.makers, auth.userId), submittedAt: clock.now(), version: t.version + 1 }).where(eq(messageTemplates.id, t.id)).returning();
    await notifyRoles(tx, ['ADM'], { messageId: 'DSH-20', params: { 'Item type': 'Message template', name: t.name }, link: { type: 'TEMPLATE', id: t.id }, dedupeKey: `tpl-submit:${t.id}:${n!.version}` });
    await audit(tx, req, { action: 'TEMPLATE_SUBMITTED', entity: 'template', entityId: t.id });
    return { template: await templateView(n!, auth), message: msg('CAT-02', { Item: t.name }) };
  });
}

/** Submit a WhatsApp template to Meta through the provider. Status comes back by webhook or status check. */
async function sendToMeta(t: Template): Promise<boolean> {
  if (env.WHATSAPP_PROVIDER === 'memory' || env.WHATSAPP_PROVIDER === 'log') return true;
  if (env.WHATSAPP_PROVIDER !== 'http') return false;
  try {
    const r = await fetch(`${env.WHATSAPP_API_URL.replace(/\/$/, '')}/templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.WHATSAPP_API_KEY}` },
      body: JSON.stringify({ id: t.id, name: t.metaName ?? t.name, category: t.metaCategory, language: t.language, body: t.body, optOutButton: 'Stop messages' }),
      signal: AbortSignal.timeout(15_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function approveTemplate(req: Request, auth: AuthContext, id: string, body: unknown) {
  const result = await db.transaction(async (tx) => {
    const t = await load(tx, id, true);
    if (t.version !== readVersion(body)) throw versionConflict('template');
    if (t.status !== 'PENDING_APPROVAL') throw stateConflict('template', t.status);
    assertChecker(auth, t.makers);
    // System purposes: one ACTIVE template per channel and language (COM-05)
    if (t.channel === 'EMAIL' && SYSTEM_PURPOSES.includes(t.purpose as Purpose)) {
      const [other] = await tx.select({ id: messageTemplates.id }).from(messageTemplates).where(and(eq(messageTemplates.purpose, t.purpose), eq(messageTemplates.channel, t.channel), eq(messageTemplates.language, t.language), eq(messageTemplates.status, 'ACTIVE'), ne(messageTemplates.id, t.id)));
      if (other) throw new AppError(409, 'COM-05', { purpose: PURPOSE_NAMES[t.purpose as Purpose] });
    }
    const ticket = await consumeStepUp(tx, auth, req.get('x-step-up-token'), 'APPROVE');
    const status = t.channel === 'EMAIL' ? 'ACTIVE' : 'SUBMITTED_TO_META';
    const metaName = t.channel === 'WHATSAPP' ? `by_${t.purpose.toLowerCase()}_${t.id.slice(0, 8)}_v${t.templateVersion}` : null;
    const [n] = await tx
      .update(messageTemplates)
      .set({ status, metaName, approvedBy: auth.userId, approvedAt: clock.now(), approvalTicketId: ticket, makers: [], version: t.version + 1 })
      .where(eq(messageTemplates.id, t.id))
      .returning();
    await audit(tx, req, { action: 'TEMPLATE_APPROVED', entity: 'template', entityId: t.id, newValue: { status, ticket } });
    return n!;
  });
  if (result.channel === 'WHATSAPP') {
    const ok = await sendToMeta(result);
    if (!ok) {
      // Submission failed: back to PENDING_APPROVAL with COM-07 and Retry
      await db.update(messageTemplates).set({ status: 'PENDING_APPROVAL' }).where(eq(messageTemplates.id, result.id));
      return { template: await templateView({ ...result, status: 'PENDING_APPROVAL' }, auth), message: msg('COM-07') };
    }
    return { template: await templateView(result, auth), message: msg('COM-01') };
  }
  return { template: await templateView(result, auth), message: msg('CAT-03', { Item: result.name }) };
}

export async function rejectTemplate(req: Request, auth: AuthContext, id: string, body: unknown) {
  const v = F.parseFields(body, { reason: { label: 'Reason', required: true, rule: F.notes } }) as { reason: string };
  return db.transaction(async (tx) => {
    const t = await load(tx, id, true);
    if (t.version !== readVersion(body)) throw versionConflict('template');
    if (t.status !== 'PENDING_APPROVAL') throw stateConflict('template', t.status);
    assertChecker(auth, t.makers);
    const [n] = await tx.update(messageTemplates).set({ status: 'DRAFT', rejectReason: v.reason, version: t.version + 1 }).where(eq(messageTemplates.id, t.id)).returning();
    await audit(tx, req, { action: 'TEMPLATE_REJECTED', entity: 'template', entityId: t.id, newValue: v });
    return { template: await templateView(n!, auth), message: msg('CAT-04', { Item: t.name, reason: v.reason }) };
  });
}

/** Meta's answer (webhook or status check): ACTIVE, or REJECTED with Meta's reason (COM-02). */
export async function metaDecision(templateId: string, approved: boolean, reason?: string) {
  const [t] = await db.select().from(messageTemplates).where(eq(messageTemplates.id, templateId));
  if (!t || t.status !== 'SUBMITTED_TO_META') return;
  await db.update(messageTemplates).set({ status: approved ? 'ACTIVE' : 'REJECTED', rejectReason: approved ? null : (reason ?? 'Rejected by Meta'), version: t.version + 1 }).where(eq(messageTemplates.id, t.id));
  await audit(db, null, { action: approved ? 'TEMPLATE_META_APPROVED' : 'TEMPLATE_META_REJECTED', entity: 'template', entityId: t.id, newValue: { reason }, actor: { job: 'meta-webhook' } });
}

export async function setTemplateActive(req: Request, auth: AuthContext, id: string, active: boolean, body: unknown) {
  if (auth.role !== 'ADM') throw forbidden();
  return db.transaction(async (tx) => {
    const t = await load(tx, id, true);
    if (t.version !== readVersion(body)) throw versionConflict('template');
    if (active ? t.status !== 'INACTIVE' : t.status !== 'ACTIVE') throw stateConflict('template', t.status);
    if (active && SYSTEM_PURPOSES.includes(t.purpose as Purpose)) {
      const [other] = await tx.select({ id: messageTemplates.id }).from(messageTemplates).where(and(eq(messageTemplates.purpose, t.purpose), eq(messageTemplates.channel, t.channel), eq(messageTemplates.status, 'ACTIVE')));
      if (other) throw new AppError(409, 'COM-05', { purpose: PURPOSE_NAMES[t.purpose as Purpose] });
    }
    const [n] = await tx.update(messageTemplates).set({ status: active ? 'ACTIVE' : 'INACTIVE', version: t.version + 1 }).where(eq(messageTemplates.id, t.id)).returning();
    // Messages already queued with it are skipped at send time ("Template inactive")
    if (!active) await tx.update(outgoingMessages).set({ status: 'SKIPPED', reason: 'Template inactive', statusAt: clock.now() }).where(and(eq(outgoingMessages.templateId, t.id), eq(outgoingMessages.status, 'QUEUED')));
    await audit(tx, req, { action: active ? 'TEMPLATE_ACTIVATED' : 'TEMPLATE_DEACTIVATED', entity: 'template', entityId: t.id });
    return { template: await templateView(n!, auth), message: msg('GEN-08', { 'Record type': 'Template' }) };
  });
}

export async function pendingTemplates() {
  const rows = await db.select().from(messageTemplates).where(eq(messageTemplates.status, 'PENDING_APPROVAL'));
  return Promise.all(
    rows.map(async (t) => {
      const makers = t.makers.length ? await db.select({ name: users.name }).from(users).where(inArray(users.id, t.makers)) : [];
      return { kind: 'MESSAGE_TEMPLATE', id: t.id, title: `${t.name} (${t.channel === 'EMAIL' ? 'Email' : 'WhatsApp'})`, makers: makers.map((m) => m.name), makerIds: t.makers, submittedAt: t.submittedAt?.toISOString() ?? null };
    }),
  );
}

/** Released defaults (document change 40): the first ACTIVE templates, created once by the seed script. */
export async function seedDefaultTemplates(): Promise<number> {
  let n = 0;
  for (const d of DEFAULT_TEMPLATES) {
    const rows = await db
      .insert(messageTemplates)
      .values({ name: d.name, channel: d.channel, purpose: d.purpose, metaCategory: d.metaCategory ?? null, language: 'English', subject: d.subject ?? null, body: d.body, status: d.channel === 'EMAIL' ? 'ACTIVE' : 'SUBMITTED_TO_META', metaName: d.channel === 'WHATSAPP' ? d.name.toLowerCase().replace(/\W+/g, '_') : null, createdAt: clock.now(), approvedAt: clock.now() })
      .onConflictDoNothing()
      .returning({ id: messageTemplates.id });
    n += rows.length;
  }
  return n;
}
