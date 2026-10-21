// One-time import: copies the SkyUp verified products from the old catalogue tool (bimayantra-admin, Neon)
// into this app's catalogue, so they show in Products for every advisor as "Verified by SkyUp".
//
//   npx tsx --env-file-if-exists=.env src/scripts/importSkyupCatalogue.ts
//
// Where the old catalogue is read from (first one found):
//   1. CATALOGUE_DATABASE_URL in .env
//   2. a file catalogue_database_url.txt in this folder
//   3. Documents\bimayantra-admin\admin-api\database_url.txt (also under OneDrive\Documents)
// Writes to this app's database (DATABASE_URL in .env), the same one the API uses.
//
// Safe to run again: products already imported (same insurer + product code) are skipped, nothing is duplicated.
// What it does:
//   - insurers: matched by name or short code; missing ones are added as Active
//   - insurance types: matched by name (Health, Term Life, Motor Private Car ...); missing ones are added
//   - feature list of each type: the old numbered features are added to the type's feature template
//     (a new Active template version; the old version is kept), plus "Sum insured details",
//     "Policy term details", "Other features" and "Other terms"
//   - each product: published version with ages, sum insured, policy terms, features, add-ons, tax and
//     source link; pricing "Manual entry (insurer portal)" like in the old tool
// The products were checked and approved in the old tool, so they are published directly (no new approval).
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { db, pool } from '../db/client.js';
import { insuranceTypes, insurers, products, productVersions, templateVersions, users } from '../db/schema.js';
import { clock, istToday } from '../lib/clock.js';
import type { ProductData, Rider } from '../modules/catalogue/productData.js';
import type { Feature } from '../modules/catalogue/types.service.js';

type Group = Feature['group'];
type DataType = Feature['dataType'];

// ---------- where the old catalogue is ----------
function sourceUrl(): string {
  if (process.env.CATALOGUE_DATABASE_URL) return process.env.CATALOGUE_DATABASE_URL.trim();
  const files = [
    join(process.cwd(), 'catalogue_database_url.txt'),
    join(homedir(), 'Documents', 'bimayantra-admin', 'admin-api', 'database_url.txt'),
    join(homedir(), 'OneDrive', 'Documents', 'bimayantra-admin', 'admin-api', 'database_url.txt'),
  ];
  for (const f of files) if (existsSync(f)) {
    const v = String(readFileSync(f, "utf8")).trim();
    if (v) {
      console.log(`Old catalogue: ${f}`);
      return v;
    }
  }
  console.log('Could not find the old catalogue (bimayantra-admin) database address.');
  console.log('Copy bimayantra-admin\\admin-api\\database_url.txt into this folder, rename it to catalogue_database_url.txt, and run again.');
  process.exit(1);
}

// ---------- small helpers ----------
const GROUPS: Record<string, Group> = {
  coverage: 'COVERAGE', 'waiting periods': 'WAITING_PERIODS', 'limits and sub-limits': 'LIMITS', limits: 'LIMITS',
  benefits: 'BENEFITS', exclusions: 'EXCLUSIONS', other: 'OTHER',
};
const DATA_TYPES: DataType[] = ['YES_NO', 'NUMBER', 'AMOUNT', 'PERCENT', 'DAYS', 'MONTHS', 'YEARS', 'TEXT'];
const NUMERIC = new Set<DataType>(['NUMBER', 'AMOUNT', 'PERCENT', 'DAYS', 'MONTHS', 'YEARS']);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'feature';
const money = (n: number | string) => `${String(n).replace(/\.\d+$/, '')}.00`;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const clean = (v: string | number | null | undefined) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
const dateStr = (v: unknown) => (v instanceof Date ? istToday(v) : typeof v === 'string' ? (clean(v)?.slice(0, 10) ?? null) : null);

/** Does this value fit the data type as the app stores it? */
function fits(dataType: DataType, v: string): boolean {
  if (dataType === 'YES_NO') return /^(yes|no)$/i.test(v);
  if (NUMERIC.has(dataType)) return /^\d+(\.\d+)?$/.test(v.replace(/,/g, ''));
  return true;
}
function store(dataType: DataType, v: string): string {
  if (dataType === 'YES_NO') return /^y/i.test(v) ? 'Yes' : 'No';
  if (NUMERIC.has(dataType)) return v.replace(/,/g, '');
  return v;
}

/** Policy terms in years from text such as "1, 2, 3", "10-40", "10 to 40", "Min 10 years; max 82", "5 up to 85".
 *  Ages ("maturity age 100", "minus entry age") and months are not terms and are ignored. The full text is kept
 *  in the "Policy term details" feature. */
function parseTerms(text: string | null): number[] {
  if (!text) return [];
  const t = text
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(maturity\s+)?age\s*\d+/gi, ' ')
    .replace(/minus\s+entry\s+age/gi, ' ')
    .replace(/\d+\s*months?/gi, ' ');
  const out = new Set<number>();
  const range = (a: number, b: number) => {
    if (a >= 1 && b <= 100 && a <= b) for (let i = a; i <= b; i++) out.add(i);
  };
  const mm = t.match(/(?:min(?:imum)?|from)\D{0,12}(\d{1,3})[^\d]*?max(?:imum)?\D{0,12}(\d{1,3})/i);
  if (mm) range(Number(mm[1]), Number(mm[2]));
  for (const m of t.matchAll(/(\d{1,3})\s*(?:-|–|to|up to)\s*(\d{1,3})|(\d{1,3})/gi)) {
    if (m[1] && m[2]) range(Number(m[1]), Number(m[2]));
    else if (m[3]) {
      const n = Number(m[3]);
      if (n >= 1 && n <= 100) out.add(n);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Sum insured: a clean list → options; "Min X; max no limit" → range from X. */
function parseSumInsured(text: string | null, values: (string | number)[] | null): ProductData['sumInsured'] {
  const nums = (values ?? []).map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0);
  if (!nums.length) return null;
  if (text && /min/i.test(text)) {
    const max = nums.length > 1 ? Math.max(...nums) : 1_000_000_000; // "no limit" → ₹100 crore
    return { mode: 'RANGE', min: money(Math.min(...nums)), max: money(max) };
  }
  return { mode: 'OPTIONS', options: [...new Set(nums)].sort((a, b) => a - b).map(money) };
}

const insurerCategory = (c: string | null) => {
  const v = (c ?? '').toLowerCase();
  return v.includes('life') ? 'LIFE' : v.includes('health') ? 'STANDALONE_HEALTH' : 'GENERAL';
};

// ---------- read the old catalogue ----------
type SrcFeature = { id: string; type_id: string; group_name: string; name: string; data_type: string; checklist_no: number | null; sort_order: number; help_text: string | null };
type SrcProduct = {
  product_id: string; code: string; insurer_id: string; insurer_name: string; insurer_code: string; insurer_category: string | null; irdai_reg_no: string | null;
  website: string | null; care_phone: string | null; care_email: string | null; type_id: string; type_name: string; type_category: string | null;
  version_id: string; name: string; short_description: string | null; uin: string | null; launch_date: unknown;
  adult_entry_min_years: number | null; adult_entry_max_years: number | null; adult_entry_no_cap: boolean | null;
  child_entry_min_days: number | null; child_entry_max_years: number | null;
  sum_insured_options: string | null; sum_insured_values: string[] | null; policy_term_options: string | null;
  tax_percent: string | null; nominee_required: boolean | null; max_nominees: number | null; grace_days: number | null;
  source_link: string | null; date_checked: unknown; other_features: string | null; other_terms: string | null; product_status: string;
};

const srcUrl = sourceUrl();
const src = new pg.Pool({ connectionString: srcUrl, ssl: /localhost|127\.0\.0\.1/.test(srcUrl) ? undefined : { rejectUnauthorized: false }, max: 2 });
const q = async <T>(text: string, params: unknown[] = []) => (await src.query(text, params)).rows as T[];

let srcProducts: SrcProduct[];
try {
  srcProducts = await q<SrcProduct>(`
    SELECT p.id AS product_id, p.code, p.status::text AS product_status,
           i.id AS insurer_id, i.name AS insurer_name, i.code AS insurer_code, i.category AS insurer_category, i.irdai_reg_no,
           i.website, i.customer_care_phone AS care_phone, i.customer_care_email AS care_email,
           t.id AS type_id, t.name AS type_name, t.category AS type_category,
           v.id AS version_id, v.name, v.short_description, v.uin, v.launch_date,
           v.adult_entry_min_years, v.adult_entry_max_years, v.adult_entry_no_cap, v.child_entry_min_days, v.child_entry_max_years,
           v.sum_insured_options, v.sum_insured_values::text[] AS sum_insured_values, v.policy_term_options,
           v.tax_percent::text, v.nominee_required, v.max_nominees, v.grace_days, v.source_link, v.date_checked,
           v.other_features, v.other_terms
    FROM products p
    JOIN product_versions v ON v.product_id = p.id AND v.status::text = 'PUBLISHED'
    JOIN insurers i ON i.id = p.insurer_id
    JOIN insurance_types t ON t.id = p.insurance_type_id
    WHERE p.owner_account_id IS NULL AND p.status::text <> 'WITHDRAWN'
    ORDER BY t.name, v.name`);
} catch (e) {
  console.log('Could not read the old catalogue: ' + (e as Error).message);
  process.exit(1);
}
console.log(`Old catalogue: ${srcProducts.length} SkyUp products found.`);
if (!srcProducts.length) process.exit(0);

const typeIds = [...new Set(srcProducts.map((p) => p.type_id))];
const srcFeatures = await q<SrcFeature>(`
  SELECT tf.id, ft.insurance_type_id AS type_id, tf.group_name, tf.name, tf.data_type::text, tf.checklist_no, tf.sort_order, tf.help_text
  FROM template_features tf JOIN feature_templates ft ON ft.id = tf.template_id
  WHERE ft.status::text = 'ACTIVE' AND ft.insurance_type_id = ANY($1)
  ORDER BY tf.checklist_no NULLS LAST, tf.sort_order, tf.name`, [typeIds]);
const versionIds = srcProducts.map((p) => p.version_id);
const srcValues = await q<{ product_version_id: string; template_feature_id: string; value_text: string | null; not_stated: boolean }>(
  `SELECT product_version_id, template_feature_id, value_text, not_stated FROM product_feature_values WHERE product_version_id = ANY($1)`, [versionIds]);
const srcAddons = await q<{ product_version_id: string; name: string; description: string | null }>(
  `SELECT product_version_id, name, description FROM product_addons WHERE product_version_id = ANY($1) ORDER BY sort_order, name`, [versionIds]);
await src.end();

// ---------- write into this app ----------
const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.role, 'ADM')).limit(1);
if (!admin) {
  console.log('No SkyUp Admin in this app yet. Run "npm run seed" first (it needs SEED_ADMIN_MOBILE in .env).');
  process.exit(1);
}
const now = clock.now();
const today = istToday();
const report = { insurersAdded: [] as string[], typesAdded: [] as string[], templatesUpdated: [] as string[], imported: 0, skipped: 0, noTerms: [] as string[] };

// insurers
const insurerMap = new Map<string, string>(); // old insurer id → app insurer id
for (const s of new Map(srcProducts.map((p) => [p.insurer_id, p])).values()) {
  const [found] = await db.select({ id: insurers.id }).from(insurers)
    .where(sql`lower(${insurers.name}) = lower(${s.insurer_name}) or ${insurers.shortCode} = ${s.insurer_code}`).limit(1);
  if (found) {
    insurerMap.set(s.insurer_id, found.id);
    continue;
  }
  const [created] = await db.insert(insurers).values({
    name: s.insurer_name, shortCode: s.insurer_code, category: insurerCategory(s.insurer_category ?? s.type_category),
    irdaiRegNo: clean(s.irdai_reg_no) ?? 'To be added', website: clean(s.website), careNumber: clean(s.care_phone), careEmail: clean(s.care_email),
    status: 'ACTIVE', createdBy: admin.id, createdAt: now,
  }).returning({ id: insurers.id });
  insurerMap.set(s.insurer_id, created!.id);
  report.insurersAdded.push(s.insurer_name);
}

// types and their feature templates
const featureKey = new Map<string, { key: string; dataType: DataType }>(); // old template feature id → app feature
const templateFor = new Map<string, string>(); // old type id → app template version id
const typeMap = new Map<string, string>(); // old type id → app type id
const EXTRA = [
  { key: 'sum_insured_details', name: 'Sum insured details' },
  { key: 'policy_term_details', name: 'Policy term details' },
  { key: 'other_features', name: 'Other features' },
  { key: 'other_terms', name: 'Other terms' },
];
for (const oldTypeId of typeIds) {
  const sample = srcProducts.find((p) => p.type_id === oldTypeId)!;
  let [typ] = await db.select().from(insuranceTypes).where(sql`lower(${insuranceTypes.name}) = lower(${sample.type_name})`);
  if (!typ) {
    const pos = ((await db.execute(sql`select coalesce(max(position), 0) + 1 as pos from insurance_types`)).rows[0] as { pos: number }).pos;
    [typ] = await db.insert(insuranceTypes).values({ name: sample.type_name, status: 'ACTIVE', position: Number(pos) }).returning();
    report.typesAdded.push(sample.type_name);
  }
  typeMap.set(oldTypeId, typ!.id);

  const [active] = await db.select().from(templateVersions).where(and(eq(templateVersions.typeId, typ!.id), eq(templateVersions.status, 'ACTIVE')));
  const features: Feature[] = active ? [...(active.features as Feature[])] : [];
  const byName = new Map(features.map((f) => [norm(f.name), f]));
  const keys = new Set(features.map((f) => f.key));
  const uniqueKey = (base: string) => {
    let k = base, i = 2;
    while (keys.has(k)) k = `${base}_${i++}`;
    keys.add(k);
    return k;
  };
  let changed = false;
  const typeValues = srcValues.filter((v) => srcProducts.some((p) => p.version_id === v.product_version_id && p.type_id === oldTypeId));
  for (const f of srcFeatures.filter((x) => x.type_id === oldTypeId)) {
    const existing = byName.get(norm(f.name));
    if (existing) {
      featureKey.set(f.id, { key: existing.key, dataType: existing.dataType });
      continue;
    }
    // keep the old data type only if every value fits it; otherwise text (nothing is lost)
    let dataType: DataType = DATA_TYPES.includes(f.data_type as DataType) ? (f.data_type as DataType) : 'TEXT';
    const vals = typeValues.filter((v) => v.template_feature_id === f.id && !v.not_stated && clean(v.value_text)).map((v) => clean(v.value_text)!);
    if (vals.some((v) => !fits(dataType, v))) dataType = 'TEXT';
    const feat: Feature = {
      key: uniqueKey(slug(f.name)), name: f.name, group: GROUPS[f.group_name.toLowerCase()] ?? 'OTHER', dataType,
      requiredToPublish: false, order: features.length + 1, help: clean(f.help_text),
    };
    features.push(feat);
    byName.set(norm(f.name), feat);
    featureKey.set(f.id, { key: feat.key, dataType });
    changed = true;
  }
  for (const x of EXTRA) {
    if (byName.has(norm(x.name))) continue;
    const feat: Feature = { key: uniqueKey(x.key), name: x.name, group: 'OTHER', dataType: 'TEXT', requiredToPublish: false, order: features.length + 1, help: null };
    features.push(feat);
    byName.set(norm(x.name), feat);
    changed = true;
  }
  if (!changed && active) {
    templateFor.set(oldTypeId, active.id);
    continue;
  }
  const tplId = await db.transaction(async (tx) => {
    const next = ((await tx.execute(sql`select coalesce(max(version_no), 0) + 1 as next from template_versions where type_id = ${typ!.id}`)).rows[0] as { next: number }).next;
    if (active) await tx.update(templateVersions).set({ status: 'RETIRED' }).where(eq(templateVersions.id, active.id));
    const [t] = await tx.insert(templateVersions).values({
      typeId: typ!.id, versionNo: Number(next), status: 'ACTIVE', features, factors: active?.factors ?? [], questions: active?.questions ?? [],
      createdBy: admin.id, createdAt: now, approvedBy: admin.id, approvedAt: now,
    }).returning({ id: templateVersions.id });
    return t!.id;
  });
  templateFor.set(oldTypeId, tplId);
  report.templatesUpdated.push(sample.type_name);
}
// keys of the 4 extra text features, per type
const extraKeys = async (oldTypeId: string) => {
  const [t] = await db.select({ features: templateVersions.features }).from(templateVersions).where(eq(templateVersions.id, templateFor.get(oldTypeId)!));
  const fs = t!.features as Feature[];
  return Object.fromEntries(EXTRA.map((x) => [x.key, fs.find((f) => norm(f.name) === norm(x.name))!.key]));
};

// products
for (const s of srcProducts) {
  const insurerId = insurerMap.get(s.insurer_id)!;
  const typeId = typeMap.get(s.type_id)!;
  const [exists] = await db.select({ id: products.id }).from(products)
    .where(and(eq(products.kind, 'VERIFIED'), eq(products.insurerId, insurerId), eq(products.code, s.code)));
  if (exists) {
    report.skipped++;
    continue;
  }
  const ex = await extraKeys(s.type_id);
  const features: ProductData['features'] = {};
  for (const v of srcValues.filter((x) => x.product_version_id === s.version_id)) {
    const f = featureKey.get(v.template_feature_id);
    if (!f) continue;
    const val = clean(v.value_text);
    if (v.not_stated || !val) features[f.key] = { value: null, notStated: true, sourcePage: null };
    else features[f.key] = { value: fits(f.dataType, val) ? store(f.dataType, val) : val, notStated: false, sourcePage: null };
  }
  const put = (k: string, v: string | null) => {
    if (v) features[ex[k]!] = { value: v, notStated: false, sourcePage: null };
  };
  put('sum_insured_details', clean(s.sum_insured_options));
  put('policy_term_details', clean(s.policy_term_options));
  put('other_features', clean(s.other_features));
  put('other_terms', clean(s.other_terms));

  const riderKeys = new Set<string>();
  const riders: Rider[] = srcAddons.filter((a) => a.product_version_id === s.version_id).map((a) => {
    let k = `r_${slug(a.name)}`.slice(0, 40), i = 2;
    while (riderKeys.has(k)) k = `r_${slug(a.name)}_${i++}`;
    riderKeys.add(k);
    return { key: k, name: a.name, description: clean(a.description), priceType: 'FIXED', value: '0.00' };
  });
  const policyTerms = parseTerms(s.policy_term_options);
  if (!policyTerms.length) report.noTerms.push(s.name);
  const isMotor = /motor/i.test(s.type_name);
  const childMax = s.child_entry_max_years;
  const data: ProductData = {
    name: s.name,
    shortDescription: clean(s.short_description) ?? s.name,
    uin: clean(s.uin)?.toUpperCase() ?? '',
    launchDate: dateStr(s.launch_date),
    adultMinAge: s.adult_entry_min_years ?? null,
    adultMaxAge: s.adult_entry_no_cap ? 99 : (s.adult_entry_max_years ?? null),
    coversChildren: childMax !== null && childMax !== undefined,
    childMinAge: childMax !== null && childMax !== undefined ? Math.floor((s.child_entry_min_days ?? 0) / 365) : null,
    childMaxAge: childMax ?? null,
    sumInsured: parseSumInsured(s.sum_insured_options, s.sum_insured_values),
    policyTerms,
    features,
    riders,
    pricingMode: 'MANUAL_ENTRY',
    taxPercent: s.tax_percent !== null ? Number(s.tax_percent).toFixed(2) : isMotor ? '18.00' : '0.00',
    nomineeRequired: s.nominee_required ?? !isMotor,
    maxNominees: s.max_nominees ?? (isMotor ? null : 4),
    graceDays: s.grace_days ?? null,
    brochureFileId: null,
    wordingFileId: null,
    sourceLink: clean(s.source_link),
    sourceCheckedOn: dateStr(s.date_checked) ?? today,
  };
  // launch date in the future → Upcoming (the app shows it from that day)
  const status = data.launchDate && data.launchDate > today ? 'UPCOMING' : 'ACTIVE';
  await db.transaction(async (tx) => {
    const [p] = await tx.insert(products).values({ kind: 'VERIFIED', insurerId, typeId, code: s.code, status, createdBy: admin.id, createdAt: now }).returning({ id: products.id });
    const [v] = await tx.insert(productVersions).values({
      productId: p!.id, versionNo: 1, status: 'PUBLISHED', templateVersionId: templateFor.get(s.type_id)!, name: data.name, uin: data.uin || null, data,
      createdBy: admin.id, createdAt: now, updatedAt: now, approvedBy: admin.id, approvedAt: now,
    }).returning({ id: productVersions.id });
    await tx.update(products).set({ publishedVersionId: v!.id }).where(eq(products.id, p!.id));
  });
  report.imported++;
}

console.log('');
if (report.insurersAdded.length) console.log(`Insurers added (${report.insurersAdded.length}): ${report.insurersAdded.join(', ')}`);
if (report.typesAdded.length) console.log(`Insurance types added: ${report.typesAdded.join(', ')}`);
if (report.templatesUpdated.length) console.log(`Feature lists updated: ${report.templatesUpdated.join(', ')}`);
console.log(`Products imported: ${report.imported}${report.skipped ? `  (already there, skipped: ${report.skipped})` : ''}`);
if (report.noTerms.length) {
  console.log(`\nThese products have no clear policy term, so they can't be quoted until SkyUp adds the terms`);
  console.log(`(Admin -> Verified products -> open -> Edit -> Policy term options):`);
  for (const n of report.noTerms) console.log('  - ' + n);
}
console.log('\nDone. Open the website -> Products. The imported products show as "Verified by SkyUp".');
await pool.end();
