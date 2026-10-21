import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { notifications, priceVersions, productVersions, products } from '../src/db/schema.js';
import { addDays, formatDate, istToday } from '../src/lib/clock.js';
import { runPriceSchedule } from '../src/modules/catalogue/prices.service.js';
import { quotability } from '../src/modules/catalogue/products.service.js';
import { settings } from '../src/modules/settings/settings.service.js';
import { Device, advisor, insertUser, key, login, makePdf, newMobile, resetClock, resetSettings, setSetting, staff, stepUp, upload } from './helpers.js';

type Staff = Awaited<ReturnType<typeof staff>>;
let A: Staff; // maker (ADM)
let B: Staff; // a different ADM, the approver
let S: Staff; // catalogue staff (STF)
let world: { typeId: string; templateId: string; insurerId: string; productId: string; versionId: string };

const rand = () => Math.random().toString(36).slice(2, 7).toUpperCase();
const today = () => istToday();
const H = () => ({ 'idempotency-key': key() });

const FEATURES = [
  { key: 'room_rent', name: 'Room rent limit', group: 'LIMITS', dataType: 'TEXT', requiredToPublish: true },
  { key: 'copay', name: 'Co-pay', group: 'LIMITS', dataType: 'PERCENT', requiredToPublish: true },
  { key: 'initial_wait', name: 'Initial waiting period', group: 'WAITING_PERIODS', dataType: 'DAYS', requiredToPublish: false },
  { key: 'network', name: 'Network hospitals count', group: 'OTHER', dataType: 'NUMBER', requiredToPublish: false },
  { key: 'maternity', name: 'Maternity cover', group: 'BENEFITS', dataType: 'YES_NO', requiredToPublish: false },
];
const FACTORS = [
  { key: 'age', name: 'Eldest age', kind: 'BAND', filledFrom: 'ELDEST_AGE', bands: [{ min: 18, max: 45 }, { min: 46, max: 65 }] },
  { key: 'si', name: 'Sum insured', kind: 'VALUE', filledFrom: 'SUM_INSURED', values: ['500000', '1000000'] },
];
const RATES = [
  { factors: { age: '18-45', si: '500000' }, basePremium: '9000' },
  { factors: { age: '18-45', si: '1000000' }, basePremium: '12000' },
  { factors: { age: '46-65', si: '500000' }, basePremium: '15000' },
  { factors: { age: '46-65', si: '1000000' }, basePremium: '19000' },
];
const productBody = (over: Record<string, unknown> = {}) => ({
  name: 'Family Shield',
  shortDescription: 'Family floater',
  uin: `UIN${rand()}`,
  launchDate: formatDate(today()),
  adultMinAge: 18,
  adultMaxAge: 65,
  coversChildren: true,
  childMinAge: 0,
  childMaxAge: 25,
  sumInsured: { mode: 'OPTIONS', options: ['500000', '1000000'] },
  policyTerms: [1, 2],
  features: { room_rent: { value: 'Single room', sourcePage: 2 }, copay: { notStated: true } },
  pricingMode: 'RATE_TABLE',
  taxPercent: '18',
  nomineeRequired: true,
  maxNominees: 2,
  sourceLink: 'https://example.com/plan',
  sourceCheckedOn: formatDate(today()),
  ...over,
});

async function approve(d: Device, mobile: string, path: string, version: number) {
  return d.post(path, { version }, { ...H(), 'x-step-up-token': await stepUp(d, mobile) });
}

async function makeType(name = `Health ${rand()}`) {
  const c = await A.d.post('/admin/catalogue/types', { name, features: FEATURES, factors: FACTORS, questions: [] }, H());
  expect(c.status).toBe(200);
  const t = c.body.type;
  const s = await A.d.post(`/admin/catalogue/templates/${t.openTemplate.id}/submit`, { version: t.openTemplate.version });
  expect(s.status).toBe(200);
  const a = await approve(B.d, B.mobile, `/admin/catalogue/templates/${t.openTemplate.id}/approve`, s.body.template.version);
  expect(a.status).toBe(200);
  return { typeId: t.id as string, templateId: t.openTemplate.id as string };
}

async function makeInsurer(over: Record<string, unknown> = {}) {
  const code = `INS-${rand()}`;
  const c = await A.d.post('/admin/catalogue/insurers', { name: `Insurer ${code}`, shortCode: code, category: 'GENERAL', irdaiRegNo: 'IRDA-123', paymentDomains: ['insurer.com'], submit: true, ...over }, H());
  expect(c.status).toBe(200);
  const a = await approve(B.d, B.mobile, `/admin/catalogue/insurers/${c.body.insurer.id}/approve`, c.body.insurer.version);
  expect(a.status).toBe(200);
  return a.body.insurer as { id: string; name: string; version: number };
}

async function makeVerified(typeId: string, insurerId: string, over: Record<string, unknown> = {}) {
  const c = await A.d.post('/admin/catalogue/products', { insurerId, typeId, code: `P-${rand()}`, ...productBody(over) }, H());
  if (c.status !== 200) console.log("CREATE", JSON.stringify(c.body));
  expect(c.status).toBe(200);
  const price = await A.d.post(`/admin/catalogue/products/${c.body.productId}/prices`, { effectiveFrom: today(), taxPercent: '18', rows: RATES }, H());
  expect(price.status).toBe(200);
  const s = await A.d.post(`/admin/catalogue/product-versions/${c.body.versionId}/submit`, { version: c.body.version });
  expect(s.status).toBe(200);
  const a = await approve(B.d, B.mobile, `/admin/catalogue/product-versions/${c.body.versionId}/approve`, s.body.version);
  expect(a.status).toBe(200);
  return { productId: c.body.productId as string, versionId: c.body.versionId as string };
}

// Every approval needs its own OTP; one approver approves many items here, so the hourly OTP limit
// (CFG-05) is raised for this file (document change: step-up OTPs and CFG-05)
const manyOtps = async () => {
  await setSetting('CFG-05', 1000);
  await setSetting('CFG-04', 0);
};
beforeAll(async () => {
  await settings.init();
  await manyOtps();
  A = await staff('ADM', 'Maker Admin');
  B = await staff('ADM', 'Approver Admin');
  S = await staff('STF');
  const t = await makeType();
  const i = await makeInsurer();
  const p = await makeVerified(t.typeId, i.id);
  world = { ...t, insurerId: i.id, ...p };
});
beforeEach(manyOtps);
afterEach(async () => {
  resetClock();
  await resetSettings();
});

describe('P-20 Manage insurers', () => {
  it('AC-P20-1: a duplicate name (ignoring case) or code is refused (CAT-06, CAT-07); CAT-10 for a URL as domain', async () => {
    const code = `DUP-${rand()}`;
    await A.d.post('/admin/catalogue/insurers', { name: `Dup ${code}`, shortCode: code, category: 'LIFE', irdaiRegNo: 'R1', paymentDomains: 'dup.com' }, H());
    const r = await S.d.post('/admin/catalogue/insurers', { name: `dup ${code.toLowerCase()}`, shortCode: code, category: 'LIFE', irdaiRegNo: 'R1', paymentDomains: ['https://dup.com/pay'] }, H());
    expect(r.status).toBe(422);
    const codes = Object.fromEntries(r.body.error.fields.map((f: { field: string; code: string }) => [f.field, f.code]));
    expect(codes).toMatchObject({ paymentDomains: 'CAT-10' });
    const r2 = await S.d.post('/admin/catalogue/insurers', { name: `dup ${code.toLowerCase()}`, shortCode: code, category: 'LIFE', irdaiRegNo: 'R1', paymentDomains: ['pay.dup.com'] }, H());
    expect(Object.fromEntries(r2.body.error.fields.map((f: { field: string; code: string }) => [f.field, f.code]))).toEqual({ name: 'CAT-06', shortCode: 'CAT-07' });
    expect(r2.body.error.fields[0].message).toBe('An insurer with this name already exists.');
  });

  it('AC-P20-2: the maker cannot approve their own insurer (CAT-05); approval needs the extra OTP (AUTH-26); STF cannot approve', async () => {
    const code = `OWN-${rand()}`;
    const c = await A.d.post('/admin/catalogue/insurers', { name: `Own ${code}`, shortCode: code, category: 'GENERAL', irdaiRegNo: 'R2', paymentDomains: ['own.in'], submit: true }, H());
    expect(c.body.message.text).toBe(`Own ${code} sent for approval.`);
    const self = await approve(A.d, A.mobile, `/admin/catalogue/insurers/${c.body.insurer.id}/approve`, c.body.insurer.version);
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('CAT-05');
    expect((await S.d.post(`/admin/catalogue/insurers/${c.body.insurer.id}/approve`, { version: c.body.insurer.version }, H())).status).toBe(403);
    const noOtp = await B.d.post(`/admin/catalogue/insurers/${c.body.insurer.id}/approve`, { version: c.body.insurer.version }, H());
    expect(noOtp.body.error.code).toBe('AUTH-26');
    const rej = await B.d.post(`/admin/catalogue/insurers/${c.body.insurer.id}/reject`, { version: c.body.insurer.version, reason: 'Wrong IRDAI number' });
    expect(rej.body.message.text).toBe(`Own ${code} rejected. Reason: Wrong IRDAI number`);
    expect(rej.body.insurer).toMatchObject({ status: 'DRAFT', irdaiRegNo: 'R2' }); // rejection keeps every value
    // advisors cannot reach the admin catalogue at all
    const { d } = await advisor();
    expect((await d.get('/admin/catalogue/insurers')).status).toBe(403);
  });

  it('AC-P20-3: an edit to an ACTIVE insurer waits for approval; CAT-08 blocks a second change', async () => {
    const ins = await makeInsurer();
    const full = (await A.d.get(`/admin/catalogue/insurers/${ins.id}`)).body;
    const body = { ...full, careEmail: 'care@insurer.com', version: full.version };
    const e = await S.d.post(`/admin/catalogue/insurers/${ins.id}`, body);
    expect(e.status).toBe(200);
    expect(e.body.insurer.careEmail).toBeNull(); // advisors still see the old values
    expect(e.body.insurer.pendingChange.changes.map((c: { field: string }) => c.field)).toEqual(['careEmail']);
    const again = await A.d.post(`/admin/catalogue/insurers/${ins.id}`, { ...full, careNumber: '9876543210', version: e.body.insurer.version });
    expect(again.body.error.code).toBe('CAT-08');
    const ok = await approve(B.d, B.mobile, `/admin/catalogue/insurers/${ins.id}/approve`, e.body.insurer.version);
    expect(ok.body.insurer).toMatchObject({ careEmail: 'care@insurer.com', pendingChange: null });
    // S made the change, so S... is STF anyway; A (who did not make this change) could approve the next one
    const list = (await B.d.get('/admin/approvals')).body.items.map((i: { id: string }) => i.id);
    expect(list).not.toContain(ins.id);
  });

  it('AC-P20-4: deactivation (ADM, CAT-09 impact) blocks new quotations but keeps history and renewals', async () => {
    const ins = await makeInsurer();
    const p = await makeVerified(world.typeId, ins.id);
    const { accountId } = await advisor();
    expect((await quotability(p.productId, { accountId })).ok).toBe(true);
    const impact = await B.d.get(`/admin/catalogue/insurers/${ins.id}/impact`);
    expect(impact.body.message.text).toBe(`Deactivating ${ins.name} hides 1 products from new quotations and affects 0 advisors. Existing quotations and policies do not change. Continue?`);
    expect((await S.d.post(`/admin/catalogue/insurers/${ins.id}/deactivate`, { version: ins.version })).status).toBe(403);
    const off = await B.d.post(`/admin/catalogue/insurers/${ins.id}/deactivate`, { version: ins.version });
    expect(off.body.insurer.status).toBe('INACTIVE');
    expect(await quotability(p.productId, { accountId })).toMatchObject({ ok: false, reason: 'INSURER_INACTIVE' });
    expect((await quotability(p.productId, { accountId, renewal: true })).ok).toBe(true);
    const [v] = await db.select().from(productVersions).where(eq(productVersions.id, p.versionId));
    expect(v!.status).toBe('PUBLISHED'); // products are untouched
  });
});

describe('P-21 Insurance types and feature templates', () => {
  it('CAT-12, CAT-30 and AC-P21-2 overlapping or gapped bands (CAT-16) are refused on submit', async () => {
    const c = await A.d.post('/admin/catalogue/types', { name: `Empty ${rand()}`, features: [], factors: [] }, H());
    const tpl = c.body.type.openTemplate;
    const s = await A.d.post(`/admin/catalogue/templates/${tpl.id}/submit`, { version: tpl.version });
    expect(s.body.error.fields.map((f: { code: string }) => f.code)).toEqual(['CAT-12', 'CAT-30']);
    const bad = await A.d.post(`/admin/catalogue/templates/${tpl.id}`, {
      version: tpl.version,
      features: FEATURES,
      factors: [{ name: 'Age', kind: 'BAND', filledFrom: 'ELDEST_AGE', bands: [{ min: 18, max: 40 }, { min: 35, max: 60 }] }],
    });
    const s2 = await A.d.post(`/admin/catalogue/templates/${tpl.id}/submit`, { version: bad.body.template.version });
    expect(s2.body.error.fields).toEqual([expect.objectContaining({ field: 'factors.0.bands', code: 'CAT-16', message: 'Minimum must not be more than maximum.' })]);
    const gap = await A.d.post(`/admin/catalogue/templates/${tpl.id}`, {
      version: bad.body.template.version,
      features: FEATURES,
      factors: [{ name: 'Age', kind: 'BAND', filledFrom: 'ELDEST_AGE', bands: [{ min: 18, max: 30 }, { min: 32, max: 60 }] }],
    });
    expect((await A.d.post(`/admin/catalogue/templates/${tpl.id}/submit`, { version: gap.body.template.version })).body.error.fields[0].code).toBe('CAT-16');
  });

  it('two makers editing one draft: the second gets GEN-05', async () => {
    const c = await A.d.post('/admin/catalogue/types', { name: `Race ${rand()}`, features: FEATURES, factors: FACTORS }, H());
    const tpl = c.body.type.openTemplate;
    expect((await A.d.post(`/admin/catalogue/templates/${tpl.id}`, { version: tpl.version, features: FEATURES, factors: FACTORS })).status).toBe(200);
    expect((await S.d.post(`/admin/catalogue/templates/${tpl.id}`, { version: tpl.version, features: FEATURES, factors: FACTORS })).body.error.code).toBe('GEN-05');
  });

  it('AC-P21-1: a new template version changes no published product until it is edited (CAT-28)', async () => {
    const t = await makeType();
    const p = await makeVerified(t.typeId, world.insurerId);
    const open = await S.d.post(`/admin/catalogue/types/${t.typeId}/template`);
    const tpl = open.body.template;
    const saved = await S.d.post(`/admin/catalogue/templates/${tpl.id}`, { version: tpl.version, features: FEATURES.filter((f) => f.key !== 'room_rent'), factors: FACTORS });
    const sub = await S.d.post(`/admin/catalogue/templates/${tpl.id}/submit`, { version: saved.body.template.version });
    const ok = await approve(A.d, A.mobile, `/admin/catalogue/templates/${tpl.id}/approve`, sub.body.template.version);
    expect(ok.status).toBe(200);
    const [v] = await db.select().from(productVersions).where(eq(productVersions.id, p.versionId));
    expect(v!.templateVersionId).toBe(t.templateId);
    expect((v!.data as { features: Record<string, unknown> }).features.room_rent).toBeDefined();
    const draft = await A.d.post(`/admin/catalogue/products/${p.productId}/edit`);
    expect(draft.body.message.text).toBe('Editing creates a new draft version. The published version stays live until the new one is approved.');
    const view = await A.d.get(`/admin/catalogue/product-versions/${draft.body.versionId}`);
    expect(view.body.olderTemplate.text).toBe('This product uses an older feature template. Update it to the current template before its next publish.');
    expect(view.body.missing.map((m: { field: string }) => m.field)).toContain('template');
  });

  it('AC-P21-3: deactivating a type hides its products from new quotations only', async () => {
    const t = await makeType();
    const p = await makeVerified(t.typeId, world.insurerId);
    const { accountId } = await advisor();
    const type = (await B.d.get(`/admin/catalogue/types/${t.typeId}`)).body;
    expect((await B.d.post(`/admin/catalogue/types/${t.typeId}/deactivate`, { version: type.version })).status).toBe(200);
    expect(await quotability(p.productId, { accountId })).toMatchObject({ ok: false, reason: 'TYPE_INACTIVE' });
    expect((await quotability(p.productId, { accountId, renewal: true })).ok).toBe(true);
  });
});

describe('P-22 Products and my commercials', () => {
  it('AC-P22-1: a product without a UIN cannot be saved (CAT-33); CAT-13 lists what is missing before submit', async () => {
    const r = await A.d.post('/admin/catalogue/products', { insurerId: world.insurerId, typeId: world.typeId, code: `P-${rand()}`, ...productBody({ uin: '' }) }, H());
    expect(r.status).toBe(422);
    expect(r.body.error.fields).toEqual([expect.objectContaining({ field: 'uin', code: 'CAT-33', message: 'UIN is required to save a product.' })]);
    const d = await A.d.post('/admin/catalogue/products', { insurerId: world.insurerId, typeId: world.typeId, code: `P-${rand()}`, uin: `UIN${rand()}`, name: 'Half done' }, H());
    expect(d.status).toBe(200);
    const s = await A.d.post(`/admin/catalogue/product-versions/${d.body.versionId}/submit`, { version: d.body.version });
    expect(s.body.error.code).toBe('CAT-13');
    expect(s.body.error.message).toContain('This product cannot be saved yet: short description, launch date, adult entry age range');
    expect(s.body.error.message).toContain('Room rent limit');
    expect(s.body.error.message).toContain('pricing mode');
  });

  it('CAT-16, CAT-34 eligibility and CAT-15 add-on limit; AC-P22-3 a child band of 0 to 25 is valid with adults 18 to 65', async () => {
    const { d } = await advisor();
    const base = { insurerId: world.insurerId, typeId: world.typeId, code: `OWN-${rand()}` };
    const r = await d.post('/catalogue/my-products', { ...base, ...productBody({ adultMinAge: 70, adultMaxAge: 60, childMaxAge: 80 }) }, H());
    expect(r.body.error.fields.map((f: { field: string; code: string }) => `${f.field}:${f.code}`)).toEqual(['adultMaxAge:CAT-16', 'childMaxAge:CAT-34']);
    await setSetting('CFG-40', 1);
    const riders = [1, 2].map((i) => ({ name: `Rider ${i}`, priceType: 'FIXED', value: '100' }));
    expect((await d.post('/catalogue/my-products', { ...base, ...productBody({ riders }) }, H())).body.error.fields[0]).toMatchObject({ code: 'CAT-15', message: 'A product can have up to 1 add-ons.' });
    const ok = await d.post('/catalogue/my-products', { ...base, ...productBody() }, H());
    expect(ok.status).toBe(200);
    const detail = (await d.get(`/catalogue/products/${ok.body.productId}`)).body;
    expect(detail.data).toMatchObject({ adultMinAge: 18, adultMaxAge: 65, childMinAge: 0, childMaxAge: 25 });
  });

  it('AC-P22-2: an own product and its commission are invisible to other accounts and to SkyUp; CAT-07 within the account', async () => {
    const a1 = await advisor();
    const a2 = await advisor();
    const code = `OWN-${rand()}`;
    const own = await a1.d.post('/catalogue/my-products', { insurerId: world.insurerId, typeId: world.typeId, code, ...productBody() }, H());
    expect(own.status).toBe(200);
    expect((await a1.d.post('/catalogue/my-products', { insurerId: world.insurerId, typeId: world.typeId, code, ...productBody() }, H())).body.error.fields[0].code).toBe('CAT-07');
    expect((await a2.d.post('/catalogue/my-products', { insurerId: world.insurerId, typeId: world.typeId, code, ...productBody() }, H())).status).toBe(200); // another account may reuse it
    const c = await a1.d.post(`/catalogue/products/${own.body.productId}/commercials`, { commissionPercent: '15', notes: 'Slab 2', version: 0 });
    expect(c.body.message.text).toBe('Your commission for Family Shield is saved. Only you can see it.');
    expect((await a2.d.get(`/catalogue/products/${own.body.productId}`)).status).toBe(404);
    expect((await a2.d.get('/catalogue/products')).body.items.map((p: { id: string }) => p.id)).not.toContain(own.body.productId);
    expect((await A.d.get('/admin/catalogue/products')).body.items.map((p: { id: string }) => p.id)).not.toContain(own.body.productId);
    const [v] = await db.select().from(products).where(eq(products.id, own.body.productId));
    expect((await A.d.get(`/admin/catalogue/product-versions/${v!.publishedVersionId}`)).status).toBe(404);
    // commission on a verified product is private too
    await a1.d.post(`/catalogue/products/${world.productId}/commercials`, { commissionPercent: '12.5', version: 0 });
    expect((await a2.d.get(`/catalogue/products/${world.productId}`)).body.commercials).toEqual({ commissionPercent: null, notes: null, version: 0 });
    expect((await a1.d.get(`/catalogue/products/${world.productId}`)).body.commercials).toMatchObject({ commissionPercent: '12.50' });
  });

  it('AC-P22-4: a WITHDRAWN own product cannot be quoted but can be renewed (CAT-26)', async () => {
    const a = await advisor();
    const own = await a.d.post('/catalogue/my-products', { insurerId: world.insurerId, typeId: world.typeId, code: `OWN-${rand()}`, ...productBody() }, H());
    const w = await a.d.post(`/catalogue/my-products/${own.body.productId}/status`, { status: 'WITHDRAWN', version: 1 });
    expect(w.body.message.text).toBe('Family Shield is withdrawn. Advisors can no longer quote it.');
    expect(await quotability(own.body.productId, { accountId: a.accountId })).toMatchObject({ ok: false, reason: 'WITHDRAWN' });
    expect((await quotability(own.body.productId, { accountId: a.accountId, renewal: true })).ok).toBe(true);
    const later = await a.d.post('/catalogue/my-products', { insurerId: world.insurerId, typeId: world.typeId, code: `OWN-${rand()}`, ...productBody({ launchDate: formatDate(addDays(today(), 10)) }) }, H());
    expect((await a.d.get(`/catalogue/products/${later.body.productId}`)).body.status).toBe('UPCOMING');
  });

  it('AC-P22-5: "Not stated in source" shows to advisors as "Not stated by insurer"', async () => {
    const { d } = await advisor();
    const detail = (await d.get(`/catalogue/products/${world.productId}`)).body;
    expect(detail.features.find((f: { key: string }) => f.key === 'copay').value).toBe('Not stated by insurer');
    expect(detail.features.find((f: { key: string }) => f.key === 'room_rent').value).toBe('Single room');
  });

  it('AC-P22-6: an assistant sees products but cannot see or change commercials, prices or own products', async () => {
    const a = await advisor();
    const astMobile = newMobile();
    await insertUser({ role: 'AST', mobile: astMobile, accountId: a.accountId });
    const ast = new Device();
    await login(ast, astMobile);
    expect((await ast.get('/catalogue/products')).status).toBe(200);
    const detail = (await ast.get(`/catalogue/products/${world.productId}`)).body;
    expect(detail.commercials).toBeNull();
    expect((await ast.post(`/catalogue/products/${world.productId}/commercials`, { commissionPercent: '10', version: 0 })).status).toBe(403);
    expect((await ast.get(`/catalogue/products/${world.productId}/prices`)).status).toBe(403);
    expect((await ast.post('/catalogue/my-products', productBody(), H())).status).toBe(403);
  });
});

describe('P-23 Read a brochure and review', () => {
  const brochure = makePdf([
    ['Family Shield brochure', 'Room rent limit: Single private room', 'Co-pay: 10%'],
    ['Initial waiting period: 30 days', 'Network hospitals: 9,500'],
  ]);

  async function draftWithBrochure() {
    const up = await upload(A.d, 'BROCHURE', [{ name: 'brochure.pdf', data: brochure }]);
    expect(up.status).toBe(200);
    const fileId = up.body.items[0].id as string;
    const c = await A.d.post('/admin/catalogue/products', { insurerId: world.insurerId, typeId: world.typeId, code: `P-${rand()}`, uin: `UIN${rand()}`, name: 'OCR product', brochureFileId: fileId }, H());
    return { fileId, versionId: c.body.versionId as string };
  }

  it('AC-P23-1 and AC-P23-2: values need a decision; low confidence is never bulk-accepted; Apply marks who checked', async () => {
    const { versionId, fileId } = await draftWithBrochure();
    const start = await A.d.post(`/admin/catalogue/product-versions/${versionId}/ocr`, {}, H());
    expect(start.body.message.text).toBe('Reading the brochure. This can take up to 5 minutes. You can leave this page; we will notify you when it is ready.');
    const job = (await A.d.get(`/admin/catalogue/ocr/${start.body.job.id}`)).body;
    expect(job.status).toBe('REVIEW_REQUIRED');
    const row = (k: string): unknown => (job.rows as { featureKey: string }[]).find((r) => r.featureKey === k);
    expect(row('room_rent')).toMatchObject({ found: 'Single private room', confidence: 95, sourcePage: 1, flagged: false });
    expect(row('copay')).toMatchObject({ found: '10.00', flagged: false });
    expect(row('initial_wait')).toMatchObject({ found: '30', sourcePage: 2 });
    expect(row('network')).toMatchObject({ found: '9500', confidence: 70, flagged: true });
    expect(row('maternity')).toMatchObject({ found: null, notFoundMessage: 'This value was not found in the brochure. Mark it Not stated, or type it from another source.' });
    // the same file again reuses the open job
    expect((await A.d.post(`/admin/catalogue/product-versions/${versionId}/ocr`, { fileId }, H())).body.job.id).toBe(job.id);
    // nothing reaches the draft yet
    const before = (await A.d.get(`/admin/catalogue/product-versions/${versionId}`)).body.data.features;
    expect(before).toEqual({});
    const bulk = await A.d.post(`/admin/catalogue/ocr/${job.id}/accept-high`, { version: job.version });
    expect(bulk.body.rows.filter((r: { decision: string | null }) => r.decision === 'ACCEPT').map((r: { featureKey: string }) => r.featureKey)).toEqual(['room_rent', 'copay', 'initial_wait']);
    const blocked = await A.d.post(`/admin/catalogue/ocr/${job.id}/apply`, { version: bulk.body.version });
    expect(blocked.body.error.message).toBe('Check every highlighted value before applying.');
    const decided = await A.d.post(`/admin/catalogue/ocr/${job.id}/decisions`, {
      version: bulk.body.version,
      rows: [
        { featureKey: 'network', decision: 'EDIT', value: '9600' },
        { featureKey: 'maternity', decision: 'NOT_STATED' },
        { featureKey: 'initial_wait', decision: 'IGNORE' },
      ],
    });
    const applied = await A.d.post(`/admin/catalogue/ocr/${job.id}/apply`, { version: decided.body.version });
    expect(applied.body.message.text).toBe('4 values applied to the draft.');
    const after = (await A.d.get(`/admin/catalogue/product-versions/${versionId}`)).body.data.features;
    expect(after).toMatchObject({
      room_rent: { value: 'Single private room', ocrCheckedBy: 'Maker Admin' },
      network: { value: '9600' },
      maternity: { notStated: true },
    });
    expect(after.initial_wait).toBeUndefined();
    const bell = await db.select().from(notifications).where(and(eq(notifications.userId, A.user.id), eq(notifications.messageId, 'OCR-02')));
    expect(bell.length).toBeGreaterThan(0);
  });

  it('AC-P23-3 and AC-P23-4: a failed read leaves the draft unchanged (OCR-03); over CFG-30 pages is refused (OCR-04); OCR off (OCR-07)', async () => {
    const up = await upload(A.d, 'BROCHURE', [{ name: 'scan.pdf', data: makePdf([[''], ['']]) }]);
    const c = await A.d.post('/admin/catalogue/products', { insurerId: world.insurerId, typeId: world.typeId, code: `P-${rand()}`, uin: `UIN${rand()}`, brochureFileId: up.body.items[0].id }, H());
    const start = await A.d.post(`/admin/catalogue/product-versions/${c.body.versionId}/ocr`, {}, H());
    const job = (await A.d.get(`/admin/catalogue/ocr/${start.body.job.id}`)).body;
    expect(job.status).toBe('FAILED');
    expect(job.message.text).toBe('We could not read this brochure. Enter the values by hand, or try again.');
    expect((await A.d.get(`/admin/catalogue/product-versions/${c.body.versionId}`)).body.data.features).toEqual({});
    const retry = await A.d.post(`/admin/catalogue/ocr/${job.id}/retry`);
    expect(retry.body.job.id).not.toBe(job.id);
    await setSetting('CFG-30', 1);
    const big = await draftWithBrochure();
    const r = await A.d.post(`/admin/catalogue/product-versions/${big.versionId}/ocr`, {}, H());
    expect(r.body.error.fields[0].message).toBe('This brochure has more than 1 pages. Upload only the pages that describe the product.');
    await setSetting('CFG-102', false);
    expect((await A.d.post(`/admin/catalogue/product-versions/${big.versionId}/ocr`, {}, H())).body.error.message).toBe('Reading brochures is switched off. Enter values by hand.');
  });

  it('own product: the brochure preview returns values to fill the form and saves nothing', async () => {
    const { d } = await advisor();
    const up = await upload(d, 'BROCHURE', [{ name: 'b.pdf', data: brochure }]);
    const start = await d.post('/catalogue/ocr', { typeId: world.typeId, fileId: up.body.items[0].id }, H());
    const job = (await d.get(`/catalogue/ocr/${start.body.job.id}`)).body;
    const dec = await d.post(`/catalogue/ocr/${job.id}/decisions`, { version: job.version, rows: [{ featureKey: 'network', decision: 'ACCEPT' }, { featureKey: 'maternity', decision: 'IGNORE' }] });
    const applied = await d.post(`/catalogue/ocr/${job.id}/apply`, { version: dec.body.version });
    expect(applied.body.features.network).toMatchObject({ value: '9500' });
    expect((await A.d.get(`/admin/catalogue/ocr/${job.id}`)).status).toBe(404); // SkyUp never sees an advisor's job
  });
});

describe('P-24 Price versions', () => {
  it('AC-P24-1: a new price from a later date closes the old one the day before (CAT-37); SYS-02 starts it', async () => {
    const { d, accountId } = await advisor();
    const first = await d.post(`/catalogue/products/${world.productId}/prices`, { effectiveFrom: formatDate(today()), taxPercent: '18', rows: RATES }, H());
    expect(first.body.price).toMatchObject({ name: 'V1', status: 'CURRENT', rowCount: 4 });
    const start = addDays(today(), 15);
    const second = await d.post(`/catalogue/products/${world.productId}/prices`, { effectiveFrom: formatDate(start), taxPercent: '18', rows: RATES }, H());
    expect(second.body.message.text).toBe(`New price from ${formatDate(start)} saved. The current price applies until ${formatDate(addDays(start, -1))}.`);
    const rows = await db.select().from(priceVersions).where(and(eq(priceVersions.ownerKey, accountId), eq(priceVersions.productId, world.productId)));
    expect(rows.find((r) => r.seq === 1)).toMatchObject({ effectiveTo: addDays(start, -1), status: 'CURRENT' });
    expect(rows.find((r) => r.seq === 2)).toMatchObject({ effectiveTo: null, status: 'SCHEDULED' });
    // CAT-25: a scheduled version can be cancelled, and the old one is open again
    const cancel = await d.post(`/catalogue/products/${world.productId}/prices/${second.body.price.id}/cancel`);
    expect(cancel.body.message.text).toBe('Price version V2 cancelled.');
    const [v1] = await db.select().from(priceVersions).where(eq(priceVersions.id, first.body.price.id));
    expect(v1!.effectiveTo).toBeNull();
    // A CURRENT version can never be cancelled
    expect((await d.post(`/catalogue/products/${world.productId}/prices/${first.body.price.id}/cancel`)).body.error.code).toBe('GEN-04');
    expect(await runPriceSchedule()).toMatchObject({ started: expect.any(Number) });
  });

  it('AC-P24-2: CAT-18 before today, CAT-38 on or before the current start, CAT-17 on a scheduled date', async () => {
    const { d } = await advisor();
    const yesterday = await d.post(`/catalogue/products/${world.productId}/prices`, { effectiveFrom: formatDate(addDays(today(), -1)), taxPercent: '18', rows: RATES }, H());
    expect(yesterday.body.error.fields[0].message).toBe('The start date cannot be before today.');
    await d.post(`/catalogue/products/${world.productId}/prices`, { effectiveFrom: formatDate(today()), taxPercent: '18', rows: RATES }, H());
    const same = await d.post(`/catalogue/products/${world.productId}/prices`, { effectiveFrom: formatDate(today()), taxPercent: '18', rows: RATES }, H());
    expect(same.body.error.fields[0].message).toBe(`The new price must start after ${formatDate(today())}, when the current price began.`);
    const later = formatDate(addDays(today(), 5));
    await d.post(`/catalogue/products/${world.productId}/prices`, { effectiveFrom: later, taxPercent: '18', rows: RATES }, H());
    const clash = await d.post(`/catalogue/products/${world.productId}/prices`, { effectiveFrom: later, taxPercent: '18', rows: RATES }, H());
    expect(clash.body.error.fields[0].message).toBe(`This price version overlaps V2 (${later} onwards). Choose a different start date.`);
  });

  it('AC-P24-3: two saves at the same moment never leave two open prices', async () => {
    const { d, accountId } = await advisor();
    await Promise.all([3, 4, 5].map((n) => d.post(`/catalogue/products/${world.productId}/prices`, { effectiveFrom: formatDate(addDays(today(), n)), taxPercent: '18', rows: RATES }, H())));
    const open = await db
      .select()
      .from(priceVersions)
      .where(and(eq(priceVersions.ownerKey, accountId), eq(priceVersions.productId, world.productId), isNull(priceVersions.effectiveTo), ne(priceVersions.status, 'CANCELLED')));
    expect(open).toHaveLength(1);
  });

  it('rate table checks: CAT-31 wrong CSV, CAT-19 row errors, CAT-22 repeats, CAT-21 missing (warning only), CAT-20 too many rows', async () => {
    const { d } = await advisor();
    const tpl = await d.get(`/catalogue/products/${world.productId}/prices/template.csv`);
    expect(tpl.text.split('\n')[0]).toBe('Eldest age,Sum insured,base_premium');
    expect(tpl.text.split('\n')).toHaveLength(6);
    const wrong = await d.post(`/catalogue/products/${world.productId}/prices/check`, { csv: 'age,si,premium\n18-45,500000,1' });
    expect(wrong.body.error.fields[0].message).toBe('Upload the CSV template for this product without changing its column names.');
    const check = await d.post(`/catalogue/products/${world.productId}/prices/check`, {
      csv: 'Eldest age,Sum insured,base_premium\n18-45,500000,9000\n18-45,500000,9100\n70-80,500000,1\n46-65,500000,abc\n',
    });
    expect(check.body).toMatchObject({ accepted: 1, duplicates: [1, 2] });
    expect(check.body.errorMessage.text).toBe('2 rows have errors. Download the error report, correct them and upload again.');
    expect(check.body.duplicateMessage.text).toBe('Rows 1, 2 repeat the same factors with different premiums.');
    expect(check.body.warning.text).toContain('These combinations have no premium and cannot be quoted: Eldest age 18-45, Sum insured 1000000');
    const save = await d.post(`/catalogue/products/${world.productId}/prices`, { effectiveFrom: formatDate(today()), taxPercent: '18', rows: RATES.slice(0, 2) }, H());
    expect(save.status).toBe(200);
    expect(save.body.warning.text).toContain('You can still submit.');
    await setSetting('CFG-39', 2);
    expect((await d.post(`/catalogue/products/${world.productId}/prices/check`, { rows: RATES })).body.error.fields[0].message).toBe('A rate table can have up to 2 rows.');
  });

  it('AC-P24-5: prices are private; the SkyUp reference price can be copied', async () => {
    const a1 = await advisor();
    const a2 = await advisor();
    const mine = await a1.d.post(`/catalogue/products/${world.productId}/prices`, { effectiveFrom: formatDate(today()), taxPercent: '18', rows: RATES }, H());
    expect((await a2.d.get(`/catalogue/products/${world.productId}/prices/${mine.body.price.id}`)).status).toBe(404);
    expect((await a2.d.get(`/catalogue/products/${world.productId}/prices`)).body.items).toEqual([]);
    expect((await A.d.get(`/admin/catalogue/products/${world.productId}/prices`)).body.items.map((p: { id: string }) => p.id)).not.toContain(mine.body.price.id);
    const ref = await a2.d.get(`/catalogue/products/${world.productId}/prices/reference`);
    expect(ref.body.rows).toHaveLength(4);
  });
});

describe('P-25 Approve, publish and withdraw', () => {
  it('AC-P25-1/2 and CAT-29: maker cannot approve; OTP is required; a version changed since opening is refused', async () => {
    const c = await S.d.post('/admin/catalogue/products', { insurerId: world.insurerId, typeId: world.typeId, code: `P-${rand()}`, ...productBody() }, H());
    await S.d.post(`/admin/catalogue/products/${c.body.productId}/prices`, { effectiveFrom: today(), taxPercent: '18', rows: RATES }, H());
    const s = await S.d.post(`/admin/catalogue/product-versions/${c.body.versionId}/submit`, { version: c.body.version });
    const items = (await A.d.get('/admin/approvals')).body.items;
    expect(items.find((i: { id: string }) => i.id === c.body.versionId)).toMatchObject({ kind: 'PRODUCT_VERSION', makers: ['Catalogue Staff'], youMadeThis: false });
    expect((await S.d.post(`/admin/catalogue/product-versions/${c.body.versionId}/approve`, { version: s.body.version }, H())).status).toBe(403);
    expect((await A.d.post(`/admin/catalogue/product-versions/${c.body.versionId}/approve`, { version: s.body.version }, H())).body.error.code).toBe('AUTH-26');
    const stale = await approve(A.d, A.mobile, `/admin/catalogue/product-versions/${c.body.versionId}/approve`, s.body.version - 1);
    expect(stale.body.error.message).toBe('This version has changed since you opened it. Reload to review the latest changes.');
    const ok = await approve(A.d, A.mobile, `/admin/catalogue/product-versions/${c.body.versionId}/approve`, s.body.version);
    expect(ok.status).toBe(200);
  });

  it('AC-P25-3: after publish new quotations use the new version; the old one is SUPERSEDED and kept', async () => {
    const p = await makeVerified(world.typeId, world.insurerId);
    const draft = await S.d.post(`/admin/catalogue/products/${p.productId}/edit`);
    const v = (await S.d.get(`/admin/catalogue/product-versions/${draft.body.versionId}`)).body;
    const saved = await S.d.post(`/admin/catalogue/product-versions/${v.id}`, { ...v.data, name: 'Family Shield Plus', version: v.version });
    const view = (await B.d.get(`/admin/catalogue/product-versions/${v.id}`)).body;
    expect(view.changes).toEqual([{ field: 'name', label: 'Product name', old: 'Family Shield', new: 'Family Shield Plus' }]);
    const sub = await S.d.post(`/admin/catalogue/product-versions/${v.id}/submit`, { version: saved.body.version });
    await approve(B.d, B.mobile, `/admin/catalogue/product-versions/${v.id}/approve`, sub.body.version);
    const { accountId } = await advisor();
    expect(await quotability(p.productId, { accountId })).toEqual({ ok: true, versionId: v.id });
    const [old] = await db.select().from(productVersions).where(eq(productVersions.id, p.versionId));
    expect(old!.status).toBe('SUPERSEDED');
  });

  it('AC-P25-4: a withdrawn product cannot be added to a new quotation (CAT-26); Make available reverses it', async () => {
    const p = await makeVerified(world.typeId, world.insurerId);
    const prod = (await B.d.get(`/admin/catalogue/products/${p.productId}`)).body;
    expect((await B.d.post(`/admin/catalogue/products/${p.productId}/withdraw`, { version: prod.version })).body.error.fields[0].code).toBe('GEN-01');
    const w = await B.d.post(`/admin/catalogue/products/${p.productId}/withdraw`, { version: prod.version, reason: 'Insurer closed it' });
    expect(w.body.message.text).toBe('Family Shield is withdrawn. Advisors can no longer quote it.');
    const { d, accountId } = await advisor();
    expect(await quotability(p.productId, { accountId })).toMatchObject({ ok: false, reason: 'WITHDRAWN' });
    expect((await d.get('/catalogue/products')).body.items.find((x: { id: string }) => x.id === p.productId)).toMatchObject({ status: 'WITHDRAWN', quotable: false });
    const back = await B.d.post(`/admin/catalogue/products/${p.productId}/make-available`, { version: prod.version + 1 });
    expect(back.body.status).toBe('ACTIVE');
  });
});

describe('P-58 Suggest a correction', () => {
  it('AC-P58-1 and AC-P58-2: advisors cannot edit a verified product; an accepted correction shows only after a second ADM approves', async () => {
    const p = await makeVerified(world.typeId, world.insurerId);
    const a = await advisor();
    expect((await a.d.post(`/catalogue/my-products/${p.productId}`, { ...productBody(), version: 1 })).status).toBe(404);
    const fields = (await a.d.get(`/catalogue/products/${p.productId}/correction-fields`)).body.items;
    expect(fields.find((f: { field: string }) => f.field === 'features.room_rent')).toMatchObject({ label: 'Room rent limit', current: 'Single room' });
    const sent = await a.d.post(`/catalogue/products/${p.productId}/corrections`, { field: 'features.room_rent', proposedValue: 'Any room', reason: 'Brochure page 2 says any room' }, H());
    expect(sent.body.message.text).toBe('Correction sent to SkyUp for review.');
    const dup = await a.d.post(`/catalogue/products/${p.productId}/corrections`, { field: 'features.room_rent', proposedValue: 'Any', reason: 'Again' }, H());
    expect(dup.body.error.code).toBe('CAT-08');
    const q = (await S.d.get('/admin/catalogue/corrections')).body.items.find((c: { id: string }) => c.id === sent.body.id);
    const acc = await S.d.post(`/admin/catalogue/corrections/${sent.body.id}/accept`, { version: q.version });
    expect(acc.body).toMatchObject({ status: 'ACCEPTED', filled: true });
    expect(acc.body.message.text).toBe('SkyUp accepted your correction to Family Shield. It will apply once the new version is approved.');
    // still the old value for advisors
    const before = (await a.d.get(`/catalogue/products/${p.productId}`)).body.features.find((f: { key: string }) => f.key === 'room_rent');
    expect(before.value).toBe('Single room');
    const v = (await A.d.get(`/admin/catalogue/product-versions/${acc.body.resultingVersionId}`)).body;
    expect(v.correctionIds).toEqual([sent.body.id]);
    const sub = await S.d.post(`/admin/catalogue/product-versions/${v.id}/submit`, { version: v.version });
    // STF reviewed it; a different ADM approves
    await approve(A.d, A.mobile, `/admin/catalogue/product-versions/${v.id}/approve`, sub.body.version);
    const after = (await a.d.get(`/catalogue/products/${p.productId}`)).body.features.find((f: { key: string }) => f.key === 'room_rent');
    expect(after.value).toBe('Any room');
    const bell = await db.select().from(notifications).where(and(eq(notifications.userId, a.user.id), eq(notifications.messageId, 'CAT-39')));
    expect(bell).toHaveLength(1);
  });

  it('reject needs a reason and sends CAT-40', async () => {
    const a = await advisor();
    const sent = await a.d.post(`/catalogue/products/${world.productId}/corrections`, { field: 'graceDays', proposedValue: '15', reason: 'Wording says 15' }, H());
    const q = (await S.d.get('/admin/catalogue/corrections')).body.items.find((c: { id: string }) => c.id === sent.body.id);
    expect((await S.d.post(`/admin/catalogue/corrections/${sent.body.id}/reject`, { version: q.version })).status).toBe(422);
    const rej = await S.d.post(`/admin/catalogue/corrections/${sent.body.id}/reject`, { version: q.version, reason: 'Wording says 30 days' });
    expect(rej.body.message.text).toBe('SkyUp did not accept your correction to Family Shield: Wording says 30 days');
    expect((await a.d.get('/catalogue/corrections')).body.items[0]).toMatchObject({ status: 'REJECTED', rejectReason: 'Wording says 30 days' });
  });
});
