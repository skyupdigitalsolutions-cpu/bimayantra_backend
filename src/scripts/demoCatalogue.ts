// Demo catalogue (development and demo only, SEED_DEMO_DATA=true): a Health feature template and one verified
// product with a SkyUp reference price, all clearly named "Demo", so the advisor screens (products, my
// commercials, my prices, suggest a correction) can be tried before SkyUp loads the real catalogue.
// Real catalogue items always go through P-20 to P-25 with two different admins.
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { insuranceTypes, insurers, priceVersions, products, productVersions, templateVersions } from '../db/schema.js';
import { clock, istToday } from '../lib/clock.js';
import type { ProductData } from '../modules/catalogue/productData.js';
import type { Factor, Feature } from '../modules/catalogue/types.service.js';

const FEATURES: Feature[] = [
  { key: 'room_rent', name: 'Room rent limit', group: 'LIMITS', dataType: 'TEXT', requiredToPublish: true, order: 1, help: null },
  { key: 'copay', name: 'Co-pay', group: 'LIMITS', dataType: 'PERCENT', requiredToPublish: true, order: 2, help: null },
  { key: 'initial_wait', name: 'Initial waiting period', group: 'WAITING_PERIODS', dataType: 'DAYS', requiredToPublish: true, order: 3, help: null },
  { key: 'ped_wait', name: 'Pre-existing disease waiting period', group: 'WAITING_PERIODS', dataType: 'MONTHS', requiredToPublish: true, order: 4, help: null },
  { key: 'restore', name: 'Restore benefit', group: 'BENEFITS', dataType: 'YES_NO', requiredToPublish: false, order: 5, help: null },
  { key: 'csr', name: 'Claim settlement ratio', group: 'OTHER', dataType: 'PERCENT', requiredToPublish: false, order: 6, help: 'With the year, for example 2024-25' },
  { key: 'network', name: 'Network hospitals', group: 'OTHER', dataType: 'NUMBER', requiredToPublish: false, order: 7, help: null },
];
const FACTORS: Factor[] = [
  { key: 'eldest_age', name: 'Eldest age', kind: 'BAND', filledFrom: 'ELDEST_AGE', bands: [{ min: 18, max: 35 }, { min: 36, max: 45 }, { min: 46, max: 55 }, { min: 56, max: 65 }], values: [] },
  { key: 'sum_insured', name: 'Sum insured', kind: 'VALUE', filledFrom: 'SUM_INSURED', bands: [], values: ['500000', '1000000'] },
];
const PREMIUMS: Record<string, [string, string]> = { '18-35': ['8500.00', '11200.00'], '36-45': ['11800.00', '15400.00'], '46-55': ['17900.00', '23600.00'], '56-65': ['26400.00', '34900.00'] };

export async function seedDemoCatalogue(adminId: string): Promise<void> {
  const [health] = await db.select().from(insuranceTypes).where(eq(insuranceTypes.name, 'Health'));
  const [ins] = await db.select().from(insurers).where(eq(insurers.shortCode, 'DEMO-HEALTH'));
  if (!health || !ins) return;
  const now = clock.now();
  let [tpl] = await db.select().from(templateVersions).where(and(eq(templateVersions.typeId, health.id), eq(templateVersions.status, 'ACTIVE')));
  if (!tpl) {
    [tpl] = await db
      .insert(templateVersions)
      .values({ typeId: health.id, versionNo: 1, status: 'ACTIVE', features: FEATURES, factors: FACTORS, questions: [], createdBy: adminId, createdAt: now, approvedAt: now })
      .returning();
    console.log('Demo Health feature template: created.');
  }
  const [exists] = await db.select({ id: products.id }).from(products).where(and(eq(products.insurerId, ins.id), eq(products.code, 'DEMO-FHP')));
  if (exists) return console.log('Demo product: already exists.');
  const data: ProductData = {
    name: 'Demo Family Health Plan',
    shortDescription: 'Demo family floater for trying the screens',
    uin: 'DEMOHLIP26001V012526',
    launchDate: istToday(),
    adultMinAge: 18,
    adultMaxAge: 65,
    coversChildren: true,
    childMinAge: 0,
    childMaxAge: 25,
    sumInsured: { mode: 'OPTIONS', options: ['500000.00', '1000000.00'] },
    policyTerms: [1, 2, 3],
    features: {
      room_rent: { value: 'Single private room', notStated: false, sourcePage: 2 },
      copay: { value: '0', notStated: false, sourcePage: 2 },
      initial_wait: { value: '30', notStated: false, sourcePage: 3 },
      ped_wait: { value: '36', notStated: false, sourcePage: 3 },
      restore: { value: 'Yes', notStated: false, sourcePage: 4 },
      csr: { value: null, notStated: true, sourcePage: null },
      network: { value: '9500', notStated: false, sourcePage: 1 },
    },
    riders: [{ key: 'r_demo_opd', name: 'Demo OPD cover', description: 'Out-patient consultations', priceType: 'FIXED', value: '2500.00' }],
    pricingMode: 'RATE_TABLE',
    taxPercent: '18.00',
    nomineeRequired: true,
    maxNominees: 2,
    graceDays: 30,
    brochureFileId: null,
    wordingFileId: null,
    sourceLink: 'https://example.com/demo-family-health-plan',
    sourceCheckedOn: istToday(),
  };
  await db.transaction(async (tx) => {
    const [p] = await tx.insert(products).values({ kind: 'VERIFIED', insurerId: ins.id, typeId: health.id, code: 'DEMO-FHP', status: 'ACTIVE', createdBy: adminId, createdAt: now }).returning();
    const [v] = await tx
      .insert(productVersions)
      .values({ productId: p!.id, versionNo: 1, status: 'PUBLISHED', templateVersionId: tpl!.id, name: data.name, uin: data.uin, data, createdBy: adminId, createdAt: now, updatedAt: now, approvedAt: now })
      .returning();
    await tx.update(products).set({ publishedVersionId: v!.id }).where(eq(products.id, p!.id));
    const rows = Object.entries(PREMIUMS).flatMap(([band, [a, b]]) => [
      { factors: { eldest_age: band, sum_insured: '500000' }, basePremium: a },
      { factors: { eldest_age: band, sum_insured: '1000000' }, basePremium: b },
    ]);
    await tx.insert(priceVersions).values({
      ownerKey: 'SKYUP',
      productId: p!.id,
      seq: 1,
      effectiveFrom: istToday(),
      status: 'CURRENT',
      taxPercent: '18.00',
      rows,
      riderPrices: [{ key: 'r_demo_opd', priceType: 'FIXED', value: '2500.00' }],
      sourceNote: 'Demo rate card',
      createdBy: adminId,
      createdAt: now,
    });
  });
  console.log('Demo product: "Demo Family Health Plan" created with a SkyUp reference price.');
}
