import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { accounts, configValues, insuranceTypes, insurers as insurersTable, users } from '../src/db/schema.js';
import { clock } from '../src/lib/clock.js';
import { settings } from '../src/modules/settings/settings.service.js';
import { sentSms } from '../src/modules/sms/sms.js';

export const app = createApp();

let counter = 0;
const runPrefix = String(Math.floor(Math.random() * 900) + 100);
/** A fresh valid 10-digit mobile number (without +91). */
export function newMobile(): string {
  counter += 1;
  return `9${runPrefix}${String(counter).padStart(6, '0')}`;
}

function newIp(): string {
  const r = () => Math.floor(Math.random() * 250) + 1;
  return `10.${r()}.${r()}.${r()}`;
}

export const key = () => randomUUID();

/** One browser: keeps its cookies, has its own IP address and user agent. */
export class Device {
  readonly agent = request.agent(app);
  constructor(
    readonly ip = newIp(),
    readonly userAgent = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36',
  ) {}
  post(path: string, body: object = {}, headers: Record<string, string> = {}) {
    return this.agent.post(`/api/v1${path}`).set('x-forwarded-for', this.ip).set('user-agent', this.userAgent).set(headers).send(body);
  }
  get(path: string) {
    return this.agent.get(`/api/v1${path}`).set('x-forwarded-for', this.ip).set('user-agent', this.userAgent);
  }
}

/** The last OTP code the (memory) SMS provider sent to a number. */
export function lastCode(mobile: string): string {
  const to = `+91${mobile}`;
  const m = [...sentSms].reverse().find((s) => s.kind === 'OTP' && s.to === to);
  if (!m || m.kind !== 'OTP') throw new Error(`No OTP sent to ${to}`);
  return m.code;
}
export const otpCount = (mobile: string) => sentSms.filter((s) => s.kind === 'OTP' && s.to === `+91${mobile}`).length;

export function wrongCode(code: string): string {
  return code === '000000' ? '111111' : '000000';
}

export async function register(device: Device, name: string, mobile: string) {
  const send = await device.post('/auth/register/send-otp', { name, mobile, termsAccepted: true });
  if (send.status !== 200) throw new Error(`send failed ${send.status} ${JSON.stringify(send.body)}`);
  const verify = await device.post('/auth/register/verify', { challengeId: send.body.challengeId, code: lastCode(mobile) }, { 'idempotency-key': key() });
  return { send, verify };
}

export async function login(device: Device, mobile: string, next?: string) {
  const send = await device.post('/auth/login/send-otp', { mobile });
  if (send.status !== 200) return { send, verify: send };
  const verify = await device.post('/auth/login/verify', { challengeId: send.body.challengeId, code: lastCode(mobile), ...(next ? { next } : {}) });
  return { send, verify };
}

/** Insert a user directly (roles that cannot self-register). */
export async function insertUser(input: { role: 'REF' | 'STF' | 'ADM' | 'AST'; mobile: string; status?: string; accountId?: string | null; invitedAt?: Date; name?: string }) {
  let accountId = input.accountId ?? null;
  if ((input.role === 'REF' || input.role === 'AST') && !accountId) {
    const [a] = await db.insert(accounts).values({}).returning();
    accountId = a!.id;
  }
  const [u] = await db
    .insert(users)
    .values({
      role: input.role,
      name: input.name ?? `Test ${input.role}`,
      mobile: `+91${input.mobile}`,
      status: input.status ?? 'ACTIVE',
      accountId,
      invitedAt: input.invitedAt ?? null,
    })
    .returning();
  return u!;
}

export async function userByMobile(mobile: string) {
  const [u] = await db.select().from(users).where(eq(users.mobile, `+91${mobile}`));
  return u;
}

/** Change a CFG value for a test (restore with resetSetting). */
export async function setSetting(id: string, value: unknown) {
  await db.update(configValues).set({ value }).where(eq(configValues.id, id));
  await settings.refresh();
}
export async function resetSettings() {
  await settings.init();
  await db.execute(sql`update config_values set value = default_value`);
  await settings.refresh();
}

export function advance(ms: number) {
  clock.setOffset(clock.offset() + ms);
}
export function resetClock() {
  clock.setOffset(0);
}

// ---------- Phase 2 helpers ----------

/** Tiny but complete sample files (content checks look at the real bytes, not the name). */
export const SAMPLE = {
  png: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1), Buffer.from('IEND'), Buffer.alloc(4)]),
  jpg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2), Buffer.from([0xff, 0xd9])]),
  pdf: Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n'),
  lockedPdf: Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R /Encrypt 2 0 R >>\n%%EOF\n'),
  exe: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 0)]),
};

export function upload(device: Device, purpose: string, files: { name: string; data: Buffer }[]) {
  let r = device.agent.post('/api/v1/files').set('x-forwarded-for', device.ip).set('x-upload', '1').field('purpose', purpose);
  for (const f of files) r = r.attach('files', f.data, f.name);
  return r;
}

export async function ensureTypes() {
  const names = ['Health', 'Term Life', 'Motor Private Car'];
  for (const [i, name] of names.entries()) await db.insert(insuranceTypes).values({ name, position: i + 1 }).onConflictDoNothing();
  return db.select().from(insuranceTypes);
}

export async function createInsurer(name: string, status = 'ACTIVE') {
  const code = name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 18) + '-' + Math.floor(Math.random() * 1000);
  const [i] = await db.insert(insurersTable).values({ name, shortCode: code, category: 'GENERAL', irdaiRegNo: 'T-1', status }).returning();
  return i!;
}

/** A signed-in advisor on a fresh device. */
export async function advisor(name = 'Test Advisor') {
  const d = new Device();
  const m = newMobile();
  await register(d, name, m);
  const u = (await userByMobile(m))!;
  return { d, mobile: m, user: u, accountId: u.accountId! };
}

// ---------- Phase 3 helpers ----------

/** A signed-in SkyUp user (STF or ADM) on a fresh device. */
export async function staff(role: 'STF' | 'ADM', name?: string) {
  const d = new Device();
  const m = newMobile();
  const user = await insertUser({ role, mobile: m, name: name ?? (role === 'ADM' ? 'Approver Admin' : 'Catalogue Staff') });
  const r = await login(d, m);
  if (r.verify.status !== 200) throw new Error(`staff login failed ${JSON.stringify(r.verify.body)}`);
  return { d, mobile: m, user };
}

/** Extra OTP for an action (AUTH-26); returns the step-up token header value. */
export async function stepUp(d: Device, mobile: string, action = 'APPROVE'): Promise<string> {
  const s = await d.post('/auth/step-up/send-otp', { action });
  if (!s.body.challengeId) throw new Error(`step-up send failed ${JSON.stringify(s.body)}`);
  const v = await d.post('/auth/step-up/verify', { challengeId: s.body.challengeId, code: lastCode(mobile) });
  if (!v.body.stepUpToken) throw new Error(`step-up failed ${JSON.stringify(v.body)}`);
  return v.body.stepUpToken as string;
}

/** A small text PDF (one string per line, one array per page) that pdf.js can read. */
export function makePdf(pages: string[][]): Buffer {
  const objs: string[] = [];
  const pageIds: number[] = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let n = 4;
  for (const lines of pages) {
    const esc = (t: string) => t.replace(/[\\()]/g, (c) => `\\${c}`);
    const stream = `BT /F1 12 Tf 14 TL 72 760 Td ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
    objs[n] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    objs[n + 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${n} 0 R >>`;
    pageIds.push(n + 1);
    n += 2;
  }
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i += 1) {
    offsets[i] = Buffer.byteLength(out);
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}
