import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import {
  advisorProfiles,
  documents,
  documentVersions,
  files,
  insurerMappings,
  outgoingMessages,
  payments,
  policies,
  products,
  productVersions,
  quotationRevisions,
  renewalCycles,
  templateVersions,
} from '../src/db/schema.js';
import { addDays, clock, formatDate, istToday } from '../src/lib/clock.js';
import { runDaily } from '../src/modules/jobs/daily.js';
import { settings } from '../src/modules/settings/settings.service.js';
import type { ProductData } from '../src/modules/catalogue/productData.js';
import { Device, advisor, advance, createInsurer, ensureTypes, key, newMobile, resetClock, resetSettings, upload, SAMPLE } from './helpers.js';

const H = () => ({ 'idempotency-key': key() });
type Adv = Awaited<ReturnType<typeof advisor>>;
let healthTypeId = '';

const FEATURES = [
  { key: 'room_rent', name: 'Room rent limit', group: 'LIMITS', dataType: 'TEXT', requiredToPublish: true, order: 1, help: null },
  { key: 'copay', name: 'Co-pay', group: 'LIMITS', dataType: 'PERCENT', requiredToPublish: true, order: 2, help: null },
  { key: 'ped_wait', name: 'Pre-existing disease waiting period', group: 'WAITING_PERIODS', dataType: 'MONTHS', requiredToPublish: true, order: 3, help: null },
  { key: 'csr', name: 'Claim settlement ratio', group: 'OTHER', dataType: 'PERCENT', requiredToPublish: false, order: 4, help: null },
];
const FACTORS = [
  { key: 'eldest_age', name: 'Eldest age', kind: 'BAND', filledFrom: 'ELDEST_AGE', bands: [{ min: 18, max: 45 }, { min: 46, max: 65 }], values: [] },
  { key: 'sum_insured', name: 'Sum insured', kind: 'VALUE', filledFrom: 'SUM_INSURED', bands: [], values: ['500000', '1000000'] },
];
const RATES = [
  { factors: { eldest_age: '18-45', sum_insured: '500000' }, basePremium: '10000.00' },
  { factors: { eldest_age: '18-45', sum_insured: '1000000' }, basePremium: '14000.00' },
  { factors: { eldest_age: '46-65', sum_insured: '500000' }, basePremium: '20000.00' },
  { factors: { eldest_age: '46-65', sum_insured: '1000000' }, basePremium: '26000.00' },
];

async function makeProduct(insurerId: string, over: Partial<ProductData> = {}, features: Record<string, { value: string | null; notStated: boolean; sourcePage: null }> = {}) {
  const [tpl] = await db.insert(templateVersions).values({ typeId: healthTypeId, versionNo: Math.floor(Math.random() * 1e6), status: 'RETIRED', features: FEATURES, factors: FACTORS, questions: [], createdBy: insurerId, createdAt: clock.now() }).returning();
  const data: ProductData = {
    name: `Plan ${Math.random().toString(36).slice(2, 7)}`,
    shortDescription: 'Test',
    uin: `UIN${Math.floor(Math.random() * 1e9)}`,
    launchDate: null,
    adultMinAge: 18,
    adultMaxAge: 65,
    coversChildren: true,
    childMinAge: 0,
    childMaxAge: 25,
    sumInsured: { mode: 'OPTIONS', options: ['500000.00', '1000000.00'] },
    policyTerms: [1, 2],
    features: {
      room_rent: { value: 'No limit', notStated: false, sourcePage: null },
      copay: { value: '0', notStated: false, sourcePage: null },
      ped_wait: { value: '24', notStated: false, sourcePage: null },
      csr: { value: null, notStated: true, sourcePage: null },
      ...features,
    },
    riders: [{ key: 'opd', name: 'OPD cover', description: null, priceType: 'PERCENT', value: '12.50' }],
    pricingMode: 'RATE_TABLE',
    taxPercent: '18.00',
    nomineeRequired: true,
    maxNominees: 2,
    graceDays: 30,
    brochureFileId: null,
    wordingFileId: null,
    sourceLink: null,
    sourceCheckedOn: null,
    ...over,
  };
  const [p] = await db.insert(products).values({ kind: 'VERIFIED', insurerId, typeId: healthTypeId, code: `C${Math.floor(Math.random() * 1e6)}`, status: 'ACTIVE', createdBy: insurerId, createdAt: clock.now() }).returning();
  const [v] = await db.insert(productVersions).values({ productId: p!.id, versionNo: 1, status: 'PUBLISHED', templateVersionId: tpl!.id, name: data.name, uin: data.uin, data, createdBy: insurerId, createdAt: clock.now() }).returning();
  await db.update(products).set({ publishedVersionId: v!.id }).where(eq(products.id, p!.id));
  return { id: p!.id, name: data.name };
}

/** A ready advisor: licence, email, authorised for Health, mapped to the insurer, own price for the product. */
async function setup(opts: { products?: number } = {}) {
  const a = await advisor('Priya Sharma');
  const ins = await createInsurer(`Care ${Math.random().toString(36).slice(2, 6)}`);
  const { insurers } = await import('../src/db/schema.js');
  await db.update(insurers).set({ paymentDomains: ['insurer.com'] }).where(eq(insurers.id, ins.id));
  await db
    .update(advisorProfiles)
    .set({ email: 'priya@example.com', licenceNumber: 'LIC12345', licenceValidUntil: addDays(istToday(), 400), authorisedTypeIds: [healthTypeId], businessName: 'Sharma Insurance' })
    .where(eq(advisorProfiles.accountId, a.accountId));
  await db.insert(insurerMappings).values({ accountId: a.accountId, insurerId: ins.id, agentCode: 'AG-001', declaredAt: clock.now() });
  const list = [];
  for (let i = 0; i < (opts.products ?? 1); i++) {
    const p = await makeProduct(ins.id, {}, i === 1 ? { copay: { value: '20', notStated: false, sourcePage: null } } : {});
    const price = await a.d.post(`/catalogue/products/${p.id}/prices`, { effectiveFrom: formatDate(istToday()), taxPercent: '18', rows: RATES, riderPrices: [{ key: 'opd', value: '12.50' }] }, H());
    expect(price.status).toBe(200);
    list.push(p);
  }
  const dob = formatDate(addDays(istToday(), -365 * 40));
  const c = await a.d.post('/customers', { fullName: 'Ravi Kumar', mobile: newMobile(), email: 'ravi@example.com', dateOfBirth: dob }, H());
  expect(c.status).toBe(200);
  return { a, ins, products: list, customerId: c.body.customer.id as string };
}

async function draft(a: Adv, customerId: string, productId: string, insurerId: string, over: Record<string, unknown> = {}) {
  const start = await a.d.post('/quotations', { customerId }, H());
  expect(start.status).toBe(200);
  let rev = (await a.d.get(`/quotations/revisions/${start.body.id}`)).body;
  const inputs = { typeId: healthTypeId, insurerId, productId, people: ['customer'], sumInsured: '500000', term: '1', startDate: formatDate(addDays(istToday(), 3)), riders: ['opd'], ...over };
  const save = await a.d.post(`/quotations/revisions/${rev.id}/draft`, { inputs, step: 10, version: rev.version });
  rev = save.body;
  return { save, rev };
}

async function generated(a: Adv, customerId: string, productId: string, insurerId: string, over: Record<string, unknown> = {}) {
  const { rev } = await draft(a, customerId, productId, insurerId, over);
  const g = await a.d.post(`/quotations/revisions/${rev.id}/generate`, { version: rev.version }, H());
  expect(g.status).toBe(200);
  return (await a.d.get(`/quotations/revisions/${rev.id}`)).body as { id: string; version: number };
}

async function kyc(a: Adv, customerId: string) {
  for (const type of ['Aadhaar', 'PAN']) {
    const up = await upload(a.d, 'CLIENT_DOCUMENT', [{ name: 'x.pdf', data: SAMPLE.pdf }]);
    const [d] = await db.insert(documents).values({ accountId: a.accountId, customerId, type, label: `${type} - Ravi`, createdBy: a.user.id }).returning();
    await db.insert(documentVersions).values({ documentId: d!.id, accountId: a.accountId, versionNo: 1, fileId: up.body.items[0].id, originalName: 'x.pdf', status: 'CONFIRMED', uploadedBy: a.user.id, uploadedAt: clock.now() });
  }
}

beforeAll(async () => {
  await settings.init();
  const types = await ensureTypes();
  healthTypeId = types.find((t) => t.name === 'Health')!.id;
});
afterEach(async () => {
  resetClock();
  await resetSettings();
});

describe('P-27 Create a normal quotation', () => {
  it('AC-P27-1/2: generate gives a QT number, R1, a frozen snapshot and a PDF; the premium matches the rate table to the paisa', async () => {
    const { a, ins, products, customerId } = await setup();
    const { save } = await draft(a, customerId, products[0]!.id, ins.id);
    expect(save.status).toBe(200);
    // base 10000 + OPD 12.5% (1250) = 11250; GST 18% = 2025; final 13275.00
    expect(save.body.breakdown).toMatchObject({ base: '10000.00', calculated: '11250.00', tax: '2025.00', finalPayable: '13275.00' });
    const g = await a.d.post(`/quotations/revisions/${save.body.id}/generate`, { version: save.body.version }, H());
    expect(g.body.message.text).toMatch(/^Quotation QT-\d{6}-00001 R1 is ready\. Share it with Ravi Kumar\.$/);
    const [r] = await db.select().from(quotationRevisions).where(eq(quotationRevisions.id, save.body.id));
    expect(r!.status).toBe('READY');
    expect(r!.pdfFileId).toBeTruthy();
    expect((r!.snapshot as { agentCode: string }).agentCode).toBe('AG-001');
    const [f] = await db.select().from(files).where(eq(files.id, r!.pdfFileId!));
    expect(f!.mime).toBe('application/pdf');
  });

  it('AC-P27-4: a person outside the entry ages is blocked (QT-06); AC-P27-8: an insurer without a mapping is refused (QT-12)', async () => {
    const { a, ins, products, customerId } = await setup();
    const kid = await a.d.post(`/customers/${customerId}/family`, { fullName: 'Old Uncle', relationship: 'Other', dateOfBirth: formatDate(addDays(istToday(), -365 * 70 - 20)) });
    expect(kid.status).toBe(200);
    const { save } = await draft(a, customerId, products[0]!.id, ins.id, { people: ['customer', kid.body.member.id] });
    expect(save.body.error.fields.find((x: { code: string }) => x.code === 'QT-06').message).toMatch(/^Old Uncle is 70\. This product accepts ages 18 to 65\.$/);
    await db.update(insurerMappings).set({ status: 'INACTIVE' }).where(eq(insurerMappings.accountId, a.accountId));
    const second = await draft(a, customerId, products[0]!.id, ins.id);
    expect(second.save.body.error.fields[0].code).toBe('QT-12');
  });

  it('AC-P27-5: discount above the premium (QT-09); discount without reference (QT-37); an assistant cannot override (GEN-03)', async () => {
    const { a, ins, products, customerId } = await setup();
    const big = await draft(a, customerId, products[0]!.id, ins.id, { discount: { kind: 'AMOUNT', value: '99999', reference: 'Ref 1' } });
    expect(big.save.body.error.fields[0].code).toBe('QT-09');
    const noRef = await draft(a, customerId, products[0]!.id, ins.id, { discount: { kind: 'PERCENT', value: '5' } });
    expect(noRef.save.body.error.fields[0].code).toBe('QT-37');
    const ok = await draft(a, customerId, products[0]!.id, ins.id, { discount: { kind: 'PERCENT', value: '10', reference: 'Festive offer' } });
    // 11250 − 1125 = 10125; GST 1822.50; final 11947.50
    expect(ok.save.body.breakdown.finalPayable).toBe('11947.50');
  });

  it('AC-P27-6: a price version starting between calculation and generate triggers QT-10', async () => {
    const { a, ins, products, customerId } = await setup();
    const { rev } = await draft(a, customerId, products[0]!.id, ins.id);
    await db.update(quotationRevisions).set({ finalPayable: '1.00' }).where(eq(quotationRevisions.id, rev.id));
    const g = await a.d.post(`/quotations/revisions/${rev.id}/generate`, { version: rev.version }, H());
    expect(g.body.error.code).toBe('QT-10');
    expect(g.body.error.new).toBe('13275.00');
  });
});

describe('P-28 / P-29 Share, revise, expire', () => {
  it('AC-P28-1/2/4: first share sets SHARED and the expiry; a later share keeps it; the view link shows QT-20 after expiry', async () => {
    const { a, ins, products, customerId } = await setup();
    const rev = await generated(a, customerId, products[0]!.id, ins.id);
    const s1 = await a.d.post(`/quotations/revisions/${rev.id}/share`, { channel: 'EMAIL' }, H());
    expect(s1.body.message.text).toBe('Quotation emailed to ravi@example.com.');
    const valid = addDays(istToday(), 15);
    expect(s1.body.validUntil).toBe(valid);
    const [m] = await db.select().from(outgoingMessages).where(eq(outgoingMessages.relatedId, rev.id));
    expect(m!.status).toBe('SENT');
    const s2 = await a.d.post(`/quotations/revisions/${rev.id}/share`, { channel: 'LINK' }, H());
    expect(s2.body.validUntil).toBe(valid);
    const token = new URL(s2.body.url).pathname.split('/').pop();
    const pub = await new Device().get(`/public/quotations/${token}`);
    expect(pub.body).toMatchObject({ valid: true, product: products[0]!.name });
    advance(20 * 86_400_000);
    await runDaily('SYS-01', true);
    const after = await new Device().get(`/public/quotations/${token}`);
    expect(after.body.valid).toBe(false);
    expect(after.body.message.text).toMatch(/^This quotation is no longer valid\. Please contact Priya Sharma on \+91/);
    const [r] = await db.select().from(quotationRevisions).where(eq(quotationRevisions.id, rev.id));
    expect(r!.status).toBe('EXPIRED');
  });

  it('AC-P29-1: revising keeps R1 until R2 is generated; then R1 is SUPERSEDED; AC-P28-3: missing profile items block sharing (PRF-03)', async () => {
    const { a, ins, products, customerId } = await setup();
    const rev = await generated(a, customerId, products[0]!.id, ins.id);
    await a.d.post(`/quotations/revisions/${rev.id}/share`, { channel: 'LINK' }, H());
    const cur = (await a.d.get(`/quotations/revisions/${rev.id}`)).body;
    const r2 = await a.d.post(`/quotations/revisions/${rev.id}/revise`, { version: cur.version }, H());
    expect(r2.body.message.text).toBe('Revision R2 created. Generate it to replace R1.');
    expect((await db.select().from(quotationRevisions).where(eq(quotationRevisions.id, rev.id)))[0]!.status).toBe('SHARED');
    const d2 = (await a.d.get(`/quotations/revisions/${r2.body.id}`)).body;
    const s = await a.d.post(`/quotations/revisions/${d2.id}/draft`, { inputs: d2.inputs, step: 10, version: d2.version });
    const g = await a.d.post(`/quotations/revisions/${d2.id}/generate`, { version: s.body.version }, H());
    expect(g.body.message.text).toMatch(/R2 is ready/);
    expect((await db.select().from(quotationRevisions).where(eq(quotationRevisions.id, rev.id)))[0]!.status).toBe('SUPERSEDED');
    await db.update(advisorProfiles).set({ email: null }).where(eq(advisorProfiles.accountId, a.accountId));
    const blocked = await a.d.post(`/quotations/revisions/${d2.id}/share`, { channel: 'LINK' }, H());
    expect(blocked.body.error.message).toBe('To share quotations, first add: Email.');
  });
});

describe('P-31 / P-32 Payments', () => {
  it('AC-P31-1/2: a link off the insurer domain (PAY-01) and a different portal amount (PAY-02) are refused', async () => {
    const { a, ins, products, customerId } = await setup();
    const rev = await generated(a, customerId, products[0]!.id, ins.id);
    const bad = await a.d.post(`/quotations/revisions/${rev.id}/payment-link`, { method: 'LINK', link: 'https://evil.com/pay', portalAmount: '13275.00' }, H());
    expect(bad.body.error.fields[0].code).toBe('PAY-01');
    const amt = await a.d.post(`/quotations/revisions/${rev.id}/payment-link`, { method: 'LINK', link: 'https://pay.insurer.com/x', portalAmount: '13000.00' }, H());
    expect(amt.body.error.fields[0].code).toBe('PAY-02');
    const ok = await a.d.post(`/quotations/revisions/${rev.id}/payment-link`, { method: 'LINK', link: 'https://pay.insurer.com/x', portalAmount: '13275.00' }, H());
    expect(ok.body.message.text).toBe('Payment link added. Share the quotation again so Ravi Kumar can pay.');
  });

  it('AC-P32-1/2/3: UPI needs a reference; cash saves with the receipt warning; a repeated reference is refused (PAY-08)', async () => {
    const { a, ins, products, customerId } = await setup();
    const rev = await generated(a, customerId, products[0]!.id, ins.id);
    await a.d.post(`/quotations/revisions/${rev.id}/share`, { channel: 'LINK' }, H());
    const base = { amount: '13275.00', paidOn: formatDate(istToday()), declaration: true };
    const noRef = await a.d.post(`/quotations/revisions/${rev.id}/payment`, { ...base, mode: 'UPI' }, H());
    expect(noRef.body.error.fields[0].message).toBe('Enter the reference number for this UPI payment.');
    const ok = await a.d.post(`/quotations/revisions/${rev.id}/payment`, { ...base, mode: 'UPI', reference: 'UTR12345678' }, H());
    expect(ok.body.message.text).toBe('Payment recorded. You can submit the proposal now.');
    expect((await db.select().from(quotationRevisions).where(eq(quotationRevisions.id, rev.id)))[0]!.status).toBe('ACCEPTED');
    const other = await generated(a, customerId, products[0]!.id, ins.id);
    await a.d.post(`/quotations/revisions/${other.id}/share`, { channel: 'LINK' }, H());
    const dup = await a.d.post(`/quotations/revisions/${other.id}/payment`, { ...base, mode: 'UPI', reference: 'utr-12345678' }, H());
    expect(dup.body.error.fields[0].code).toBe('PAY-08');
    const cash = await a.d.post(`/quotations/revisions/${other.id}/payment`, { ...base, mode: 'Cash' }, H());
    expect(cash.body.warning.code).toBe('PAY-17');
  });
});

describe('P-55 / P-33 / P-35 Proposal, policy and nominees', () => {
  it('AC-P55-2/3/4: submit needs KYC, payment and valid nominees; submitting creates AWAITING_ISSUANCE; P-33 issue creates one cycle; POL-02', async () => {
    const { a, ins, products, customerId } = await setup();
    const rev = await generated(a, customerId, products[0]!.id, ins.id);
    await a.d.post(`/quotations/revisions/${rev.id}/share`, { channel: 'LINK' }, H());
    const start = await a.d.post(`/quotations/revisions/${rev.id}/proposal`, {}, H());
    expect(start.body.message.text).toMatch(/^Proposal PR-\d{6}-00001 started from quotation QT-/);
    let p = (await a.d.get(`/proposals/${start.body.id}`)).body;
    expect(p.questions).toContain('Hospital stay in the last 4 years');
    const answers = Object.fromEntries(p.questions.map((q: string) => [q, { answer: 'NO' }]));
    const badShares = await a.d.post(`/proposals/${p.id}/draft`, { step: 5, declarations: { customer: answers }, nominees: [{ name: 'Lata Kumar', relationship: 'Spouse', dateOfBirth: '01-01-1990', sharePercent: '99.99' }], version: p.version });
    expect(badShares.body.error.message).toBe('Shares must add up to 100%. They now add up to 99.99%.');
    const saved = await a.d.post(`/proposals/${p.id}/draft`, { step: 6, declarations: { customer: answers }, nominees: [{ name: 'Lata Kumar', relationship: 'Spouse', dateOfBirth: '01-01-1990', sharePercent: '100' }], version: p.version });
    expect(saved.status).toBe(200);
    p = saved.body;
    expect(p.canSubmit).toBe(false);
    const noKyc = await a.d.post(`/proposals/${p.id}/submit`, { version: p.version }, H());
    expect(noKyc.body.error.code).toBe('PRP-04');
    await kyc(a, customerId);
    const noPay = await a.d.post(`/proposals/${p.id}/submit`, { version: p.version }, H());
    expect(noPay.body.error.code).toBe('PAY-18');
    await a.d.post(`/quotations/revisions/${rev.id}/payment`, { amount: '13275.00', paidOn: formatDate(istToday()), declaration: true, mode: 'UPI', reference: 'UTR998877' }, H());
    const sub = await a.d.post(`/proposals/${p.id}/submit`, { version: p.version }, H());
    expect(sub.body.message.text).toMatch(/submitted\. Record the policy when/);
    const pol = (await a.d.get(`/policies/${sub.body.policyId}`)).body;
    expect(pol.status).toBe('AWAITING_ISSUANCE');
    const doc = await upload(a.d, 'POLICY_DOCUMENT', [{ name: 'policy.pdf', data: SAMPLE.pdf }]);
    const start1 = addDays(istToday(), 3);
    const issue = await a.d.post(`/policies/${pol.id}/issue`, { insurerPolicyNumber: 'POL123456', issueDate: formatDate(istToday()), startDate: formatDate(start1), endDate: formatDate(addDays(start1, 364)), frequency: 'YEARLY', sumInsured: '500000', premium: '13275.00', documentFileId: doc.body.items[0].id, version: pol.version }, H());
    expect(issue.body.message.text).toBe('Policy POL123456 recorded. Renewal tracking has started.');
    const cycles = await db.select().from(renewalCycles).where(eq(renewalCycles.policyId, pol.id));
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.renewalDate).toBe(addDays(start1, 364));
    // A second policy with the same number for this insurer is refused (POL-02)
    const ex = await a.d.post('/policies/existing', { customerId, insurerId: ins.id, productName: 'Old plan', typeId: healthTypeId, insured: ['customer'], insurerPolicyNumber: 'POL-123456', issueDate: formatDate(addDays(istToday(), -10)), startDate: formatDate(addDays(istToday(), -10)), endDate: formatDate(addDays(istToday(), 300)), frequency: 'YEARLY', sumInsured: '300000', premium: '9000' }, H());
    expect(ex.body.error.fields[0].message).toBe('Policy number POL-123456 is already recorded for Ravi Kumar. Check the number.');
    // AC-P35-5: a change on an ISSUED policy needs an endorsement reference
    const after = (await a.d.get(`/policies/${pol.id}`)).body;
    const noEnd = await a.d.post(`/policies/${pol.id}/nominees`, { nominees: [{ name: 'Lata Kumar', relationship: 'Spouse', dateOfBirth: '01-01-1990', sharePercent: '100' }], nomineeVersion: after.nomineeVersion }, H());
    expect(noEnd.body.error.fields[0].message).toBe('Insurer endorsement reference is required.');
    const minor = await a.d.post(`/policies/${pol.id}/nominees`, { nominees: [{ name: 'Baby Kumar', relationship: 'Son', dateOfBirth: formatDate(addDays(istToday(), -365 * 5)), sharePercent: '100' }], nomineeVersion: after.nomineeVersion, endorsementRef: 'END12345', effectiveDate: formatDate(istToday()) }, H());
    expect(minor.body.error.fields[0].message).toBe('Baby Kumar is under 18. Add an appointee.');
  });

  it('AC-P34-2: an existing policy with a past end date is saved as EXPIRED after POL-08', async () => {
    const { a, ins, customerId } = await setup();
    const body = { customerId, insurerId: ins.id, productName: 'Old plan', typeId: healthTypeId, insured: ['customer'], insurerPolicyNumber: 'OLD7788', issueDate: formatDate(addDays(istToday(), -400)), startDate: formatDate(addDays(istToday(), -400)), endDate: formatDate(addDays(istToday(), -36)), frequency: 'YEARLY', sumInsured: '300000', premium: '9000' };
    const ask = await a.d.post('/policies/existing', body, H());
    expect(ask.body.error.message).toBe("This policy's end date has passed. It will be saved as expired. Continue?");
    const ok = await a.d.post('/policies/existing', { ...body, confirmExpired: true }, H());
    expect(ok.body.message.text).toBe('Existing policy OLD7788 added.');
    const [p] = await db.select().from(policies).where(eq(policies.id, ok.body.id));
    expect(p!.status).toBe('EXPIRED');
    const [c] = await db.select().from(renewalCycles).where(eq(renewalCycles.policyId, p!.id));
    expect(c!.status).toBe('LAPSED');
  });
});

describe('P-26 / P-30 Best fit and comparison', () => {
  it('AC-P26-2/4: ranking follows the CFG-168 weights; missing facts score 0 "Not stated by insurer"', async () => {
    const { a, customerId } = await setup({ products: 2 });
    const r = await a.d.post('/best-fit/rank', { customerId, typeId: healthTypeId, people: ['customer'], budget: '20000', priority: 'Best coverage', sumInsured: '500000' });
    expect(r.body.message.text).toBe('2 products ranked. Each score shows its reason.');
    expect(r.body.items[0].scores.find((s: { key: string }) => s.key === 'coPay').score).toBe(100);
    expect(r.body.items[1].scores.find((s: { key: string }) => s.key === 'coPay').score).toBe(30);
    expect(r.body.items[0].scores.find((s: { key: string }) => s.key === 'claimRatio').reason).toBe('Not stated by insurer');
  });

  it('AC-P30-1/3: wrong number of products is refused (QT-30); choosing a product creates a separate normal quotation draft', async () => {
    const { a, ins, products, customerId } = await setup({ products: 2 });
    const st = await a.d.post('/comparisons', { customerId }, H());
    const c0 = (await a.d.get(`/comparisons/${st.body.id}`)).body;
    const inputs = { typeId: healthTypeId, people: ['customer'], sumInsured: '500000', term: '1', startDate: formatDate(addDays(istToday(), 2)) };
    const one = await a.d.post(`/comparisons/${c0.id}/draft`, { inputs, options: [{ productId: products[0]!.id }], step: 3, version: c0.version });
    expect(one.body.error.message).toBe('Choose at least 2 and at most 3 products.');
    const two = await a.d.post(`/comparisons/${c0.id}/draft`, { inputs, options: products.map((p) => ({ productId: p.id })), recommendedProductId: products[0]!.id, recommendedReason: 'No co-pay at all', step: 3, version: c0.version });
    expect(two.status).toBe(200);
    expect(two.body.options.every((o: { ok: boolean }) => o.ok)).toBe(true);
    const g = await a.d.post(`/comparisons/${c0.id}/generate`, { version: two.body.version }, H());
    expect(g.body.message.text).toMatch(/^Comparison CQ-\d{6}-00001 is ready/);
    const c1 = (await a.d.get(`/comparisons/${c0.id}`)).body;
    expect(c1.table.find((r: { label: string }) => r.label === 'Claim settlement ratio').cells[0]).toBe('Not stated by insurer');
    await a.d.post(`/comparisons/${c0.id}/share`, { channel: 'LINK' }, H());
    const c2 = (await a.d.get(`/comparisons/${c0.id}`)).body;
    const ch = await a.d.post(`/comparisons/${c0.id}/choose`, { productId: products[1]!.id, version: c2.version }, H());
    expect(ch.body.message.text).toMatch(/choice is saved\. Create the quotation for/);
    const q = (await a.d.get(`/quotations/revisions/${ch.body.quotation.revisionId}`)).body;
    expect(q).toMatchObject({ status: 'DRAFT', number: null });
    expect(q.inputs.productId).toBe(products[1]!.id);
    expect(q.inputs.insurerId).toBe(ins.id);
    const [pay] = await db.select().from(payments).where(and(eq(payments.accountId, a.accountId)));
    expect(pay).toBeUndefined();
  });
});
