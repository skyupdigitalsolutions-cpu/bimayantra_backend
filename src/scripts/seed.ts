// Start-up data. Safe to run on every deploy (creates only what is missing).
// - CFG settings defaults (never overwrites a value an admin changed)
// - the first SkyUp Admin from SEED_ADMIN_MOBILE (log in with that mobile's OTP)
// - a second SkyUp Admin from SEED_SECOND_ADMIN_MOBILE (catalogue approvals need a different admin)
// - outside production, with SEED_DEMO_DATA=true: a demo advisor (+91 99999 00001), demo insurers and a
//   demo Health feature template with one demo product, so the advisor screens can be tried
import { eq } from 'drizzle-orm';
import { env, isProduction } from '../config/env.js';
import { db, pool } from '../db/client.js';
import { insuranceTypes, insurers, users } from '../db/schema.js';
import { clock } from '../lib/clock.js';
import { mobile, personName } from '../lib/fields.js';
import { maskMobile } from '../lib/mask.js';
import { createAdvisorAccount } from '../modules/accounts/accounts.service.js';
import { audit } from '../modules/audit/audit.js';
import { settings } from '../modules/settings/settings.service.js';
import { seedDemoCatalogue } from './demoCatalogue.js';
import { seedDefaultTemplates } from '../modules/messages/templates.service.js';

await settings.init();
console.log('Settings: defaults written.');

// Starting insurance types (CFG-115). Platform data, created once; SkyUp manages them later (P-21).
const types = settings.get('CFG-115');
for (const [i, name] of types.entries()) {
  await db.insert(insuranceTypes).values({ name, position: i + 1 }).onConflictDoNothing();
}
console.log(`Insurance types: ${types.length} ensured.`);

// Released message templates (document change 40): email ones ACTIVE, WhatsApp ones wait for Meta (P-39)
console.log(`Message templates: ${await seedDefaultTemplates()} added.`);

async function ensureAdmin(rawMobile: string, rawName: string, label: string) {
  const m = mobile(rawMobile);
  const n = personName(rawName);
  if (!m.ok || !n.ok) throw new Error(`${label}: the mobile number or name is not valid`);
  const [existing] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.mobile, m.value));
  if (existing) {
    console.log(`${label}: ${maskMobile(m.value)} already exists (${existing.role}).`);
    return existing.id;
  }
  const id = await db.transaction(async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({ role: 'ADM', name: n.value, mobile: m.value, status: 'ACTIVE', activatedAt: clock.now(), createdAt: clock.now() })
      .returning({ id: users.id });
    await audit(tx, null, { action: 'USER_CREATED', entity: 'user', entityId: u!.id, newValue: { role: 'ADM', mobile: maskMobile(m.value) }, actor: { job: 'seed' } });
    return u!.id;
  });
  console.log(`${label}: created for ${maskMobile(m.value)}.`);
  return id;
}

const adminId = env.SEED_ADMIN_MOBILE ? await ensureAdmin(env.SEED_ADMIN_MOBILE, env.SEED_ADMIN_NAME, 'SkyUp Admin') : null;
if (env.SEED_SECOND_ADMIN_MOBILE) await ensureAdmin(env.SEED_SECOND_ADMIN_MOBILE, env.SEED_SECOND_ADMIN_NAME, 'Second SkyUp Admin');

if (!isProduction && env.SEED_DEMO_DATA) {
  const demoMobile = '+919999900001';
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.mobile, demoMobile));
  if (!existing) {
    await db.transaction(async (tx) => {
      const { user } = await createAdvisorAccount(tx, { name: 'Demo Advisor', mobile: demoMobile, termsVersion: env.TERMS_VERSION, termsAcceptedAt: clock.now() });
      await audit(tx, null, { action: 'ACCOUNT_CREATED', entity: 'account', entityId: user.accountId, accountId: user.accountId, actor: { job: 'seed' } });
    });
    console.log('Demo advisor: created (mobile 99999 00001).');
  } else console.log('Demo advisor: already exists.');

  // Demo insurers so "My insurers" can be tried before the catalogue team adds the real ones (P-20)
  const demoInsurers = [
    { name: 'Demo Health Insurance Ltd', shortCode: 'DEMO-HEALTH', category: 'STANDALONE_HEALTH', irdaiRegNo: 'DEMO-101' },
    { name: 'Demo General Insurance Ltd', shortCode: 'DEMO-GENERAL', category: 'GENERAL', irdaiRegNo: 'DEMO-102' },
    { name: 'Demo Life Insurance Ltd', shortCode: 'DEMO-LIFE', category: 'LIFE', irdaiRegNo: 'DEMO-103' },
  ];
  for (const ins of demoInsurers) await db.insert(insurers).values({ ...ins, status: 'ACTIVE', paymentDomains: ['example.com'] }).onConflictDoNothing();
  console.log('Demo insurers: ensured (clearly named "Demo …").');
  if (adminId) await seedDemoCatalogue(adminId);
}

await pool.end();
