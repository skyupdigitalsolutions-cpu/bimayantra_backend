// P-52 Export account data: one ZIP of CSV files with only the account's own records, built in the
// background (SYS-11). Works in read-only mode. The download link works for CFG-113 hours and only for the
// signed-in advisor. "All files" also puts every stored file of the account in the ZIP (documents of each
// customer, quotation and comparison PDFs, policy documents, receipts, photos, KYC), in folders, with files_index.csv.
import type { Request } from 'express';
import { and, desc, eq, gte, inArray, ne, notInArray, sql } from 'drizzle-orm';
import { strToU8, zipSync } from 'fflate';
import { db } from '../../db/client.js';
import {
  advisorProfiles,
  comparisons,
  customers,
  documentVersions,
  documents,
  exportJobs,
  files as storedFiles,
  familyMembers,
  leads,
  nomineeVersions,
  outgoingMessages,
  payments,
  policies,
  quotationRevisions,
  quotations,
  renewalCycles,
} from '../../db/schema.js';
import { clock, istToday } from '../../lib/clock.js';
import { AppError, fieldErrors, forbidden, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { msg } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { consumeStepUp } from '../auth/auth.service.js';
import { isUuid } from '../clients/common.js';
import { fileLink, readStored, storeGenerated } from '../files/files.service.js';
import { defineJob, enqueue } from '../jobs/jobs.js';
import { notify } from '../notifications/notifications.service.js';
import { settings } from '../settings/settings.service.js';

export const PARTS = ['CUSTOMERS', 'LEADS', 'QUOTATIONS', 'PAYMENTS', 'POLICIES', 'RENEWALS', 'COMMUNICATIONS', 'DOCUMENTS', 'FILES'] as const;
export const PART_NAMES: Record<string, string> = {
  CUSTOMERS: 'Customers and family',
  LEADS: 'Leads',
  QUOTATIONS: 'Quotations and comparisons',
  PAYMENTS: 'Payments',
  POLICIES: 'Policies and nominees',
  RENEWALS: 'Renewals',
  COMMUNICATIONS: 'Communications log',
  DOCUMENTS: 'Documents list',
  FILES: 'All files (customer documents, quotation and policy PDFs, receipts, photos)',
};

const cell = (v: unknown) => {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- only strings, numbers and booleans reach String()
  const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows: Record<string, unknown>[], cols: string[]) => [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');

export async function listExports(auth: AuthContext) {
  const rows = await db.select().from(exportJobs).where(eq(exportJobs.accountId, auth.accountId!)).orderBy(desc(exportJobs.createdAt)).limit(20);
  const now = clock.now();
  return {
    items: rows.map((j) => ({ id: j.id, include: j.include, status: j.status === 'READY' && j.expiresAt && j.expiresAt < now ? 'DOWNLOAD_EXPIRED' : j.status, readyAt: j.readyAt?.toISOString() ?? null, expiresAt: j.expiresAt?.toISOString() ?? null, createdAt: j.createdAt.toISOString() })),
    parts: PARTS.map((p) => ({ value: p, label: PART_NAMES[p] })),
    perDay: settings.get('CFG-114'),
  };
}

export async function requestExport(req: Request, auth: AuthContext, body: unknown) {
  if (auth.role !== 'ADV') throw forbidden();
  const include = Array.isArray((body as { include?: unknown })?.include) ? ((body as { include: unknown[] }).include.filter((x) => (PARTS as readonly unknown[]).includes(x)) as string[]) : [];
  if (!include.length) throw fieldErrors([{ field: 'include', code: 'GEN-01', params: { 'Field label': 'What to include' } }]);
  const start = new Date(`${istToday()}T00:00:00+05:30`);
  const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(exportJobs).where(and(eq(exportJobs.accountId, auth.accountId!), gte(exportJobs.createdAt, start), ne(exportJobs.status, 'FAILED')))) as [{ n: number }];
  if (n >= settings.get('CFG-114')) throw new AppError(429, 'ADM-12');
  const job = await db.transaction(async (tx) => {
    await consumeStepUp(tx, auth, req.get('x-step-up-token'), 'EXPORT');
    const [j] = await tx.insert(exportJobs).values({ accountId: auth.accountId!, requestedBy: auth.userId, include, status: 'QUEUED', createdAt: clock.now() }).returning();
    await audit(tx, req, { action: 'EXPORT_REQUESTED', entity: 'export', entityId: j!.id, newValue: { include } });
    return j!;
  });
  await enqueue('account-export', { id: job.id });
  return { id: job.id, message: msg('ADM-10') };
}

const FOLDER: Record<string, string> = {
  QUOTATION_PDF: 'quotation-pdfs', COMPARISON_PDF: 'comparison-pdfs', POLICY_DOCUMENT: 'policy-documents', PAYMENT_RECEIPT: 'payment-receipts',
  ENDORSEMENT: 'endorsements', CONSENT_EVIDENCE: 'consent-evidence', FAMILY_PHOTO: 'family-photos', VEHICLE_PHOTO: 'vehicle-photos',
  KYC_PAN: 'my-account', KYC_LICENCE: 'my-account', APPOINTMENT_LETTER: 'my-account', PROFILE_PHOTO: 'my-account', BUSINESS_LOGO: 'my-account',
};
const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'file';

/** Every stored file of the account (never other exports), in folders. Customer documents go under the customer. */
async function addStoredFiles(a: string, out: Record<string, Uint8Array | [Uint8Array, { level: 0 }]>) {
  const rows = await db.select().from(storedFiles).where(and(eq(storedFiles.accountId, a), notInArray(storedFiles.purpose, ['ACCOUNT_EXPORT', 'AUDIT_EXPORT'])));
  const ids = rows.map((r) => r.id);
  // which customer and document each file belongs to
  const docRows = ids.length
    ? await db
      .select({ fileId: documentVersions.fileId, versionNo: documentVersions.versionNo, label: documents.label, customer: customers.number, customerName: customers.fullName })
      .from(documentVersions)
      .innerJoin(documents, eq(documents.id, documentVersions.documentId))
      .innerJoin(customers, eq(customers.id, documents.customerId))
      .where(inArray(documentVersions.fileId, ids))
    : [];
  const byFile = new Map(docRows.map((d) => [d.fileId, d]));
  const used = new Set(Object.keys(out));
  const unique = (path: string) => {
    let p = path, i = 2;
    while (used.has(p)) p = path.replace(/(\.[^./]+)?$/, (ext) => ` (${i++})${ext}`);
    used.add(p);
    return p;
  };
  const index: Record<string, unknown>[] = [];
  for (const f of rows) {
    const ext = (f.originalName.match(/\.[A-Za-z0-9]{1,5}$/)?.[0] ?? '').toLowerCase();
    const d = byFile.get(f.id);
    const path = d
      ? unique(`files/customers/${safeName(`${d.customer} ${d.customerName}`)}/${safeName(`${d.label} v${d.versionNo}`)}${ext}`)
      : unique(`files/${FOLDER[f.purpose] ?? 'other'}/${safeName(f.originalName)}`);
    try {
      out[path] = [new Uint8Array(await readStored(f.storageKey)), { level: 0 }];
      index.push({ path, purpose: f.purpose, originalName: f.originalName, customer: d?.customer ?? '', sizeBytes: f.sizeBytes, uploadedAt: f.createdAt, missing: '' });
    } catch {
      index.push({ path: '', purpose: f.purpose, originalName: f.originalName, customer: d?.customer ?? '', sizeBytes: f.sizeBytes, uploadedAt: f.createdAt, missing: 'file not found in storage' });
    }
  }
  out['files_index.csv'] = strToU8(toCsv(index, ['path', 'purpose', 'originalName', 'customer', 'sizeBytes', 'uploadedAt', 'missing']));
}

/** SYS-11: build the ZIP. */
export async function buildExport(id: string) {
  const [j] = await db.select().from(exportJobs).where(eq(exportJobs.id, id));
  if (!j || j.status !== 'QUEUED') return;
  const a = j.accountId;
  try {
    const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};
    const add = (name: string, rows: Record<string, unknown>[], cols: string[]) => void (files[name] = strToU8(toCsv(rows, cols)));
    if (j.include.includes('CUSTOMERS')) {
      add('customers.csv', await db.select().from(customers).where(eq(customers.accountId, a)), ['number', 'fullName', 'mobile', 'email', 'dateOfBirth', 'gender', 'city', 'state', 'pinCode', 'anniversary', 'occupation', 'source', 'panMasked', 'aadhaarMasked', 'status', 'createdAt']);
      add('family_members.csv', await db.select({ customer: customers.number, fullName: familyMembers.fullName, relationship: familyMembers.relationship, dateOfBirth: familyMembers.dateOfBirth, mobile: familyMembers.mobile, status: familyMembers.status }).from(familyMembers).innerJoin(customers, eq(customers.id, familyMembers.customerId)).where(eq(familyMembers.accountId, a)), ['customer', 'fullName', 'relationship', 'dateOfBirth', 'mobile', 'status']);
    }
    if (j.include.includes('LEADS')) add('leads.csv', await db.select().from(leads).where(eq(leads.accountId, a)), ['number', 'name', 'mobile', 'email', 'source', 'priority', 'status', 'lostReason', 'createdAt', 'convertedAt']);
    if (j.include.includes('QUOTATIONS')) {
      add('quotations.csv', await db.select({ number: quotations.number, revision: quotationRevisions.revisionNo, status: quotationRevisions.status, finalPayable: quotationRevisions.finalPayable, calculatedOn: quotationRevisions.calculatedOn, validUntil: quotationRevisions.validUntil, customer: customers.number }).from(quotationRevisions).innerJoin(quotations, eq(quotations.id, quotationRevisions.quotationId)).innerJoin(customers, eq(customers.id, quotations.customerId)).where(eq(quotations.accountId, a)), ['number', 'revision', 'status', 'finalPayable', 'calculatedOn', 'validUntil', 'customer']);
      add('comparisons.csv', await db.select({ number: comparisons.number, status: comparisons.status, validUntil: comparisons.validUntil, customer: customers.number }).from(comparisons).innerJoin(customers, eq(customers.id, comparisons.customerId)).where(eq(comparisons.accountId, a)), ['number', 'status', 'validUntil', 'customer']);
    }
    if (j.include.includes('PAYMENTS')) add('payments.csv', await db.select({ quotation: quotations.number, kind: payments.kind, status: payments.status, method: payments.method, mode: payments.mode, amount: payments.amount, paidOn: payments.paidOn, reference: payments.reference, recordedAt: payments.recordedAt }).from(payments).leftJoin(quotations, eq(quotations.id, payments.quotationId)).where(eq(payments.accountId, a)), ['quotation', 'kind', 'status', 'method', 'mode', 'amount', 'paidOn', 'reference', 'recordedAt']);
    if (j.include.includes('POLICIES')) {
      add('policies.csv', await db.select({ number: policies.number, insurerPolicyNumber: policies.insurerPolicyNumber, customer: customers.number, product: policies.productName, source: policies.source, status: policies.status, startDate: policies.startDate, endDate: policies.endDate, frequency: policies.frequency, nextDueDate: policies.nextDueDate, sumInsured: policies.sumInsured, premium: policies.premium }).from(policies).innerJoin(customers, eq(customers.id, policies.customerId)).where(eq(policies.accountId, a)), ['number', 'insurerPolicyNumber', 'customer', 'product', 'source', 'status', 'startDate', 'endDate', 'frequency', 'nextDueDate', 'sumInsured', 'premium']);
      add('nominees.csv', await db.select({ policy: policies.number, version: nomineeVersions.versionNo, status: nomineeVersions.status, nominees: nomineeVersions.nominees, endorsementRef: nomineeVersions.endorsementRef }).from(nomineeVersions).innerJoin(policies, eq(policies.id, nomineeVersions.policyId)).where(eq(nomineeVersions.accountId, a)), ['policy', 'version', 'status', 'nominees', 'endorsementRef']);
    }
    if (j.include.includes('RENEWALS')) add('renewals.csv', await db.select({ policy: policies.number, renewalDate: renewalCycles.renewalDate, graceEnd: renewalCycles.graceEnd, status: renewalCycles.status, reason: renewalCycles.reason }).from(renewalCycles).innerJoin(policies, eq(policies.id, renewalCycles.policyId)).where(eq(renewalCycles.accountId, a)), ['policy', 'renewalDate', 'graceEnd', 'status', 'reason']);
    if (j.include.includes('COMMUNICATIONS')) add('communications.csv', await db.select().from(outgoingMessages).where(eq(outgoingMessages.accountId, a)), ['createdAt', 'channel', 'purpose', 'personName', 'recipient', 'status', 'reason', 'sentAt', 'deliveredAt']);
    if (j.include.includes('DOCUMENTS')) add('documents.csv', await db.select({ customer: customers.number, type: documents.type, label: documents.label, versions: documents.latestVersion, createdAt: documents.createdAt }).from(documents).innerJoin(customers, eq(customers.id, documents.customerId)).where(eq(documents.accountId, a)), ['customer', 'type', 'label', 'versions', 'createdAt']);
    if (j.include.includes('FILES')) await addStoredFiles(a, files);
    const zip = Buffer.from(zipSync(files));
    const f = await storeGenerated(a, j.requestedBy, 'ACCOUNT_EXPORT', `bimayantra-export-${istToday()}.zip`, zip, 'application/zip');
    const expiresAt = new Date(clock.now().getTime() + settings.get('CFG-113') * 3600_000);
    await db.update(exportJobs).set({ status: 'READY', fileId: f.id, readyAt: clock.now(), expiresAt }).where(eq(exportJobs.id, j.id));
    const [p] = await db.select({ email: advisorProfiles.email }).from(advisorProfiles).where(eq(advisorProfiles.accountId, a));
    await notify(db, { userId: j.requestedBy, accountId: a, messageId: 'ADM-11', link: { type: 'EXPORT', id: j.id }, dedupeKey: `export:${j.id}`, email: { to: p?.email, subject: 'Your Bimayantra export is ready' } });
    await audit(db, null, { action: 'EXPORT_READY', entity: 'export', entityId: j.id, accountId: a, actor: { job: 'SYS-11' } });
  } catch (err) {
    logger.error({ err }, 'Export failed');
    await db.update(exportJobs).set({ status: 'FAILED', error: err instanceof Error ? err.message : 'failed' }).where(eq(exportJobs.id, j.id));
  }
}
defineJob('account-export', async (d) => buildExport(String(d.id)));

export async function downloadExport(auth: AuthContext, id: string) {
  if (auth.role !== 'ADV' || !isUuid(id)) throw notFound();
  const [j] = await db.select().from(exportJobs).where(and(eq(exportJobs.id, id), eq(exportJobs.accountId, auth.accountId!)));
  if (!j || !j.fileId) throw notFound();
  if (j.status === 'FAILED') throw new AppError(409, 'ADM-13');
  if (j.expiresAt && j.expiresAt < clock.now()) {
    await db.update(exportJobs).set({ status: 'DOWNLOAD_EXPIRED' }).where(eq(exportJobs.id, j.id));
    throw notFound();
  }
  return fileLink(auth.userId, auth.sessionId, j.fileId);
}
