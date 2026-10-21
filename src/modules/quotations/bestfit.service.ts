// P-26 Rank products by best fit. Only products the advisor can actually quote are ranked (AC-P26-1); five
// part scores from CFG-179, weighted by the chosen priority (CFG-168). Every score shows its reason and a
// fact the insurer does not state scores 0 "Not stated by insurer" (AC-P26-4). Uses catalogue facts and the
// advisor's own prices only; nothing is sent to any AI service in this release (FIT-05 path not used).
import type { Request } from 'express';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { fitLogs } from '../../db/schema.js';
import { clock } from '../../lib/clock.js';
import { AppError, fieldErrors, notFound, type FieldError } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import { msg, render } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { isUuid } from '../clients/common.js';
import { settings } from '../settings/settings.service.js';
import { bandIssue, calculate, checkSteps, coverage, loadCtx, mappingFor, mappingIssue, productIssue, productsOfType, sumInsuredAllowed, type Person } from './engine.js';
import { fact } from './features.js';

type Part = 'budgetFit' | 'roomRent' | 'coPay' | 'waitingPeriod' | 'claimRatio';
const PART_LABEL: Record<Part, string> = { budgetFit: 'Budget fit', roomRent: 'Room rent', coPay: 'Co-pay', waitingPeriod: 'Waiting period', claimRatio: 'Claim settlement ratio' };
const NOT_STATED = 'Not stated by insurer';

type Rules = {
  budgetFit: { atOrUnderBudget: number; minusPerPercentOver: number; zeroAtPercentOver: number };
  roomRent: { noLimit: number; singlePrivateRoom: number; percentOfSumInsured: number; fixedRupeeCap: number };
  coPay: { none: number; upTo10: number; upTo20: number; above20: number };
  preExistingWaitingYears: Record<string, number>;
  claimSettlementRatio: { min: number; max: number };
  notStated: number;
};

function scoreRoomRent(text: string | null, r: Rules): [number, string] {
  if (!text) return [r.notStated, NOT_STATED];
  const t = text.toLowerCase();
  if (/no\s*(limit|cap|sub-?limit)|any\s*room|unlimited/.test(t)) return [r.roomRent.noLimit, `${text}`];
  if (/single|private/.test(t)) return [r.roomRent.singlePrivateRoom, text];
  if (/%/.test(t)) return [r.roomRent.percentOfSumInsured, text];
  if (/\d/.test(t)) return [r.roomRent.fixedRupeeCap, text];
  return [r.notStated, `${text} (not recognised)`];
}

function toYears(value: string, dataType: string): number {
  const n = Number(value);
  if (dataType === 'DAYS') return n / 365;
  if (dataType === 'MONTHS') return n / 12;
  return n;
}

export async function bestFitOptions(auth: AuthContext, typeId: string) {
  if (!isUuid(typeId)) throw fieldErrors([{ field: 'typeId', code: 'VAL-22' }]);
  const products = await productsOfType(auth.accountId!, typeId);
  const options = new Set<string>();
  const ranges: { min: string; max: string }[] = [];
  for (const p of products) {
    if (p.status !== 'ACTIVE') continue;
    const si = p.data.sumInsured;
    if (si?.mode === 'OPTIONS') si.options.forEach((o) => options.add(o));
    else if (si?.mode === 'RANGE') ranges.push({ min: si.min, max: si.max });
  }
  const weights = settings.get('CFG-168') as Record<string, Record<Part, number>>;
  return { sumInsuredOptions: [...options].sort((a, b) => Number(a) - Number(b)), ranges, priorities: Object.keys(weights), weights };
}

export async function rank(req: Request, auth: AuthContext, body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const weightsAll = settings.get('CFG-168') as Record<string, Record<Part, number>>;
  const v = F.parseFields(b, {
    customerId: { label: 'Customer', required: true },
    typeId: { label: 'Insurance type', required: true },
    budget: { label: 'Yearly budget', required: true, rule: F.amount() },
    priority: { label: 'What matters most', required: true, oneOf: Object.keys(weightsAll) },
    sumInsured: { label: 'Sum insured', required: true, rule: F.amount() },
  }) as { customerId: string; typeId: string; budget: string; priority: string; sumInsured: string };
  const peopleKeys = Array.isArray(b.people) ? b.people.filter((x): x is string => typeof x === 'string') : [];
  if (!peopleKeys.length) throw fieldErrors([{ field: 'people', code: 'GEN-01', params: { 'Field label': 'People to cover' } }]);
  const ctx = await loadCtx(auth.accountId!, auth.role, v.customerId, { typeId: v.typeId });
  if (!ctx.people.length) throw notFound();
  const errs: FieldError[] = (await checkSteps(ctx, { typeId: v.typeId }, 3)).filter((e) => e.field !== 'insurerId');
  const people = peopleKeys.map((k) => ctx.people.find((p) => p.key === k && p.active)).filter((p): p is Person => !!p);
  for (const p of people) if (p.age === null) errs.push({ field: `people.${p.key}`, code: 'QT-05', params: { name: p.name } });
  if (errs.length) throw fieldErrors(errs);

  const rules = settings.get('CFG-179') as unknown as Rules;
  const weights = weightsAll[v.priority]!;
  const budget = Number(v.budget);
  const products = await productsOfType(auth.accountId!, v.typeId);
  const ranked = [];
  for (const p of products) {
    if (p.status !== 'ACTIVE') continue;
    if (mappingIssue(await mappingFor(db, auth.accountId!, p.insurerId), p.insurerName, p.insurerStatus)) continue;
    if (await productIssue(auth.accountId!, p)) continue;
    if (!sumInsuredAllowed(p.data, v.sumInsured)) continue;
    const covered = people.filter((x) => !bandIssue(x, p.data));
    if (!covered.length) continue;
    const cov = coverage(people, p.data);
    const term = p.data.policyTerms[0];
    let premium: string | null = null;
    if (p.data.pricingMode === 'RATE_TABLE') {
      const res = await calculate(auth.accountId!, p, covered, ctx.people, { sumInsured: v.sumInsured, term, people: covered.map((x) => x.key), typeId: v.typeId, insurerId: p.insurerId, productId: p.productId }, auth.role);
      if (!res.ok) continue;
      premium = res.breakdown.finalPayable;
    }
    const parts: { key: Part; label: string; score: number; reason: string }[] = [];
    // Budget fit
    if (premium === null) parts.push({ key: 'budgetFit', label: PART_LABEL.budgetFit, score: rules.notStated, reason: 'Premium is typed from the insurer portal when quoting' });
    else {
      const over = ((Number(premium) - budget) / budget) * 100;
      const s = over <= 0 ? rules.budgetFit.atOrUnderBudget : over >= rules.budgetFit.zeroAtPercentOver ? 0 : Math.max(0, rules.budgetFit.atOrUnderBudget - rules.budgetFit.minusPerPercentOver * over);
      parts.push({ key: 'budgetFit', label: PART_LABEL.budgetFit, score: Math.round(s * 10) / 10, reason: over <= 0 ? `₹${F.groupIndian(premium)} is within your budget` : `₹${F.groupIndian(premium)} is ${Math.round(over * 10) / 10}% over budget` });
    }
    // Room rent
    const rr = fact(p.features, p.data, 'roomRent');
    const [rrs, rrReason] = scoreRoomRent(rr.text === NOT_STATED ? null : (rr.value?.value ?? null), rules);
    parts.push({ key: 'roomRent', label: PART_LABEL.roomRent, score: rrs, reason: rrReason });
    // Co-pay
    const cp = fact(p.features, p.data, 'coPay');
    if (cp.text === NOT_STATED || cp.value?.value === undefined || cp.value.value === null || Number.isNaN(Number(cp.value.value))) parts.push({ key: 'coPay', label: PART_LABEL.coPay, score: rules.notStated, reason: NOT_STATED });
    else {
      const n = Number(cp.value.value);
      const s = n === 0 ? rules.coPay.none : n <= 10 ? rules.coPay.upTo10 : n <= 20 ? rules.coPay.upTo20 : rules.coPay.above20;
      parts.push({ key: 'coPay', label: PART_LABEL.coPay, score: s, reason: n === 0 ? 'No co-pay' : `${n}% co-pay` });
    }
    // Waiting period for pre-existing conditions
    const wp = fact(p.features, p.data, 'pedWait');
    if (wp.text === NOT_STATED || !wp.feature || !wp.value?.value) parts.push({ key: 'waitingPeriod', label: PART_LABEL.waitingPeriod, score: rules.notStated, reason: NOT_STATED });
    else {
      const years = Math.ceil(toYears(wp.value.value, wp.feature.dataType));
      const s = years <= 1 ? (rules.preExistingWaitingYears['1'] ?? 100) : (rules.preExistingWaitingYears[String(years)] ?? 0);
      parts.push({ key: 'waitingPeriod', label: PART_LABEL.waitingPeriod, score: s, reason: `${wp.text} for pre-existing conditions` });
    }
    // Claim settlement ratio: (ratio − 80) × 5, from 0 to 100
    const csr = fact(p.features, p.data, 'csr');
    if (csr.text === NOT_STATED || !csr.value?.value || Number.isNaN(Number(csr.value.value))) parts.push({ key: 'claimRatio', label: PART_LABEL.claimRatio, score: rules.notStated, reason: NOT_STATED });
    else {
      const ratio = Number(csr.value.value);
      const s = Math.min(rules.claimSettlementRatio.max, Math.max(rules.claimSettlementRatio.min, (ratio - 80) * 5));
      parts.push({ key: 'claimRatio', label: PART_LABEL.claimRatio, score: Math.round(s * 10) / 10, reason: `${ratio}% claims settled` });
    }
    const total = parts.reduce((t, x) => t + x.score * (weights[x.key] ?? 0), 0) / 100;
    ranked.push({
      productId: p.productId,
      name: p.data.name,
      uin: p.data.uin,
      insurerId: p.insurerId,
      insurerName: p.insurerName,
      pricingMode: p.data.pricingMode,
      premium,
      term,
      total: Math.round(total * 10) / 10,
      scores: parts.map((x) => ({ ...x, weight: weights[x.key] ?? 0, text: `${x.label}: ${x.reason}, ${x.score}` })),
      coverage: { n: cov.n, m: cov.m, notCovered: cov.notCovered, full: cov.n === cov.m, text: cov.n < cov.m ? render('QT-41', { n: cov.n, m: cov.m, names: cov.notCovered.join(', ') }) : null },
    });
  }
  // Products covering everyone first, then by total score (AC-P26-3); ties by lower premium, then name
  ranked.sort((a, b) => Number(b.coverage.full) - Number(a.coverage.full) || b.total - a.total || Number(a.premium ?? Infinity) - Number(b.premium ?? Infinity) || a.name.localeCompare(b.name));
  const [log] = await db
    .insert(fitLogs)
    .values({ accountId: auth.accountId!, customerId: v.customerId, inputs: { ...v, people: peopleKeys, ages: people.map((p) => p.age) }, ranked: ranked.map((r) => ({ productId: r.productId, total: r.total, scores: r.scores.map((s) => [s.key, s.score]) })), createdBy: auth.userId, createdAt: clock.now() })
    .returning();
  if (!ranked.length) return { logId: log!.id, items: [], message: msg('FIT-02') };
  void req;
  return { logId: log!.id, items: ranked, message: msg('FIT-03', { n: ranked.length }), compare: { min: settings.get('CFG-44'), max: settings.get('CFG-45') } };
}

/** The log keeps which product the advisor chose (Create quotation from the ranking). */
export async function chooseFromRanking(auth: AuthContext, logId: string, body: unknown) {
  const productId = (body as { productId?: unknown } | null)?.productId;
  if (!isUuid(logId) || typeof productId !== 'string') throw notFound();
  const rows = await db.update(fitLogs).set({ chosenProductId: productId }).where(and(eq(fitLogs.id, logId), eq(fitLogs.accountId, auth.accountId!))).returning({ id: fitLogs.id });
  if (!rows.length) throw notFound();
  return { ok: true };
}

/** FIT-04 for Add to comparison. */
export function checkCompareCount(n: number) {
  if (n < settings.get('CFG-44') || n > settings.get('CFG-45')) throw new AppError(422, 'FIT-04');
}
