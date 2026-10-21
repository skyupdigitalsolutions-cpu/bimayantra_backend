// Demo data for showing the app (not for the live server): realistic customers with family, leads at
// different stages, policies with renewals coming up, and today's tasks — so every screen looks alive.
//
//   npm run demo:data                    → fills the demo advisor (99999 00001; created if missing)
//   npm run demo:data -- 98450 12345     → fills that advisor account instead (your own test account)
//
// Everything goes through the app's own rules (numbers, duplicate checks, renewals), exactly as if typed.
// Running it again skips what is already there. Refused on the live server (NODE_ENV=production).
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { and, eq, sql } from 'drizzle-orm';
import { env, isProduction } from '../config/env.js';
import { db, pool } from '../db/client.js';
import { advisorProfiles, insuranceTypes, insurerMappings, insurers, leads, pipelines, tasks, users } from '../db/schema.js';
import { clock, istToday } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import type { AuthContext } from '../types/express.js';
import { createAdvisorAccount } from '../modules/accounts/accounts.service.js';
import { settings } from '../modules/settings/settings.service.js';
import { createCustomer } from '../modules/customers/customers.service.js';
import { addMember } from '../modules/customers/family.service.js';
import { recordConsent } from '../modules/customers/consent.service.js';
import { changeStatus, createLead } from '../modules/leads/leads.service.js';
import { recordExisting } from '../modules/policies/policies.service.js';
import { saveSection } from '../modules/profile/profile.service.js';
import { addMapping } from '../modules/insurers/mappings.service.js';

if (isProduction) {
  console.log('Demo data is not allowed on the live server.');
  process.exit(1);
}
await settings.init();

// ---------- whose account ----------
const arg = process.argv.slice(2).join('').replace(/\D/g, '').slice(-10);
const mobile = `+91${arg || '9999900001'}`;
let [user] = await db.select().from(users).where(eq(users.mobile, mobile));
if (!user && !arg) {
  await db.transaction((tx) => createAdvisorAccount(tx, { name: 'Arjun Rao', mobile, termsVersion: env.TERMS_VERSION, termsAcceptedAt: clock.now() }));
  [user] = await db.select().from(users).where(eq(users.mobile, mobile));
  console.log('Demo advisor created: 99999 00001 (log in with OTP).');
}
if (!user || user.role !== 'ADV' || !user.accountId) {
  console.log(`No advisor account with the mobile number ${arg}. Register it in the app first, then run this again.`);
  process.exit(1);
}
// the demo advisor gets a real-looking name ("Good evening, Arjun")
if (!arg && user.name === 'Demo Advisor') {
  await db.update(users).set({ name: 'Arjun Rao' }).where(eq(users.id, user.id));
  await db.update(advisorProfiles).set({ fullName: 'Arjun Rao' }).where(eq(advisorProfiles.accountId, user.accountId));
  user = { ...user, name: 'Arjun Rao' };
}
const auth: AuthContext = { userId: user.id, sessionId: randomUUID(), role: 'ADV', accountId: user.accountId, name: user.name, mobile: user.mobile, readOnly: false };
const req = { ip: '127.0.0.1', requestId: 'demo-data', auth, headers: {}, get: () => undefined } as unknown as Request;
// ---------- the demo advisor can quote (P-27 needs: email, licence, authorised types, an insurer mapping) ----------
if (!arg) {
  const [pr] = await db.select().from(advisorProfiles).where(eq(advisorProfiles.accountId, auth.accountId!));
  const t = await db.select({ id: insuranceTypes.id }).from(insuranceTypes).where(eq(insuranceTypes.status, 'ACTIVE'));
  const in3y = `${Number(istToday().slice(0, 4)) + 3}${istToday().slice(4)}`;
  if (pr && !pr.email) await saveSection(req, auth, 'contact', { email: 'arjun.rao@example.com', addressLine1: '21, 2nd Main, Sahakar Nagar', city: 'Bengaluru', state: 'Karnataka', pinCode: '560092', version: pr.contactVersion }).catch((e) => console.log('  profile contact:', (e as AppError).code, JSON.stringify((e as AppError).fields ?? '')));
  if (pr && !pr.licenceNumber) await saveSection(req, auth, 'professional', { advisorType: 'POSP', licenceNumber: 'POSPKA2021000871', licenceValidUntil: in3y, experienceYears: '6', authorisedTypeIds: t.map((x) => x.id), version: pr.professionalVersion }).catch((e) => console.log('  profile professional:', (e as AppError).code, JSON.stringify((e as AppError).fields ?? '')));
  const have = new Set((await db.select({ i: insurerMappings.insurerId }).from(insurerMappings).where(eq(insurerMappings.accountId, auth.accountId!))).map((r) => r.i));
  const all = await db.select({ id: insurers.id, name: insurers.name }).from(insurers).where(eq(insurers.status, 'ACTIVE'));
  let n = 0;
  for (const [i, ins] of all.entries()) {
    if (have.has(ins.id) || /^demo /i.test(ins.name)) continue;
    const r = await addMapping(req, auth, { insurerId: ins.id, agentCode: `BY${String(410200 + i * 37)}`, codeValidUntil: in3y, declaration: true }).catch((e) => { console.log(`  insurer ${ins.name}:`, (e as AppError).code); return null; });
    if (r) n++;
  }
  // insurers from the catalogue import have no payment link domains, so no payment link could be added (PAY-01).
  // Fill the insurers' usual websites where empty, for the demo only; SkyUp checks them in Admin → Insurers.
  const DOMAINS: [RegExp, string[]][] = [
    [/^care health/i, ['careinsurance.com']], [/^niva bupa/i, ['nivabupa.com']], [/^hdfc ergo/i, ['hdfcergo.com']],
    [/^icici lombard/i, ['icicilombard.com']], [/^life insurance corporation/i, ['licindia.in']], [/^aditya birla health/i, ['adityabirlacapital.com']],
    [/^star health/i, ['starhealth.in']], [/^tata aig/i, ['tataaig.com']], [/^go digit/i, ['godigit.com']], [/^bajaj/i, ['bajajallianz.com', 'bajajgeneralinsurance.com']],
    [/^tata aia/i, ['tataaia.com']], [/^axis max/i, ['axismaxlife.com', 'maxlifeinsurance.com']], [/^icici prudential/i, ['iciciprulife.com']],
  ];
  let nd = 0;
  for (const ins of await db.select({ id: insurers.id, name: insurers.name, d: insurers.paymentDomains }).from(insurers)) {
    const hit = DOMAINS.find(([re]) => re.test(ins.name));
    if (hit && !(ins.d ?? []).length) { await db.update(insurers).set({ paymentDomains: hit[1] }).where(eq(insurers.id, ins.id)); nd++; }
  }
  if (nd) console.log(`  payment link websites filled for ${nd} insurers (demo) - SkyUp must check them in Admin > Insurers before going live`);
  console.log(`  profile ready to quote; insurers added: ${n}`);
}

console.log(`Filling the account of ${user.name} (${mobile.slice(3, 8)} ${mobile.slice(8)})...`);

// ---------- dates ----------
const today = istToday(); // YYYY-MM-DD
const shift = (days: number, from = today) => {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const years = (n: number, from = today) => `${Number(from.slice(0, 4)) - n}${from.slice(4)}`;
const birthdayToday = (age: number) => years(age); // born on this day
const birthdayIn = (days: number, age: number) => years(age, shift(days));

const quiet = async <T>(what: string, fn: () => Promise<T>): Promise<T | null> => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError && ['CU-02', 'LD-02', 'POL-02', 'CU-07', 'GEN-02'].includes(err.code)) return null; // already there
    if (err instanceof AppError && err.status === 409) return null; // possible duplicate → already there
    const e = err as AppError;
    console.log(`  skipped ${what}: ${e.code ?? ''} ${e.message} ${e.fields ? JSON.stringify(e.fields) : ''}`);
    return null;
  }
};

// ---------- customers + family ----------
type Fam = { fullName: string; relationship: string; dateOfBirth?: string; gender?: string; mobile?: string };
type Cust = { fullName: string; mobile: string; dateOfBirth: string; gender: string; email?: string; city: string; state: string; pinCode: string; addressLine1: string; occupation?: string; anniversary?: string; preferredContact?: string; family?: Fam[] };
const CUSTOMERS: Cust[] = [
  { fullName: 'Ravi Kumar', mobile: '9845012301', dateOfBirth: years(41, '2026-05-10'), gender: 'MALE', email: 'ravi.kumar@example.com', city: 'Bengaluru', state: 'Karnataka', pinCode: '560092', addressLine1: '12, 3rd Cross, Sahakar Nagar', occupation: 'Software engineer', anniversary: '2012-11-25', preferredContact: 'WHATSAPP',
    family: [{ fullName: 'Asha Kumar', relationship: 'Spouse', dateOfBirth: '1988-03-14', gender: 'FEMALE' }, { fullName: 'Aarav Kumar', relationship: 'Son', dateOfBirth: '2015-07-02', gender: 'MALE' }] },
  { fullName: 'Priya Sharma', mobile: '9845012302', dateOfBirth: birthdayToday(34), gender: 'FEMALE', email: 'priya.sharma@example.com', city: 'Bengaluru', state: 'Karnataka', pinCode: '560038', addressLine1: '45, 12th Main, Indiranagar', occupation: 'Doctor', preferredContact: 'WHATSAPP',
    family: [{ fullName: 'Rohit Sharma', relationship: 'Spouse', dateOfBirth: '1989-09-21', gender: 'MALE' }] },
  { fullName: 'Suresh Gowda', mobile: '9845012303', dateOfBirth: '1968-01-20', gender: 'MALE', city: 'Mysuru', state: 'Karnataka', pinCode: '570009', addressLine1: '8, Kuvempu Nagar', occupation: 'Business owner', anniversary: '1994-02-10', preferredContact: 'PHONE',
    family: [{ fullName: 'Lakshmi Gowda', relationship: 'Spouse', dateOfBirth: '1972-06-30', gender: 'FEMALE' }, { fullName: 'Kavya Gowda', relationship: 'Daughter', dateOfBirth: '1998-12-05', gender: 'FEMALE' }, { fullName: 'Nanjappa Gowda', relationship: 'Father', dateOfBirth: '1944-04-11', gender: 'MALE' }] },
  { fullName: 'Meena Iyer', mobile: '9845012304', dateOfBirth: birthdayIn(3, 29), gender: 'FEMALE', email: 'meena.iyer@example.com', city: 'Bengaluru', state: 'Karnataka', pinCode: '560041', addressLine1: '22, 4th Block, Jayanagar', occupation: 'Teacher', preferredContact: 'WHATSAPP' },
  { fullName: 'Mohammed Irfan', mobile: '9845012305', dateOfBirth: '1983-08-15', gender: 'MALE', city: 'Bengaluru', state: 'Karnataka', pinCode: '560045', addressLine1: '5, Frazer Town', occupation: 'Shop owner', preferredContact: 'PHONE',
    family: [{ fullName: 'Ayesha Irfan', relationship: 'Spouse', dateOfBirth: '1987-01-09', gender: 'FEMALE' }, { fullName: 'Zoya Irfan', relationship: 'Daughter', dateOfBirth: '2012-10-18', gender: 'FEMALE' }] },
  { fullName: 'Anitha Reddy', mobile: '9845012306', dateOfBirth: '1979-11-02', gender: 'FEMALE', email: 'anitha.reddy@example.com', city: 'Hyderabad', state: 'Telangana', pinCode: '500034', addressLine1: '17, Road No. 10, Banjara Hills', occupation: 'Chartered accountant', preferredContact: 'EMAIL' },
  { fullName: 'Prakash Shetty', mobile: '9845012307', dateOfBirth: '1975-01-20', gender: 'MALE', city: 'Udupi', state: 'Karnataka', pinCode: '576101', addressLine1: '3, Car Street', occupation: 'Hotel owner', anniversary: '2001-05-06', preferredContact: 'WHATSAPP',
    family: [{ fullName: 'Shobha Shetty', relationship: 'Spouse', dateOfBirth: '1978-08-08', gender: 'FEMALE' }, { fullName: 'Rakshith Shetty', relationship: 'Son', dateOfBirth: '2004-03-27', gender: 'MALE' }] },
  { fullName: 'Kiran Patil', mobile: '9845012308', dateOfBirth: '1991-06-12', gender: 'MALE', email: 'kiran.patil@example.com', city: 'Hubballi', state: 'Karnataka', pinCode: '580020', addressLine1: '9, Vidyanagar', occupation: 'Sales manager', preferredContact: 'WHATSAPP' },
  { fullName: 'Deepa Nair', mobile: '9845012309', dateOfBirth: '1986-04-25', gender: 'FEMALE', city: 'Bengaluru', state: 'Karnataka', pinCode: '560066', addressLine1: '101, Whitefield Main Road', occupation: 'HR manager', preferredContact: 'WHATSAPP',
    family: [{ fullName: 'Vinod Nair', relationship: 'Spouse', dateOfBirth: '1984-02-17', gender: 'MALE' }, { fullName: 'Diya Nair', relationship: 'Daughter', dateOfBirth: '2016-11-30', gender: 'FEMALE' }] },
  { fullName: 'Ramesh Joshi', mobile: '9845012310', dateOfBirth: '1960-09-09', gender: 'MALE', city: 'Belagavi', state: 'Karnataka', pinCode: '590001', addressLine1: '14, Tilakwadi', occupation: 'Retired bank officer', anniversary: '1987-12-12', preferredContact: 'PHONE',
    family: [{ fullName: 'Sunanda Joshi', relationship: 'Spouse', dateOfBirth: '1963-05-19', gender: 'FEMALE' }] },
  { fullName: 'Sneha Rao', mobile: '9845012311', dateOfBirth: '1995-02-28', gender: 'FEMALE', email: 'sneha.rao@example.com', city: 'Mangaluru', state: 'Karnataka', pinCode: '575003', addressLine1: '6, Kadri Hills', occupation: 'Architect', preferredContact: 'WHATSAPP' },
  { fullName: 'Vikram Singh', mobile: '9845012312', dateOfBirth: '1982-12-01', gender: 'MALE', city: 'Bengaluru', state: 'Karnataka', pinCode: '560102', addressLine1: '33, HSR Layout Sector 2', occupation: 'Startup founder', preferredContact: 'WHATSAPP',
    family: [{ fullName: 'Neha Singh', relationship: 'Spouse', dateOfBirth: '1985-07-07', gender: 'FEMALE' }, { fullName: 'Kabir Singh', relationship: 'Son', dateOfBirth: '2018-01-15', gender: 'MALE' }, { fullName: 'Harbhajan Singh', relationship: 'Father', dateOfBirth: '1952-03-03', gender: 'MALE' }, { fullName: 'Gurpreet Kaur', relationship: 'Mother', dateOfBirth: '1956-10-21', gender: 'FEMALE' }] },
];

const custIds = new Map<string, string>();
let nCust = 0, nFam = 0;
for (const c of CUSTOMERS) {
  const { family, ...body } = c;
  const r = await quiet(`customer ${c.fullName}`, () => createCustomer(req, auth, { ...body, saveAnyway: true }));
  if (r) nCust++;
  const [row] = await db.execute(sql`select id from customers where account_id = ${auth.accountId} and mobile = ${'+91' + c.mobile} and status = 'ACTIVE' limit 1`).then((x) => x.rows as { id: string }[]);
  if (!row) continue;
  custIds.set(c.fullName, row.id);
  // consent recorded on a signed form (needed before Aadhaar / PAN can be stored, and for WhatsApp messages)
  for (const channel of ['PERSONAL_DATA', 'WHATSAPP']) await quiet(`consent ${c.fullName}`, () => recordConsent(req, auth, row.id, { channel, familyMemberId: null, how: 'Signed form', declaration: true, version: 0 }));
  for (const f of family ?? []) if (await quiet(`family ${f.fullName}`, () => addMember(req, auth, row.id, f))) nFam++;
}
console.log(`  customers: ${nCust} added, family members: ${nFam} added`);

// ---------- policies (renewals coming up) ----------
const ins = await db.select({ id: insurers.id, name: insurers.name }).from(insurers).where(eq(insurers.status, 'ACTIVE'));
const types = await db.select({ id: insuranceTypes.id, name: insuranceTypes.name }).from(insuranceTypes);
const insurer = (word: string) => ins.find((i) => i.name.toLowerCase().includes(word))?.id ?? ins.find((i) => !/^demo/i.test(i.name))?.id ?? ins[0]?.id;
const type = (word: string) => types.find((t) => t.name.toLowerCase().includes(word))?.id ?? types[0]?.id;
const memberKeys = async (customerId: string) => {
  const rows = (await db.execute(sql`select id from family_members where customer_id = ${customerId} and status = 'ACTIVE'`)).rows as { id: string }[];
  return ['customer', ...rows.map((r) => r.id)];
};
// end date decides when the renewal is due: a few this week, some this month, the rest later
const POLICIES: { who: string; ins: string; type: string; product: string; no: string; endIn: number; si: number; premium: number; freq?: string; family?: boolean }[] = [
  { who: 'Ravi Kumar', ins: 'care', type: 'health', product: 'Care Supreme Family Floater', no: 'CHI/2025/882301', endIn: 6, si: 1000000, premium: 24850, family: true },
  { who: 'Priya Sharma', ins: 'niva', type: 'health', product: 'ReAssure 2.0', no: 'NB-31882044', endIn: 12, si: 500000, premium: 13600, family: true },
  { who: 'Suresh Gowda', ins: 'hdfc ergo', type: 'health', product: 'Optima Secure', no: 'HE/2301/77412', endIn: 3, si: 1500000, premium: 41200, family: true },
  { who: 'Mohammed Irfan', ins: 'icici lombard', type: 'car', product: 'Private Car Package Policy', no: 'ICL-MOT-5521890', endIn: 18, si: 640000, premium: 11890 },
  { who: 'Prakash Shetty', ins: 'life insurance corporation', type: 'term', product: 'Jeevan Amar', no: 'LIC-702233918', endIn: 25, si: 10000000, premium: 18720, freq: 'YEARLY' },
  { who: 'Deepa Nair', ins: 'aditya birla', type: 'health', product: 'Activ One', no: 'ABH-2025-338105', endIn: 40, si: 700000, premium: 19340, family: true },
  { who: 'Ramesh Joshi', ins: 'star', type: 'health', product: 'Senior Citizens Red Carpet', no: 'SH-P-161100-4471', endIn: 9, si: 500000, premium: 32150, family: true },
  { who: 'Vikram Singh', ins: 'tata aig', type: 'health', product: 'Medicare Premier', no: 'TAIG-HL-0091827', endIn: 75, si: 2500000, premium: 52300, family: true },
  { who: 'Kiran Patil', ins: 'go digit', type: 'two', product: 'Two-wheeler Comprehensive', no: 'DIGIT-2W-88123', endIn: 4, si: 85000, premium: 2350 },
  { who: 'Anitha Reddy', ins: 'axis max', type: 'term', product: 'Smart Term Plan Plus', no: 'MAX-TRM-4410982', endIn: 140, si: 15000000, premium: 21400, freq: 'YEARLY' },
];
let nPol = 0;
for (const p of POLICIES) {
  const cid = custIds.get(p.who);
  const insurerId = insurer(p.ins);
  const typeId = type(p.type);
  if (!cid || !insurerId || !typeId) continue;
  const endDate = shift(p.endIn);
  const startDate = shift(1, years(1, endDate));
  const keys = p.family ? await memberKeys(cid) : ['customer'];
  const r = await quiet(`policy ${p.no}`, () => recordExisting(req, auth, {
    customerId: cid, insurerId, typeId, productName: p.product, insured: keys,
    insurerPolicyNumber: p.no, issueDate: startDate < today ? startDate : today, startDate, endDate,
    frequency: p.freq ?? 'YEARLY', nextDueDate: p.freq ? endDate : undefined, sumInsured: String(p.si), premium: String(p.premium), soldByMe: true,
  }));
  if (r) nPol++;
}
console.log(`  policies: ${nPol} added (renewals due in the next days and weeks)`);

// ---------- leads at different stages ----------
const [pipe] = await db.select({ id: pipelines.id }).from(pipelines).where(eq(pipelines.accountId, auth.accountId!)).limit(1);
const LEADS: { name: string; mobile: string; source: string; priority: string; notes: string; campaign?: string; to?: string[]; followIn?: number }[] = [
  { name: 'Arun Prasad', mobile: '9900112201', source: 'Walk-in or personal contact', priority: 'HIGH', notes: 'Wants family health cover for 4, budget ₹25,000', to: ['CONTACTED', 'QUALIFIED'] },
  { name: 'Lavanya Krishnan', mobile: '9900112202', source: 'Social media', priority: 'MEDIUM', notes: 'Asked about term insurance on Instagram', to: ['CONTACTED'] },
  { name: 'Naveen Hegde', mobile: '9900112203', source: 'Website', priority: 'HIGH', notes: 'New car next month, needs motor insurance', followIn: 1 },
  { name: 'Farhan Khan', mobile: '9900112204', source: 'Paid ads', priority: 'LOW', notes: 'Clicked the health insurance ad' },
  { name: 'Pooja Menon', mobile: '9900112205', source: 'Campaign', campaign: 'Office health camp', priority: 'MEDIUM', notes: 'Met at the office health camp', to: ['CONTACTED'], followIn: 2 },
  { name: 'Sanjay Kulkarni', mobile: '9900112206', source: 'Walk-in or personal contact', priority: 'HIGH', notes: 'Parents 62 and 58, wants senior citizen plan', to: ['CONTACTED', 'QUALIFIED'] },
  { name: 'Rekha Bhat', mobile: '9900112207', source: 'Other', priority: 'LOW', notes: 'Call after Diwali' },
  { name: 'Tarun Malhotra', mobile: '9900112208', source: 'Website', priority: 'MEDIUM', notes: 'Compare 2 health plans and send on WhatsApp', followIn: 3 },
];
let nLead = 0;
if (pipe) {
  for (const l of LEADS) {
    const fu = l.followIn ? { followUpDate: shift(l.followIn), followUpTime: '11:00 AM' } : {};
    const r = await quiet(`lead ${l.name}`, () => createLead(req, auth, { name: l.name, mobile: l.mobile, source: l.source, pipelineId: pipe.id, priority: l.priority, notes: l.notes, ...(l.campaign ? { campaign: l.campaign } : {}), ...fu, saveAnyway: true }));
    if (!r) continue;
    nLead++;
    const id = (r as { lead?: { id: string } }).lead?.id ?? (await db.select({ id: leads.id }).from(leads).where(and(eq(leads.accountId, auth.accountId!), eq(leads.mobile, '+91' + l.mobile))).limit(1))[0]?.id;
    for (const to of l.to ?? []) {
      const [cur] = await db.select({ version: leads.version }).from(leads).where(eq(leads.id, id!));
      await quiet(`lead status ${l.name}`, () => changeStatus(req, auth, id!, { status: to, version: cur!.version }));
    }
  }
}
console.log(`  leads: ${nLead} added`);

// ---------- today's tasks (and two overdue) ----------
const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`);
const now = clock.now();
const laterToday = (hhmm: string) => (at(today, hhmm) > now ? at(today, hhmm) : new Date(now.getTime() + 30 * 60_000));
const TASKS: { title: string; dueAt: Date; who?: string; notes?: string }[] = [
  { title: 'Call Ravi Kumar about health renewal', dueAt: laterToday('11:00'), who: 'Ravi Kumar', notes: 'Renewal in 6 days, premium ₹24,850' },
  { title: 'Send birthday wishes to Priya Sharma', dueAt: laterToday('10:00'), who: 'Priya Sharma' },
  { title: 'Collect Aadhaar copy from Suresh Gowda', dueAt: laterToday('16:00'), who: 'Suresh Gowda' },
  { title: 'Share 2 health quotations with Arun Prasad', dueAt: laterToday('18:30') },
  { title: 'Follow up Kiran Patil two-wheeler renewal', dueAt: at(shift(-1), '12:00'), who: 'Kiran Patil' },
  { title: 'Ramesh Joshi: senior plan documents', dueAt: at(shift(-2), '15:00'), who: 'Ramesh Joshi' },
  { title: 'Motor quote for Naveen Hegde', dueAt: at(shift(2), '11:30') },
];
let nTask = 0;
for (const t of TASKS) {
  const [dup] = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.accountId, auth.accountId!), eq(tasks.title, t.title))).limit(1);
  if (dup) continue;
  const cid = t.who ? custIds.get(t.who) : undefined;
  await db.insert(tasks).values({ accountId: auth.accountId!, title: t.title, dueAt: t.dueAt, notes: t.notes ?? null, linkedType: cid ? 'CUSTOMER' : null, linkedId: cid ?? null, createdBy: auth.userId, createdAt: clock.now() });
  nTask++;
}
console.log(`  tasks: ${nTask} added`);
console.log('\nDone. Open the app and log in with this number to see it (pull down to refresh).');
await pool.end();
