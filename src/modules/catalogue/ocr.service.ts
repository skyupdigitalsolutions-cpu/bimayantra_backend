// P-23 Read a brochure and review. The job reads the file and matches text to the template's features; a
// person decides every value. Nothing reaches a draft without a decision (AC-P23-1); low-confidence values
// (below CFG-37) cannot be accepted in bulk (AC-P23-2); a failed job never changes the draft (AC-P23-3);
// a brochure over CFG-30 pages is refused (OCR-04). Raw text and every decision are kept for audit.
//
// Reader: text PDFs are read here (pdf.js). Scanned PDFs and photos need an OCR provider; until one is
// configured (OCR_PROVIDER, document change 27) they fail with OCR-03 and the values are entered by hand.
import type { Request } from 'express';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { db, type DbOrTx } from '../../db/client.js';
import { files, insuranceTypes, ocrJobs, productVersions, products, templateVersions, users } from '../../db/schema.js';
import { clock } from '../../lib/clock.js';
import { AppError, fieldError, notFound, stateConflict, versionConflict } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { msg } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { readStored } from '../files/files.service.js';
import { defineJob, enqueue } from '../jobs/jobs.js';
import { notify } from '../notifications/notifications.service.js';
import { settings } from '../settings/settings.service.js';
import { isUuid, readVersion, scalar } from './common.js';
import { parseFeatureValue, type FeatureValue, type ProductData } from './productData.js';
import type { Feature } from './types.service.js';

export const DECISIONS = ['ACCEPT', 'EDIT', 'IGNORE', 'NOT_STATED'] as const;
type Decision = (typeof DECISIONS)[number];
export type OcrRow = {
  featureKey: string;
  name: string;
  dataType: Feature['dataType'];
  found: string | null;
  confidence: number;
  sourcePage: number | null;
  decision: Decision | null;
  finalValue: string | null;
};
type Job = typeof ocrJobs.$inferSelect;

// ---------- reading ----------
export async function pdfPages(buf: Buffer): Promise<string[]> {
  const task = getDocument({ data: new Uint8Array(buf), useSystemFonts: true, verbosity: 0 });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : ' ') : '')).join(''));
  }
  await task.destroy();
  return pages;
}

export async function pdfPageCount(buf: Buffer): Promise<number> {
  const task = getDocument({ data: new Uint8Array(buf), verbosity: 0 });
  const doc = await task.promise;
  const n = doc.numPages;
  await task.destroy();
  return n;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9%₹.]+/g, ' ').trim();

/** Pull a value of the feature's data type out of the text next to its name. */
export function extractValue(f: Pick<Feature, 'dataType'>, text: string): string | null {
  const t = text.toLowerCase();
  switch (f.dataType) {
    case 'YES_NO':
      if (/\b(not covered|not available|excluded|no)\b/.test(t)) return 'No';
      if (/\b(yes|covered|available|included)\b/.test(t)) return 'Yes';
      return null;
    case 'PERCENT': {
      const m = /(\d{1,3}(?:\.\d{1,2})?)\s*%/.exec(t);
      return m ? m[1]! : null;
    }
    case 'DAYS':
    case 'MONTHS':
    case 'YEARS': {
      const m = /(\d{1,5})\s*(day|month|year)s?/.exec(t);
      if (!m) return null;
      const n = Number(m[1]);
      const unit = m[2]!;
      const want = f.dataType.toLowerCase().replace(/s$/, '');
      if (unit === want) return String(n);
      if (unit === 'year' && want === 'month') return String(n * 12);
      if (unit === 'month' && want === 'year' && n % 12 === 0) return String(n / 12);
      if (unit === 'year' && want === 'day') return String(n * 365);
      return null;
    }
    case 'AMOUNT': {
      const m = /(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(lakhs?|lacs?|crores?|cr)?\b/.exec(t);
      if (!m) return null;
      const base = Number(m[1]!.replace(/,/g, ''));
      const mult = m[2]?.startsWith('cr') ? 1_00_00_000 : m[2] ? 1_00_000 : 1;
      return (base * mult).toFixed(2);
    }
    case 'NUMBER': {
      const m = /(\d[\d,]*)/.exec(t);
      return m ? m[1]!.replace(/,/g, '') : null;
    }
    default: {
      const v = text.trim().replace(/\s+/g, ' ');
      return v ? v.slice(0, settings.get('CFG-13')) : null;
    }
  }
}

/** Match each feature to the brochure text. Confidence: exact name + typed value 95; partial name 70. */
export function matchFeatures(features: Feature[], pages: string[]): OcrRow[] {
  const lines = pages.flatMap((p, i) => p.split(/\n/).map((l) => ({ page: i + 1, text: l.trim() })).filter((l) => l.text));
  return features.map((f) => {
    const name = norm(f.name);
    const words = name.split(' ').filter((w) => w.length > 2);
    let best: { value: string | null; confidence: number; page: number } | null = null;
    lines.forEach((l, idx) => {
      const ln = norm(l.text);
      let conf = 0;
      if (ln.includes(name)) conf = 95;
      else if (words.length && words.filter((w) => ln.includes(w)).length / words.length >= 0.6) conf = 70;
      if (!conf) return;
      const lower = l.text.toLowerCase();
      const at = lower.indexOf(f.name.toLowerCase());
      let rest = at >= 0 ? l.text.slice(at + f.name.length) : l.text.includes(':') ? l.text.slice(l.text.indexOf(':') + 1) : l.text;
      rest = rest.replace(/^\s*[:\-–—]\s*/, '');
      if (!rest.trim() && lines[idx + 1]) rest = lines[idx + 1]!.text;
      const raw = extractValue(f, rest);
      const parsed = raw === null ? null : parseFeatureValue(f, raw);
      const value = parsed?.ok ? parsed.value : null;
      const score = value !== null ? conf : Math.min(conf, 40);
      if (!best || score > best.confidence) best = { value, confidence: score, page: l.page };
    });
    const b = best as { value: string | null; confidence: number; page: number } | null;
    return {
      featureKey: f.key,
      name: f.name,
      dataType: f.dataType,
      found: b?.value ?? null,
      confidence: b?.value ? b.confidence : 0,
      sourcePage: b?.value ? b.page : null,
      decision: null,
      finalValue: null,
    };
  });
}

const flagged = (r: OcrRow) => r.confidence < settings.get('CFG-37');

// ---------- jobs ----------
async function startJob(req: Request, auth: AuthContext, args: { fileId: string; templateVersionId: string; productVersionId: string | null; accountId: string | null }) {
  if (!settings.get('CFG-102')) throw new AppError(409, 'OCR-07');
  const [f] = await db.select().from(files).where(eq(files.id, args.fileId));
  if (!f || f.purpose !== 'BROCHURE' || f.accountId !== args.accountId) throw fieldError('fileId', 'VAL-22');
  if (f.sizeBytes > settings.get('CFG-29') * 1024 * 1024) throw fieldError('fileId', 'VAL-24', { 'size limit': settings.get('CFG-29') });
  if (f.mime === 'application/pdf') {
    const pages = await pdfPageCount(await readStored(f.storageKey)).catch(() => 0);
    if (pages > settings.get('CFG-30')) throw fieldError('fileId', 'OCR-04');
  }
  const open = await db
    .select()
    .from(ocrJobs)
    .where(
      and(
        eq(ocrJobs.fileId, f.id),
        args.productVersionId ? eq(ocrJobs.productVersionId, args.productVersionId) : sql`${ocrJobs.productVersionId} is null`,
        inArray(ocrJobs.status, ['QUEUED', 'PROCESSING', 'REVIEW_REQUIRED']),
      ),
    );
  if (open[0]) return { job: jobView(open[0]), message: msg('OCR-01'), reused: true };
  const [job] = await db
    .insert(ocrJobs)
    .values({ accountId: args.accountId, productVersionId: args.productVersionId, templateVersionId: args.templateVersionId, fileId: f.id, startedBy: auth.userId, createdAt: clock.now() })
    .onConflictDoNothing()
    .returning();
  if (!job) {
    const [again] = await db.select().from(ocrJobs).where(and(eq(ocrJobs.fileId, f.id), inArray(ocrJobs.status, ['QUEUED', 'PROCESSING', 'REVIEW_REQUIRED'])));
    return { job: jobView(again!), message: msg('OCR-01'), reused: true };
  }
  await audit(db, req, { action: 'OCR_STARTED', entity: 'ocr_job', entityId: job.id, accountId: args.accountId, newValue: { fileId: f.id, productVersionId: args.productVersionId } });
  await enqueue('ocr-read', { jobId: job.id }, { singletonKey: job.id });
  const [fresh] = await db.select().from(ocrJobs).where(eq(ocrJobs.id, job.id));
  return { job: jobView(fresh!), message: msg('OCR-01'), reused: false };
}

/** SkyUp: Brochure → Read with OCR on a verified product draft. */
export async function startForVersion(req: Request, auth: AuthContext, versionId: string, body: unknown) {
  if (!isUuid(versionId)) throw notFound();
  const [r] = await db.select({ v: productVersions, p: products }).from(productVersions).innerJoin(products, eq(products.id, productVersions.productId)).where(eq(productVersions.id, versionId));
  if (!r || r.p.kind !== 'VERIFIED') throw notFound();
  if (r.v.status !== 'DRAFT') throw stateConflict('product', r.v.status);
  const fileId = (body as { fileId?: unknown } | null)?.fileId ?? (r.v.data as ProductData).brochureFileId;
  if (!isUuid(fileId)) throw fieldError('fileId', 'GEN-01', { 'Field label': 'Brochure' });
  return startJob(req, auth, { fileId, templateVersionId: r.v.templateVersionId, productVersionId: r.v.id, accountId: null });
}

/** Advisor: Scan brochure on "+ My product" (the preview fills the form; nothing is saved by the job). */
export async function startForOwn(req: Request, auth: AuthContext, body: unknown) {
  const b = (body ?? {}) as { typeId?: unknown; fileId?: unknown };
  if (!isUuid(b.typeId)) throw fieldError('typeId', 'GEN-01', { 'Field label': 'Insurance type' });
  if (!isUuid(b.fileId)) throw fieldError('fileId', 'GEN-01', { 'Field label': 'Brochure' });
  const [t] = await db
    .select({ id: templateVersions.id })
    .from(templateVersions)
    .innerJoin(insuranceTypes, eq(insuranceTypes.id, templateVersions.typeId))
    .where(and(eq(templateVersions.typeId, b.typeId), eq(templateVersions.status, 'ACTIVE'), eq(insuranceTypes.status, 'ACTIVE')));
  if (!t) throw fieldError('typeId', 'VAL-22');
  return startJob(req, auth, { fileId: b.fileId, templateVersionId: t.id, productVersionId: null, accountId: auth.accountId });
}

async function finish(job: Job, ok: boolean, set: Partial<Job>) {
  const [n] = await db
    .update(ocrJobs)
    .set({ ...set, finishedAt: clock.now() })
    .where(and(eq(ocrJobs.id, job.id), inArray(ocrJobs.status, ['QUEUED', 'PROCESSING'])))
    .returning();
  if (!n) return;
  const rows = (n.rows as OcrRow[]) ?? [];
  await notify(db, {
    userId: job.startedBy,
    accountId: job.accountId,
    messageId: ok ? 'OCR-02' : 'OCR-03',
    params: { n: rows.filter((r) => r.found !== null).length, m: rows.filter(flagged).length },
    dedupeKey: `ocr:${job.id}`,
    link: { type: 'OCR_REVIEW', id: job.id },
  });
}

export async function runOcrJob(jobId: string): Promise<void> {
  const [job] = await db.update(ocrJobs).set({ status: 'PROCESSING' }).where(and(eq(ocrJobs.id, jobId), eq(ocrJobs.status, 'QUEUED'))).returning();
  if (!job) return; // already running or done (repeat-safe)
  try {
    const [f] = await db.select().from(files).where(eq(files.id, job.fileId));
    const [tpl] = await db.select().from(templateVersions).where(eq(templateVersions.id, job.templateVersionId));
    if (!f || !tpl) throw new Error('File or template missing');
    if (f.mime !== 'application/pdf') throw new Error('No OCR provider for images');
    const limitMs = settings.get('CFG-38') * 60_000;
    const pages = await Promise.race([
      pdfPages(await readStored(f.storageKey)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('OCR time limit')), limitMs).unref()),
    ]);
    if (pages.length > settings.get('CFG-30')) throw new Error('Too many pages');
    if (pages.join('').trim().length < 20) throw new Error('No readable text (scanned brochure)');
    const rows = matchFeatures(tpl.features as Feature[], pages);
    await finish(job, true, { status: 'REVIEW_REQUIRED', raw: pages, rows });
  } catch (err) {
    logger.warn({ err, jobId }, 'Brochure reading failed');
    await finish(job, false, { status: 'FAILED', error: err instanceof Error ? err.message.slice(0, 200) : 'failed' });
  }
}

/** Jobs past the CFG-38 time limit become FAILED with OCR-03 (also covers a crashed worker). */
export async function failTimedOutJobs(): Promise<number> {
  const cutoff = new Date(clock.now().getTime() - settings.get('CFG-38') * 60_000 - 60_000);
  const stale = await db.select().from(ocrJobs).where(and(inArray(ocrJobs.status, ['QUEUED', 'PROCESSING']), lt(ocrJobs.createdAt, cutoff)));
  for (const j of stale) await finish(j, false, { status: 'FAILED', error: 'OCR time limit' });
  return stale.length;
}

defineJob('ocr-read', async (data) => runOcrJob(String(data.jobId)));
defineJob('ocr-timeouts', async () => void (await failTimedOutJobs()), '*/5 * * * *');

// ---------- review ----------
async function loadJob(dbx: DbOrTx, auth: AuthContext, id: string, lock = false): Promise<Job> {
  if (!isUuid(id)) throw notFound();
  const q = dbx.select().from(ocrJobs).where(eq(ocrJobs.id, id));
  const [j] = lock ? await q.for('update') : await q;
  // SkyUp sees only SkyUp jobs; an advisor only their own account's jobs
  const allowed = j && (j.accountId === null ? auth.role === 'STF' || auth.role === 'ADM' : auth.role === 'ADV' && auth.accountId === j.accountId);
  if (!j || !allowed) throw notFound();
  return j;
}

function jobView(j: Job) {
  const rows = (j.rows as OcrRow[]) ?? [];
  const threshold = settings.get('CFG-37');
  let message = null;
  if (j.status === 'QUEUED' || j.status === 'PROCESSING') message = msg('OCR-01');
  else if (j.status === 'FAILED') message = msg('OCR-03');
  else if (j.status === 'REVIEW_REQUIRED') message = msg('OCR-02', { n: rows.filter((r) => r.found !== null).length, m: rows.filter(flagged).length });
  return {
    id: j.id,
    status: j.status,
    fileId: j.fileId,
    productVersionId: j.productVersionId,
    threshold,
    rows: rows.map((r) => ({ ...r, flagged: flagged(r), notFoundMessage: r.found === null ? msg('OCR-08').text : null })),
    message,
    version: j.version,
  };
}

export async function getJob(auth: AuthContext, id: string) {
  return jobView(await loadJob(db, auth, id));
}

/** Save the reviewer's decisions (Accept, Edit with the correct value, Ignore, Not stated). */
export async function saveDecisions(req: Request, auth: AuthContext, id: string, body: unknown) {
  const version = readVersion(body);
  const input = Array.isArray((body as { rows?: unknown } | null)?.rows) ? ((body as { rows: unknown[] }).rows as Record<string, unknown>[]) : [];
  return db.transaction(async (tx) => {
    const j = await loadJob(tx, auth, id, true);
    if (j.version !== version) throw versionConflict('brochure review');
    if (j.status !== 'REVIEW_REQUIRED') throw stateConflict('brochure review', j.status);
    const rows = (j.rows as OcrRow[]).map((r) => ({ ...r }));
    for (const d of input) {
      const r = rows.find((x) => x.featureKey === d.featureKey);
      if (!r) continue;
      const decision = d.decision === null ? null : (DECISIONS as readonly string[]).includes(scalar(d.decision)) ? (d.decision as Decision) : undefined;
      if (decision === undefined) throw fieldError(`rows.${r.featureKey}`, 'VAL-22');
      if (decision === 'ACCEPT' && r.found === null) throw fieldError(`rows.${r.featureKey}`, 'OCR-08');
      if (decision === 'EDIT') {
        const v = parseFeatureValue(r, scalar(d.value));
        if (!scalar(d.value).trim()) throw fieldError(`rows.${r.featureKey}`, 'GEN-01', { 'Field label': r.name });
        if (!v.ok) throw fieldError(`rows.${r.featureKey}`, v.code, v.params);
        r.finalValue = v.value;
      } else r.finalValue = null;
      r.decision = decision;
    }
    const [n] = await tx.update(ocrJobs).set({ rows, version: j.version + 1 }).where(eq(ocrJobs.id, j.id)).returning();
    await audit(tx, req, { action: 'OCR_DECISIONS_SAVED', entity: 'ocr_job', entityId: j.id, accountId: j.accountId, newValue: input });
    return jobView(n!);
  });
}

/** Accept all above {CFG-37}: only high-confidence rows with a value; flagged rows are never accepted in bulk. */
export async function acceptHigh(req: Request, auth: AuthContext, id: string, body: unknown) {
  const version = readVersion(body);
  return db.transaction(async (tx) => {
    const j = await loadJob(tx, auth, id, true);
    if (j.version !== version) throw versionConflict('brochure review');
    if (j.status !== 'REVIEW_REQUIRED') throw stateConflict('brochure review', j.status);
    const rows = (j.rows as OcrRow[]).map((r) => (r.decision === null && r.found !== null && !flagged(r) ? { ...r, decision: 'ACCEPT' as const } : r));
    const [n] = await tx.update(ocrJobs).set({ rows, version: j.version + 1 }).where(eq(ocrJobs.id, j.id)).returning();
    await audit(tx, req, { action: 'OCR_ACCEPT_HIGH', entity: 'ocr_job', entityId: j.id, accountId: j.accountId });
    return jobView(n!);
  });
}

/**
 * Apply to draft (OCR-06): every highlighted row must have a decision (OCR-05). Accepted and edited values,
 * and Not stated, are copied into the draft marked "Read by OCR, checked by {name}". For an advisor's own
 * product the values are returned to fill the form instead.
 */
export async function applyJob(req: Request, auth: AuthContext, id: string, body: unknown) {
  const version = readVersion(body);
  return db.transaction(async (tx) => {
    const j = await loadJob(tx, auth, id, true);
    if (j.version !== version) throw versionConflict('brochure review');
    if (j.status !== 'REVIEW_REQUIRED') throw stateConflict('brochure review', j.status);
    const rows = j.rows as OcrRow[];
    if (rows.some((r) => flagged(r) && r.decision === null)) throw new AppError(422, 'OCR-05');
    const [me] = await tx.select({ name: users.name }).from(users).where(eq(users.id, auth.userId));
    const values: Record<string, FeatureValue> = {};
    for (const r of rows) {
      if (r.decision === 'ACCEPT') values[r.featureKey] = { value: r.found, notStated: false, sourcePage: r.sourcePage, ocrCheckedBy: me!.name };
      else if (r.decision === 'EDIT') values[r.featureKey] = { value: r.finalValue, notStated: false, sourcePage: r.sourcePage, ocrCheckedBy: me!.name };
      else if (r.decision === 'NOT_STATED') values[r.featureKey] = { value: null, notStated: true, sourcePage: null, ocrCheckedBy: me!.name };
    }
    const n = Object.keys(values).length;
    if (j.productVersionId) {
      const [v] = await tx.select().from(productVersions).where(eq(productVersions.id, j.productVersionId)).for('update');
      if (!v || v.status !== 'DRAFT') throw stateConflict('product', v?.status ?? 'missing');
      if (v.templateVersionId !== j.templateVersionId) throw stateConflict('product', 'template changed');
      const data = structuredClone(v.data as ProductData);
      data.features = { ...data.features, ...values };
      await tx.update(productVersions).set({ data, updatedAt: clock.now(), version: v.version + 1 }).where(eq(productVersions.id, v.id));
    }
    await tx.update(ocrJobs).set({ status: 'REVIEWED', reviewedBy: auth.userId, reviewedAt: clock.now(), version: j.version + 1 }).where(eq(ocrJobs.id, j.id));
    await audit(tx, req, { action: 'OCR_APPLIED', entity: 'ocr_job', entityId: j.id, accountId: j.accountId, newValue: { productVersionId: j.productVersionId, applied: values } });
    return { message: msg('OCR-06', { n }), features: j.productVersionId ? null : values };
  });
}

/** Try again after a failure: same file, a new job (P-23 failure and recovery). */
export async function retryJob(req: Request, auth: AuthContext, id: string) {
  const j = await loadJob(db, auth, id);
  if (j.status !== 'FAILED') throw stateConflict('brochure review', j.status);
  return startJob(req, auth, { fileId: j.fileId, templateVersionId: j.templateVersionId, productVersionId: j.productVersionId, accountId: j.accountId });
}
