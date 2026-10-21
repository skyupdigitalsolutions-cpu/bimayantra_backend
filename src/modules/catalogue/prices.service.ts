// P-24 Price versions: the advisor's private, dated price for a product (no approval). STF or ADM may load a
// SkyUp reference price for a verified product, which advisors can copy. Exactly one version per owner and
// product has no end date (database rule); saving a new version closes the previous one on the day before,
// in the same transaction. The price used is the one whose dates cover IST today (GR-23 stores its ID).
// SYS-02 starts SCHEDULED versions at 00:00 IST and closes ended ones.
import type { Request } from 'express';
import { and, desc, eq, gte, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.js';
import { priceVersions, products, productVersions, templateVersions } from '../../db/schema.js';
import { addDays, clock, formatDate, istToday } from '../../lib/clock.js';
import { AppError, fieldError, fieldErrors, notFound, stateConflict, type FieldError } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import { msg, render } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { audit } from '../audit/audit.js';
import { defineJob } from '../jobs/jobs.js';
import { settings } from '../settings/settings.service.js';
import { isUnique, isUuid, scalar } from './common.js';
import type { ProductData } from './productData.js';
import { startLaunchedProducts } from './products.service.js';
import { bandLabel, type Factor } from './types.service.js';

export type RateRow = { factors: Record<string, string>; basePremium: string };
type Price = typeof priceVersions.$inferSelect;
type Owner = { key: string; accountId: string | null };
const ownerOf = (auth: AuthContext): Owner => (auth.role === 'ADV' ? { key: auth.accountId!, accountId: auth.accountId! } : { key: 'SKYUP', accountId: null });
const nameOf = (p: Pick<Price, 'seq'>) => `V${p.seq}`;

/**
 * The product and the version whose rating factors and riders apply. Advisors price the published version;
 * SkyUp may load a reference price while the first version is still a draft (it is needed to submit).
 */
async function pricingContext(dbx: DbOrTx, auth: AuthContext, productId: string) {
  if (!isUuid(productId)) throw notFound();
  const accountOk = auth.role === 'ADV' ? or(isNull(products.accountId), eq(products.accountId, auth.accountId!)) : isNull(products.accountId);
  const [p] = await dbx.select().from(products).where(and(eq(products.id, productId), accountOk));
  if (!p) throw notFound();
  let [v] = p.publishedVersionId ? await dbx.select().from(productVersions).where(eq(productVersions.id, p.publishedVersionId)) : [];
  if (auth.role !== 'ADV') {
    const [open] = await dbx
      .select()
      .from(productVersions)
      .where(and(eq(productVersions.productId, p.id), sql`${productVersions.status} in ('DRAFT','PENDING_APPROVAL')`));
    v = open ?? v;
  }
  if (!v) throw notFound();
  const [t] = await dbx.select().from(templateVersions).where(eq(templateVersions.id, v.templateVersionId));
  const data = v.data as ProductData;
  return { product: p, data, factors: (t?.factors ?? []) as Factor[] };
}

const valuesOf = (f: Factor) => (f.kind === 'BAND' ? f.bands.map(bandLabel) : f.values);
export const csvHeader = (factors: Factor[]) => [...factors.map((f) => f.name), 'base_premium'];

function csvEscape(v: string) {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i += 1;
      row.push(cell);
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

/** All factor combinations (capped), for the template download and the missing-combination warning. */
function* combinations(factors: Factor[]): Generator<Record<string, string>> {
  const lists = factors.map(valuesOf);
  if (lists.some((l) => l.length === 0)) return;
  const idx = lists.map(() => 0);
  while (true) {
    yield Object.fromEntries(factors.map((f, i) => [f.key, lists[i]![idx[i]!]!]));
    let k = lists.length - 1;
    while (k >= 0 && idx[k]! + 1 >= lists[k]!.length) {
      idx[k] = 0;
      k -= 1;
    }
    if (k < 0) return;
    idx[k]! += 1;
  }
}

export async function rateTemplateCsv(auth: AuthContext, productId: string): Promise<{ name: string; csv: string }> {
  const ctx = await pricingContext(db, auth, productId);
  const lines = [csvHeader(ctx.factors).map(csvEscape).join(',')];
  const cap = settings.get('CFG-39');
  for (const c of combinations(ctx.factors)) {
    if (lines.length > cap) break;
    lines.push([...ctx.factors.map((f) => csvEscape(c[f.key]!)), ''].join(','));
  }
  return { name: `${ctx.product.code}-rate-template.csv`, csv: `${lines.join('\n')}\n` };
}

type CheckResult = { rows: RateRow[]; errors: { row: number; field: string; message: string }[]; missing: string[]; missingCount: number; duplicates: number[] };

/** Check every row (P-24 step 3): accepted rows, row errors (report), repeats, missing combinations. */
export function checkRows(factors: Factor[], input: { rows?: unknown; csv?: unknown }): CheckResult {
  const cap = settings.get('CFG-39');
  let raw: { factors: Record<string, unknown>; basePremium: unknown }[] = [];
  if (typeof input.csv === 'string') {
    const table = parseCsv(input.csv);
    const header = (table[0] ?? []).map((h) => h.trim());
    const expected = csvHeader(factors);
    if (header.length !== expected.length || header.some((h, i) => h !== expected[i])) throw fieldError('csv', 'CAT-31');
    raw = table.slice(1).map((r) => ({ factors: Object.fromEntries(factors.map((f, i) => [f.key, r[i] ?? ''])), basePremium: r[factors.length] ?? '' }));
  } else if (Array.isArray(input.rows)) {
    raw = (input.rows as Record<string, unknown>[]).map((r) => ({ factors: (r.factors ?? {}) as Record<string, unknown>, basePremium: r.basePremium }));
  }
  if (raw.length === 0) throw fieldError('rows', 'GEN-01', { 'Field label': 'Rate table' });
  if (raw.length > cap) throw fieldError('rows', 'CAT-20');
  const errors: CheckResult['errors'] = [];
  const rows: RateRow[] = [];
  const seen = new Map<string, { premium: string; row: number }>();
  const duplicates = new Set<number>();
  raw.forEach((r, i) => {
    const n = i + 1;
    const out: Record<string, string> = {};
    let ok = true;
    for (const f of factors) {
      const v = scalar(r.factors[f.key]).trim().replace(/\s*[–—]\s*/g, '-').replace(/\s*-\s*/g, '-');
      const match = valuesOf(f).find((x) => x.toLowerCase() === v.toLowerCase());
      if (!match) {
        ok = false;
        errors.push({ row: n, field: f.name, message: v ? render('VAL-22') : render('GEN-01', { 'Field label': f.name }) });
      } else out[f.key] = match;
    }
    const prem = F.amount()(scalar(r.basePremium));
    if (!prem.ok) {
      ok = false;
      errors.push({ row: n, field: 'base_premium', message: render(prem.code, prem.params) });
    }
    if (!ok || !prem.ok) return;
    const key = factors.map((f) => out[f.key]).join('|');
    const before = seen.get(key);
    if (before) {
      if (before.premium !== prem.value) {
        duplicates.add(before.row);
        duplicates.add(n);
      }
      return; // the same factors with the same premium are one row
    }
    seen.set(key, { premium: prem.value, row: n });
    rows.push({ factors: out, basePremium: prem.value });
  });
  const missing: string[] = [];
  let missingCount = 0;
  let scanned = 0;
  for (const c of combinations(factors)) {
    scanned += 1;
    if (scanned > cap * 2) break;
    if (!seen.has(factors.map((f) => c[f.key]).join('|'))) {
      missingCount += 1;
      if (missing.length < 20) missing.push(factors.map((f) => `${f.name} ${c[f.key]}`).join(', '));
    }
  }
  return { rows, errors, missing, missingCount, duplicates: [...duplicates].sort((a, b) => a - b) };
}

function summarise(r: CheckResult) {
  return {
    accepted: r.rows.length,
    errors: r.errors,
    errorMessage: r.errors.length ? msg('CAT-19', { n: new Set(r.errors.map((e) => e.row)).size }) : null,
    duplicates: r.duplicates,
    duplicateMessage: r.duplicates.length ? msg('CAT-22', { list: r.duplicates.join(', ') }) : null,
    missing: r.missing,
    missingCount: r.missingCount,
    warning: r.missingCount ? msg('CAT-21', { list: `${r.missing.join('; ')}${r.missingCount > r.missing.length ? ` and ${r.missingCount - r.missing.length} more` : ''}` }) : null,
  };
}

/** Check without saving (the screen shows accepted rows, errors and missing combinations). */
export async function checkPrice(auth: AuthContext, productId: string, body: unknown) {
  const ctx = await pricingContext(db, auth, productId);
  return summarise(checkRows(ctx.factors, (body ?? {})));
}

function priceView(p: Price) {
  return {
    id: p.id,
    name: nameOf(p),
    effectiveFrom: p.effectiveFrom,
    effectiveTo: p.effectiveTo,
    status: p.status,
    taxPercent: p.taxPercent,
    rowCount: (p.rows as RateRow[]).length,
    riderPrices: p.riderPrices,
    sourceNote: p.sourceNote,
    createdAt: p.createdAt,
  };
}

export async function listPrices(auth: AuthContext, productId: string) {
  const ctx = await pricingContext(db, auth, productId);
  const owner = ownerOf(auth);
  const rows = await db
    .select()
    .from(priceVersions)
    .where(and(eq(priceVersions.ownerKey, owner.key), eq(priceVersions.productId, ctx.product.id)))
    .orderBy(desc(priceVersions.seq));
  const inEffect = await priceInEffect(db, owner.key, ctx.product.id);
  const [reference] = ctx.product.kind === 'VERIFIED' && auth.role === 'ADV' ? await referenceRow(ctx.product.id) : [];
  return {
    pricingMode: ctx.data.pricingMode,
    factors: ctx.factors,
    riders: ctx.data.riders,
    items: rows.map(priceView),
    inEffectId: inEffect?.id ?? null,
    hasReference: Boolean(reference),
  };
}

export async function getPrice(auth: AuthContext, productId: string, priceId: string) {
  const ctx = await pricingContext(db, auth, productId);
  if (!isUuid(priceId)) throw notFound();
  const [p] = await db
    .select()
    .from(priceVersions)
    .where(and(eq(priceVersions.id, priceId), eq(priceVersions.ownerKey, ownerOf(auth).key), eq(priceVersions.productId, ctx.product.id)));
  if (!p) throw notFound(); // prices are private: another account's price never exists for this caller
  return { ...priceView(p), rows: p.rows as RateRow[] };
}

const referenceRow = (productId: string) => {
  const today = istToday();
  return db
    .select()
    .from(priceVersions)
    .where(
      and(
        eq(priceVersions.ownerKey, 'SKYUP'),
        eq(priceVersions.productId, productId),
        ne(priceVersions.status, 'CANCELLED'),
        lte(priceVersions.effectiveFrom, today),
        or(isNull(priceVersions.effectiveTo), gte(priceVersions.effectiveTo, today)),
      ),
    );
};

/** Copy SkyUp reference price: the rows of the SkyUp price in effect today, to adjust and save as mine. */
export async function referencePrice(auth: AuthContext, productId: string) {
  const ctx = await pricingContext(db, auth, productId);
  if (ctx.product.kind !== 'VERIFIED') throw notFound();
  const [p] = await referenceRow(ctx.product.id);
  if (!p) throw notFound();
  return { taxPercent: p.taxPercent, rows: p.rows as RateRow[], riderPrices: p.riderPrices, sourceNote: p.sourceNote };
}

/** The version whose dates cover the given IST date (default today). */
export async function priceInEffect(dbx: DbOrTx, ownerKey: string, productId: string, on = istToday()): Promise<Price | undefined> {
  const [p] = await dbx
    .select()
    .from(priceVersions)
    .where(
      and(
        eq(priceVersions.ownerKey, ownerKey),
        eq(priceVersions.productId, productId),
        ne(priceVersions.status, 'CANCELLED'),
        lte(priceVersions.effectiveFrom, on),
        or(isNull(priceVersions.effectiveTo), gte(priceVersions.effectiveTo, on)),
      ),
    )
    .orderBy(desc(priceVersions.effectiveFrom))
    .limit(1);
  return p;
}

/** + New price (P-24 steps 1–4). */
export async function createPrice(req: Request, auth: AuthContext, productId: string, body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const errors: FieldError[] = [];
  let effectiveFrom = '';
  let taxPercent = '';
  let sourceNote: string | null = null;
  try {
    const v = F.parseFields(body, {
      effectiveFrom: { label: 'Effective from', required: true, rule: F.date },
      taxPercent: { label: 'Tax %', required: true, rule: F.percentage },
      sourceNote: { label: 'Source note', rule: F.shortText },
    }) as { effectiveFrom: string; taxPercent: string; sourceNote?: string };
    effectiveFrom = v.effectiveFrom;
    taxPercent = v.taxPercent;
    sourceNote = v.sourceNote ?? null;
  } catch (err) {
    if (err instanceof AppError) errors.push(...err.fields);
    else throw err;
  }
  const today = istToday();
  if (effectiveFrom && effectiveFrom < today) errors.push({ field: 'effectiveFrom', code: 'CAT-18' });
  const ctx = await pricingContext(db, auth, productId);
  if (ctx.data.pricingMode !== 'RATE_TABLE') throw stateConflict('product', 'MANUAL_ENTRY');
  // Rider prices: one per rider, as an amount (FLD-08) or a percentage (FLD-09)
  const riderIn = Array.isArray(b.riderPrices) ? (b.riderPrices as Record<string, unknown>[]) : [];
  const riderPrices = ctx.data.riders.map((r, i) => {
    const given = riderIn.find((x) => x.key === r.key);
    const raw = given?.value;
    if (scalar(raw).trim() === '') {
      errors.push({ field: `riderPrices.${i}`, code: 'GEN-01', params: { 'Field label': r.name } });
      return { key: r.key, priceType: r.priceType, value: '' };
    }
    const res = r.priceType === 'PERCENT' ? F.percentage(scalar(raw)) : F.amount()(scalar(raw));
    if (!res.ok) errors.push({ field: `riderPrices.${i}`, code: res.code, ...(res.params ? { params: res.params } : {}) });
    return { key: r.key, priceType: r.priceType, value: res.ok ? res.value : '' };
  });
  if (errors.length) throw fieldErrors(errors);
  const check = checkRows(ctx.factors, b);
  if (check.errors.length) throw new AppError(422, 'CAT-19', { n: new Set(check.errors.map((e) => e.row)).size }, [{ field: 'rows', code: 'CAT-19', params: { n: new Set(check.errors.map((e) => e.row)).size } }], { rowErrors: check.errors });
  if (check.duplicates.length) throw fieldError('rows', 'CAT-22', { list: check.duplicates.join(', ') });
  const owner = ownerOf(auth);
  try {
    return await db.transaction(async (tx) => {
      // Serialise saves for this product so two saves at the same moment cannot both close the old price
      await tx.select({ id: products.id }).from(products).where(eq(products.id, ctx.product.id)).for('update');
      const [open] = await tx
        .select()
        .from(priceVersions)
        .where(and(eq(priceVersions.ownerKey, owner.key), eq(priceVersions.productId, ctx.product.id), isNull(priceVersions.effectiveTo), ne(priceVersions.status, 'CANCELLED')))
        .for('update');
      if (open && effectiveFrom <= open.effectiveFrom) {
        if (open.status === 'SCHEDULED') throw fieldError('effectiveFrom', 'CAT-17', { version: nameOf(open), dates: `${formatDate(open.effectiveFrom)} onwards` });
        throw fieldError('effectiveFrom', 'CAT-38', { date: formatDate(open.effectiveFrom) });
      }
      const endOfOld = addDays(effectiveFrom, -1);
      if (open) {
        const closedNow = open.status === 'CURRENT' && endOfOld < today;
        await tx.update(priceVersions).set({ effectiveTo: endOfOld, status: closedNow ? 'CLOSED' : open.status }).where(eq(priceVersions.id, open.id));
      }
      const [last] = await tx
        .select({ n: sql<number>`coalesce(max(${priceVersions.seq}), 0)::int` })
        .from(priceVersions)
        .where(and(eq(priceVersions.ownerKey, owner.key), eq(priceVersions.productId, ctx.product.id)));
      const status = effectiveFrom === today ? 'CURRENT' : 'SCHEDULED';
      const [p] = await tx
        .insert(priceVersions)
        .values({
          ownerKey: owner.key,
          accountId: owner.accountId,
          productId: ctx.product.id,
          seq: (last?.n ?? 0) + 1,
          effectiveFrom,
          status,
          taxPercent,
          rows: check.rows,
          riderPrices,
          sourceNote,
          createdBy: auth.userId,
          createdAt: clock.now(),
        })
        .returning();
      await audit(tx, req, {
        action: 'PRICE_VERSION_SAVED',
        entity: 'price_version',
        entityId: p!.id,
        accountId: owner.accountId,
        newValue: { productId: ctx.product.id, name: nameOf(p!), effectiveFrom, status, rows: check.rows.length, closed: open ? { id: open.id, effectiveTo: endOfOld } : null },
      });
      return {
        price: priceView(p!),
        message: open ? msg('CAT-37', { 'start date': formatDate(effectiveFrom), 'end date': formatDate(endOfOld) }) : msg('GEN-08', { 'Record type': `Price ${nameOf(p!)}` }),
        warning: summarise(check).warning,
      };
    });
  } catch (err) {
    if (isUnique(err, 'price_one_open') || isUnique(err, 'price_seq')) throw stateConflict('price', 'changed');
    throw err;
  }
}

/** Cancel a SCHEDULED version before it starts (CAT-25). CURRENT and CLOSED versions can never change. */
export async function cancelPrice(req: Request, auth: AuthContext, productId: string, priceId: string) {
  const ctx = await pricingContext(db, auth, productId);
  const owner = ownerOf(auth);
  if (!isUuid(priceId)) throw notFound();
  return db.transaction(async (tx) => {
    await tx.select({ id: products.id }).from(products).where(eq(products.id, ctx.product.id)).for('update');
    const [p] = await tx
      .select()
      .from(priceVersions)
      .where(and(eq(priceVersions.id, priceId), eq(priceVersions.ownerKey, owner.key), eq(priceVersions.productId, ctx.product.id)))
      .for('update');
    if (!p) throw notFound();
    if (p.status !== 'SCHEDULED' || p.effectiveFrom <= istToday()) throw stateConflict('price', p.status);
    await tx.update(priceVersions).set({ status: 'CANCELLED', cancelledAt: clock.now() }).where(eq(priceVersions.id, p.id));
    // The version before it takes back its end date (open again if this was the latest)
    const [prev] = await tx
      .select()
      .from(priceVersions)
      .where(and(eq(priceVersions.ownerKey, owner.key), eq(priceVersions.productId, ctx.product.id), eq(priceVersions.effectiveTo, addDays(p.effectiveFrom, -1)), ne(priceVersions.status, 'CANCELLED')));
    if (prev) await tx.update(priceVersions).set({ effectiveTo: p.effectiveTo, status: prev.status === 'CLOSED' ? 'CURRENT' : prev.status }).where(eq(priceVersions.id, prev.id));
    await audit(tx, req, { action: 'PRICE_VERSION_CANCELLED', entity: 'price_version', entityId: p.id, accountId: owner.accountId });
    return { message: msg('CAT-25', { name: nameOf(p) }) };
  });
}

/** SYS-02 (daily 00:00 IST): SCHEDULED → CURRENT on its start date; ended CURRENT → CLOSED. Repeat-safe. */
export async function runPriceSchedule(): Promise<{ started: number; closed: number }> {
  const today = istToday();
  const closed = await db
    .update(priceVersions)
    .set({ status: 'CLOSED' })
    .where(and(eq(priceVersions.status, 'CURRENT'), sql`${priceVersions.effectiveTo} < ${today}`))
    .returning({ id: priceVersions.id });
  const started = await db
    .update(priceVersions)
    .set({ status: 'CURRENT' })
    .where(and(eq(priceVersions.status, 'SCHEDULED'), lte(priceVersions.effectiveFrom, today), or(isNull(priceVersions.effectiveTo), gte(priceVersions.effectiveTo, today))))
    .returning({ id: priceVersions.id });
  // A scheduled version whose whole period passed without the job (very long outage) is closed too
  await db.update(priceVersions).set({ status: 'CLOSED' }).where(and(eq(priceVersions.status, 'SCHEDULED'), sql`${priceVersions.effectiveTo} < ${today}`));
  return { started: started.length, closed: closed.length };
}

defineJob(
  'price-versions-daily',
  async () => {
    await runPriceSchedule();
    await startLaunchedProducts();
  },
  '0 0 * * *',
);

export { parseCsv };
